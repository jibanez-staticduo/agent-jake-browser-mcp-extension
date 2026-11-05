<script setup lang="ts">
/**
 * «Opciones»: the one place for everything the old toolbar popup did (MCP connection, tab
 * connection, activity, new-version notice) plus the copilot settings. The popup components
 * and stores are imported from src/popup, not copied.
 *
 * The copilot comes first: «Abrir Opciones» from the chat lands on the field that is missing,
 * visible and focused, and the MCP status below cannot cover the reason.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  COPILOT_ALLOWED_ORIGINS_KEY,
  copilotMissing,
  type CopilotField,
  type CopilotSettings,
} from '@/types/copilot';
import { LAST_AUTO_KEY, UPDATE_STATE_KEY, type UpdateState } from '@/background/update-check';
import type { LastAuto, SelfUpdateResult } from '@/background/self-update';
import { NOT_RELOADED_TEXT, RELOAD_TIMEOUT_MS, RELOAD_WARNING, UPDATING_TEXT, isReloading, lastAutoLine, manualResultText } from './self-update-text';
import { useActivityStore, useServerStore, useStatusStore } from '../popup/stores';
import ActivityLog from '../popup/components/ActivityLog.vue';
import ActivityModal from '../popup/components/ActivityModal.vue';
import ConnectionStatus from '../popup/components/ConnectionStatus.vue';
import ServerSettings from '../popup/components/ServerSettings.vue';
import TabSelector from '../popup/components/TabSelector.vue';
import { FIELD_IDS } from './setup';

const props = defineProps<{
  settings: CopilotSettings;
  focusField: CopilotField | null;
  check: { state: 'idle' | 'ok' | 'error'; text: string };
}>();
const emit = defineEmits<{ back: []; save: [settings: CopilotSettings] }>();

const status = useStatusStore();
const server = useServerStore();
const activity = useActivityStore();

const draft = ref<CopilotSettings>({ ...props.settings });
const allowed = ref<string[]>([]);
const update = ref<UpdateState | null>(null);
const lastAuto = ref<LastAuto | null>(null);
const updating = ref(false);
const updateNote = ref('');
// Only for the build the banner offers now: a skipped run of an older build is a stale excuse.
const lastAutoSkip = computed(() => lastAutoLine(lastAuto.value, update.value?.latest?.build));
let reloadTimer: ReturnType<typeof setTimeout> | undefined;

// A note belongs to the build that was offered when it was written: when a DIFFERENT build appears, the old one («No se puede
// actualizar sola…») must not come back unasked, so it is cleared. The banner going away is NOT a reason to clear: that is what
// the click's own fresh check does when nothing newer exists, and its answer («Ya tienes la última versión») must stay visible
// whatever the order of the storage event and the message response. A click in flight keeps its note too.
watch(() => update.value?.latest?.build, (now, before) => {
  if (now !== undefined && now !== before && !updating.value) updateNote.value = '';
});

/** «Actualizar ahora»: the background re-checks and self-updates with the idle rule skipped; the extension reloads on `applied`. */
async function updateNow() {
  clearTimeout(reloadTimer);
  updating.value = true;
  updateNote.value = UPDATING_TEXT;
  try {
    const r = await chrome.runtime.sendMessage({ action: 'selfUpdateNow' }) as SelfUpdateResult | { success: false; error: string } | undefined;
    if (!r || 'error' in r || !('status' in r)) updateNote.value = `La actualización falló: ${r && 'error' in r ? r.error : 'sin respuesta'}`;
    else {
      updateNote.value = manualResultText(r);
      if (isReloading(r)) {
        // `applied`: stays disabled, the reload is 300 ms away. If this panel is still here after RELOAD_TIMEOUT_MS it never happened.
        reloadTimer = setTimeout(() => { updating.value = false; updateNote.value = NOT_RELOADED_TEXT; }, RELOAD_TIMEOUT_MS);
        return;
      }
    }
  } catch (e) {
    updateNote.value = `La actualización falló: ${(e as Error).message}`;
  }
  updating.value = false;
}

// The same rule as the chat (copilotMissing), applied to what is typed.
const missing = computed(() => copilotMissing(draft.value));
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(props.settings));
const FIELD_LABEL: Record<CopilotField, string> = { baseUrl: 'Endpoint', apiKey: 'API key', model: 'Modelo' };
const FIELD_WHY: Record<CopilotField, string> = {
  baseUrl: 'Escribe la URL del endpoint (https, o localhost).',
  apiKey: 'Pega la API key del endpoint.',
  model: 'Indica el id del modelo.',
};
const state = computed(() => {
  if (missing.value.length) return `Falta: ${missing.value.map((f) => FIELD_LABEL[f]).join(', ')}`;
  if (dirty.value) return 'Cambios sin guardar';
  return props.check.state === 'idle' ? 'Guardado' : `Guardado · ${props.check.text}`;
});

