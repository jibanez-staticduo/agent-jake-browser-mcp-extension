# Autoactualización de la extensión — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que la extensión Agent Jake se reescriba sola desde la build firmada que publica el CI, sin scripts por navegador.

**Architecture:** el CI firma (Ed25519) una lista de ficheros dentro del zip neutro que ya sirve el pod. La extensión,
instalada en `<Descargas>/agent-jake-browser/`, verifica firma y hashes, se sobrescribe con `chrome.downloads`
(`data:` + `overwrite`) y se recarga. El servidor no cambia.

**Tech Stack:** TypeScript 5.9, Vite 7 + CRXJS, Vitest 2.1, WebCrypto Ed25519, `fflate` (unzip), bash + node para el CI.

**Spec:** `docs/superpowers/specs/2026-10-05-autoactualizacion-design.md` (copiada del scratchpad en la Task 1).

**Desviación aprobable de la spec:** NO se añade `key` al manifest. La carpeta es fija
(`<Descargas>/agent-jake-browser`), así que el id ya es estable entre actualizaciones; con `key`, las instalaciones
viejas que sigue sincronizando el vigilante del x86 cambiarían de id al recargar, perderían `chrome.storage` y su
`connectionId`, y las etiquetas `x86`/`mac` del pod dejarían de casar antes de migrar.

## Global Constraints

- Repo `pocharlies-org/agent-browser-extension`, rama `feat/autoactualizacion` desde `origin/main` (6126e70 o posterior).
  Trabajar en un clon NUEVO en `~/Workspace/agent-browser-extension` (NO en `~/agent-browser/src/agent-browser-extension`,
  que usa el updater de launchd y debe seguir limpio).
- Node 22.23.2 en CI; `npm run typecheck` y `npm run test:unit` en verde; `bash scripts/check-deltas.sh` en verde.
- Carpeta de instalación: `agent-jake-browser` (constante `INSTALL_DIR`).
- Ficheros del paquete: `update-files.json` y `update-files.json.sig` en la raíz del zip.
- Esperas: sonda y cada descarga 15 s; cerrojo 10 min; inactividad 5 min; comprobación cada 30 min (alarma existente).
- URL publicada: `https://browser-mcp.lan.e-dani.com/download/latest.json`.
- Secreto de CI: `AJB_UPDATE_SIGNING_KEY` (Ed25519 PKCS8 PEM). Nunca en disco, nunca en logs.
- La build publicada no lleva `VITE_WS_*`, `VITE_COPILOT_*` ni `VITE_UPDATE_PUBLIC_KEY`.
- Ningún nombre escrito empieza por `.`; rutas sin `..`, sin `/` inicial, solo `[A-Za-z0-9._/-]`.
- Comentarios en inglés en el código (estilo del repo); documentación (ARCHITECTURE/README) en español.

## Review Focus

1. Un fichero que existe en las dos versiones (manifest, iconos) NO se borra en la limpieza: solo `removeFile` de rutas que
   ya no están en la lista nueva; las entradas viejas de rutas comunes solo se `erase`n. (Test en Task 3.)
2. Una actualización interrumpida a mitad (falla la descarga n.º k) no deja el cerrojo puesto ni escribe
   `pendingCleanup`, y reintenta en la siguiente pasada. (Test en Task 3.)
3. El `config.json` que el servidor inyecta en el zip, y cualquier fichero no listado, nunca se escribe. (Test en Task 3.)
4. Una build publicada con el mismo `build` que la instalada (re-publicación) no reescribe nada. (Test en Task 3.)
5. Instalaciones viejas fuera de Descargas: un solo aviso por build y causa, nunca en bucle cada 30 min. (Test en Task 3.)

---

### Task 1: Paquete de actualización (formato, rutas, MIME, firma)

**Files:**
- Create: `src/config/update-mime.json`, `src/background/update-package.ts`, `src/config/update-key.ts`
- Create: `docs/superpowers/specs/2026-10-05-autoactualizacion-design.md`, `docs/superpowers/plans/2026-10-05-autoactualizacion-plan.md` (copias del scratchpad)
- Test: `tests/unit/background/update-package.test.ts`

**Interfaces:**
- Produces:
  - `INSTALL_DIR = 'agent-jake-browser'`, `FILES_NAME = 'update-files.json'`, `SIG_NAME = 'update-files.json.sig'`
  - `interface UpdateFileEntry { path: string; sha256: string; size: number }`
  - `interface UpdateFiles { version: string; build: number; sha: string; files: UpdateFileEntry[] }`
  - `mimeFor(path: string): string | null`
  - `isSafePath(path: string): boolean`
  - `parseUpdateFiles(raw: unknown): UpdateFiles | null`
  - `sha256Hex(bytes: Uint8Array): Promise<string>`
  - `verifySignature(message: Uint8Array, sigB64: string, publicKeyB64: string): Promise<boolean>`
  - `writeOrder(files: UpdateFileEntry[]): UpdateFileEntry[]`
  - `toDataUrl(bytes: Uint8Array, mime: string): string`
  - `UPDATE_PUBLIC_KEY: string` (en `update-key.ts`; base64 de los 32 bytes raw)

- [ ] **Step 1: Clave de firma (la genera el PMO, no el implementer).** El hilo principal genera el par Ed25519 y sube la
  privada como secreto con confirmación de Daniel; al implementer le llega solo la pública (base64 raw, 32 bytes):
  ```bash
  node -e 'const c=require("crypto");const {publicKey,privateKey}=c.generateKeyPairSync("ed25519");
  process.stderr.write(publicKey.export({format:"der",type:"spki"}).subarray(12).toString("base64")+"\n");
  process.stdout.write(privateKey.export({format:"pem",type:"pkcs8"}));' \
  | gh secret set AJB_UPDATE_SIGNING_KEY -R pocharlies-org/agent-browser-extension
  ```

