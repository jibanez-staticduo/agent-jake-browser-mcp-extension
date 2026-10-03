/**
 * Copilot side panel entry point. Pinia and base.css are here because «Opciones» imports
 * the popup components and stores (src/popup), which need both.
 */
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import '../popup/styles/variables.css';
import '../popup/styles/base.css';
import App from './App.vue';

const app = createApp(App);
app.use(createPinia());
app.mount('#app');