function goTo(field: CopilotField) {
  const el = document.getElementById(FIELD_IDS[field]) as HTMLInputElement | null;
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.focus({ preventScroll: true });
}

// New published build (background/update-check.ts writes it; cleared once up to date).
const onStorage = (changes: Record<string, chrome.storage.StorageChange>) => {
  if (UPDATE_STATE_KEY in changes) update.value = (changes[UPDATE_STATE_KEY].newValue as UpdateState | undefined) ?? null;
  if (LAST_AUTO_KEY in changes) lastAuto.value = (changes[LAST_AUTO_KEY].newValue as LastAuto | undefined) ?? null;
  if (COPILOT_ALLOWED_ORIGINS_KEY in changes) allowed.value = (changes[COPILOT_ALLOWED_ORIGINS_KEY].newValue as string[] | undefined) ?? [];
};

async function forgetOrigin(origin: string) {
  allowed.value = allowed.value.filter((o) => o !== origin);
  await chrome.storage.local.set({ [COPILOT_ALLOWED_ORIGINS_KEY]: allowed.value });
}

onMounted(async () => {
  const stored = await chrome.storage.local.get([UPDATE_STATE_KEY, LAST_AUTO_KEY, COPILOT_ALLOWED_ORIGINS_KEY]);
  update.value = (stored[UPDATE_STATE_KEY] as UpdateState | undefined) ?? null;
  lastAuto.value = (stored[LAST_AUTO_KEY] as LastAuto | undefined) ?? null;
  const origins = stored[COPILOT_ALLOWED_ORIGINS_KEY];
  allowed.value = Array.isArray(origins) ? origins as string[] : [];
  chrome.storage.onChanged.addListener(onStorage);
  status.startPolling();
  server.startPolling();
  activity.startPolling();
  if (props.focusField) {
    await nextTick();
    goTo(props.focusField);
    // The MCP components above/below paint later and can move the layout: land once more.
    setTimeout(() => goTo(props.focusField!), 250);
  }
});

onUnmounted(() => {
  clearTimeout(reloadTimer);
  chrome.storage.onChanged.removeListener(onStorage);
  status.stopPolling();
  server.stopPolling();
  activity.stopPolling();
});
</script>