- [ ] **Step 2: Test que falla** — `tests/unit/background/update-package.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { generateKeyPairSync, sign } from 'node:crypto';
  import { isSafePath, mimeFor, parseUpdateFiles, sha256Hex, verifySignature, writeOrder, toDataUrl } from '@/background/update-package';

  const enc = (s: string) => new TextEncoder().encode(s);

  describe('isSafePath', () => {
    it.each(['manifest.json', 'assets/index.ts-loader-BAV7mLrc.js', 'src/sidepanel/index.html', 'icons/icon16.png'])('accepts %s', (p) => expect(isSafePath(p)).toBe(true));
    it.each(['', '/etc/x.js', '../x.js', 'a/../b.js', '.vite/manifest.json', 'assets/.hidden.js', 'a\\b.js', 'x.exe', 'a//b.js', 'config.json '])('rejects %j', (p) => expect(isSafePath(p)).toBe(false));
  });

  describe('mimeFor', () => {
    it('maps by extension, case-insensitive', () => {
      expect(mimeFor('a.js')).toBe('text/javascript');
      expect(mimeFor('manifest.json')).toBe('application/json');
      expect(mimeFor('i/x.PNG')).toBe('image/png');
      expect(mimeFor('x.exe')).toBeNull();
    });
  });

  describe('parseUpdateFiles', () => {
    const ok = { version: '2.4.0.140', build: 140, sha: 'abc1234', files: [{ path: 'manifest.json', sha256: 'a'.repeat(64), size: 10 }] };
    it('accepts a well-formed list', () => expect(parseUpdateFiles(ok)).toEqual(ok));
    it('requires manifest.json', () => expect(parseUpdateFiles({ ...ok, files: [{ path: 'a.js', sha256: 'a'.repeat(64), size: 1 }] })).toBeNull());
    it('rejects unsafe paths, bad hashes, duplicates and bad builds', () => {
      expect(parseUpdateFiles({ ...ok, files: [...ok.files, { path: '../x.js', sha256: 'a'.repeat(64), size: 1 }] })).toBeNull();
      expect(parseUpdateFiles({ ...ok, files: [{ path: 'manifest.json', sha256: 'XYZ', size: 1 }] })).toBeNull();
      expect(parseUpdateFiles({ ...ok, files: [ok.files[0], ok.files[0]] })).toBeNull();
      expect(parseUpdateFiles({ ...ok, build: 1.5 })).toBeNull();
      expect(parseUpdateFiles(null)).toBeNull();
    });
  });

  describe('verifySignature', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
    const msg = enc('{"build":1}');
    const sig = sign(null, Buffer.from(msg), privateKey).toString('base64');
    it('accepts a valid signature', async () => expect(await verifySignature(msg, sig, pub)).toBe(true));
    it('rejects a tampered message', async () => expect(await verifySignature(enc('{"build":2}'), sig, pub)).toBe(false));
    it('rejects garbage without throwing', async () => expect(await verifySignature(msg, 'not-base64!!', pub)).toBe(false));
  });

  describe('writeOrder', () => {
    it('writes hashed assets first, then manifest.json, then entry files', () => {
      const f = (path: string) => ({ path, sha256: 'a'.repeat(64), size: 1 });
      const order = writeOrder([f('service-worker-loader.js'), f('manifest.json'), f('assets/a-1.js'), f('icons/i.png'), f('assets/b-2.css')]).map((e) => e.path);
      expect(order).toEqual(['assets/a-1.js', 'assets/b-2.css', 'manifest.json', 'icons/i.png', 'service-worker-loader.js']);
    });
  });

  it('sha256Hex and toDataUrl', async () => {
    expect(await sha256Hex(enc('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(toDataUrl(enc('hi'), 'text/plain')).toBe('data:text/plain;base64,aGk=');
  });
  ```

- [ ] **Step 3: Ejecutar y ver que falla** — `npx vitest run tests/unit/background/update-package.test.ts` → FAIL (módulo inexistente).

- [ ] **Step 4: Implementar.** `src/config/update-mime.json`:
  ```json
  { "js": "text/javascript", "mjs": "text/javascript", "json": "application/json", "html": "text/html", "css": "text/css",
    "png": "image/png", "svg": "image/svg+xml", "ico": "image/x-icon", "webp": "image/webp", "woff": "font/woff",
    "woff2": "font/woff2", "map": "application/json", "txt": "text/plain" }
  ```
  `src/config/update-key.ts`:
  ```ts
  /** Ed25519 public key (raw 32 bytes, base64) that signs update-files.json. The private half is the
   *  AJB_UPDATE_SIGNING_KEY secret of the CI `publicar` job. A test build may override it with
   *  VITE_UPDATE_PUBLIC_KEY; scripts/publicar.sh refuses to publish such a build. */
  export const PINNED_UPDATE_PUBLIC_KEY = '<base64 del Step 1>';
  export const UPDATE_PUBLIC_KEY: string = import.meta.env.VITE_UPDATE_PUBLIC_KEY || PINNED_UPDATE_PUBLIC_KEY;
  ```
  (añadir `readonly VITE_UPDATE_PUBLIC_KEY?: string` a `src/env.d.ts`.)
  `src/background/update-package.ts`:
  ```ts
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

  export function mimeFor(path: string): string | null {
    const dot = path.lastIndexOf('.');
    if (dot < 0) return null;
    return MIME_BY_EXT[path.slice(dot + 1).toLowerCase()] ?? null;
  }

  export function isSafePath(path: string): boolean {
    if (!path || path.length > 200 || !SAFE_CHARS.test(path) || path.startsWith('/')) return false;
    const parts = path.split('/');
    if (parts.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) return false;
    return mimeFor(path) !== null;
  }

  export function parseUpdateFiles(raw: unknown): UpdateFiles | null {
    const r = raw as Partial<UpdateFiles> | null;
    if (!r || typeof r.version !== 'string' || typeof r.sha !== 'string') return null;
    if (typeof r.build !== 'number' || !Number.isInteger(r.build) || r.build <= 0) return null;
    if (!Array.isArray(r.files) || r.files.length === 0) return null;
    const seen = new Set<string>();
    for (const f of r.files) {
      if (!f || typeof f.path !== 'string' || !isSafePath(f.path) || seen.has(f.path)) return null;
      if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) return null;
      if (typeof f.size !== 'number' || !Number.isInteger(f.size) || f.size < 0) return null;
      seen.add(f.path);
    }
    if (!seen.has('manifest.json')) return null;
    return { version: r.version, build: r.build, sha: r.sha, files: r.files.map(({ path, sha256, size }) => ({ path, sha256, size })) };
  }

  export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function fromB64(b64: string): Uint8Array {
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  export async function verifySignature(message: Uint8Array, sigB64: string, publicKeyB64: string): Promise<boolean> {
    try {
      const key = await crypto.subtle.importKey('raw', fromB64(publicKeyB64), { name: 'Ed25519' }, false, ['verify']);
      return await crypto.subtle.verify({ name: 'Ed25519' }, key, fromB64(sigB64.trim()), message);
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
  ```
  Si `resolveJsonModule` no está activo en `tsconfig.json`, activarlo.

