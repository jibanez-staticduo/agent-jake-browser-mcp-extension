/**
 * Format of a self-update package: the zip served at /download carries update-files.json (every
 * file of the extension with its sha256 and size) and update-files.json.sig (Ed25519 over the exact
 * bytes of update-files.json). Pure functions, shared rules with scripts/update-files.mjs.
 */
import MIME from '@/config/update-mime.json';

export const INSTALL_DIR = 'agent-jake-browser';
export const FILES_NAME = 'update-files.json';
export const SIG_NAME = 'update-files.json.sig';

export interface UpdateFileEntry { path: string; sha256: string; size: number }
export interface UpdateFiles { version: string; build: number; sha: string; files: UpdateFileEntry[] }

const MIME_BY_EXT = MIME as Record<string, string>;
const SAFE_CHARS = /^[A-Za-z0-9._\/-]+$/;
// Windows reserved device names (any extension); the install may live on a Windows profile.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function mimeFor(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  return MIME_BY_EXT[path.slice(dot + 1).toLowerCase()] ?? null;
}

export function isSafePath(path: string): boolean {
  if (!path || path.length > 200 || !SAFE_CHARS.test(path) || path.startsWith('/')) return false;
  const parts = path.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.') || s.endsWith('.') || WINDOWS_RESERVED.test(s.split('.')[0]))) return false;
  return mimeFor(path) !== null;
}

export function parseUpdateFiles(raw: unknown): UpdateFiles | null {
  const r = raw as Partial<UpdateFiles> | null;
  if (!r || typeof r.version !== 'string' || typeof r.sha !== 'string') return null;
  if (typeof r.build !== 'number' || !Number.isInteger(r.build) || r.build <= 0) return null;
  if (!Array.isArray(r.files) || r.files.length === 0) return null;
  const seen = new Set<string>();
  for (const f of r.files) {
    if (!f || typeof f.path !== 'string' || !isSafePath(f.path) || seen.has(f.path.toLowerCase())) return null;
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) return null;
    if (typeof f.size !== 'number' || !Number.isInteger(f.size) || f.size < 0) return null;
    seen.add(f.path.toLowerCase());
  }
  if (!seen.has('manifest.json')) return null;
  return { version: r.version, build: r.build, sha: r.sha, files: r.files.map(({ path, sha256, size }) => ({ path, sha256, size })) };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function verifySignature(message: Uint8Array, sigB64: string, publicKeyB64: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', fromB64(publicKeyB64), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, fromB64(sigB64.trim()), message as BufferSource);
  } catch {
    return false;
  }
}

const rank = (p: string) => (p.startsWith('assets/') ? 0 : p === 'manifest.json' ? 1 : 2);
/** Hashed assets first (harmless if the update stops there), then the manifest, then the
 *  un-hashed entry files that a service-worker restart would pick up. */
export function writeOrder(files: UpdateFileEntry[]): UpdateFileEntry[] {
  return [...files].sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
}

export function toDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

/** RFC 8032 test-vector public key: any valid raw Ed25519 key works for feature detection. */
const PROBE_KEY_HEX = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';

/** False on Chrome builds whose WebCrypto lacks Ed25519 (so a valid signature could never verify). */
export async function supportsEd25519(): Promise<boolean> {
  try {
    const raw = Uint8Array.from(PROBE_KEY_HEX.match(/../g)!, (h) => parseInt(h, 16));
    await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
    return true;
  } catch {
    return false;
  }
}
