<script setup lang="ts">
/**
 * Tab list for connecting to browser tabs.
 * Uses Pinia stores for state management.
 */
import { useStatusStore } from '../stores';
import type { TabInfo } from '../types';

const status = useStatusStore();

function handleTabClick(tab: TabInfo) {
  status.connectTab(tab.id, tab.url || '');
}

function truncate(str: string, len: number): string {
  return str.length > len ? str.slice(0, len - 3) + '...' : str;
}

const defaultFavicon = "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22><rect fill=%22%23666%22 width=%2216%22 height=%2216%22 rx=%222%22/></svg>";
</script>

<template>
  <div class="tab-selector">
    <div class="section-title">Connect to Tab</div>

    <div class="tab-list">
      <div v-if="status.sortedTabs.length === 0" class="empty-state">
        No valid tabs available
      </div>

      <!-- When connected, only show the connected tab -->
      <template v-if="status.hasConnectedTab">
        <div
          v-for="tab in status.sortedTabs.filter(t => t.connected)"
          :key="tab.id"
          class="tab-item active"
          @click="status.focusTab()"
        >
          <div class="tab-checkmark" @click.stop="status.disconnectTab()">✓</div>
          <span class="tab-title">{{ tab.title || 'Untitled' }}</span>
        </div>
      </template>

      <!-- When not connected, show all tabs -->
      <template v-else>
        <div
          v-for="tab in status.sortedTabs"
          :key="tab.id"
          class="tab-item"
          @click="handleTabClick(tab)"
        >
          <img
            class="tab-favicon"
            :src="tab.favIconUrl || defaultFavicon"
            @error="($event.target as HTMLImageElement).src = defaultFavicon"
          >
          <span class="tab-title">{{ truncate(tab.title || 'Untitled', 30) }}</span>
          <span v-if="tab.active" class="current-badge">CURRENT</span>
        </div>
      </template>
    </div>

  </div>
</template>

<style scoped>
.tab-selector {
  position: relative;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-tertiary);
  margin-bottom: 10px;
  letter-spacing: 0.8px;
}

.tab-list {
  max-height: 180px;
  overflow-y: auto;
}

.empty-state {
  padding: 20px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 12px;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--bg-surface);
  border-radius: var(--radius-md);
  margin-bottom: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
  border: 1px solid transparent;
}

.tab-item:hover {
  background: var(--bg-elevated);
}

.tab-item.active {
  background: var(--accent-primary-dim);
  border-color: var(--accent-primary);
}

.tab-favicon {
  width: 18px;
  height: 18px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}

.tab-checkmark {
  width: 18px;
  height: 18px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
  background: var(--accent-success);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: white;
  cursor: pointer;
  transition: all 0.15s ease;
}

.tab-checkmark:hover {
  background: var(--accent-danger);
}

.tab-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-primary);
}

.current-badge {
  font-size: 9px;
  padding: 3px 7px;
  background: var(--accent-primary-dim);
  color: var(--accent-primary);
  border-radius: 20px;
  font-weight: 500;
  text-transform: uppercase;
}
</style>