- [ ] **Step 5: Ejecutar y ver que pasa** — `npx vitest run tests/unit/background/update-package.test.ts` → PASS; `npm run typecheck` → OK.
- [ ] **Step 6: Commit** — `git add src/config/update-mime.json src/config/update-key.ts src/env.d.ts src/background/update-package.ts tests/unit/background/update-package.test.ts docs/superpowers tsconfig.json && git commit -m "feat(self-update): formato del paquete firmado (update-files.json + Ed25519)"`

### Task 2: Firma en Node (`scripts/update-files.mjs`)

**Files:**
- Create: `scripts/update-files.mjs`
- Test: `tests/unit/scripts/update-files.test.ts`

**Interfaces:**
- Consumes: reglas de `isSafePath`/`mimeFor` (Task 1) vía `src/config/update-mime.json`.
- Produces: CLI `node scripts/update-files.mjs sign <distDir> --version V --build N --sha S` (lee la clave de
  `AJB_UPDATE_SIGNING_KEY`, escribe `<distDir>/update-files.json` y `.sig`); `node scripts/update-files.mjs verify <distDir> --pub <b64>` (exit 0/1).
  Exporta además `listFiles(distDir)` y `buildUpdateFiles(distDir, meta)` para el test.

- [ ] **Step 1: Test que falla** — `tests/unit/scripts/update-files.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { tmpdir } from 'node:os';
  import { execFileSync } from 'node:child_process';
  import { generateKeyPairSync } from 'node:crypto';
  import { parseUpdateFiles, verifySignature } from '@/background/update-package';

  function dist() {
    const d = mkdtempSync(join(tmpdir(), 'ajb-dist-'));
    mkdirSync(join(d, 'assets')); mkdirSync(join(d, '.vite'));
    writeFileSync(join(d, 'manifest.json'), '{"version":"2.4.0"}');
    writeFileSync(join(d, 'assets', 'a-1.js'), 'console.log(1)');
    writeFileSync(join(d, '.vite', 'manifest.json'), '{}');
    return d;
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

  describe('update-files.mjs', () => {
    it('signs every non-dot file and the extension accepts the result', async () => {
      const d = dist();
      execFileSync('node', ['scripts/update-files.mjs', 'sign', d, '--version', '2.4.0.140', '--build', '140', '--sha', 'abc1234'], { env: { ...process.env, AJB_UPDATE_SIGNING_KEY: pem } });
      const bytes = readFileSync(join(d, 'update-files.json'));
      const files = parseUpdateFiles(JSON.parse(bytes.toString()));
      expect(files?.files.map((f) => f.path).sort()).toEqual(['assets/a-1.js', 'manifest.json']);
      expect(await verifySignature(new Uint8Array(bytes), readFileSync(join(d, 'update-files.json.sig'), 'utf8'), pub)).toBe(true);
      expect(() => execFileSync('node', ['scripts/update-files.mjs', 'verify', d, '--pub', pub])).not.toThrow();
    });
    it('fails on a file the extension would refuse to write', () => {
      const d = dist(); writeFileSync(join(d, 'tool.exe'), 'x');
      expect(() => execFileSync('node', ['scripts/update-files.mjs', 'sign', d, '--version', 'v', '--build', '1', '--sha', 's'], { env: { ...process.env, AJB_UPDATE_SIGNING_KEY: pem }, stdio: 'pipe' })).toThrow();
    });
    it('fails without the key and never prints it', () => {
      const d = dist();
      expect(() => execFileSync('node', ['scripts/update-files.mjs', 'sign', d, '--version', 'v', '--build', '1', '--sha', 's'], { env: { ...process.env, AJB_UPDATE_SIGNING_KEY: '' }, stdio: 'pipe' })).toThrow();
    });
  });
  ```
- [ ] **Step 2: Ver que falla** — `npx vitest run tests/unit/scripts/update-files.test.ts` → FAIL.
- [ ] **Step 3: Implementar** `scripts/update-files.mjs`:
  ```js
  #!/usr/bin/env node
  // Builds and signs update-files.json for a dist directory (CI `publicar`), or verifies it.
  // Same path/MIME rules as src/background/update-package.ts (shared table: src/config/update-mime.json).
  import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
  import { join, relative, sep } from 'node:path';
  import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
  import { fileURLToPath } from 'node:url';

  const MIME = JSON.parse(readFileSync(new URL('../src/config/update-mime.json', import.meta.url), 'utf8'));
  const SAFE = /^[A-Za-z0-9._\/-]+$/;
  const OWN = new Set(['update-files.json', 'update-files.json.sig']);
  const safe = (p) => p.length <= 200 && SAFE.test(p) && !p.split('/').some((s) => !s || s === '..' || s.startsWith('.'))
    && Object.hasOwn(MIME, p.slice(p.lastIndexOf('.') + 1).toLowerCase());

  export function listFiles(dir, base = dir) {
    return readdirSync(dir).flatMap((name) => {
      if (name.startsWith('.')) return [];
      const full = join(dir, name);
      return statSync(full).isDirectory() ? listFiles(full, base) : [relative(base, full).split(sep).join('/')];
    }).filter((p) => !OWN.has(p)).sort();
  }

  export function buildUpdateFiles(dir, { version, build, sha }) {
    const files = listFiles(dir).map((path) => {
      if (!safe(path)) throw new Error(`unsupported file in package: ${path}`);
      const bytes = readFileSync(join(dir, path));
      return { path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    });
    if (!files.some((f) => f.path === 'manifest.json')) throw new Error('manifest.json missing');
    return { version, build: Number(build), sha, files };
  }

  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

  if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [cmd, dir] = process.argv.slice(2);
    if (cmd === 'sign') {
      const pem = process.env.AJB_UPDATE_SIGNING_KEY || '';
      if (!pem.includes('PRIVATE KEY')) { console.error('AJB_UPDATE_SIGNING_KEY missing'); process.exit(1); }
      const body = Buffer.from(JSON.stringify(buildUpdateFiles(dir, { version: arg('--version'), build: arg('--build'), sha: arg('--sha') }), null, 1));
      writeFileSync(join(dir, 'update-files.json'), body);
      writeFileSync(join(dir, 'update-files.json.sig'), sign(null, body, createPrivateKey(pem)).toString('base64'));
      console.log(`signed ${JSON.parse(body).files.length} files`);
    } else if (cmd === 'verify') {
      const raw = Buffer.from(arg('--pub') || '', 'base64');
      const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
      const body = readFileSync(join(dir, 'update-files.json'));
      const ok = verify(null, body, key, Buffer.from(readFileSync(join(dir, 'update-files.json.sig'), 'utf8').trim(), 'base64'));
      const files = JSON.parse(body).files;
      const bad = files.filter((f) => createHash('sha256').update(readFileSync(join(dir, f.path))).digest('hex') !== f.sha256);
      if (!ok || bad.length) { console.error(`verify failed (signature ${ok}, bad hashes ${bad.length})`); process.exit(1); }
      console.log(`verified ${files.length} files`);
    } else { console.error('usage: update-files.mjs sign|verify <dir> ...'); process.exit(2); }
  }
  ```
