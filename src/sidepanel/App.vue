<script setup lang="ts">
/**
 * Copilot side panel: a Claude-style chat whose agent acts on the browser tabs.
 * The loop runs in the service worker (background/agent); this page renders the
 * conversation, answers the agent's requests, and owns model/mode/tab selection.
 */
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import {
  COPILOT_PORT,
  COPILOT_SETTINGS_KEY,
  DEFAULT_COPILOT_SETTINGS,
  copilotMissing,
  type CopilotField,
  isCopilotConfigured,
  type ChatTurn,
  type CopilotMode,
  type CopilotSettings,
  type PlanStep,
  type UserResponse,
  type WorkerToPanel,
} from '@/types/copilot';
import { renderMarkdown } from './markdown';
import { imageParts, promptWithFiles, readAttachment, transcribe, type Attachment } from './attachments';
import ModelPicker from './ModelPicker.vue';
import { explainError, isControllable, missingText as describeMissing } from './setup';
import OptionsView from './OptionsView.vue';
import RequestCard from './RequestCard.vue';
import {
  chatModels,
  blocksOf,
  chatOfScope,
  currentChatId,
  deleteChat,
  listChats,
  newChat,
  saveChat,
  scopeOf,
  setCurrentChat,
  type Chat,
  type Item,
} from './chats';

