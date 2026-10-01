/**
 * Vite config for standalone preview mode.
 * Runs without @crxjs/vite-plugin so the popup renders
 * in a normal browser tab with mocked Chrome APIs.
 */
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5174,
    open: '/src/popup/preview/index.html',
  },
});