- [ ] **Step 4: Ver que pasa** — `npx vitest run tests/unit/scripts/update-files.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(self-update): firma y verificación del paquete en node (scripts/update-files.mjs)"` (añadir los ficheros nuevos con `git add`).

### Task 3: Motor de autoactualización (`src/background/self-update.ts`)

**Files:**
- Create: `src/background/self-update.ts`
- Modify: `package.json` (+ dependencia `fflate`)
- Test: `tests/unit/background/self-update.test.ts`

**Interfaces:**
- Consumes: Task 1 (`INSTALL_DIR`, `FILES_NAME`, `SIG_NAME`, `parseUpdateFiles`, `verifySignature`, `sha256Hex`, `writeOrder`, `toDataUrl`, `mimeFor`), `PublishedBuild` de `update-check.ts`.
- Produces:
  ```ts
  export type SelfUpdateProblem = 'not-in-downloads' | 'download-prompt' | 'bad-package' | 'write-failed';
  export type SelfUpdateStatus = 'applied' | 'up-to-date' | 'locked' | 'busy' | 'not-eligible' | 'rejected' | 'failed';
  export interface SelfUpdateResult { status: SelfUpdateStatus; reason?: string }
  export class DownloadStalledError extends Error {}
  export interface SelfUpdateDeps {
    currentBuild: number;
    publicKey: string;
    fetchBytes(url: string): Promise<Uint8Array>;
    unzip(bytes: Uint8Array): Record<string, Uint8Array>;
    /** Writes INSTALL_DIR/<path>; resolves the download id once complete with that exact name.
     *  Rejects with DownloadStalledError if still in progress after 15 s (it cancels it first). */
    writeFile(path: string, dataUrl: string): Promise<number>;
    removeFile(id: number): Promise<void>;
    erase(id: number): Promise<void>;
    setDownloadUi(enabled: boolean): Promise<void>;
    readOwnFile(path: string): Promise<string | null>;
    lastToolActivityAt(): Promise<number | null>;
    storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; remove(key: string): Promise<void> };
    reload(): void;
    notify(problem: SelfUpdateProblem, build: number): Promise<void>;
    now(): number;
    randomId(): string;
  }
  export const LOCK_KEY = 'ajb.selfUpdate.lock';
  export const FILES_KEY = 'ajb.selfUpdate.files';
  export const PENDING_KEY = 'ajb.selfUpdate.pendingCleanup';
  export const NOTIFIED_KEY = 'ajb.selfUpdate.notified';
  export function applyUpdate(latest: PublishedBuild, zipUrl: string, deps: SelfUpdateDeps): Promise<SelfUpdateResult>;
  export function cleanupAfterUpdate(deps: SelfUpdateDeps): Promise<void>;
  export function chromeSelfUpdateDeps(): SelfUpdateDeps;
  ```