interface Target {
  id: number;
  title: string;
  url: string;
  groupId?: number;
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
const target = ref<Target | null>(null);
const pinned = ref(false);
/** Nombre de la pestaña a la que el agente se ha ido en esta conversación (chip de la cabecera). */
const agentTab = ref<string | null>(null);
const panel = ref<'none' | 'history'>('none');
const view = ref<'chat' | 'options'>('chat');
const settings = ref<CopilotSettings>({ ...DEFAULT_COPILOT_SETTINGS });
const models = ref<string[]>([]);
const modelsError = ref('');
const modelsLoading = ref(false);
/** Result of the last model listing, shown under the endpoint in Opciones («Guardar y probar»). */
const check = ref<{ state: 'idle' | 'ok' | 'error'; text: string }>({ state: 'idle', text: '' });
const planOpen = ref(true);
const log = ref<HTMLElement | null>(null);
const textarea = ref<HTMLTextAreaElement | null>(null);
const attachments = ref<Attachment[]>([]);
const attachError = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const recording = ref(false);
const transcribing = ref(false);
let recorder: MediaRecorder | null = null;

let port: chrome.runtime.Port | null = null;
let windowId: number | null = null;

const items = computed(() => chat.value.items);
const plan = computed(() => chat.value.plan);
/** One rule for «what is missing» (types/copilot.ts): chat notice, Opciones summary and amber dot. */
const missing = computed(() => copilotMissing(settings.value));
const needsSetup = computed(() => missing.value.length > 0);
const missingText = computed(() => describeMissing(settings.value));
const controllable = computed(() => !target.value || isControllable(target.value.url));
const blockedReason = computed(() => {
  if (needsSetup.value) return 'Falta configurar el copiloto';
  if (running.value) return 'Esperando al agente';
  if (!controllable.value) return 'Esta pestaña no se puede controlar';
  return '';
});
const keysHelp = 'Enter envía · Shift+Enter salto de línea · Shift+Tab cambia de modo · Esc para · Alt+J abre el panel';
// Sin botón de enviar, el motivo por el que no se puede enviar se lee en el campo (INFRA-881).
const placeholder = computed(() => {
  if (needsSetup.value) return 'Falta configurar el copiloto: abre Opciones';
  if (!controllable.value) return 'Esta pestaña no se puede controlar';
  return running.value ? 'Escribe tu siguiente mensaje' : 'Escribe qué quieres hacer en la pestaña';
});
const planDone = computed(() => plan.value.filter((s) => s.status === 'done').length);
const blocks = computed(() => blocksOf(items.value));

function stepsLabel(steps: Item[]): string {
  const tools = steps.filter((s) => s.kind === 'tool');
  const failed = tools.filter((s) => s.ok === false).length;
  const names = [...new Set(tools.map((s) => s.text.replace(/^browser_/, '')))].slice(0, 4).join(', ');
  const n = tools.length || 1;
  return `${n} ${n === 1 ? 'paso' : 'pasos'}${names ? ` · ${names}` : ''}${failed ? ` · ${failed} con error` : ''}`;
}

function history(): ChatTurn[] {
  return items.value
    .filter((i) => i.kind === 'user' || (i.kind === 'assistant' && !i.interim && i.text))
    .map((i) => ({
      role: i.kind as ChatTurn['role'],
      // Un turno de usuario con imágenes adjuntas viaja con sus partes, como las capturas del agente.
      content:
        i.kind === 'user' && i.images?.length
          ? [
              { type: 'text' as const, text: i.text },
              ...i.images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
            ]
          : i.text,
    }));
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
      void saveSettings();
      break;
    case 'target':
      agentTab.value = event.title;
      break;
    case 'assistant': {
      const s = streamingItem();
      if (s) {
        s.text = event.text || s.text;
        s.streaming = false;
        s.interim = false;
        s.limit = event.limit;
      } else {
        push({ kind: 'assistant', text: event.text || '(sin respuesta)', ...(event.limit ? { limit: true } : {}) });
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

/** `text` sin escribir en el campo: el «Continuar» de un corte por pasos (INFRA-876). */
function send(text?: string) {
  const written = (text ?? input.value).trim();
  if ((!written && !attachments.value.length) || blockedReason.value) return;
  const turns = history();
  const images = imageParts(attachments.value);
  const files = attachments.value.filter((a) => a.kind === 'text').map((a) => a.name);
  const prompt = promptWithFiles(written, attachments.value);
  input.value = '';
  attachments.value = [];
  attachError.value = '';
  agentTab.value = null;
  running.value = true;
  push({ kind: 'user', text: written, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) });
  persist();
  connect().postMessage({
    type: 'prompt',
    history: turns,
    prompt,
    targetTabId: target.value?.id ?? null,
    pinned: pinned.value,
    mode: settings.value.mode,
    model: settings.value.model,
    images,
  });
}

function pickFiles() {
  fileInput.value?.click();
}

async function addFiles(files: File[]) {
  const rejected: string[] = [];
  for (const file of files) {
    const read = await readAttachment(file);
    if ('error' in read) rejected.push(read.error);
    else attachments.value.push(read);
  }
  attachError.value = rejected.join(' · ');
}

async function onFiles(e: Event) {
  const field = e.target as HTMLInputElement;
  const chosen = Array.from(field.files ?? []);
  field.value = '';
  await addFiles(chosen);
}

/** Ctrl+V con una imagen en el portapapeles: entra como adjunto, igual que con el botón +. */
async function onPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.files ?? []);
  if (!files.length) return;
  // Solo imagen en el portapapeles: se traga el pegado (el textarea no pinta nada).
  // Con texto además, el texto entra normal y la imagen se añade como adjunto.
  if (!e.clipboardData?.getData('text')) e.preventDefault();
  await addFiles(files);
}

function removeAttachment(index: number) {
  attachments.value.splice(index, 1);
}

/** Dictado: graba, lo transcribe el Whisper de casa y deja el texto en el campo, editable antes de enviar. */
async function toggleMic() {
  if (recorder) {
    recorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      recorder = null;
      recording.value = false;
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      if (!blob.size) return;
      transcribing.value = true;
      try {
        const said = await transcribe(blob, settings.value);
        input.value = input.value.trim() ? `${input.value.trim()} ${said}` : said;
        await nextTick();
        textarea.value?.focus();
      } catch (error) {
        attachError.value = (error as Error).message;
      } finally {
        transcribing.value = false;
      }
    };
    rec.start();
    recorder = rec;
    recording.value = true;
    attachError.value = '';
  } catch (error) {
    attachError.value = `No pude grabar (${(error as Error).name}): el panel necesita permiso de micrófono.`;
  }
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
  void saveSettings();
}

function onModeSelect(e: Event) {
  setMode((e.target as HTMLSelectElement).value as CopilotMode);
}

