<script setup lang="ts">
/**
 * Single activity log entry.
 */
import { ref, computed } from 'vue';
import type { ActivityEntry } from '../types';
import { formatTime, formatDuration } from '../composables/useFormatting';

const props = defineProps<{
  entry: ActivityEntry;
  expandable?: boolean;
}>();

const expanded = ref(false);

const details = computed(() => {
  if (!props.entry.details) return null;
  return JSON.stringify(props.entry.details, null, 2);
});

function toggle() {
  if (props.expandable && details.value) {
    expanded.value = !expanded.value;
  }
}
</script>

<template>
  <div
    class="activity-entry"
    :class="[
      entry.success ? 'success' : 'error',
      { expanded, clickable: expandable && details }
    ]"
    :data-type="entry.type"
    @click="toggle"
  >
    <div class="activity-header">
      <span class="activity-time">{{ formatTime(entry.timestamp) }}</span>
      <span class="activity-type">{{ entry.type }}</span>
      <span class="activity-spacer"></span>
      <span class="activity-icon">{{ entry.success ? '✓' : '✕' }}</span>
      <span v-if="entry.durationMs" class="activity-duration">
        {{ formatDuration(entry.durationMs) }}
      </span>
    </div>
    <div class="activity-desc">{{ entry.description }}</div>
    <div v-if="details && expanded" class="activity-details">{{ details }}</div>
  </div>
</template>

<style scoped>
.activity-entry {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-subtle);
}

.activity-entry:last-child {
  border-bottom: none;
}

.activity-entry.error {
  background: var(--accent-danger-dim);
}

.activity-entry.clickable {
  cursor: pointer;
}

.activity-entry.clickable:hover {
  background: var(--bg-surface);
}

.activity-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.activity-time {
  color: var(--text-tertiary);
  font-size: 10px;
}

.activity-type {
  font-size: 9px;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  text-transform: uppercase;
  font-weight: 500;
}

.activity-entry[data-type="connection"] .activity-type {
  background: var(--accent-primary-dim);
  color: var(--accent-primary);
}

.activity-entry[data-type="tool"] .activity-type {
  background: var(--accent-secondary-dim);
  color: var(--accent-secondary);
}

.activity-entry[data-type="tab"] .activity-type {
  background: var(--accent-success-dim);
  color: var(--accent-success);
}

.activity-entry[data-type="error"] .activity-type {
  background: var(--accent-danger-dim);
  color: var(--accent-danger);
}

.activity-entry[data-type="auth"] .activity-type {
  background: var(--accent-warning-dim);
  color: var(--accent-warning);
}

.activity-spacer {
  flex: 1;
}

.activity-icon {
  font-size: 10px;
}

.activity-entry.success .activity-icon {
  color: var(--accent-success);
}

.activity-entry.error .activity-icon {
  color: var(--accent-danger);
}

.activity-desc {
  color: var(--text-secondary);
  word-break: break-word;
  line-height: 1.4;
}

.activity-duration {
  color: var(--text-tertiary);
  font-size: 10px;
}

.activity-details {
  padding: 10px 12px;
  margin-top: 6px;
  background: var(--bg-deepest);
  border-radius: var(--radius-md);
  font-size: 10px;
  color: var(--text-tertiary);
  white-space: pre-wrap;
  word-break: break-all;
  border: 1px solid var(--border-subtle);
}
</style>
