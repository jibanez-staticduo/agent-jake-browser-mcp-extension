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
  readonly VITE_WS_TOKEN?: string;
  readonly VITE_WS_SECURE?: string;
  readonly VITE_COPILOT_BASE_URL?: string;
  readonly VITE_COPILOT_API_KEY?: string;
  readonly VITE_BUILD_NUMBER?: string;
  readonly VITE_BUILD_SHA?: string;
  readonly VITE_LATEST_URL?: string;
  readonly VITE_UPDATE_PUBLIC_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