<template>
  <div class="options">
    <div class="topbar">
      <button type="button" class="link" @click="emit('back')">← Volver a la conversación</button>
    </div>

    <div v-if="update?.available" class="update-banner">
      Versión nueva <strong>{{ update.latest?.version }}</strong> publicada · tienes la {{ update.current.version }}
      <a v-if="update.downloadUrl" :href="update.downloadUrl" target="_blank">Descargar</a>
      <button type="button" class="primary now" :disabled="updating" :title="RELOAD_WARNING" @click="updateNow">Actualizar ahora</button>
      <div class="note">{{ RELOAD_WARNING }}</div>
      <div v-if="updateNote" class="note" role="status">{{ updateNote }}</div>
      <div v-if="lastAutoSkip" class="note">{{ lastAutoSkip }}</div>
    </div>
    <!-- The click's own fresh check removes the banner when nothing newer exists: the answer stays here. -->
    <div v-else-if="updateNote" class="update-banner idle" role="status">{{ updateNote }}</div>

    <section class="summary" :class="{ bad: missing.length }" role="status">
      <template v-if="missing.length">
        <strong>Falta configurar el copiloto</strong>
        <div class="goto">
          <button v-for="f in missing" :key="f" type="button" class="link" @click="goTo(f)">{{ FIELD_LABEL[f] }} ↓ ir</button>
        </div>
      </template>
      <strong v-else>El copiloto está listo</strong>
    </section>

    <h2>Copiloto</h2>
    <form class="copilot" @submit.prevent="emit('save', { ...draft })">
      <label>Endpoint (OpenAI-compatible)
        <input :id="FIELD_IDS.baseUrl" v-model="draft.baseUrl" :class="{ bad: missing.includes('baseUrl') }" placeholder="https://…/v1"
          spellcheck="false" :aria-invalid="missing.includes('baseUrl')">
        <span v-if="missing.includes('baseUrl')" class="why">{{ FIELD_WHY.baseUrl }}</span>
      </label>
      <label>API key
        <input :id="FIELD_IDS.apiKey" v-model="draft.apiKey" type="password" autocomplete="off" :class="{ bad: missing.includes('apiKey') }"
          :aria-invalid="missing.includes('apiKey')">
        <span v-if="missing.includes('apiKey')" class="why">{{ FIELD_WHY.apiKey }}</span>
      </label>
      <label>Modelo (id del alias)
        <input :id="FIELD_IDS.model" v-model="draft.model" :class="{ bad: missing.includes('model') }" spellcheck="false">
        <span v-if="missing.includes('model')" class="why">{{ FIELD_WHY.model }}</span>
      </label>
      <div class="row">
        <label>Pasos máx.<input v-model.number="draft.maxSteps" type="number" min="1" max="100"></label>
        <label class="check"><input v-model="draft.vision" type="checkbox"> Visión (capturas al modelo)</label>
      </div>
      <label>Vista de pasos
        <select v-model="draft.stepsView">
          <option value="compact">Compacta — un bloque por turno</option>
          <option value="extended">Extendida — cada paso a la vista</option>
        </select>
      </label>
      <!-- INFRA-909: la capacidad nueva vive en el servidor; aquí solo se le dice cuál es. -->
      <label>MCP del servidor (plugins)
        <input v-model="draft.mcpUrl" type="url" spellcheck="false"
          placeholder="http://127.0.0.1:8790/browser · vacío: sin plugins">
        <span class="why">Lo que ese servidor anuncie en tools/list entra como herramienta del copiloto (solo en modo Auto). Las que el panel ya ejecuta se ignoran por nombre; las demás actúan sobre los navegadores del servidor, no sobre esta pestaña.</span>
      </label>
      <div v-if="allowed.length" class="allowed">
        <span>Sitios con permiso permanente (modo Preguntar):</span>
        <div v-for="o in allowed" :key="o" class="origin">
          {{ o }} <button type="button" class="link" :aria-label="`Olvidar ${o}`" @click="forgetOrigin(o)">Olvidar</button>
        </div>
      </div>
      <div class="savebar">
        <span class="state" :class="{ err: missing.length || check.state === 'error' }">{{ state }}</span>
        <button type="submit" class="primary" :disabled="missing.length > 0">Guardar copiloto</button>
      </div>
    </form>

    <h2>Conexión MCP (sesiones del agente)</h2>
    <p class="help">Es la conexión de este navegador con el servidor MCP. Es independiente del copiloto de este panel.</p>
    <ConnectionStatus />
    <ServerSettings />
    <div class="block"><TabSelector /></div>
    <ActivityLog />
    <ActivityModal />
  </div>
</template>

<style scoped>
.options { padding: 12px; background: var(--bg-deep); min-height: 100%; box-sizing: border-box; }
.topbar { margin-bottom: 6px; }
.topbar .link { padding-left: 0; }
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--accent-primary); font-family: var(--font-mono, monospace); margin: 16px 0 8px; }
.help { margin: 0 0 8px; color: var(--text-secondary); font-size: 12px; }
.block { margin: 12px 0; }
.summary { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-left: 3px solid var(--accent-success); background: var(--bg-surface); border-radius: var(--radius-sm); }
.summary.bad { border-left-color: var(--accent-warning); }
.goto { display: flex; flex-wrap: wrap; gap: 4px; }
.update-banner { margin-bottom: 12px; padding: 10px 12px; border-radius: var(--radius-lg); border: 1px solid var(--accent-primary); font-size: 12px; }
.update-banner a { margin-left: 6px; color: var(--accent-primary); }
.update-banner .now { margin-left: 6px; }
.update-banner .note { margin-top: 4px; color: var(--text-secondary); }
.update-banner.idle { border-color: var(--text-secondary); color: var(--text-secondary); }
.copilot { display: flex; flex-direction: column; gap: 8px; }
.copilot label { display: flex; flex-direction: column; gap: 3px; color: var(--text-secondary); flex: 1; }
.copilot label.check { flex-direction: row; align-items: center; gap: 6px; }
.copilot input.bad { border-color: var(--accent-danger); }
.why { color: var(--accent-danger); font-size: 12px; }
.row { display: flex; gap: 8px; align-items: flex-end; }
.allowed { display: flex; flex-direction: column; gap: 2px; color: var(--text-secondary); }
.origin { display: flex; align-items: center; justify-content: space-between; color: var(--text-primary); font-family: var(--font-mono, monospace); font-size: 11px; }
.savebar { position: sticky; bottom: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 0; background: var(--bg-deep); border-top: 1px solid var(--border-default); }
.state { color: var(--text-secondary); font-size: 12px; }
.state.err { color: var(--accent-danger); }
</style>
