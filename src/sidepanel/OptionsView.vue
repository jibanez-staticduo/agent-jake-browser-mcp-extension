<script setup lang="ts">
/**
 * «Opciones»: the one place for everything the old toolbar popup did (MCP connection, tab
 * connection, activity, new-version notice) plus the copilot settings. The popup components
 * and stores are imported from src/popup, not copied.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  COPILOT_ALLOWED_ORIGINS_KEY,
  isCopilotConfigured,
  type CopilotSettings,
} from '@/types/copilot';
import { UPDATE_STATE_KEY, type UpdateState } from '@/background/update-check';
import { useActivityStore, useServerStore, useStatusStore } from '../popup/stores';
import ActivityLog from '../popup/components/ActivityLog.vue';
import ActivityModal from '../popup/components/ActivityModal.vue';
import ConnectionStatus from '../popup/components/ConnectionStatus.vue';
import ServerSettings from '../popup/components/ServerSettings.vue';
import TabSelector from '../popup/components/TabSelector.vue';

const props = defineProps<{ settings: CopilotSettings }>();
const emit = defineEmits<{ back: []; save: [settings: CopilotSettings] }>();

const status = useStatusStore();
const server = useServerStore();
const activity = useActivityStore();

const draft = ref<CopilotSettings>({ ...props.settings });
const allowed = ref<string[]>([]);
const update = ref<UpdateState | null>(null);
const endpointInput = ref<HTMLInputElement | null>(null);

const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(props.settings));
const ready = () => isCopilotConfigured(draft.value) && !!draft.value.apiKey.trim();

// New published build (background/update-check.ts writes it; cleared once up to date).
const onStorage = (changes: Record<string, chrome.storage.StorageChange>) => {
  if (UPDATE_STATE_KEY in changes) update.value = (changes[UPDATE_STATE_KEY].newValue as UpdateState | undefined) ?? null;
  if (COPILOT_ALLOWED_ORIGINS_KEY in changes) allowed.value = (changes[COPILOT_ALLOWED_ORIGINS_KEY].newValue as string[] | undefined) ?? [];
};

async function forgetOrigin(origin: string) {
  allowed.value = allowed.value.filter((o) => o !== origin);
  await chrome.storage.local.set({ [COPILOT_ALLOWED_ORIGINS_KEY]: allowed.value });
}

onMounted(async () => {
  const stored = await chrome.storage.local.get([UPDATE_STATE_KEY, COPILOT_ALLOWED_ORIGINS_KEY]);
  update.value = (stored[UPDATE_STATE_KEY] as UpdateState | undefined) ?? null;
  const origins = stored[COPILOT_ALLOWED_ORIGINS_KEY];
  allowed.value = Array.isArray(origins) ? origins as string[] : [];
  chrome.storage.onChanged.addListener(onStorage);
  status.startPolling();
  server.startPolling();
  activity.startPolling();
  if (!isCopilotConfigured(draft.value)) endpointInput.value?.focus();
});

onUnmounted(() => {
  chrome.storage.onChanged.removeListener(onStorage);
  status.stopPolling();
  server.stopPolling();
  activity.stopPolling();
});
</script>

<template>
  <div class="options">
    <div class="topbar">
      <button type="button" class="back" @click="emit('back')">← Volver a la conversación</button>
    </div>

    <div v-if="update?.available" class="update-banner">
      Versión nueva <strong>{{ update.latest?.version }}</strong> publicada · tienes la {{ update.current.version }}
      <a v-if="update.downloadUrl" :href="update.downloadUrl" target="_blank">Descargar</a>
    </div>

    <h2>Conexión MCP</h2>
    <ConnectionStatus />
    <ServerSettings />
    <div class="block"><TabSelector /></div>
    <ActivityLog />
    <ActivityModal />

    <h2>Copiloto</h2>
    <form class="copilot" @submit.prevent="emit('save', { ...draft })">
      <label>Endpoint (OpenAI-compatible)
        <input ref="endpointInput" v-model="draft.baseUrl" placeholder="https://…/v1" spellcheck="false">
      </label>
      <label>API key
        <input v-model="draft.apiKey" type="password" autocomplete="off">
      </label>
      <div class="row">
        <label>Pasos máx.<input v-model.number="draft.maxSteps" type="number" min="1" max="100"></label>
        <label class="check"><input v-model="draft.vision" type="checkbox"> Visión (capturas al modelo)</label>
      </div>
      <div v-if="allowed.length" class="allowed">
        <span>Sitios con permiso permanente (modo Preguntar):</span>
        <div v-for="o in allowed" :key="o" class="origin">
          {{ o }} <button type="button" class="link" :aria-label="`Olvidar ${o}`" @click="forgetOrigin(o)">Olvidar</button>
        </div>
      </div>
      <div class="savebar">
        <span class="muted">{{ !ready() ? 'Falta endpoint o API key' : dirty ? 'Cambios sin guardar' : 'Guardado' }}</span>
        <button type="submit" :disabled="!isCopilotConfigured(draft)">Guardar</button>
      </div>
    </form>

    <footer class="foot">
      Local MCP ·
      <a href="https://github.com/SnakeO/agent-jake-browser-mcp-extension" target="_blank">Docs</a>
    </footer>
  </div>
</template>

<style scoped>
.options { padding: 12px; background: var(--bg-deep); min-height: 100%; box-sizing: border-box; }
.topbar { margin-bottom: 10px; }
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--accent-primary); font-family: var(--font-mono, monospace); margin: 16px 0 8px; }
.block { margin: 12px 0; }
.back { background: none; border: none; color: var(--accent-primary); padding: 4px 0; cursor: pointer; font: inherit; }
.update-banner { margin-bottom: 12px; padding: 10px 12px; border-radius: var(--radius-lg); border: 1px solid var(--accent-primary); font-size: 12px; }
.update-banner a { margin-left: 6px; color: var(--accent-primary); }
.copilot { display: flex; flex-direction: column; gap: 8px; }
.copilot label { display: flex; flex-direction: column; gap: 3px; color: var(--text-secondary); flex: 1; }
.copilot label.check { flex-direction: row; align-items: center; gap: 6px; }
.row { display: flex; gap: 8px; align-items: flex-end; }
.allowed { display: flex; flex-direction: column; gap: 2px; color: var(--text-secondary); }
.origin { display: flex; align-items: center; justify-content: space-between; color: var(--text-primary); font-family: var(--font-mono, monospace); font-size: 11px; }
.link { background: none; border: none; color: var(--accent-primary); cursor: pointer; font: inherit; padding: 2px 4px; }
.savebar { position: sticky; bottom: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 0; background: var(--bg-deep); border-top: 1px solid var(--border-default); }
.muted { color: var(--text-secondary); font-size: 12px; }
input { background: var(--bg-deepest); color: var(--text-primary); border: 1px solid var(--border-default); border-radius: 6px; padding: 6px 8px; font: inherit; }
button[type='submit'] { background: var(--accent-primary-dim); color: var(--text-primary); border: 1px solid var(--accent-primary); border-radius: 6px; padding: 6px 14px; cursor: pointer; font: inherit; min-height: 32px; }
button:disabled { opacity: 0.4; cursor: default; }
.foot { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border-subtle); font-size: 10px; color: var(--text-tertiary); text-align: center; font-family: var(--font-mono, monospace); }
.foot a { color: var(--accent-primary); text-decoration: none; }
</style>
