/** Importable composition API. MV3 starts only through the manifest entrypoints. */
import { getEffectiveConfig, parseWsUrl } from './config/runtime';

export interface ExtensionComposition {
  getServerConfig: typeof getEffectiveConfig;
  parseServerUrl: typeof parseWsUrl;
}

export interface HouseComposition {
  readonly house: 'staticduo' | 'pocharlies';
  readonly createExtension: typeof createExtension;
}

export function createExtension(): ExtensionComposition {
  return Object.freeze({
    getServerConfig: getEffectiveConfig,
    parseServerUrl: parseWsUrl,
  });
}
