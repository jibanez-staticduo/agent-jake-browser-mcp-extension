/**
 * Vite configuration for Chrome extension build.
 * Uses CRXJS plugin for seamless extension development with HMR.
 * Vue 3 support for popup UI.
 */
import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import { execSync } from 'child_process';
import manifest from './manifest.json';

/**
 * Build identity baked into the bundle for the update check: the build number is the commit
 * count of the checkout (monotonic on main), the same number the CI publishes in
 * /download/latest.json. Outside git both stay empty and the check stays quiet.
 */
function git(cmd: string): string {
  try { return execSync(`git ${cmd}`, { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return ''; }
}
process.env.VITE_BUILD_NUMBER ??= git('rev-list --count HEAD');
process.env.VITE_BUILD_SHA ??= git('rev-parse --short HEAD');

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