- [ ] **Step 1: Test que falla** — `tests/unit/background/self-update.test.ts`. Fábrica de deps falsas en memoria
  (disco simulado `Map<path,string>`, ids crecientes, almacenamiento `Map`) y un zip construido con `fflate.zipSync`
  firmado con una clave de test. Casos (cada uno un `it`):
  ```ts
  import { describe, expect, it, vi } from 'vitest';
  import { zipSync, strToU8, unzipSync } from 'fflate';
  import { createHash, generateKeyPairSync, sign } from 'node:crypto';
  import { applyUpdate, cleanupAfterUpdate, DownloadStalledError, FILES_KEY, LOCK_KEY, PENDING_KEY, type SelfUpdateDeps } from '@/background/self-update';

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const PUB = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
  const LATEST = { version: '2.4.0.141', build: 141, sha: 'def5678', publishedAt: '2026-10-05T10:00:00Z' };

  function pkg(files: Record<string, string>, meta = { version: LATEST.version, build: LATEST.build, sha: LATEST.sha }, extra: Record<string, string> = {}, tamper = false) {
    const list = { ...meta, files: Object.entries(files).map(([path, c]) => ({ path, sha256: createHash('sha256').update(c).digest('hex'), size: Buffer.byteLength(c) })) };
    const body = Buffer.from(JSON.stringify(list));
    const sig = sign(null, body, privateKey).toString('base64');
    const entries: Record<string, Uint8Array> = { 'update-files.json': new Uint8Array(body), 'update-files.json.sig': strToU8(sig) };
    for (const [p, c] of Object.entries({ ...files, ...extra })) entries[p] = strToU8(tamper && p.endsWith('.js') ? c + ';evil()' : c);
    return zipSync(entries);
  }
  const FILES = { 'manifest.json': '{"version":"2.4.0.141"}', 'assets/a-2.js': 'a2', 'service-worker-loader.js': 'import "./assets/a-2.js"' };

  function deps(over: Partial<SelfUpdateDeps> = {}, zip = pkg(FILES)) {
    const disk = new Map<string, string>(); const store = new Map<string, unknown>(); const ids = new Map<number, string>();
    let next = 1; const writes: string[] = []; const notes: string[] = [];
    const d: SelfUpdateDeps & { disk: typeof disk; store: typeof store; writes: string[]; notes: string[]; reloaded: number; ui: boolean[] } = {
      disk, store, writes, notes, reloaded: 0, ui: [],
      currentBuild: 140, publicKey: PUB,
      fetchBytes: async () => zip,
      unzip: unzipSync,
      writeFile: async (path, url) => { writes.push(path); disk.set(path, Buffer.from(url.split(',')[1], 'base64').toString()); const id = next++; ids.set(id, path); return id; },
      removeFile: async (id) => { disk.delete(ids.get(id)!); },
      erase: async (id) => { ids.delete(id); },
      setDownloadUi: async (on) => { d.ui.push(on); },
      readOwnFile: async (p) => disk.get(p) ?? null,
      lastToolActivityAt: async () => null,
      storage: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); }, remove: async (k) => { store.delete(k); } },
      reload: () => { d.reloaded++; },
      notify: async (p) => { notes.push(p); },
      now: () => 1_000_000_000,
      randomId: () => 'r1',
      ...over,
    };
    return d;
  }
  ```
  Casos a cubrir (código de cada `it` en el mismo estilo; todos con `await applyUpdate(LATEST, 'https://pod/download', d)`):
  1. aplica: escribe en orden `assets/a-2.js`, `manifest.json`, `service-worker-loader.js` (la sonda va antes), recarga 1 vez,
     deja `PENDING_KEY` y `FILES_KEY`, `ui` = `[false, true]`, sin cerrojo al final. Status `applied`.
  2. `currentBuild: 141` → `up-to-date`, cero escrituras, sin fetch.
  3. cerrojo vigente (`store.set(LOCK_KEY, now - 60_000)`) → `locked`; caducado (`now - 11*60_000`) → aplica.
  4. actividad MCP hace 2 min → `busy`, cero escrituras, cerrojo liberado.
  5. sonda no legible (`readOwnFile: async () => null`) → `not-eligible`, aviso `not-in-downloads`, solo la sonda escrita (y borrada).
  6. sonda colgada (`writeFile` rechaza con `DownloadStalledError` en la primera) → `not-eligible`, aviso `download-prompt`.
  7. firma inválida (otra clave en `publicKey`) → `rejected`, aviso `bad-package`, ninguna escritura salvo la sonda.
  8. hash que no cuadra (`pkg(FILES, undefined, {}, true)`) → `rejected`, ninguna escritura del paquete.
  9. `update-files.json` con `build` 141 pero `LATEST.build` 142 → `rejected`; y `build` ≤ `currentBuild` → `rejected`.
  10. **(Review Focus 3)** zip con `config.json` extra no listado (`extra: {'config.json': '{}'}`) → aplica y `config.json` NO se escribe.
  11. **(Review Focus 2)** `writeFile` falla en la 3.ª llamada → `failed`, aviso `write-failed`, sin `PENDING_KEY`, sin cerrojo, `ui` termina en `true`, sin recarga.
  12. **(Review Focus 5)** aviso único: dos pasadas seguidas con sonda no legible y el mismo build → `notify` llamado 1 vez (usa `NOTIFIED_KEY` = `"<problem>:<build>"`).
  13. **(Review Focus 4)** re-publicación: `currentBuild` 141 y `LATEST.build` 141 → `up-to-date`.
  14. **(Review Focus 1)** `cleanupAfterUpdate`: con `FILES_KEY` anterior `{manifest.json: 1, assets/a-1.js: 2}` y `PENDING_KEY`
      `{build: 141, previous: {manifest.json: 1, assets/a-1.js: 2}, written: {manifest.json: 5, assets/a-2.js: 6}}`, `currentBuild` 141:
      `removeFile` solo de 2 (`assets/a-1.js`), `erase` de 1 y 2, el disco conserva `manifest.json`, borra `PENDING_KEY`.
      Con `currentBuild` 140 (la recarga no cogió la versión nueva) no toca nada.
