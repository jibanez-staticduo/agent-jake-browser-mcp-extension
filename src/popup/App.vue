<script setup lang="ts">
/**
 * Root Vue component for extension popup.
 * Uses Pinia stores for centralized state management.
 */
import { onMounted, onUnmounted } from 'vue';
import { useStatusStore, useActivityStore } from './stores';
import ConnectionStatus from './components/ConnectionStatus.vue';
import TabSelector from './components/TabSelector.vue';
import ActivityLog from './components/ActivityLog.vue';
import ActivityModal from './components/ActivityModal.vue';

const status = useStatusStore();
const activity = useActivityStore();

onMounted(() => {
  status.startPolling();
  activity.startPolling();
});

onUnmounted(() => {
  status.stopPolling();
  activity.stopPolling();
});
</script>

<template>
  <div class="container">
    <div class="local-header">
      <div>
        <div class="eyebrow">Local MCP Mode</div>
        <h1>Agent Jake Browser</h1>
      </div>
      <span class="endpoint">wss://agent-browser.staticduo.com</span>
    </div>

    <!-- Connection Status Panel -->
    <ConnectionStatus />

    <!-- Tab Connection Section -->
    <div class="section">
      <TabSelector />
    </div>

    <!-- Activity Log -->
    <ActivityLog />

    <!-- Activity Modal -->
    <ActivityModal />

    <!-- Footer -->
    <div class="footer">
      WebSocket: agent-browser.staticduo.com · Local MCP only ·
      <a href="https://github.com/SnakeO/agent-jake-browser-mcp-extension" target="_blank">Docs</a>
    </div>
  </div>
</template>

<style scoped>
.container {
  padding: 20px;
  background: var(--bg-deep);
  min-height: 100vh;
}

.local-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  padding: 16px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
}

.eyebrow {
  font-size: 10px;
  color: var(--accent-primary);
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 6px;
}

h1 {
  margin: 0;
  color: var(--text-primary);
  font-size: 18px;
  line-height: 1.1;
}

.endpoint {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 10px;
  text-align: right;
  line-height: 1.4;
}

.section {
  margin-top: 16px;
  margin-bottom: 16px;
}

.footer {
  padding-top: 16px;
  border-top: 1px solid var(--border-subtle);
  font-size: 10px;
  color: var(--text-tertiary);
  text-align: center;
  font-family: var(--font-mono);
}

.footer a {
  color: var(--accent-primary);
  text-decoration: none;
  transition: color 0.15s ease;
}

.footer a:hover {
  color: var(--text-primary);
}
</style>
