/**
 * Activity log store.
 */
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { sendMessage } from './index';
import type { ActivityEntry, ActivityLogResponse, ActivityFilter } from '../types';

export const useActivityStore = defineStore('activity', () => {
  // State
  const activities = ref<ActivityEntry[]>([]);
  const total = ref(0);
  const filter = ref<ActivityFilter>('all');
  const modalOpen = ref(false);

  // Polling
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  // Computed
  const filtered = computed<ActivityEntry[]>(() => {
    if (filter.value === 'all') return activities.value;
    return activities.value.filter(a => a.type === filter.value);
  });

  const hasMore = computed<boolean>(() => {
    return total.value > 5;
  });

  // Actions
  async function refresh(limit = 5): Promise<void> {
    try {
      const response = await sendMessage<ActivityLogResponse>('getActivity', { limit });
      activities.value = response?.activities ?? [];
      total.value = response?.total ?? 0;
    } catch (e) {
      console.error('[ActivityStore] refresh failed:', e);
      activities.value = [];
      total.value = 0;
    }
  }

  async function fetchAll(): Promise<void> {
    try {
      const response = await sendMessage<ActivityLogResponse>('getActivity');
      activities.value = response?.activities ?? [];
      total.value = response?.total ?? 0;
    } catch (e) {
      console.error('[ActivityStore] fetchAll failed:', e);
    }
  }

  async function clear(): Promise<void> {
    try {
      await sendMessage('clearActivity');
      await refresh();
    } catch (e) {
      console.error('[ActivityStore] clear failed:', e);
    }
  }

  function setFilter(newFilter: ActivityFilter): void {
    filter.value = newFilter;
  }

  function openModal(): void {
    modalOpen.value = true;
    fetchAll();
  }

  function closeModal(): void {
    modalOpen.value = false;
  }

  function startPolling(): void {
    refresh();
    pollInterval = setInterval(() => refresh(), 2000);
  }

  function stopPolling(): void {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  return {
    // State
    activities,
    total,
    filter,
    modalOpen,
    // Computed
    filtered,
    hasMore,
    // Actions
    refresh,
    fetchAll,
    clear,
    setFilter,
    openModal,
    closeModal,
    startPolling,
    stopPolling,
  };
});
