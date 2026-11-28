/**
 * Preview mode entry point.
 * Installs Chrome API mocks before mounting the production OptionsView.vue,
 * so the «Opciones» view can be developed in any browser without the extension runtime.
 */

// Install mocks BEFORE any Vue code that touches chrome.*
import { installMockChrome } from './mock-chrome';
installMockChrome();

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from '../../sidepanel/OptionsView.vue';
import StateController from './StateController.vue';
import { DEFAULT_COPILOT_SETTINGS } from '@/types/copilot';
import '../styles/variables.css';
import '../styles/base.css';

// Mount production app
const app = createApp(App, {
  snapshot: { settings: { ...DEFAULT_COPILOT_SETTINGS }, serverRevision: null },
  focusField: null,
  check: { state: 'idle', text: '' },
  saveSettings: async () => {},
});
app.use(createPinia());
app.mount('#app');

// Mount preview state controller overlay
const controllerApp = createApp(StateController);
controllerApp.mount('#state-controller');
