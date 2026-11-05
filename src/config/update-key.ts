/** Ed25519 public key (raw 32 bytes, base64) that signs update-files.json. The private half is the
 *  AJB_UPDATE_SIGNING_KEY secret of the CI `publicar` job. A test build may override it with
 *  VITE_UPDATE_PUBLIC_KEY; scripts/publicar.sh refuses to publish such a build.
 *  StaticDuo trust anchor: a catch-up from upstream must not replace this repository's release
 *  identity. The matching private key remains outside Git in the release environment. Guarda:
 *  check-deltas.sh. */
export const PINNED_UPDATE_PUBLIC_KEY = '8c8tp8Jvr8S8GnkZHdL79/6y9f/99sisBAooeem1wRQ=';
export const UPDATE_PUBLIC_KEY: string = import.meta.env.VITE_UPDATE_PUBLIC_KEY || PINNED_UPDATE_PUBLIC_KEY;
