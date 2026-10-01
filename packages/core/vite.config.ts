/**
 * Vite configuration for Chrome extension build.
 * Uses CRXJS plugin for seamless extension development with HMR.
 * Vue 3 support for popup UI.
 */
import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import manifest from './manifest.json';

export default defineConfig({
  plugins: [
    vue(),
    crx({ manifest }),
  ],
  base: './', // Use relative paths for Chrome extension
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
        sidepanel: resolve(__dirname, 'src/sidepanel/index.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
});
