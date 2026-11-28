/**
 * Preview mode entry point.
 * Installs Chrome API mocks before mounting the production OptionsView.vue,
 * so the «Opciones» view can be developed in any browser without the extension runtime.
 */

// Install mocks BEFORE any Vue code that touches chrome.*
import { installMockChrome } from './mock-chrome';
installMockChrome();

import { createApp, h, nextTick, shallowRef } from 'vue';
import { createPinia } from 'pinia';
import App from '../../sidepanel/OptionsView.vue';
import StateController from './StateController.vue';
import { DEFAULT_COPILOT_SETTINGS, type CopilotSettings } from '@/types/copilot';
import type { CopilotSettingsSnapshot } from '@/utils/copilot-settings';
import '../styles/variables.css';
import '../styles/base.css';

const snapshot = shallowRef<CopilotSettingsSnapshot>({
  settings: { ...DEFAULT_COPILOT_SETTINGS },
  serverRevision: null,
});

async function saveSettings(settings: CopilotSettings) {
  snapshot.value = { ...snapshot.value, settings };
  await nextTick();
}

// Mount production app
const app = createApp({
  render: () => h(App, {
    snapshot: snapshot.value,
    focusField: null,
    check: { state: 'idle', text: '' },
    saveSettings,
  }),
});
app.use(createPinia());
app.mount('#app');

// Mount preview state controller overlay
const controllerApp = createApp(StateController);
controllerApp.mount('#state-controller');
