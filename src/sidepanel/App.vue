<script setup lang="ts">
/**
 * Copilot side panel: a Claude-style chat whose agent acts on the browser tabs.
 * The loop runs in the service worker (background/agent); this page renders the
 * conversation, answers the agent's requests, and owns model/mode/tab selection.
 */
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import {
  COPILOT_ALLOWED_ORIGINS_KEY,
  COPILOT_PORT,
  COPILOT_SETTINGS_KEY,
  DEFAULT_COPILOT_SETTINGS,
  isCopilotConfigured,
  type ChatTurn,
  type CopilotMode,
  type CopilotSettings,
  type PlanStep,
  type UserResponse,
  type WorkerToPanel,
} from '@/types/copilot';
import { renderMarkdown } from './markdown';
import RequestCard from './RequestCard.vue';
import {
  chatModels,
  currentChatId,
  deleteChat,
  listChats,
  newChat,
  saveChat,
  type Chat,
  type Item,
} from './chats';

interface Target {
  id: number;
  title: string;
  url: string;
}

const MODES: { id: CopilotMode; label: string; hint: string }[] = [
  { id: 'ask', label: 'Preguntar', hint: 'Pide permiso antes de cada acción que cambia la página' },
  { id: 'auto', label: 'Auto', hint: 'Actúa sin preguntar' },
  { id: 'plan', label: 'Plan', hint: 'Investiga, propone un plan y espera tu aprobación' },
];

const chat = ref<Chat>(newChat());
const chats = ref<Chat[]>([]);
const input = ref('');
const running = ref(false);
const step = ref(0);
const target = ref<Target | null>(null);
const pinned = ref(false);
const panel = ref<'none' | 'settings' | 'history'>('none');
const settings = ref<CopilotSettings>({ ...DEFAULT_COPILOT_SETTINGS });
const models = ref<string[]>([]);
const modelsError = ref('');
const allowed = ref<string[]>([]);
const planOpen = ref(true);
const log = ref<HTMLElement | null>(null);
const textarea = ref<HTMLTextAreaElement | null>(null);

let port: chrome.runtime.Port | null = null;
let windowId: number | null = null;

const items = computed(() => chat.value.items);
const plan = computed(() => chat.value.plan);
const needsSetup = computed(() => !isCopilotConfigured(settings.value));
const planDone = computed(() => plan.value.filter((s) => s.status === 'done').length);
const modelOptions = computed(() =>
  models.value.includes(settings.value.model) ? models.value : [settings.value.model, ...models.value]);
/** A run of tool calls and silent reasoning, shown collapsed as one "N pasos" block. */
type Block = { key: number; item: Item } | { key: number; steps: Item[] };

const blocks = computed<Block[]>(() => {
  const out: Block[] = [];
  items.value.forEach((item, i) => {
    const quiet = item.kind === 'tool' || (item.kind === 'assistant' && item.interim && !item.text.trim());
    const last = out[out.length - 1];
    if (quiet && last && 'steps' in last) last.steps.push(item);
    else if (quiet) out.push({ key: i, steps: [item] });
    else out.push({ key: i, item });
  });
  return out;
});

function stepsLabel(steps: Item[]): string {
  const tools = steps.filter((s) => s.kind === 'tool');
  const failed = tools.filter((s) => s.ok === false).length;
  const names = [...new Set(tools.map((s) => s.text.replace(/^browser_/, '')))].slice(0, 4).join(', ');
  const n = tools.length || 1;
  return `${n} ${n === 1 ? 'paso' : 'pasos'}${names ? ` · ${names}` : ''}${failed ? ` · ${failed} con error` : ''}`;
}

const waiting = computed(() => items.value.some((i) => i.kind === 'request' && !i.answered));

function history(): ChatTurn[] {
  return items.value
    .filter((i) => i.kind === 'user' || (i.kind === 'assistant' && !i.interim && i.text))
    .map((i) => ({ role: i.kind as ChatTurn['role'], content: i.text }));
}

function persist() {
  void saveChat(chat.value);
}

async function scroll() {
  await nextTick();
  log.value?.scrollTo({ top: log.value.scrollHeight });
}

function push(item: Item) {
  chat.value.items.push(item);
  void scroll();
}

function streamingItem(): Item | null {
  const last = items.value[items.value.length - 1];
  return last?.kind === 'assistant' && last.streaming ? last : null;
}