- [ ] **Step 2: Ver que falla** — `npx vitest run tests/unit/background/self-update.test.ts` → FAIL.
- [ ] **Step 3: Implementar** (`npm install fflate`):
  ```ts
  /**
   * Self-update: an unpacked install living in <Downloads>/agent-jake-browser rewrites itself with
   * chrome.downloads from the signed package the CI publishes, then reloads. Spike 2026-10-05:
   * needs "Ask where to save" off (saveAs:false does not override it) and Developer mode on.
   */
  import { unzipSync } from 'fflate';
  import { CONFIG } from '@/types/config';
  import { UPDATE_PUBLIC_KEY } from '@/config/update-key';
  import { activityLog } from './activity-log';
  import type { PublishedBuild } from './update-check';
  import { FILES_NAME, INSTALL_DIR, SIG_NAME, mimeFor, parseUpdateFiles, sha256Hex, toDataUrl, verifySignature, writeOrder, type UpdateFiles } from './update-package';

  export type SelfUpdateProblem = 'not-in-downloads' | 'download-prompt' | 'bad-package' | 'write-failed';
  export type SelfUpdateStatus = 'applied' | 'up-to-date' | 'locked' | 'busy' | 'not-eligible' | 'rejected' | 'failed';
  export interface SelfUpdateResult { status: SelfUpdateStatus; reason?: string }
  export class DownloadStalledError extends Error {}
  // SelfUpdateDeps exactly as in the Interfaces block above.

  export const LOCK_KEY = 'ajb.selfUpdate.lock';
  export const FILES_KEY = 'ajb.selfUpdate.files';
  export const PENDING_KEY = 'ajb.selfUpdate.pendingCleanup';
  export const NOTIFIED_KEY = 'ajb.selfUpdate.notified';
  const LOCK_MS = 10 * 60_000;
  const IDLE_MS = 5 * 60_000;
  const STALL_MS = 15_000;

  type FileMap = Record<string, number>;
  interface Pending { build: number; previous: FileMap; written: FileMap }

  async function warnOnce(deps: SelfUpdateDeps, problem: SelfUpdateProblem, build: number) {
    const mark = `${problem}:${build}`;
    if ((await deps.storage.get(NOTIFIED_KEY)) === mark) return;
    await deps.notify(problem, build);
    await deps.storage.set(NOTIFIED_KEY, mark);
  }

  async function probe(deps: SelfUpdateDeps): Promise<'ok' | SelfUpdateProblem> {
    const name = `agent-jake-probe-${deps.randomId()}.txt`;
    const token = `probe-${deps.randomId()}`;
    let id: number | undefined;
    try {
      id = await deps.writeFile(name, toDataUrl(new TextEncoder().encode(token), 'text/plain'));
      return (await deps.readOwnFile(name)) === token ? 'ok' : 'not-in-downloads';
    } catch (e) {
      return e instanceof DownloadStalledError ? 'download-prompt' : 'not-in-downloads';
    } finally {
      if (id !== undefined) { await deps.removeFile(id).catch(() => {}); await deps.erase(id).catch(() => {}); }
    }
  }

  async function verifiedPackage(zip: Record<string, Uint8Array>, latest: PublishedBuild, deps: SelfUpdateDeps): Promise<UpdateFiles | null> {
    const body = zip[FILES_NAME]; const sig = zip[SIG_NAME];
    if (!body || !sig) return null;
    if (!await verifySignature(body, new TextDecoder().decode(sig), deps.publicKey)) return null;
    let files: UpdateFiles | null;
    try { files = parseUpdateFiles(JSON.parse(new TextDecoder().decode(body))); } catch { return null; }
    if (!files || files.build !== latest.build || files.build <= deps.currentBuild) return null;
    for (const f of files.files) {
      const bytes = zip[f.path];
      if (!bytes || bytes.length !== f.size || await sha256Hex(bytes) !== f.sha256) return null;
    }
    return files;
  }

  export async function applyUpdate(latest: PublishedBuild, zipUrl: string, deps: SelfUpdateDeps): Promise<SelfUpdateResult> {
    if (latest.build <= deps.currentBuild) return { status: 'up-to-date' };
    const held = await deps.storage.get(LOCK_KEY);
    if (typeof held === 'number' && deps.now() - held < LOCK_MS) return { status: 'locked' };
    await deps.storage.set(LOCK_KEY, deps.now());
    try {
      const last = await deps.lastToolActivityAt();
      if (last !== null && deps.now() - last < IDLE_MS) return { status: 'busy' };

      const eligible = await probe(deps);
      if (eligible !== 'ok') { await warnOnce(deps, eligible, latest.build); return { status: 'not-eligible', reason: eligible }; }

      let files: UpdateFiles | null = null; let zip: Record<string, Uint8Array> = {};
      try { zip = deps.unzip(await deps.fetchBytes(zipUrl)); files = await verifiedPackage(zip, latest, deps); } catch { files = null; }
      if (!files) { await warnOnce(deps, 'bad-package', latest.build); return { status: 'rejected' }; }

      const previous = ((await deps.storage.get(FILES_KEY)) as FileMap | undefined) ?? {};
      const written: FileMap = {};
      await deps.setDownloadUi(false);
      try {
        for (const f of writeOrder(files.files)) written[f.path] = await deps.writeFile(f.path, toDataUrl(zip[f.path], mimeFor(f.path)!));
      } catch (e) {
        await warnOnce(deps, 'write-failed', latest.build);
        return { status: 'failed', reason: String((e as Error)?.message ?? e) };
      } finally {
        await deps.setDownloadUi(true);
      }
      const pending: Pending = { build: files.build, previous, written };
      await deps.storage.set(PENDING_KEY, pending);
      await deps.storage.set(FILES_KEY, written);
      await deps.storage.remove(LOCK_KEY);
      deps.reload();
      return { status: 'applied' };
    } finally {
      await deps.storage.remove(LOCK_KEY);
    }
  }

  export async function cleanupAfterUpdate(deps: SelfUpdateDeps): Promise<void> {
    const pending = (await deps.storage.get(PENDING_KEY)) as Pending | undefined;
    if (!pending || pending.build !== deps.currentBuild) return;
    for (const [path, id] of Object.entries(pending.previous)) {
      if (!(path in pending.written)) await deps.removeFile(id).catch(() => {});
      await deps.erase(id).catch(() => {});
    }
    await deps.storage.remove(PENDING_KEY);
  }
  ```
  `chromeSelfUpdateDeps()` (mismo fichero, al final):
  - `currentBuild: CONFIG.BUILD_NUMBER`, `publicKey: UPDATE_PUBLIC_KEY`, `unzip: unzipSync`
  - `fetchBytes`: `fetch(url, {cache:'no-store', signal: AbortSignal.timeout(30_000)})` → `new Uint8Array(await res.arrayBuffer())`, error si `!res.ok`.
  - `writeFile(path, url)`: `chrome.downloads.download({url, filename: \`${INSTALL_DIR}/${path}\`, conflictAction:'overwrite', saveAs:false})`;
    espera con `chrome.downloads.onChanged` + `chrome.downloads.search({id})` hasta `complete` (valida que
    `item.filename` acaba en `/${INSTALL_DIR}/${path}`, si no `throw new Error('renamed: ' + basename)`), `interrupted` (`throw`), o 15 s
    (`chrome.downloads.cancel(id)` y `throw new DownloadStalledError(path)`).
  - `removeFile`/`erase`: `chrome.downloads.removeFile(id)` / `chrome.downloads.erase({id})`.
  - `setDownloadUi`: `chrome.downloads.setUiOptions({enabled})`.
  - `readOwnFile`: `fetch(chrome.runtime.getURL(path), {cache:'no-store'})` → texto o `null`.
  - `lastToolActivityAt`: la entrada más reciente con `type === 'tool'` de `activityLog` (usar el método de lectura que ya exista, p. ej. `getLatest(50)`; confirmar el orden que devuelve) → `timestamp` o `null`.
  - `storage`: `chrome.storage.local`. `reload`: `setTimeout(() => chrome.runtime.reload(), 300)` (patrón de `browser_reload_extension`).
  - `notify(problem, build)`: `chrome.notifications.create('ajb-self-update-' + problem, {...})` con estos textos:
    `not-in-downloads` → «Agent Jake no puede actualizarse sola: instálala desde Descargas/agent-jake-browser»;
    `download-prompt` → «Agent Jake no puede actualizarse sola: desactiva "Preguntar dónde guardar cada archivo" en los ajustes de Chrome»;
    `bad-package` → «Actualización de Agent Jake rechazada: paquete o firma no válidos»;
    `write-failed` → «La actualización de Agent Jake falló a mitad; se reintenta en 30 min». `contextMessage` = `Build ${build}`.
  - `now: Date.now`, `randomId: () => crypto.randomUUID().slice(0, 8)`.
