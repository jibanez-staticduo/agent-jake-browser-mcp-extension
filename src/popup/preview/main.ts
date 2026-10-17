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
import '../styles/variables.css';
import '../styles/base.css';

// Mount production app
const app = createApp(App, { settings: { baseUrl: '', apiKey: '', model: 'qwen38-flash-next', mode: 'ask', maxSteps: 30, vision: false } });
app.use(createPinia());
app.mount('#app');

// Mount preview state controller overlay
const controllerApp = createApp(StateController);
controllerApp.mount('#state-controller');
