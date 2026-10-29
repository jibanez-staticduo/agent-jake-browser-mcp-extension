/** StaticDuo Ed25519 trust anchor (raw 32 bytes, base64). The private key is kept outside Git.
 * Test builds may override this key; release-staticduo.mjs rejects overrides for publication. */
export const PINNED_UPDATE_PUBLIC_KEY = '8c8tp8Jvr8S8GnkZHdL79/6y9f/99sisBAooeem1wRQ=';
export const UPDATE_PUBLIC_KEY: string = import.meta.env.VITE_UPDATE_PUBLIC_KEY || PINNED_UPDATE_PUBLIC_KEY;
