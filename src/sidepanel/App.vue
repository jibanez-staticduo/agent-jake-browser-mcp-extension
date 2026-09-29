<script setup lang="ts">
/**
 * Copilot side panel: a chat whose agent acts on the browser tabs.
 * The loop runs in the service worker (background/agent); this page only renders
 * the conversation, tracks the target tab and edits the settings.
 */
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import {
  COPILOT_PORT,
  COPILOT_SETTINGS_KEY,
  DEFAULT_COPILOT_SETTINGS,
  type ChatTurn,
  type CopilotSettings,
  type WorkerToPanel,
} from '@/types/copilot';

interface Item {
  kind: 'user' | 'assistant' | 'tool' | 'error' | 'info';
  text: string;
  id?: string;
  ok?: boolean;
  detail?: string;
}

interface Target {
  id: number;
  title: string;
  url: string;
}

const CHAT_KEY = 'copilotChat';

const items = ref<Item[]>([]);
const input = ref('');
const running = ref(false);
const step = ref(0);
const target = ref<Target | null>(null);
const pinned = ref(false);
const showSettings = ref(false);
const settings = ref<CopilotSettings>({ ...DEFAULT_COPILOT_SETTINGS });
const log = ref<HTMLElement | null>(null);

let port: chrome.runtime.Port | null = null;
let windowId: number | null = null;

const needsSetup = computed(() => !settings.value.baseUrl || !settings.value.model);

function history(): ChatTurn[] {
  return items.value
    .filter((i) => i.kind === 'user' || i.kind === 'assistant')
    .map((i) => ({ role: i.kind as ChatTurn['role'], content: i.text }));
}

async function persist() {
  await chrome.storage.session.set({ [CHAT_KEY]: items.value });
}

async function push(item: Item) {
  items.value.push(item);
  await nextTick();
  log.value?.scrollTo({ top: log.value.scrollHeight });
  void persist();
}

function onWorker(event: WorkerToPanel) {
  switch (event.type) {
    case 'step':
      step.value = event.step;
      break;
    case 'tool_call':
      void push({ kind: 'tool', id: event.id, text: event.name, detail: JSON.stringify(event.args) });
      break;
    case 'tool_result': {
      const item = [...items.value].reverse().find((i) => i.kind === 'tool' && i.id === event.id);
      if (item) {
        item.ok = event.ok;
        item.detail = `${item.detail}\n→ ${event.summary}`;
        void persist();
      }
      break;
    }
    case 'assistant':
      void push({ kind: 'assistant', text: event.text || '(sin respuesta)' });
      break;
    case 'error':
      void push({ kind: 'error', text: event.message });
      break;
    case 'done':
      running.value = false;
      step.value = 0;
      if (event.stopped) void push({ kind: 'info', text: 'Parado.' });
      break;
  }
}

function connect(): chrome.runtime.Port {
  if (port) return port;
  port = chrome.runtime.connect({ name: COPILOT_PORT });
  port.onMessage.addListener(onWorker);
  port.onDisconnect.addListener(() => {
    port = null;
    if (running.value) {
      running.value = false;
      void push({ kind: 'error', text: 'Se perdió la conexión con el service worker.' });
    }
  });
  return port;
}

async function send() {
  const prompt = input.value.trim();
  if (!prompt || running.value) return;
  const turns = history();
  input.value = '';
  running.value = true;
  await push({ kind: 'user', text: prompt });
  connect().postMessage({ type: 'prompt', history: turns, prompt, targetTabId: target.value?.id ?? null });
}

function stop() {
  port?.postMessage({ type: 'stop' });
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void send();
  }
}

async function clearChat() {
  items.value = [];
  await persist();
}

async function saveSettings() {
  await chrome.storage.local.set({ [COPILOT_SETTINGS_KEY]: { ...settings.value } });
  showSettings.value = false;
}

async function refreshTarget() {
  if (pinned.value || windowId === null) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  target.value = tab?.id ? { id: tab.id, title: tab.title || '', url: tab.url || '' } : null;
}

const onActivated = (info: chrome.tabs.OnActivatedInfo) => {
  if (info.windowId === windowId) void refreshTarget();
};
const onUpdated = (tabId: number, _change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
  if (target.value?.id === tabId) target.value = { id: tabId, title: tab.title || '', url: tab.url || '' };
};
const onRemoved = (tabId: number) => {
  if (target.value?.id === tabId) {
    pinned.value = false;
    void refreshTarget();
  }
};

onMounted(async () => {
  windowId = (await chrome.windows.getCurrent()).id ?? null;
  const stored = await chrome.storage.local.get(COPILOT_SETTINGS_KEY);
  settings.value = { ...DEFAULT_COPILOT_SETTINGS, ...(stored[COPILOT_SETTINGS_KEY] as Partial<CopilotSettings>) };
  showSettings.value = !settings.value.apiKey;
  const chat = await chrome.storage.session.get(CHAT_KEY);
  items.value = (chat[CHAT_KEY] as Item[] | undefined) ?? [];
  await refreshTarget();
  chrome.tabs.onActivated.addListener(onActivated);
  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.tabs.onRemoved.addListener(onRemoved);
});

onUnmounted(() => {
  chrome.tabs.onActivated.removeListener(onActivated);
  chrome.tabs.onUpdated.removeListener(onUpdated);
  chrome.tabs.onRemoved.removeListener(onRemoved);
  port?.disconnect();
});

