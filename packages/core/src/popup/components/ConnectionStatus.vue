<script setup lang="ts">
/**
 * Dual connection status indicators - spaceship control panel aesthetic.
 * Shows local MCP WebSocket and tab connection states independently.
 */
import { computed } from 'vue';
import { useStatusStore } from '../stores';

const status = useStatusStore();

// Local MCP WebSocket state from the background service worker.
const serverConnected = computed(() => status.status.connected);
const serverState = computed(() => status.status.connected ? 'connected' : 'disconnected');

// Tab connection state from status store
const tabConnected = computed(() => status.hasConnectedTab);
const tabTitle = computed(() => {
  const tab = status.connectedTab;
  if (!tab) return 'No tab';
  return tab.title.length > 18 ? tab.title.slice(0, 18) + '…' : tab.title;
});

// Server status text
const mcpTitle = computed(() => serverConnected.value ? 'Click to disconnect MCP' : 'Click to connect MCP');

const serverStatusText = computed(() => {
  switch (serverState.value) {
    case 'connected': return 'ONLINE';
    case 'connecting': return 'SYNC';
    case 'reconnecting': return 'RETRY';
    case 'failed': return 'ERROR';
    default: return 'OFFLINE';
  }
});
</script>

<template>
  <div class="status-panel">
    <!-- Server Connection Indicator -->
    <button
      type="button"
      class="indicator mcp-indicator clickable"
      :class="{ active: serverConnected, error: serverState === 'failed' }"
      :title="mcpTitle"
      @click="status.toggleMcp()"
    >
      <div class="indicator-ring">
        <div class="indicator-core"></div>
        <div class="indicator-pulse"></div>
      </div>
      <div class="indicator-info">
        <span class="indicator-label">MCP</span>
        <span class="indicator-value" :class="serverState">{{ serverStatusText }}</span>
      </div>
      <div class="indicator-line"></div>
    </button>

    <!-- Tab Connection Indicator -->
    <div
      class="indicator tab-indicator"
      :class="{ active: tabConnected, clickable: tabConnected }"
      @click="tabConnected && status.focusTab()"
    >
      <div class="indicator-ring">
        <div class="indicator-core"></div>
        <div class="indicator-pulse"></div>
      </div>
      <div class="indicator-info">
        <span class="indicator-label">TAB</span>
        <span class="indicator-value" :class="{ connected: tabConnected }">
          {{ tabConnected ? tabTitle : 'Pick a tab' }}
        </span>
      </div>
      <div class="indicator-line"></div>
    </div>
  </div>
</template>

<style scoped>
.status-panel {
  display: flex;
  gap: 12px;
  padding: 14px 16px;
  background:
    linear-gradient(135deg, rgba(0, 212, 255, 0.03) 0%, transparent 50%),
    linear-gradient(225deg, rgba(168, 85, 247, 0.03) 0%, transparent 50%),
    var(--bg-surface);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-subtle);
  position: relative;
  overflow: hidden;
}

/* Subtle scan line effect */
.status-panel::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg,
    transparent 0%,
    var(--accent-primary) 20%,
    var(--accent-secondary) 80%,
    transparent 100%
  );
  opacity: 0.6;
}

.indicator {
  appearance: none;
  color: inherit;
  font: inherit;
  text-align: left;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: var(--bg-deep);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  position: relative;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}

button.indicator {
  cursor: pointer;
}

.indicator:hover {
  border-color: var(--border-default);
  background: var(--bg-elevated);
}

/* Active state glow */
.indicator.active {
  border-color: rgba(0, 212, 255, 0.3);
  box-shadow:
    0 0 20px rgba(0, 212, 255, 0.1),
    inset 0 1px 0 rgba(0, 212, 255, 0.1);
}

.indicator.tab-indicator.active {
  border-color: rgba(16, 185, 129, 0.3);
  box-shadow:
    0 0 20px rgba(16, 185, 129, 0.1),
    inset 0 1px 0 rgba(16, 185, 129, 0.1);
}

.indicator.error {
  border-color: rgba(239, 68, 68, 0.3);
  box-shadow:
    0 0 20px rgba(239, 68, 68, 0.1),
    inset 0 1px 0 rgba(239, 68, 68, 0.1);
}

/* Indicator Ring - The main LED */
.indicator-ring {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--bg-deepest);
  border: 2px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  flex-shrink: 0;
  transition: all 0.3s ease;
}

