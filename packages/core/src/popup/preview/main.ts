/**
 * Preview mode entry point.
 * Installs Chrome API mocks before mounting the production App.vue,
 * so the popup can be developed in any browser without the extension runtime.
 */

// Install mocks BEFORE any Vue code that touches chrome.*
import { installMockChrome } from './mock-chrome';
installMockChrome();

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from '../App.vue';
import StateController from './StateController.vue';
import '../styles/variables.css';
import '../styles/base.css';

// Mount production app
const app = createApp(App);
app.use(createPinia());
app.mount('#app');

// Mount preview state controller overlay
const controllerApp = createApp(StateController);
controllerApp.mount('#state-controller');