function host(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
</script>

<template>
  <div class="panel">
    <header>
      <div class="target" :title="target?.url">
        <span class="dot" :class="{ pinned }" />
        <span class="title">{{ target ? target.title || host(target.url) : 'Sin pestaña' }}</span>
        <span class="host">{{ target ? host(target.url) : '' }}</span>
      </div>
      <div class="actions">
        <button class="icon" :class="{ on: pinned }" :title="pinned ? 'Seguir la pestaña activa' : 'Fijar esta pestaña'"
          @click="pinned = !pinned; refreshTarget()">📌</button>
        <button class="icon" title="Borrar conversación" @click="clearChat">🗑</button>
        <button class="icon" :class="{ on: showSettings }" title="Ajustes" @click="showSettings = !showSettings">⚙</button>
      </div>
    </header>

    <form v-if="showSettings" class="settings" @submit.prevent="saveSettings">
      <label>Endpoint (OpenAI-compatible)<input v-model="settings.baseUrl" placeholder="https://…/v1"></label>
      <label>API key<input v-model="settings.apiKey" type="password" autocomplete="off"></label>
      <div class="row">
        <label>Modelo<input v-model="settings.model"></label>
        <label class="narrow">Pasos máx.<input v-model.number="settings.maxSteps" type="number" min="1" max="100"></label>
      </div>
      <label class="check"><input v-model="settings.vision" type="checkbox"> Visión (capturas al modelo)</label>
      <button type="submit" :disabled="needsSetup">Guardar</button>
    </form>

    <main ref="log" class="log">
      <p v-if="!items.length" class="empty">
        Pide algo sobre esta página u otras pestañas.<br>
        El agente ve la pestaña objetivo (URL, título y elementos) en cada mensaje.
      </p>
      <div v-for="(item, i) in items" :key="i" class="item" :class="item.kind">
        <template v-if="item.kind === 'tool'">
          <details>
            <summary>
              <span :class="item.ok === undefined ? 'pending' : item.ok ? 'ok' : 'ko'">●</span> {{ item.text }}
            </summary>
            <pre>{{ item.detail }}</pre>
          </details>
        </template>
        <template v-else>{{ item.text }}</template>
      </div>
      <div v-if="running" class="item info">Pensando… paso {{ step || 1 }}/{{ settings.maxSteps }}</div>
    </main>

    <footer>
      <textarea v-model="input" rows="3" placeholder="Escribe un prompt (Enter envía, Shift+Enter salto de línea)"
        :disabled="needsSetup" @keydown="onKey" />
      <button v-if="running" class="stop" @click="stop">Stop</button>
      <button v-else :disabled="!input.trim() || needsSetup" @click="send">Enviar</button>
    </footer>
  </div>
</template>

<style>
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg-deepest);
  color: var(--text-primary);
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 13px;
}
#app { height: 100%; }
</style>

<style scoped>
.panel { display: flex; flex-direction: column; height: 100%; }
header {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  border-bottom: 1px solid var(--border-default); background: var(--bg-deep);
}
.target { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; }
.target .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.target .host { color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 1; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent-success); flex-shrink: 0; }
.dot.pinned { background: var(--accent-warning); }
.actions { display: flex; gap: 2px; }
button {
  background: var(--accent-primary-dim); color: var(--text-primary); border: 1px solid var(--border-default);
  border-radius: 6px; padding: 6px 12px; cursor: pointer; font: inherit;
}
button:disabled { opacity: 0.4; cursor: default; }
button.icon { background: none; border: none; padding: 4px 6px; opacity: 0.6; }
button.icon.on, button.icon:hover { opacity: 1; }
button.stop { background: var(--accent-danger-dim); border-color: var(--accent-danger); }
.settings { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-bottom: 1px solid var(--border-default); background: var(--bg-surface); }
.settings label { display: flex; flex-direction: column; gap: 3px; color: var(--text-secondary); flex: 1; }
.settings label.narrow { flex: 0 0 90px; }
.settings label.check { flex-direction: row; align-items: center; gap: 6px; }
.settings .row { display: flex; gap: 8px; }
input, textarea {
  background: var(--bg-deep); color: var(--text-primary); border: 1px solid var(--border-default);
  border-radius: 6px; padding: 6px 8px; font: inherit;
}
.log { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.empty { color: var(--text-secondary); text-align: center; margin-top: 40px; line-height: 1.6; }
.item { white-space: pre-wrap; word-break: break-word; line-height: 1.45; }
.item.user { align-self: flex-end; background: var(--accent-primary-dim); padding: 6px 10px; border-radius: 10px; max-width: 85%; }
.item.assistant { padding: 2px 0; }
.item.tool { font-family: var(--font-mono, monospace); font-size: 11px; color: var(--text-secondary); }
.item.tool summary { cursor: pointer; }
.item.tool pre { margin: 4px 0 0 14px; white-space: pre-wrap; word-break: break-all; max-height: 160px; overflow-y: auto; }
.item.error { color: var(--accent-danger); }
.item.info { color: var(--text-secondary); font-style: italic; }
.ok { color: var(--accent-success); }
.ko { color: var(--accent-danger); }
.pending { color: var(--accent-warning); }
footer { display: flex; gap: 8px; padding: 8px 10px; border-top: 1px solid var(--border-default); align-items: flex-end; }
footer textarea { flex: 1; resize: none; }
</style>
