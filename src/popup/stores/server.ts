/**
 * Runtime server configuration store (URL + token + pairing + connection id).
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
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
  const saving = ref(false);
  const pairingLoading = ref(false);
  const error = ref<string | null>(null);
  const savedFlash = ref(false);

  // Set while the user is typing so polling does not overwrite the draft.
  let draftTouched = false;
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  // Computed
  const connectionId = computed(() => info.value?.connectionId ?? '');
  const effectiveUrl = computed(() => info.value?.effectiveUrl ?? '');
  const connected = computed(() => info.value?.connected ?? false);
  const pairing = computed<PairingInfo>(() => info.value?.pairing ?? { state: 'idle' });

  function syncDrafts(force = false): void {
    if (!info.value) return;
    if (!draftTouched || force) {
      serverUrlInput.value = info.value.storedServerUrl;
      tokenInput.value = info.value.storedToken;
    }
  }

  // Actions
  async function refresh(): Promise<void> {
    try {
      const result = await sendMessage<ServerConfigInfo>('getServerConfig');
      if (result && typeof result.effectiveUrl === 'string') {
        info.value = result;
        syncDrafts();
      }
    } catch (e) {
      console.error('[ServerStore] refresh failed:', e);
    }
  }

  function markDraftTouched(): void {
    draftTouched = true;
  }

  async function save(): Promise<void> {
    saving.value = true;
    error.value = null;
    try {
      const result = await sendMessage<SaveResult>('saveServerConfig', {
        serverUrl: serverUrlInput.value,
        token: tokenInput.value,
      });
      if (result && result.success === false) {
        error.value = result.error || 'No se pudo guardar';
        return;
      }
      draftTouched = false;
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

  function startPolling(): void {
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
    saving,
    pairingLoading,
    error,
    savedFlash,
    // Computed
    connectionId,
    effectiveUrl,
    connected,
    pairing,
    // Actions
    refresh,
    markDraftTouched,
    save,
    startPairing,
    startPolling,
    stopPolling,
  };
});
