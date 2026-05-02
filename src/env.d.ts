/**
 * Vue component type declarations for TypeScript.
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

interface ImportMetaEnv {
  readonly VITE_WS_HOST?: string;
  readonly VITE_WS_PATH?: string;
  readonly VITE_WS_PORT?: string;
  readonly VITE_WS_SECURE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
