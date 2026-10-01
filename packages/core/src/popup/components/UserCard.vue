<script setup lang="ts">
/**
 * Signed-in user card with actions.
 * Uses Pinia stores for state management.
 */
import { computed } from 'vue';
import { useAuthStore } from '../stores';

const auth = useAuthStore();

const user = computed(() => auth.state.user);

const initials = computed(() => {
  if (!user.value) return '?';
  return user.value.name
    .split(' ')
    .map(n => n[0])
    .filter(Boolean)
    .join('')
    .toUpperCase()
    .slice(0, 2) || '?';
});

const statusClass = computed(() => {
  const state = auth.state.connectionState || 'disconnected';
  switch (state) {
    case 'connected': return 'online';
    case 'connecting':
    case 'reconnecting': return 'connecting';
    case 'failed': return 'error';
    default: return 'offline';
  }
});
</script>

<template>
  <div class="user-card">
    <div class="user-info">
      <div class="user-avatar">{{ initials }}</div>
      <div class="user-details">
        <div class="user-name">{{ user?.name }}</div>
        <div class="user-email">{{ user?.email }}</div>
      </div>
      <button
        class="btn-signout"
        @click="auth.logout"
      >
        Sign Out
      </button>
    </div>
  </div>
</template>

<style scoped>
.user-card {
  background: var(--bg-surface);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-subtle);
  overflow: hidden;
  position: relative;
}

.user-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, var(--accent-success), var(--accent-primary));
}

.user-info {
  padding: 16px;
  display: flex;
  align-items: center;
  gap: 14px;
}

.user-avatar {
  width: 48px;
  height: 48px;
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  font-weight: 600;
  color: var(--bg-deepest);
  box-shadow: var(--glow-primary);
  text-transform: uppercase;
  flex-shrink: 0;
}

.user-details {
  flex: 1;
  min-width: 0;
}

.user-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.user-email {
  font-size: 12px;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

.btn-signout {
  margin-left: auto;
  padding: 6px 12px;
  background: var(--accent-danger-dim);
  border: 1px solid var(--accent-danger);
  border-radius: var(--radius-sm);
  color: var(--accent-danger);
  font-size: 11px;
  font-weight: 500;
  font-family: var(--font-sans);
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-signout:hover {
  background: var(--accent-danger);
  border-color: var(--accent-danger);
  color: white;
  box-shadow: 0 0 12px rgba(239, 68, 68, 0.4);
}
</style>