/** Lo que hace el modo elegido; el chip lo dice en el tooltip (antes ocupaba media pantalla). */
const modeHint = computed(() => MODES.find((m) => m.id === settings.value.mode)?.hint ?? '');

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
  chat.value = { ...newChat(), scope: target.value ? scopeOf(target.value) : undefined };
  await setCurrentChat(chat.value.id);
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
  void setCurrentChat(c.id);
  panel.value = 'none';
  void scroll();
}

const undoable = ref<Chat | null>(null);

async function undoRemove() {
  if (!undoable.value) return;
  await saveChat(undoable.value);
  chats.value = await listChats();
  undoable.value = null;
}

async function removeChat(c: Chat) {
  undoable.value = JSON.parse(JSON.stringify(c)) as Chat;
  await deleteChat(c.id);
  chats.value = await listChats();
  if (c.id === chat.value.id) {
    chat.value = { ...newChat(), scope: target.value ? scopeOf(target.value) : undefined };
    await setCurrentChat(chat.value.id);
  }
}

async function saveSettings(next?: CopilotSettings) {
  if (next) settings.value = next;
  if (!isCopilotConfigured(settings.value)) return;
  await chrome.storage.local.set({ [COPILOT_SETTINGS_KEY]: { ...settings.value } });
  if (next) void loadModels();
}