.indicator.active .indicator-ring {
  border-color: var(--accent-primary);
  box-shadow:
    0 0 0 3px rgba(0, 212, 255, 0.15),
    0 0 15px rgba(0, 212, 255, 0.3);
}

.indicator.tab-indicator.active .indicator-ring {
  border-color: var(--accent-success);
  box-shadow:
    0 0 0 3px rgba(16, 185, 129, 0.15),
    0 0 15px rgba(16, 185, 129, 0.3);
}

.indicator.error .indicator-ring {
  border-color: var(--accent-danger);
  box-shadow:
    0 0 0 3px rgba(239, 68, 68, 0.15),
    0 0 15px rgba(239, 68, 68, 0.3);
}

/* Inner core - The actual LED */
.indicator-core {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--text-tertiary);
  transition: all 0.3s ease;
}

.indicator.active .indicator-core {
  background: var(--accent-primary);
  box-shadow:
    0 0 8px var(--accent-primary),
    0 0 20px var(--accent-primary-glow);
}

.indicator.tab-indicator.active .indicator-core {
  background: var(--accent-success);
  box-shadow:
    0 0 8px var(--accent-success),
    0 0 20px rgba(16, 185, 129, 0.5);
}

.indicator.error .indicator-core {
  background: var(--accent-danger);
  box-shadow:
    0 0 8px var(--accent-danger),
    0 0 20px rgba(239, 68, 68, 0.5);
  animation: error-blink 1s ease-in-out infinite;
}

/* Pulse ring animation */
.indicator-pulse {
  position: absolute;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  border: 1px solid transparent;
  opacity: 0;
  transform: scale(1);
}

.indicator.active .indicator-pulse {
  border-color: var(--accent-primary);
  animation: pulse-ring 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

.indicator.tab-indicator.active .indicator-pulse {
  border-color: var(--accent-success);
  animation: pulse-ring-green 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

/* Clickable state */
.indicator.clickable {
  cursor: pointer;
}

.indicator.clickable:hover {
  background: var(--bg-hover);
}

/* Not clickable state (no tab connected) */
.indicator.tab-indicator:not(.active) {
  cursor: not-allowed;
}

/* Info section */
.indicator-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
  overflow: hidden;
}

.indicator-label {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 1.5px;
  color: var(--text-tertiary);
  text-transform: uppercase;
}

.indicator.active .indicator-label {
  color: var(--accent-primary);
}

.indicator.tab-indicator.active .indicator-label {
  color: var(--accent-success);
}

.indicator-value {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color 0.2s ease;
}

.indicator-value.connected {
  color: var(--accent-success);
}

.indicator-value.connecting,
.indicator-value.reconnecting {
  color: var(--accent-warning);
  animation: text-pulse 1.5s ease-in-out infinite;
}

.indicator-value.failed {
  color: var(--accent-danger);
}

/* Decorative line */
.indicator-line {
  position: absolute;
  bottom: 0;
  left: 14px;
  right: 14px;
  height: 2px;
  background: linear-gradient(90deg,
    transparent 0%,
    var(--border-subtle) 20%,
    var(--border-subtle) 80%,
    transparent 100%
  );
  border-radius: 1px;
  opacity: 0.5;
}

.indicator.active .indicator-line {
  background: linear-gradient(90deg,
    transparent 0%,
    var(--accent-primary) 20%,
    var(--accent-primary) 80%,
    transparent 100%
  );
  opacity: 0.4;
}

.indicator.tab-indicator.active .indicator-line {
  background: linear-gradient(90deg,
    transparent 0%,
    var(--accent-success) 20%,
    var(--accent-success) 80%,
    transparent 100%
  );
  opacity: 0.4;
}

/* Animations */
@keyframes pulse-ring {
  0% {
    opacity: 0.6;
    transform: scale(1);
  }
  50% {
    opacity: 0;
    transform: scale(1.6);
  }
  100% {
    opacity: 0;
    transform: scale(1.6);
  }
}

@keyframes pulse-ring-green {
  0% {
    opacity: 0.6;
    transform: scale(1);
  }
  50% {
    opacity: 0;
    transform: scale(1.6);
  }
  100% {
    opacity: 0;
    transform: scale(1.6);
  }
}

@keyframes text-pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

@keyframes error-blink {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}

/* Disconnected idle breathing animation */
.indicator:not(.active):not(.error) .indicator-core {
  animation: idle-breathe 3s ease-in-out infinite;
}

@keyframes idle-breathe {
  0%, 100% {
    opacity: 0.4;
  }
  50% {
    opacity: 0.7;
  }
}
</style>