function closeStreaming(interim: boolean) {
  const s = streamingItem();
  if (!s) return;
  s.streaming = false;
  s.interim = interim;
  if (!s.text.trim() && !s.reasoning) chat.value.items.pop();
}

function onWorker(event: WorkerToPanel) {
  switch (event.type) {
    case 'step':
      step.value = event.step;
      break;
    case 'delta': {
      const s = streamingItem();
      if (s) s.text += event.text;
      else push({ kind: 'assistant', text: event.text, streaming: true });
      void scroll();
      break;
    }
    case 'reasoning': {
      const s = streamingItem();
      if (s) s.reasoning = (s.reasoning ?? '') + event.text;
      else push({ kind: 'assistant', text: '', reasoning: event.text, streaming: true });
      break;
    }
    case 'tool_call':
      closeStreaming(true);
      push({ kind: 'tool', id: event.id, text: event.name, detail: JSON.stringify(event.args) });
      break;
    case 'tool_result': {
      const item = [...items.value].reverse().find((i) => i.kind === 'tool' && i.id === event.id);
      if (item) {
        item.ok = event.ok;
        item.detail = `${item.detail}\n→ ${event.summary}`;
      }
      break;
    }
    case 'request':
      closeStreaming(true);
      push({ kind: 'request', id: event.requestId, text: '', request: event.request });
      persist();
      break;
    case 'plan':
      chat.value.plan = event.steps;
      planOpen.value = true;
      break;
    case 'mode':
      settings.value.mode = event.mode;
      void saveSettings(false);
      break;
    case 'assistant': {
      const s = streamingItem();
      if (s) {
        s.text = event.text || s.text;
        s.streaming = false;
        s.interim = false;
      } else {
        push({ kind: 'assistant', text: event.text || '(sin respuesta)' });
      }
      break;
    }
    case 'error':
      closeStreaming(true);
      push({ kind: 'error', text: event.message });
      break;
    case 'done':
      closeStreaming(false);
      for (const i of items.value) if (i.kind === 'request' && !i.answered) i.answered = 'cancelled';
      running.value = false;
      step.value = 0;
      if (event.stopped) push({ kind: 'info', text: 'Parado.' });
      persist();
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
      push({ kind: 'error', text: 'Se perdió la conexión con el service worker.' });
    }
  });
  return port;
}

function send() {
  const prompt = input.value.trim();
  if (!prompt || running.value || needsSetup.value) return;
  const turns = history();
  input.value = '';
  running.value = true;
  push({ kind: 'user', text: prompt });
  persist();
  connect().postMessage({
    type: 'prompt',
    history: turns,
    prompt,
    targetTabId: target.value?.id ?? null,
    mode: settings.value.mode,
    model: settings.value.model,
  });
}

function respond(item: Item, response: UserResponse, label: string) {
  item.answered = label;
  port?.postMessage({ type: 'response', requestId: item.id, response });
  persist();
}

function stop() {
  port?.postMessage({ type: 'stop' });
}

function cycleMode() {
  const i = MODES.findIndex((m) => m.id === settings.value.mode);
  setMode(MODES[(i + 1) % MODES.length].id);
}

function setMode(mode: CopilotMode) {
  settings.value.mode = mode;
  void saveSettings(false);
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  } else if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    cycleMode();
  } else if (e.key === 'Escape' && running.value) {
    stop();
  }
}

async function startNewChat() {
  if (running.value) return;
  chat.value = newChat();
  panel.value = 'none';
  await nextTick();
  textarea.value?.focus();
}

async function openHistory() {
  chats.value = await listChats();
  panel.value = panel.value === 'history' ? 'none' : 'history';
}

function openChat(c: Chat) {
  if (running.value) return;
  chat.value = JSON.parse(JSON.stringify(c)) as Chat;
  panel.value = 'none';
  void scroll();
}

async function removeChat(c: Chat) {
  await deleteChat(c.id);
  chats.value = await listChats();
  if (c.id === chat.value.id) chat.value = newChat();
}

async function saveSettings(close = true) {
  if (!isCopilotConfigured(settings.value)) return;
  await chrome.storage.local.set({ [COPILOT_SETTINGS_KEY]: { ...settings.value } });
  if (close) {
    panel.value = 'none';
    void loadModels();
  }
}