- [ ] **Step 4: Ver que pasa** — `npx vitest run tests/unit/background/self-update.test.ts` → PASS (14 casos); `npm run typecheck` OK.
- [ ] **Step 5: Commit** — `git add -A src/background/self-update.ts tests/unit/background/self-update.test.ts package.json package-lock.json && git commit -m "feat(self-update): la extensión se reescribe desde el paquete firmado y se recarga"`

### Task 4: Enganche en el service worker, manifest y guardas

**Files:**
- Modify: `src/background/index.ts` (`runUpdateCheck`, arranque del SW)
- Modify: `manifest.json` (permisos `downloads`, `downloads.ui`)
- Modify: `scripts/check-deltas.sh` (asercion nueva)
- Modify: `src/background/update-check.ts` (comentario de cabecera: ya no dice que el CI actualiza x86 y Mac)
- Test: `tests/unit/background/self-update-wiring.test.ts`

**Interfaces:**
- Consumes: `applyUpdate`, `cleanupAfterUpdate`, `chromeSelfUpdateDeps` (Task 3); `checkForUpdate` (existente).
- Produces: `maybeSelfUpdate(state: UpdateState | null, deps?: SelfUpdateDeps): Promise<SelfUpdateResult | null>` exportada desde `self-update.ts` (sólo llama a `applyUpdate` si `state?.available && state.latest && state.downloadUrl`).

- [ ] **Step 1: Test que falla** — `self-update-wiring.test.ts`: `maybeSelfUpdate(null)` → `null`; con `available:false` → `null` sin llamar a deps;
  con `available:true` → llama a `applyUpdate` con `state.latest` y `state.downloadUrl` (spy sobre `deps.fetchBytes`).
- [ ] **Step 2: Ver que falla.**
- [ ] **Step 3: Implementar.** En `self-update.ts`:
  ```ts
  export async function maybeSelfUpdate(state: UpdateState | null, deps: SelfUpdateDeps = chromeSelfUpdateDeps()): Promise<SelfUpdateResult | null> {
    if (!state?.available || !state.latest || !state.downloadUrl) return null;
    return applyUpdate(state.latest, state.downloadUrl, deps);
  }
  ```
  En `index.ts`, dentro de `runUpdateCheck` tras `checkForUpdate`:
  ```ts
  const result = await maybeSelfUpdate(state);
  if (result) log.info(`[SelfUpdate] ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
  ```
  y a nivel de módulo (arranque de cada SW): `void cleanupAfterUpdate(chromeSelfUpdateDeps()).catch((e) => log.warn('[SelfUpdate] cleanup failed:', e));`
  `manifest.json`: añadir `"downloads"` y `"downloads.ui"` a `permissions`.
  `check-deltas.sh`: `chk "17 autoactualización firmada" bash -c 'test -f src/background/self-update.ts && grep -q "\"downloads.ui\"" manifest.json && grep -q PINNED_UPDATE_PUBLIC_KEY src/config/update-key.ts'`
- [ ] **Step 4: Ver que pasa** — `npm run typecheck && npm run test:unit && bash scripts/check-deltas.sh` → todo verde.
- [ ] **Step 5: Commit** — `git commit -am "feat(self-update): enganche en el SW, permisos downloads y guarda en check-deltas"`

### Task 5: Publicación en CI (`scripts/publicar.sh` + job `publicar`)

**Files:**
- Create: `scripts/publicar.sh`
- Modify: `.github/workflows/ci.yml` (sustituye el job `desplegar` por `publicar`)

**Interfaces:**
- Consumes: `scripts/update-files.mjs sign|verify` (Task 2), `PINNED_UPDATE_PUBLIC_KEY` (Task 1).
- Produces: `bash scripts/publicar.sh [--dry-run]`. En `--dry-run` firma con una clave efímera, verifica y no sube.

- [ ] **Step 1: Implementar** `scripts/publicar.sh` (bash, `set -euo pipefail`), pasos:
  1. `build=$(git rev-list --count HEAD)`; `sha=$(git rev-parse --short HEAD)`; `tmp=$(mktemp -d)`; `trap 'rm -rf "$tmp"' EXIT`.
  2. `git archive HEAD | tar -x -C "$tmp/src"`; `ln -s "$PWD/node_modules" "$tmp/src/node_modules"`.
  3. Build neutra: `env -u VITE_WS_HOST -u VITE_WS_PORT -u VITE_WS_PATH -u VITE_WS_SECURE -u VITE_WS_TOKEN -u VITE_COPILOT_BASE_URL -u VITE_COPILOT_API_KEY -u VITE_UPDATE_PUBLIC_KEY VITE_BUILD_NUMBER=$build VITE_BUILD_SHA=$sha VITE_LATEST_URL=https://browser-mcp.lan.e-dani.com/download/latest.json npx vite build --outDir "$tmp/dist" --emptyOutDir` (desde `$tmp/src`).
  4. Sella la versión: `jq --arg v "$(jq -r .version "$tmp/dist/manifest.json" | cut -d. -f1-3).$build" '.version=$v'` sobre `manifest.json`.
  5. Guardas: el config compilado contiene `WS_TOKEN:""`, `COPILOT_API_KEY:""` y la clave pinneada (`grep -rqF "$PINNED" "$tmp/dist/assets"`, con `PINNED` leído de `src/config/update-key.ts`); si no, `exit 1`.
  6. `rm -rf "$tmp/dist/.vite"`.
  7. Firma: en `--dry-run`, clave efímera generada con node en una variable; si no, `AJB_UPDATE_SIGNING_KEY` del entorno (falla si vacía). `node scripts/update-files.mjs sign "$tmp/dist" --version "$version" --build "$build" --sha "$sha"`, luego `verify` con la pública que toca (efímera en dry-run, `PINNED` en real).
  8. Zip con `python3 -c 'import shutil,sys; shutil.make_archive(sys.argv[1],"zip",sys.argv[2])' "$tmp/agent-jake-browser-extension" "$tmp/dist"` y `latest.json` con `jq -n` (`version`, `build`, `sha`, `publishedAt`).
  9. Solo real: subida al pod copiando `publicar()` de `agent-browser-sync.sh` (pod Running sin `deletionTimestamp` en ns `agentjake-browser`, `kubectl cp` a `/data/extension/.zip.tmp` y `.latest.tmp`, `mv` atómico, zip primero), `export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"`, y comprobación final de que `https://browser-mcp.lan.e-dani.com/download/latest.json` anuncia `$build`.