async function loadModels() {
  modelsError.value = '';
  check.value = { state: 'idle', text: '' };
  if (!isCopilotConfigured(settings.value)) return;
  modelsLoading.value = true;
  try {
    const base = settings.value.baseUrl.trim().replace(/\/+$/, '');
    const res = await fetch(`${base}/models`, {
      headers: settings.value.apiKey ? { Authorization: `Bearer ${settings.value.apiKey}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { data?: { id: string }[] };
    models.value = chatModels((data.data ?? []).map((m) => m.id));
    check.value = { state: 'ok', text: `Conecta: ${models.value.length} modelos de chat disponibles.` };
  } catch (error) {
    const msg = (error as Error).message;
    modelsError.value = /HTTP 40[13]/.test(msg) ? 'La key no vale.' : `No pude listar modelos: ${msg}.`;
    check.value = { state: 'error', text: /HTTP 40[13]/.test(msg) ? 'El endpoint responde pero la API key no vale.' : `No llego al endpoint (${msg}).` };
  } finally {
    modelsLoading.value = false;
  }
}

function onModelChange() {
  void saveSettings();
}

const focusField = ref<CopilotField | null>(null);

/** «Abrir Opciones»: lands on the first missing field (Opciones scrolls to it and focuses it). */
function openOptions() {
  panel.value = 'none';
  focusField.value = missing.value[0] ?? null;
  view.value = 'options';
}

/**
 * The panel belongs to the tab that opened it (INFRA-875): it is never re-pointed at whichever tab
 * you happen to click on. Chrome hides this instance when you leave the tab and shows it again when
 * you come back, so the target is decided once, here.
 */
async function bindOwnTab() {
  if (windowId === null) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  target.value = tab?.id ? { id: tab.id, title: tab.title || '', url: tab.url || '', groupId: tab.groupId } : null;
  await followScope();
}

/** La chincheta: congelar la pestaña. Se comunica al service worker porque es él quien ejecuta las herramientas. */
function togglePin() {
  pinned.value = !pinned.value;
  connect().postMessage({ type: 'pin', pinned: pinned.value });
}

/** One conversation per tab (or per tab group): follow the target's scope when it changes. */
async function followScope() {
  if (running.value || !target.value) return;
  const scope = scopeOf(target.value);
  if (!scope || chat.value.scope === scope) return;
  const saved = await chatOfScope(scope);
  chat.value = saved ? (JSON.parse(JSON.stringify(saved)) as Chat) : { ...newChat(), scope };
  for (const i of chat.value.items) {
    if (i.kind === 'request' && !i.answered) i.answered = 'cancelled';
    i.streaming = false;
  }
  void scroll();
}

const onUpdated = (tabId: number, _change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
  if (target.value?.id === tabId) {
    target.value = { id: tabId, title: tab.title || '', url: tab.url || '', groupId: tab.groupId };
    void followScope();
  }
};

// The service worker may seed the settings (provision.ts) after the panel is open.
const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
  const next = changes[COPILOT_SETTINGS_KEY]?.newValue as Partial<CopilotSettings> | undefined;
  if (area === 'local' && next) settings.value = { ...DEFAULT_COPILOT_SETTINGS, ...next };
};

onMounted(async () => {
  windowId = (await chrome.windows.getCurrent()).id ?? null;
  const stored = await chrome.storage.local.get(COPILOT_SETTINGS_KEY);
  settings.value = { ...DEFAULT_COPILOT_SETTINGS, ...(stored[COPILOT_SETTINGS_KEY] as Partial<CopilotSettings>) };
  const id = await currentChatId();
  const last = id ? (await listChats()).find((c) => c.id === id) : undefined;
  if (last) {
    chat.value = last;
    for (const i of chat.value.items) {
      if (i.kind === 'request' && !i.answered) i.answered = 'cancelled';
      i.streaming = false;
    }
  }
  await bindOwnTab();
  void loadModels();
  void scroll();
  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.storage.onChanged.addListener(onStorage);
});

onUnmounted(() => {
  chrome.tabs.onUpdated.removeListener(onUpdated);
  chrome.storage.onChanged.removeListener(onStorage);
  port?.disconnect();
});

function when(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const statusIcon: Record<PlanStep['status'], string> = { pending: '○', in_progress: '◐', done: '●' };
</script>

<template>
  <div class="panel">
    <OptionsView v-if="view === 'options'" class="grow" :settings="settings" :focus-field="focusField" :check="check"
      @back="view = 'chat'" @save="saveSettings" />
    <template v-else>
    <header>
      <div class="top">
        <button type="button" class="quiet" :disabled="running" :title="running ? 'Espera a que termine la respuesta' : 'Empezar una conversación nueva'"
          @click="startNewChat">Nueva</button>
        <button type="button" class="quiet" :class="{ on: panel === 'history' }" title="Conversaciones guardadas" @click="openHistory">Historial</button>
        <button type="button" class="quiet" :class="{ on: view === 'options', warn: needsSetup }"
          :title="needsSetup ? 'Falta configuración' : 'Conexión MCP y ajustes del copiloto'"
          @click="view === 'options' ? (view = 'chat') : openOptions()">Opciones<span v-if="needsSetup" class="warn-dot" aria-label="falta configuración" /></button>
        <!-- Chincheta: arriba a la derecha; lo único que hace es no dejar que el agente se mueva de esta pestaña. -->
        <button type="button" class="pin" :class="{ on: pinned }" :aria-pressed="pinned" :disabled="!target"
          :title="pinned ? 'Quitar la chincheta: dejar que el agente cambie de pestaña' : 'Chincheta: que el agente no se mueva de esta pestaña'"
          @click="togglePin">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="currentColor">
            <path d="M5.6 1.6h4.8l-.9 4.6 2.2 1.7v1.3H4.3V7.9l2.2-1.7z" />
            <path d="M7.3 9.9h1.4l.4 4.5H6.9z" />
          </svg>
        </button>
      </div>
      <!-- Solo cuando el agente se ha ido a otra pestaña: su nombre, no la URL (la línea de la URL
           repetía la pestaña a la que está pegado el panel). -->
      <div v-if="agentTab" class="using">
        <span class="chip">{{ agentTab }}</span>
      </div>
    </header>

    <div v-if="panel === 'history'" class="drawer history">
      <p v-if="undoable" class="muted">Conversación borrada. <button type="button" class="link" @click="undoRemove">Deshacer</button></p>
      <p v-if="!chats.length" class="muted">No hay conversaciones guardadas.</p>
      <div v-for="c in chats" :key="c.id" class="chat-row" :class="{ current: c.id === chat.id }">
        <button class="link title" @click="openChat(c)">{{ c.title }}</button>
        <span class="muted">{{ when(c.updatedAt) }}</span>
        <button class="link del" :aria-label="`Borrar ${c.title}`" @click="removeChat(c)">Borrar</button>
      </div>
    </div>

    <main ref="log" class="log">
      <template v-for="(block, b) in blocks" :key="block.key">
        <details v-if="'steps' in block" class="steps" :open="running && b === blocks.length - 1">
          <summary>{{ stepsLabel(block.steps) }}</summary>
          <template v-for="(item, j) in block.steps" :key="j">
            <details v-if="item.kind === 'tool'" class="item tool">
              <summary><span :class="item.ok === undefined ? 'pending' : item.ok ? 'ok' : 'ko'">●</span> {{ item.text }}</summary>
              <pre>{{ item.detail }}</pre>
            </details>
            <div v-else class="item assistant interim">
              <details v-if="item.reasoning" class="reasoning">
                <summary>razonamiento</summary>
                <pre>{{ item.reasoning }}</pre>
              </details>
              <div v-if="item.text" class="md" v-html="renderMarkdown(item.text)" />
            </div>
          </template>
        </details>
        <template v-else>
          <div v-if="block.item.kind === 'user'" class="item user">
            <span v-if="block.item.text">{{ block.item.text }}</span>
            <span v-if="block.item.files?.length" class="files-line">{{ block.item.files.join(' · ') }}</span>
            <span v-if="block.item.images?.length" class="thumbs">
              <img v-for="(src, t) in block.item.images" :key="t" :src="src" alt="imagen adjunta">
            </span>
          </div>
          <div v-else-if="block.item.kind === 'assistant'" class="item assistant" :class="{ interim: block.item.interim }">
            <details v-if="block.item.reasoning" class="reasoning">
              <summary>razonamiento</summary>
              <pre>{{ block.item.reasoning }}</pre>
            </details>
            <template v-if="block.item.limit">
              <p class="limit">Sin respuesta cerrada: se acabaron los {{ settings.maxSteps }} pasos.</p>
              <button type="button" class="link" :disabled="running" title="Darle otra ronda de pasos a esta conversación"
                @click="send('Continúa donde lo dejaste.')">Continuar</button>
            </template>
            <template v-else>
              <div class="md" v-html="renderMarkdown(block.item.text)" /><span v-if="block.item.streaming" class="caret">▍</span>
            </template>
          </div>
          <RequestCard v-else-if="block.item.kind === 'request' && block.item.request" :request="block.item.request"
            :answered="block.item.answered" @respond="(r, label) => respond(block.item, r, label)" />
          <div v-else-if="block.item.kind === 'error' && explainError(block.item.text)" class="notice err" role="alert">
            <strong>{{ explainError(block.item.text)!.title }}</strong>
            <span>{{ explainError(block.item.text)!.why }}</span>
            <button v-if="explainError(block.item.text)!.action === 'options'" type="button" @click="openOptions">Abrir Opciones</button>
            <details><summary>Detalle técnico</summary><pre>{{ block.item.text }}</pre></details>
          </div>
          <div v-else class="item" :class="block.item.kind">{{ block.item.text }}</div>
        </template>
      </template>
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
      <div v-if="needsSetup" class="notice" role="alert">
        <strong>Falta configurar el copiloto</strong>
        <span>{{ missingText }} Mientras tanto puedes ir escribiendo, pero no se envía.</span>
        <button type="button" @click="openOptions">Abrir Opciones</button>
      </div>
      <div v-else-if="!controllable" class="notice" role="status">
        <strong>Esta pestaña no se puede controlar</strong>
        <span>El agente no puede actuar en páginas del navegador ni de extensiones. Abre una página web y elígela como objetivo.</span>
      </div>
      <div class="composer" :title="keysHelp">
        <div v-if="attachments.length" class="files">
          <span v-for="(a, i) in attachments" :key="i" class="file">
            <img v-if="a.kind === 'image'" :src="a.data" :alt="a.name">
            <span v-else class="kind" aria-hidden="true">≡</span>
            <span class="name" :title="a.name">{{ a.name }}</span>
            <button type="button" :aria-label="`Quitar ${a.name}`" @click="removeAttachment(i)">×</button>
          </span>
        </div>
        <p v-if="attachError" class="attach-err" role="alert">{{ attachError }}</p>
        <input ref="fileInput" type="file" multiple hidden @change="onFiles">
        <textarea ref="textarea" v-model="input" rows="3" aria-label="Mensaje para el copiloto"
          :placeholder="placeholder" @keydown="onKey" @paste="onPaste" />
        <div v-if="transcribing" class="waiting" role="status">Transcribiendo el audio…</div>
        <div v-else-if="running" class="waiting" role="status">Esperando al agente… (Esc para parar)</div>
        <!-- Sin botón de enviar: Enter envía (como en Claude). Los controles son texto e iconos planos. -->
        <div class="bar">
          <button type="button" class="icon" aria-label="Adjuntar imágenes o ficheros" title="Adjuntar imágenes o ficheros de texto"
            @click="pickFiles">+</button>
          <label class="mode" :title="modeHint">
            <select :value="settings.mode" aria-label="Modo del agente" @change="onModeSelect">
              <option v-for="m in MODES" :key="m.id" :value="m.id">{{ m.label }}</option>
            </select>
            <span aria-hidden="true">▾</span>
          </label>
          <div class="right">
            <ModelPicker v-model="settings.model" :models="models" :loading="modelsLoading" :error="modelsError"
              @update:model-value="onModelChange" @options="openOptions" />
            <button type="button" class="icon mic" :class="{ on: recording }" :disabled="transcribing"
              :aria-label="recording ? 'Parar de grabar' : 'Dictar por micrófono'"
              :title="recording ? 'Parar de grabar' : 'Dictar: se transcribe y lo puedes editar antes de enviar'"
              @click="toggleMic">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
              </svg>
            </button>
            <button v-if="running" type="button" class="quiet" title="Parar la respuesta (Esc)" @click="stop">Parar</button>
          </div>
        </div>
      </div>
    </footer>
    </template>
  </div>
</template>

<style>
html, body { margin: 0; height: 100%; }
html body {
  background: var(--bg-deepest);
  color: var(--text-primary);
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 14px;
}
#app { height: 100%; }
</style>

<style scoped>
.panel { display: flex; flex-direction: column; height: 100%; }
.grow { flex: 1; overflow-y: auto; }
header {
  display: flex; flex-direction: column; gap: 12px; padding: 14px 18px 12px;
  border-bottom: 1px solid var(--border-default); background: var(--bg-deep);
}
.top { display: flex; align-items: center; gap: 18px; }
/* Los tres accesos son texto discreto, no tres pastillas: la cabecera no compite con la conversación. */
.quiet { border: none; background: none; padding: 0; color: var(--text-secondary); font-size: 12px; font-weight: 600; }
.quiet.on { color: var(--text-primary); }
.quiet.warn { color: var(--accent-warning); }
/* La pestaña a la que el agente se ha ido, marcada como la ficha de Claude: nombre en pastilla. */
.using { display: flex; min-width: 0; }
.chip { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: var(--accent-primary-dim); border: 1px solid var(--accent-primary); color: var(--text-primary); border-radius: 999px; padding: 2px 10px; font-size: 12px; }
button.pin { margin-left: auto; flex-shrink: 0; line-height: 0; min-height: 0; padding: 2px 4px; border: none; background: none; color: var(--text-secondary); }
button.pin.on { color: var(--accent-warning); }
.warn-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--accent-warning); margin-left: 6px; }
button.link.del { flex: none; color: var(--accent-danger); }
button.link { text-align: left; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 0; }
button.link.title { color: var(--text-primary); }
.muted { color: var(--text-secondary); }
.drawer { padding: 12px 18px; border-bottom: 1px solid var(--border-default); background: var(--bg-surface); max-height: 45%; overflow-y: auto; }
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
.log { flex: 1; overflow-y: auto; padding: 22px max(22px, calc((100% - 640px) / 2)); display: flex; flex-direction: column; gap: 18px; }
.item { word-break: break-word; line-height: 1.7; }
.item.user { white-space: pre-wrap; align-self: flex-end; background: var(--clay-soft); border: 1px solid var(--border-default); padding: 10px 16px; border-radius: var(--radius-lg); max-width: 85%; }
.item.assistant.interim { color: var(--text-secondary); }
/* Corte por pasos (INFRA-876): se cambia el texto interno del bucle por una línea y un botón. */
.limit { margin: 0 0 10px; color: var(--text-secondary); }
.md :deep(p) { margin: 0 0 10px; }
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
.item.tool pre { margin: 4px 0 0 14px; white-space: pre-wrap; word-break: break-all; max-height: 160px; overflow-y: auto; background: var(--bg-surface); padding: 6px; border-radius: var(--radius-sm); }
.item.error { color: var(--accent-danger); white-space: pre-wrap; }
.item.info { color: var(--text-secondary); font-style: italic; }
.ok { color: var(--accent-success); }
.ko { color: var(--accent-danger); }
.pending { color: var(--accent-warning); }
.plan { border-top: 1px solid var(--border-default); background: var(--bg-deep); padding: 8px 18px 10px; max-height: 30%; overflow-y: auto; }
.plan-head { background: none; border: none; padding: 2px 0; font-weight: 600; width: 100%; text-align: left; font-family: var(--font-serif); font-size: 15px; }
.plan ul { list-style: none; margin: 2px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.plan li.done { color: var(--text-secondary); text-decoration: line-through; }
.plan li.in_progress { color: var(--accent-primary); font-weight: 600; }
/* Sin línea sobre el campo: partía el panel en dos y no aportaba nada (INFRA-883). */
footer { display: flex; flex-direction: column; gap: 10px; padding: 12px 18px 18px; }
.notice { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 10px 12px; border-left: 3px solid var(--accent-warning); background: var(--bg-surface); border-radius: var(--radius-sm); }
.notice span { color: var(--text-secondary); }
.notice.err { margin: 0; border-left-color: var(--accent-danger); }
.notice pre { white-space: pre-wrap; word-break: break-all; margin: 4px 0 0; font-size: 11px; }
.notice summary { cursor: pointer; color: var(--text-secondary); font-size: 11px; }
.waiting { padding: 2px 4px; color: var(--text-secondary); font-size: 12px; }
.right { display: flex; align-items: center; gap: 14px; margin-left: auto; min-width: 0; }
.composer { display: flex; flex-direction: column; border: 1px solid var(--border-default); border-radius: var(--radius-lg); background: var(--bg-deep); padding: 10px; gap: 8px; box-shadow: var(--shadow-pop); }
.composer:focus-within { border-color: var(--accent-primary); }
.composer textarea { resize: none; border: none; background: none; outline: none; padding: 8px 6px; }
.bar { display: flex; align-items: center; gap: 14px; min-width: 0; flex-wrap: nowrap; }
.bar > :first-child { min-width: 0; }
/* Pie plano (INFRA-881): sin bordes ni rellenos; el modo es un desplegable de texto, como en Claude. */
.mode { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; color: var(--text-secondary); font-size: 12px; font-weight: 600; }
.mode select { appearance: none; field-sizing: content; min-height: 0; border: none; background: none; padding: 0; font: inherit; color: var(--text-primary); cursor: pointer; }
/* Adjuntos (INFRA-857): «+» y micro como iconos, y los elegidos en chips encima del campo. */
.icon { display: inline-flex; align-items: center; min-height: 24px; padding: 0; border: none; background: none; line-height: 1; font-size: 16px; color: var(--text-secondary); flex-shrink: 0; }
.icon.mic.on { color: var(--accent-primary); }
.files { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 4px 0; }
.file { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 3px 6px; border: 1px solid var(--border-default); border-radius: var(--radius-pill); background: var(--bg-surface); font-size: 12px; }
.file img { width: 22px; height: 22px; object-fit: cover; border-radius: 4px; }
.file .kind { color: var(--text-secondary); }
.file .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
.file button { border: none; background: none; padding: 0 2px; color: var(--text-secondary); font-size: 14px; line-height: 1; }
.attach-err { margin: 4px 4px 0; color: var(--accent-danger); font-size: 12px; }
.files-line { display: block; margin-top: 6px; color: var(--text-secondary); font-size: 12px; }
.thumbs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.thumbs img { max-width: 120px; max-height: 120px; border-radius: var(--radius-sm); border: 1px solid var(--border-default); }
</style>
