/** Ed25519 public key (raw 32 bytes, base64) that signs update-files.json. The private half is the
 *  AJB_UPDATE_SIGNING_KEY secret of the CI `publicar` job. A test build may override it with
 *  VITE_UPDATE_PUBLIC_KEY; scripts/publicar.sh refuses to publish such a build. */
export const PINNED_UPDATE_PUBLIC_KEY = 'zjV1cGctLLOkPqIHtubPQASoklV4Na+WoWsGyfqN6A4=';
export const UPDATE_PUBLIC_KEY: string = import.meta.env.VITE_UPDATE_PUBLIC_KEY || PINNED_UPDATE_PUBLIC_KEY;