- [ ] **Step 2: Probar** — `bash scripts/publicar.sh --dry-run` → termina con `verified N files` y `dry-run: no se sube nada`, exit 0. Prueba negativa: `VITE_WS_TOKEN=x bash scripts/publicar.sh --dry-run` sigue saliendo con `WS_TOKEN:""` (el `env -u` lo quita).
- [ ] **Step 3: CI.** En `.github/workflows/ci.yml`, sustituir el job `desplegar` por:
  ```yaml
  # Tras cada merge a main se publica la build neutra y firmada en el pod; cada extensión
  # instalada en <Descargas>/agent-jake-browser se reescribe sola desde ella (self-update.ts).
  publicar:
    name: Publicar la build firmada en el pod
    needs: [build-test, deltas]
    # Solo push a main. NUNCA pull_request: el secreto de firma y el runner del host no se exponen a PRs.
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    # Runner del x86 solo porque tiene kubectl hacia el pod de agentjake-browser.
    runs-on: [self-hosted, x86, agent-browser]
    timeout-minutes: 20
    concurrency: { group: publicar-extension, cancel-in-progress: false }
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with: { persist-credentials: false, fetch-depth: 0 }
      - name: npm ci
        run: npm ci
        env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }
      - name: Publicar
        run: bash scripts/publicar.sh
        env: { AJB_UPDATE_SIGNING_KEY: '${{ secrets.AJB_UPDATE_SIGNING_KEY }}' }
  ```
  (`fetch-depth: 0` es imprescindible: `rev-list --count` necesita la historia entera.) Añadir al job `build-test` un paso
  `bash scripts/publicar.sh --dry-run` para que cada PR pruebe la firma.
- [ ] **Step 4: Commit** — `git add scripts/publicar.sh .github/workflows/ci.yml && git commit -m "ci: publicar la build firmada sustituye a desplegar"`

### Task 6: Prueba de extremo a extremo en Chrome real (perfil desechable)

**Files:**
- Create: `scripts/e2e-self-update.mjs` (manual, no corre en CI)

**Interfaces:**
- Consumes: todo lo anterior; reutiliza la técnica del spike (`scratchpad/spike-selfupdate/run.mjs`).

- [ ] **Step 1: Implementar** el arnés: construye dos builds desde el árbol de trabajo con una clave de test
  (`VITE_UPDATE_PUBLIC_KEY`), A = build 9000 y B = 9001, ambas con `VITE_LATEST_URL=http://127.0.0.1:<port>/download/latest.json`;
  firma B con `update-files.mjs`; sirve `latest.json` (build 9001) y el zip B con un `http.createServer` en 127.0.0.1; lanza
  Google Chrome con `--user-data-dir` desechable (Preferences: `download.default_directory=<tmp>/dl`, `prompt_for_download=false`),
  `--enable-unsafe-extension-debugging --remote-debugging-port=<libre, nunca 9222>`, `--headless=new`; activa el modo
  desarrollador (`chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true})` desde `chrome://extensions`, como el spike);
  copia A a `<tmp>/dl/agent-jake-browser` y la carga con `Extensions.loadUnpacked`. `onInstalled` dispara la comprobación.
- [ ] **Step 2: Aserciones** (exit 1 si alguna falla): en ≤ 90 s el SW nuevo responde `chrome.runtime.getManifest().version`
  terminado en `.9001`; `chrome.storage.local['ajb.selfUpdate.files']` tiene todas las rutas de B; un fichero de A que no está en B
  ya no existe en disco; no queda `ajb.selfUpdate.lock` ni `pendingCleanup`. Variante negativa (`--tamper`): zip B con un `.js`
  alterado → la versión sigue en `.9000` y el disco no cambia.
- [ ] **Step 3: Ejecutar** `node scripts/e2e-self-update.mjs && node scripts/e2e-self-update.mjs --tamper` → ambos exit 0. Matar solo los PIDs propios.
- [ ] **Step 4: Commit** — `git add scripts/e2e-self-update.mjs && git commit -m "test(self-update): arnés e2e con Chrome desechable"`

### Task 7: Documentación y PR

**Files:**
- Modify: `ARCHITECTURE.md` (CI, «Aviso de versión nueva» → «Autoactualización», provisión del copiloto), `README.md` (instalación en `Descargas/agent-jake-browser`, condiciones R1/R2, migración)

- [ ] **Step 1:** Actualizar docs: CI = `publicar`; autoactualización (flujo de la spec §3); la build publicada no siembra copiloto (Opciones); requisitos: modo desarrollador y «Preguntar dónde guardar» desactivado; instalación/migración (spec §4).
- [ ] **Step 2:** `npm run typecheck && npm run test:unit && bash scripts/check-deltas.sh && bash scripts/publicar.sh --dry-run` → todo verde.
- [ ] **Step 3:** Commit, push de `feat/autoactualizacion`, PR a `main` con resumen, evidencia de tests y e2e, y el plan de migración/retirada. Esperar CI + bot de review; atender comentarios.

### Después del merge (operación, no código; el PMO coordina)

- F1: verificar que el job `publicar` corre y que `latest.json` anuncia la build nueva; bajar el zip y `update-files.mjs verify` con la clave pinneada.
- F2: migrar el Mac de CloudBlue (zip en `~/Downloads/agent-jake-browser`, cargarla por CDP, Daniel quita la vieja y mete URL/token en Opciones), luego x86 y MacBook Air; actualizar `AGENT_BROWSER_CONNECTION_LABELS`.
- F3: un merge cualquiera y comprobar que los navegadores migrados se reescriben solos.
- F4: PR en `x86-host-runtime-pocharlies` que borra `agent-browser-sync*`; desinstalar `com.pocharlies.agent-browser-update` de este Mac.
