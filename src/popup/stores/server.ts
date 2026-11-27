/**
 * Runtime server configuration store (URL + token + pairing + connection id).
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { SetupInstance, SetupPairingInfo } from '@/config/setup-instances';
import { sendMessage } from './index';
import type { PairingInfo, ServerConfigInfo } from '../types';

interface SaveResult {
  success?: boolean;
  error?: string;
}

interface StartPairingResult {
  success?: boolean;
  otp?: string;
  approveUrl?: string;
  error?: string;
}

export const useServerStore = defineStore('server', () => {
  // State
  const info = ref<ServerConfigInfo | null>(null);
  const serverUrlInput = ref('');
  const tokenInput = ref('');
  const labelInput = ref('');
  const saving = ref(false);
  const pairingLoading = ref(false);
  const setupLoading = ref(false);
  const error = ref<string | null>(null);
  const savedFlash = ref(false);

  // Set while the user is typing so polling does not overwrite the draft.
  const drafts = { serverUrlInput, tokenInput, labelInput };
  const touched = new Set<keyof typeof drafts>();
  let draftRevision = 0;
  let refreshRevision = 0;
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  // Computed
  const connectionId = computed(() => info.value?.connectionId ?? '');
  const effectiveUrl = computed(() => info.value?.effectiveUrl ?? '');
  const connected = computed(() => info.value?.connected ?? false);
  const pairing = computed<PairingInfo>(() => info.value?.pairing ?? { state: 'idle' });
  const setup = computed<SetupPairingInfo>(() => info.value?.setupPairing ?? { state: 'idle' });
  function syncDrafts(): void {
    if (!info.value) return;
    const latest = {
      serverUrlInput: info.value.storedServerUrl,
      tokenInput: info.value.storedToken,
      labelInput: info.value.label ?? '',
    };
    for (const key of Object.keys(drafts) as (keyof typeof drafts)[]) {
      if (!touched.has(key)) drafts[key].value = latest[key];
    }
  }

  // Actions
  async function refresh(): Promise<void> {
    const revision = ++refreshRevision;
    try {
      const result = await sendMessage<ServerConfigInfo>('getServerConfig');
      if (revision === refreshRevision && result && typeof result.effectiveUrl === 'string') {
        info.value = result;
        syncDrafts();
      }
    } catch (e) {
      console.error('[ServerStore] refresh failed:', e);
    }
  }

  function markDraftTouched(field: keyof typeof drafts = 'labelInput'): void {
    touched.add(field);
    draftRevision += 1;
  }

  async function save(): Promise<void> {
    saving.value = true;
    error.value = null;
    const savingRevision = draftRevision;
    try {
      const result = await sendMessage<SaveResult>('saveServerConfig', {
        ...(!info.value || touched.has('serverUrlInput') ? { serverUrl: serverUrlInput.value } : {}),
        ...(!info.value || touched.has('tokenInput') ? { token: tokenInput.value } : {}),
        ...(!info.value || touched.has('labelInput') ? { label: labelInput.value } : {}),
      });
      if (result && result.success === false) {
        error.value = result.error || 'No se pudo guardar';
        return;
      }
      // Preserve edits made while the background was saving/reconnecting.
      if (draftRevision === savingRevision) touched.clear();
      savedFlash.value = true;
      setTimeout(() => { savedFlash.value = false; }, 2500);
      await refresh();
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      saving.value = false;
    }
  }

  async function startPairing(): Promise<void> {
    pairingLoading.value = true;
    error.value = null;
    try {
      const result = await sendMessage<StartPairingResult>('startPairing');
      if (result && result.success === false) {
        error.value = result.error || 'No se pudo iniciar el pairing';
      } else if (result?.otp) {
        info.value = info.value
          ? { ...info.value, pairing: { state: 'pending', otp: result.otp, approveUrl: result.approveUrl } }
          : info.value;
      }
      await refresh();
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      pairingLoading.value = false;
    }
  }

  async function runSetup(instance?: SetupInstance): Promise<void> {
    setupLoading.value = true;
    error.value = null;
    try {
      const result = await sendMessage<SaveResult>(instance ? 'startSetup' : 'cancelSetup', instance);
      if (!result?.success) error.value = result?.error || 'No se pudo actualizar el emparejamiento.';
      await refresh();
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      setupLoading.value = false;
    }
  }

  function startPolling(): void {
    if (pollInterval) return;
    refresh();
    pollInterval = setInterval(refresh, 2000);
  }

  function stopPolling(): void {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  return {
    // State
    info,
    serverUrlInput,
    tokenInput,
    labelInput,
    saving,
    pairingLoading,
    setupLoading,
    error,
    savedFlash,
    // Computed
    connectionId,
    effectiveUrl,
    connected,
    pairing,
    setup,
    // Actions
    refresh,
    markDraftTouched,
    save,
    startPairing,
    runSetup,
    startPolling,
    stopPolling,
  };
});