async function loadModels() {
  modelsError.value = '';
  if (!isCopilotConfigured(settings.value)) return;
  try {
    const base = settings.value.baseUrl.trim().replace(/\/+$/, '');
    const res = await fetch(`${base}/models`, {
      headers: settings.value.apiKey ? { Authorization: `Bearer ${settings.value.apiKey}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { data?: { id: string }[] };
    models.value = chatModels((data.data ?? []).map((m) => m.id));
  } catch (error) {
    modelsError.value = `No pude listar modelos: ${(error as Error).message}`;
  }
}

function onModelChange() {
  void saveSettings(false);
}

async function loadAllowed() {
  const stored = await chrome.storage.local.get(COPILOT_ALLOWED_ORIGINS_KEY);
  allowed.value = Array.isArray(stored[COPILOT_ALLOWED_ORIGINS_KEY]) ? stored[COPILOT_ALLOWED_ORIGINS_KEY] as string[] : [];
}

async function forgetOrigin(origin: string) {
  allowed.value = allowed.value.filter((o) => o !== origin);
  await chrome.storage.local.set({ [COPILOT_ALLOWED_ORIGINS_KEY]: allowed.value });
}

async function toggleSettings() {
  panel.value = panel.value === 'settings' ? 'none' : 'settings';
  if (panel.value === 'settings') await loadAllowed();
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
  // ?windowId=N: the panel runs detached in its own window and follows N's active tab.
  const detached = Number(new URLSearchParams(location.search).get('windowId'));
  windowId = detached || ((await chrome.windows.getCurrent()).id ?? null);
  const stored = await chrome.storage.local.get(COPILOT_SETTINGS_KEY);
  settings.value = { ...DEFAULT_COPILOT_SETTINGS, ...(stored[COPILOT_SETTINGS_KEY] as Partial<CopilotSettings>) };
  if (needsSetup.value) panel.value = 'settings';
  const id = await currentChatId();
  const last = id ? (await listChats()).find((c) => c.id === id) : undefined;
  if (last) {
    chat.value = last;
    for (const i of chat.value.items) {
      if (i.kind === 'request' && !i.answered) i.answered = 'cancelled';
      i.streaming = false;
    }
  }
  await refreshTarget();
  void loadModels();
  void scroll();
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

function when(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const statusIcon: Record<PlanStep['status'], string> = { pending: '○', in_progress: '◐', done: '●' };
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
        <button class="icon" title="Nueva conversación" :disabled="running" @click="startNewChat">✚</button>
        <button class="icon" :class="{ on: panel === 'history' }" title="Conversaciones" @click="openHistory">🕘</button>
        <button class="icon" :class="{ on: panel === 'settings' }" title="Ajustes" @click="toggleSettings">⚙</button>
      </div>
    </header>

    <form v-if="panel === 'settings'" class="drawer settings" @submit.prevent="saveSettings()">
      <label>Endpoint (OpenAI-compatible)<input v-model="settings.baseUrl" placeholder="https://…/v1"></label>
      <label>API key<input v-model="settings.apiKey" type="password" autocomplete="off"></label>
      <div class="row">
        <label>Pasos máx.<input v-model.number="settings.maxSteps" type="number" min="1" max="100"></label>
        <label class="check"><input v-model="settings.vision" type="checkbox"> Visión (capturas al modelo)</label>
      </div>
      <div v-if="allowed.length" class="allowed">
        <span>Sitios con permiso permanente (modo Preguntar):</span>
        <div v-for="o in allowed" :key="o" class="origin">{{ o }} <button type="button" class="icon" @click="forgetOrigin(o)">✕</button></div>
      </div>
      <button type="submit" :disabled="needsSetup">Guardar</button>
    </form>

    <div v-else-if="panel === 'history'" class="drawer history">
      <p v-if="!chats.length" class="muted">No hay conversaciones guardadas.</p>
      <div v-for="c in chats" :key="c.id" class="chat-row" :class="{ current: c.id === chat.id }">
        <button class="link" @click="openChat(c)">{{ c.title }}</button>
        <span class="muted">{{ when(c.updatedAt) }}</span>
        <button class="icon" title="Borrar" @click="removeChat(c)">🗑</button>
      </div>
    </div>

    <main ref="log" class="log">
      <div v-if="!items.length" class="empty">
        <p>Pide algo sobre esta página u otras pestañas.</p>
        <p class="muted">El agente ve la pestaña objetivo (URL, título y elementos) en cada mensaje.
          <b>Preguntar</b> pide permiso antes de actuar, <b>Auto</b> actúa solo y <b>Plan</b> propone un plan antes de tocar nada
          (Shift+Tab cambia de modo).</p>
      </div>
      <template v-for="(block, b) in blocks" :key="block.key">
        <details v-if="'steps' in block" class="steps" :open="running && b === blocks.length - 1">
          <summary>{{ stepsLabel(block.steps) }}</summary>
          <template v-for="(item, j) in block.steps" :key="j">
            <details v-if="item.kind === 'tool'" class="item tool">
              <summary><span :class="item.ok === undefined ? 'pending' : item.ok ? 'ok' : 'ko'">●</span> {{ item.text }}</summary>
              <pre>{{ item.detail }}</pre>
            </details>
            <details v-else-if="item.reasoning" class="item reasoning">
              <summary>razonamiento</summary>
              <pre>{{ item.reasoning }}</pre>
            </details>
          </template>
        </details>
        <template v-else>
          <div v-if="block.item.kind === 'user'" class="item user">{{ block.item.text }}</div>
          <div v-else-if="block.item.kind === 'assistant'" class="item assistant" :class="{ interim: block.item.interim }">
            <details v-if="block.item.reasoning" class="reasoning">
              <summary>razonamiento</summary>
              <pre>{{ block.item.reasoning }}</pre>
            </details>
            <div class="md" v-html="renderMarkdown(block.item.text)" /><span v-if="block.item.streaming" class="caret">▍</span>
          </div>
          <RequestCard v-else-if="block.item.kind === 'request' && block.item.request" :request="block.item.request"
            :answered="block.item.answered" @respond="(r, label) => respond(block.item, r, label)" />
          <div v-else class="item" :class="block.item.kind">{{ block.item.text }}</div>
        </template>
      </template>
      <div v-if="running && !waiting" class="item info">Trabajando… paso {{ step || 1 }}/{{ settings.maxSteps }}</div>
    </main>

    <section v-if="plan.length" class="plan">
      <button class="plan-head" @click="planOpen = !planOpen">
        Plan · {{ planDone }}/{{ plan.length }} <span class="muted">{{ planOpen ? '▾' : '▸' }}</span>
      </button>
      <ul v-if="planOpen">
        <li v-for="(s, i) in plan" :key="i" :class="s.status"><span>{{ statusIcon[s.status] }}</span> {{ s.text }}</li>
      </ul>
    </section>

    <footer>
      <textarea ref="textarea" v-model="input" rows="3"
        placeholder="Escribe un prompt · Enter envía · Shift+Enter salto · Shift+Tab modo"
        :disabled="needsSetup" @keydown="onKey" />
      <div class="toolbar">
        <div class="modes" role="radiogroup">
          <button v-for="m in MODES" :key="m.id" type="button" class="mode" :class="[m.id, { on: settings.mode === m.id }]"
            :title="m.hint" @click="setMode(m.id)">{{ m.label }}</button>
        </div>
        <select v-model="settings.model" class="model" :title="modelsError || 'Modelo'" @change="onModelChange">
          <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
        </select>
        <button v-if="running" class="stop" @click="stop">Stop</button>
        <button v-else class="send" :disabled="!input.trim() || needsSetup" @click="send">↑</button>
      </div>
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
  border-radius: 6px; padding: 5px 10px; cursor: pointer; font: inherit;
}
button:disabled { opacity: 0.4; cursor: default; }
button.icon { background: none; border: none; padding: 4px 6px; opacity: 0.6; }
button.icon.on, button.icon:hover:not(:disabled) { opacity: 1; }
button.link { background: none; border: none; padding: 0; text-align: left; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button.stop { background: var(--accent-danger-dim); border-color: var(--accent-danger); }
.muted { color: var(--text-secondary); }
.drawer { padding: 10px; border-bottom: 1px solid var(--border-default); background: var(--bg-surface); max-height: 45%; overflow-y: auto; }
.settings { display: flex; flex-direction: column; gap: 8px; }
.settings label { display: flex; flex-direction: column; gap: 3px; color: var(--text-secondary); flex: 1; }
.settings label.check { flex-direction: row; align-items: center; gap: 6px; }
.settings .row { display: flex; gap: 8px; align-items: flex-end; }
.allowed { display: flex; flex-direction: column; gap: 2px; color: var(--text-secondary); }
.origin { display: flex; align-items: center; justify-content: space-between; color: var(--text-primary); font-family: var(--font-mono, monospace); font-size: 11px; }
.history { display: flex; flex-direction: column; gap: 4px; }
.chat-row { display: flex; align-items: center; gap: 6px; padding: 3px 4px; border-radius: 6px; }
.chat-row.current { background: var(--bg-elevated); }
.chat-row .muted { font-size: 11px; white-space: nowrap; }
input, textarea, select {
  background: var(--bg-deep); color: var(--text-primary); border: 1px solid var(--border-default);
  border-radius: 6px; padding: 6px 8px; font: inherit;
}
.log { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.empty { text-align: center; margin-top: 30px; line-height: 1.6; padding: 0 10px; }
.item { word-break: break-word; line-height: 1.5; }
.item.user { white-space: pre-wrap; align-self: flex-end; background: var(--accent-primary-dim); padding: 6px 10px; border-radius: 10px; max-width: 85%; }
.item.assistant.interim { color: var(--text-secondary); }
.md :deep(p) { margin: 0 0 6px; }
.md :deep(p:last-child) { margin-bottom: 0; }
.md :deep(ul), .md :deep(ol) { margin: 4px 0; padding-left: 20px; }
.md :deep(code) { font-family: var(--font-mono, monospace); background: var(--bg-elevated); padding: 1px 4px; border-radius: 4px; font-size: 12px; }
.md :deep(pre) { background: var(--bg-elevated); padding: 8px; border-radius: 6px; overflow-x: auto; }
.md :deep(pre code) { background: none; padding: 0; }
.md :deep(a) { color: var(--accent-primary); }
.md :deep(blockquote) { margin: 4px 0; padding-left: 8px; border-left: 2px solid var(--border-default); color: var(--text-secondary); }
.md :deep(h3), .md :deep(h4), .md :deep(h5), .md :deep(h6) { margin: 8px 0 4px; }
.caret { color: var(--accent-primary); animation: blink 1s steps(2) infinite; }
@keyframes blink { 50% { opacity: 0; } }
.reasoning { color: var(--text-secondary); font-size: 11px; margin-bottom: 4px; }
.reasoning pre { white-space: pre-wrap; max-height: 160px; overflow-y: auto; margin: 4px 0 0; }
.steps { font-size: 12px; color: var(--text-secondary); border-left: 2px solid var(--border-default); padding-left: 8px; }
.steps > summary { cursor: pointer; }
.steps > .item { margin: 3px 0 0 6px; }
.item.tool { font-family: var(--font-mono, monospace); font-size: 11px; color: var(--text-secondary); }
.item.tool summary { cursor: pointer; }
.item.tool pre { margin: 4px 0 0 14px; white-space: pre-wrap; word-break: break-all; max-height: 160px; overflow-y: auto; }
.item.error { color: var(--accent-danger); white-space: pre-wrap; }
.item.info { color: var(--text-secondary); font-style: italic; }
.ok { color: var(--accent-success); }
.ko { color: var(--accent-danger); }
.pending { color: var(--accent-warning); }
.plan { border-top: 1px solid var(--border-default); background: var(--bg-deep); padding: 4px 10px 6px; max-height: 30%; overflow-y: auto; }
.plan-head { background: none; border: none; padding: 2px 0; font-weight: 600; width: 100%; text-align: left; }
.plan ul { list-style: none; margin: 2px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.plan li.done { color: var(--text-secondary); text-decoration: line-through; }
.plan li.in_progress { color: var(--accent-primary); font-weight: 600; }
footer { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--border-default); }
footer textarea { resize: none; }
.toolbar { display: flex; align-items: center; gap: 6px; }
.modes { display: flex; border: 1px solid var(--border-default); border-radius: 6px; overflow: hidden; }
.mode { border: none; border-radius: 0; background: none; padding: 4px 8px; color: var(--text-secondary); }
.mode.on.ask { background: var(--accent-warning-dim); color: var(--text-primary); }
.mode.on.auto { background: var(--accent-success-dim); color: var(--text-primary); }
.mode.on.plan { background: var(--accent-secondary-dim); color: var(--text-primary); }
.model { flex: 1; min-width: 0; padding: 4px 6px; }
.send { font-weight: 700; }
</style>
