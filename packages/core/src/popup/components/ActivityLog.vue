<script setup lang="ts">
/**
 * Activity log with header actions.
 * Uses Pinia activity store for state management.
 */
import { useActivityStore } from '../stores';
import ActivityEntryComponent from './ActivityEntry.vue';

const activity = useActivityStore();
</script>

<template>
  <div class="activity-section">
    <div class="activity-header">
      <div class="section-title">Activity</div>
      <div class="activity-actions">
        <button class="activity-btn" title="Clear" @click="activity.clear">
          Clear
        </button>
        <button class="activity-btn" title="Refresh" @click="activity.refresh()">
          ↻
        </button>
      </div>
    </div>

    <div class="activity-log">
      <div v-if="activity.activities.length === 0" class="empty-state">
        No activity yet...
      </div>
      <ActivityEntryComponent
        v-for="entry in activity.activities"
        :key="entry.id"
        :entry="entry"
      />
    </div>

    <button
      v-if="activity.hasMore"
      class="activity-see-more"
      @click="activity.openModal"
    >
      See More ({{ activity.total }} total)
    </button>
  </div>
</template>

<style scoped>
.activity-section {
  display: flex;
  flex-direction: column;
}

.activity-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-tertiary);
  letter-spacing: 0.8px;
}

.activity-actions {
  display: flex;
  gap: 6px;
}

.activity-btn {
  background: transparent;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  padding: 4px 8px;
  font-size: 11px;
  font-family: var(--font-mono);
  border-radius: var(--radius-sm);
  transition: all 0.15s ease;
}

.activity-btn:hover {
  color: var(--text-primary);
  background: var(--bg-elevated);
}

.activity-log {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--bg-deepest);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
  max-height: 200px;
  overflow-y: auto;
}

.empty-state {
  padding: 16px;
  color: var(--text-tertiary);
  text-align: center;
  font-style: italic;
}

.activity-see-more {
  display: block;
  width: 100%;
  padding: 10px;
  background: var(--bg-surface);
  border: none;
  border-top: 1px solid var(--border-subtle);
  color: var(--accent-primary);
  font-size: 11px;
  font-family: var(--font-mono);
  cursor: pointer;
  transition: background 0.15s ease;
  margin-top: -1px;
  border-radius: 0 0 var(--radius-md) var(--radius-md);
}

.activity-see-more:hover {
  background: var(--bg-elevated);
}
</style>
