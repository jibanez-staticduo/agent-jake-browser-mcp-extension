<script setup lang="ts">
/**
 * Floating state controller overlay for preview mode.
 * Provides buttons to toggle UI states without a real Chrome extension runtime.
 */
import { ref, computed } from 'vue';
import {
  previewState,
  addMockActivity,
  clearMockActivities,
  resetPreviewState,
  seedActivities,
} from './mock-chrome';

const collapsed = ref(false);

const authLabel = computed(() => previewState.authenticated ? 'Logged In' : 'Logged Out');
const connLabel = computed(() => previewState.connected ? 'Connected' : 'Disconnected');

function toggleAuth(): void {
  previewState.authenticated = !previewState.authenticated;
  if (!previewState.authenticated) {
    previewState.connected = false;
    previewState.connectedTabId = null;
  }
}

function toggleConnected(): void {
  if (!previewState.authenticated) {
    previewState.authenticated = true;
  }
  previewState.connected = !previewState.connected;
  previewState.connectedTabId = previewState.connected ? 101 : null;
}

function addToolActivity(): void {
  const tools = ['browser_navigate', 'browser_click', 'browser_snapshot', 'browser_type', 'browser_hover'];
  const tool = tools[Math.floor(Math.random() * tools.length)];
  addMockActivity({
    type: 'tool',
    action: tool,
    description: `Executed ${tool} successfully`,
    success: true,
    durationMs: Math.floor(Math.random() * 500) + 50,
  });
}

function addErrorActivity(): void {
  addMockActivity({
    type: 'error',
    action: 'browser_click',
    description: 'Target element not found in current snapshot',
    success: false,
    details: { ref: 's1e99', error: 'Element not found' },
  });
}

function handleSeed(): void {
  seedActivities();
}

function handleClear(): void {
  clearMockActivities();
}

function handleReset(): void {
  resetPreviewState();
}
</script>

<template>
  <div class="state-controller" :class="{ collapsed }">
    <button class="toggle-btn" @click="collapsed = !collapsed" :title="collapsed ? 'Expand' : 'Collapse'">
      {{ collapsed ? '&laquo;' : '&raquo;' }}
    </button>

    <template v-if="!collapsed">
      <div class="title">Preview Controls</div>

      <div class="group">
        <div class="group-label">State</div>
        <button class="ctrl-btn" :class="{ active: previewState.authenticated }" @click="toggleAuth">
          {{ authLabel }}
        </button>
        <button class="ctrl-btn" :class="{ active: previewState.connected }" @click="toggleConnected">
          {{ connLabel }}
        </button>
      </div>

      <div class="group">
        <div class="group-label">Activities</div>
        <button class="ctrl-btn" @click="handleSeed">Seed Data</button>
        <button class="ctrl-btn" @click="addToolActivity">+ Tool</button>
        <button class="ctrl-btn danger" @click="addErrorActivity">+ Error</button>
        <button class="ctrl-btn" @click="handleClear">Clear</button>
      </div>

      <div class="group">
        <button class="ctrl-btn reset" @click="handleReset">Reset All</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.state-controller {
  position: fixed;
  bottom: 12px;
  right: 12px;
  z-index: 99999;
  background: #1a1a2e;
  border: 1px solid rgba(0, 212, 255, 0.3);
  border-radius: 8px;
  padding: 10px;
  font-family: 'DM Sans', sans-serif;
  font-size: 11px;
  color: #f0f0f5;
  min-width: 160px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
}

.state-controller.collapsed {
  min-width: auto;
  padding: 4px;
}

.toggle-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  background: none;
  border: none;
  color: #8888a0;
  cursor: pointer;
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 4px;
}

.toggle-btn:hover {
  color: #00d4ff;
  background: rgba(0, 212, 255, 0.1);
}

.collapsed .toggle-btn {
  position: static;
}

.title {
  font-size: 10px;
  font-weight: 600;
  color: #00d4ff;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
  padding-right: 20px;
}

.group {
  margin-bottom: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.group-label {
  width: 100%;
  font-size: 9px;
  color: #8888a0;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 2px;
}

.ctrl-btn {
  background: #242442;
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #f0f0f5;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 10px;
  font-family: inherit;
  transition: all 0.15s ease;
}

.ctrl-btn:hover {
  background: #2a2a4a;
  border-color: rgba(0, 212, 255, 0.3);
}

.ctrl-btn.active {
  background: rgba(16, 185, 129, 0.15);
  border-color: #10b981;
  color: #10b981;
}

.ctrl-btn.danger {
  color: #ef4444;
}

.ctrl-btn.danger:hover {
  background: rgba(239, 68, 68, 0.15);
  border-color: rgba(239, 68, 68, 0.3);
}

.ctrl-btn.reset {
  width: 100%;
  color: #8888a0;
}

.ctrl-btn.reset:hover {
  color: #f0f0f5;
}
</style>
