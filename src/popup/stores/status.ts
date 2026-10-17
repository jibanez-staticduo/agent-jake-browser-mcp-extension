/**
 * Tab and connection status store.
 */
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { sendMessage } from './index';
import type { Status, TabInfo } from '../types';
import { usePolling } from '../composables/usePolling';

export const useStatusStore = defineStore('status', () => {
  // State
  const status = ref<Status>({
    connected: false,
    tabs: [],
  });

  // Polling

  // Computed: the tabs the agent drives — several sessions drive several tabs at once (INFRA-907)
  const connectedTabs = computed<TabInfo[]>(() => status.value.tabs.filter(t => t.connected));

  const connectedTab = computed<TabInfo | undefined>(() => connectedTabs.value[0]);

  const hasConnectedTab = computed<boolean>(() => connectedTabs.value.length > 0);

  const validTabs = computed<TabInfo[]>(() => {
    return status.value.tabs.filter(tab => {
      if (!tab.url || tab.url === 'about:blank' || tab.url === 'chrome://newtab/') {
        return true;
      }
      return !tab.url.startsWith('chrome://') &&
             !tab.url.startsWith('chrome-extension://');
    });
  });

  const sortedTabs = computed<TabInfo[]>(() => {
    return [...validTabs.value].sort((a, b) => {
      if (a.connected && !b.connected) return -1;
      if (!a.connected && b.connected) return 1;
      if (a.active && !b.active) return -1;
      if (!a.active && b.active) return 1;
      return 0;
    });
  });

  // Actions
  async function refresh(): Promise<void> {
    try {
      status.value = await sendMessage<Status>('getStatus');
    } catch (e) {
      console.error('[StatusStore] refresh failed:', e);
    }
  }

  async function connectTab(tabId: number, tabUrl?: string): Promise<void> {
    try {
      await sendMessage('connectTab', { tabId, tabUrl });
      await refresh();
    } catch (e) {
      console.error('[StatusStore] connectTab failed:', e);
    }
  }

  async function disconnectTab(tabId: number): Promise<void> {
    try {
      await sendMessage('disconnectTab', { tabId });
      await refresh();
    } catch (e) {
      console.error('[StatusStore] disconnectTab failed:', e);
    }
  }

  async function toggleMcp(): Promise<void> {
    try {
      const result = await sendMessage<{ success: boolean; error?: string }>('toggleMcp');
      if (!result.success && result.error) {
        console.warn('[StatusStore] toggleMcp warning:', result.error);
      }
      await refresh();
    } catch (e) {
      console.error('[StatusStore] toggleMcp failed:', e);
    }
  }

  async function focusTab(tabId: number): Promise<void> {
    try {
      const fullTab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      if (fullTab.windowId) {
        await chrome.windows.update(fullTab.windowId, { focused: true });
      }
      window.close();
    } catch (e) {
      console.error('[StatusStore] focusTab failed:', e);
    }
  }

  const { startPolling, stopPolling } = usePolling(refresh);

  return {
    // State
    status,
    // Computed
    connectedTabs,
    connectedTab,
    hasConnectedTab,
    validTabs,
    sortedTabs,
    // Actions
    refresh,
    connectTab,
    disconnectTab,
    toggleMcp,
    focusTab,
    startPolling,
    stopPolling,
  };
});
