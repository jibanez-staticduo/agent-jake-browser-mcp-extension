/**
 * Tab and connection status store.
 */
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { sendMessage } from './index';
import type { Status, TabInfo } from '../types';

export const useStatusStore = defineStore('status', () => {
  // State
  const status = ref<Status>({
    connected: false,
    tabId: null,
    tabs: [],
  });

  // Polling
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  // Computed
  const connectedTab = computed<TabInfo | undefined>(() => {
    return status.value.tabs.find(t => t.connected);
  });

  const hasConnectedTab = computed<boolean>(() => {
    return !!connectedTab.value;
  });

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

  async function disconnectTab(): Promise<void> {
    try {
      await sendMessage('disconnectTab');
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

  async function focusTab(): Promise<void> {
    const tab = connectedTab.value;
    if (tab?.id) {
      try {
        const fullTab = await chrome.tabs.get(tab.id);
        await chrome.tabs.update(tab.id, { active: true });
        if (fullTab.windowId) {
          await chrome.windows.update(fullTab.windowId, { focused: true });
        }
        window.close();
      } catch (e) {
        console.error('[StatusStore] focusTab failed:', e);
      }
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
    status,
    // Computed
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
