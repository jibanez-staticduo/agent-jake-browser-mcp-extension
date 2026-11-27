/**
 * Browser pairing flow (F-Descarga).
 *
 * When no effective token exists but the server is reachable, the extension
 * generates a one-time OTP, registers it with POST /pair/start, and polls
 * GET /pair/status until the user approves the link on the server mini-web.
 * On approval the emitted token is stored in chrome.storage.local
 * (`ajb.token`) and the WebSocket is reloaded so the handshake uses it.
 *
 * Contract (see PLAN-agent-jake-browser.md):
 *   POST <httpOrigin>/pair/start   {otp, connectionId}
 *   GET  <httpOrigin>/pair?otp=    approval page (human)
 *   GET  <httpOrigin>/pair/status?otp=  {state, token?} polled by us
 */

import {
  STORAGE_KEYS,
  loadBundleConfig,
  getEffectiveConfig,
  hasStoredServerUrl,
  httpOrigin,
  buildDisplayUrl,
} from '@/config/runtime';
import { SETUP_INSTANCES } from '@/config/setup-instances';
import { log } from '@/utils/logger';
import { updateSettings } from './settings-update';

const OTP_LENGTH = 8;
// Ambiguity-free alphabet (no 0/O/1/I).
const OTP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const POLL_INTERVAL_MS = 2000;
// Server TTL for pending OTPs is 10 minutes; stop slightly after it.
const PAIRING_TTL_MS = 11 * 60 * 1000;

export type PairingStatusState = 'idle' | 'pending' | 'approved' | 'expired' | 'error';

export interface PairingInfo {
  state: PairingStatusState;
  otp?: string;
  approveUrl?: string;
  error?: string;
}

interface ActivePairing {
  otp: string;
  origin: string;
  wsUrl: string;
  state: PairingStatusState;
  error?: string;
  startedAt: number;
  pollTimer: ReturnType<typeof setInterval> | null;
}

let active: ActivePairing | null = null;
let onTokenApproved: (() => void) | null = null;

export function setOnTokenApproved(callback: () => void): void {
  onTokenApproved = callback;
}

export function generateOtp(): string {
  const bytes = new Uint8Array(OTP_LENGTH);
  crypto.getRandomValues(bytes);
  let otp = '';
  for (const byte of bytes) {
    otp += OTP_ALPHABET[byte % OTP_ALPHABET.length];
  }
  return otp;
}

function buildApproveUrl(origin: string, otp: string): string {
  return `${origin}/pair?otp=${encodeURIComponent(otp)}`;
}

export function getPairingInfo(): PairingInfo {
  if (!active) {
    return { state: 'idle' };
  }
  const info: PairingInfo = { state: active.state, otp: active.otp };
  if (active.state !== 'error') {
    info.approveUrl = buildApproveUrl(active.origin, active.otp);
  }
  if (active.error) {
    info.error = active.error;
  }
  return info;
}

function stopPolling(): void {
  if (active?.pollTimer) {
    clearInterval(active.pollTimer);
    active.pollTimer = null;
  }
}

export function cancelPairing(): void {
  stopPolling();
  active = null;
}

async function storePairCode(otp: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.pairCode]: otp });
}

export async function clearPairCode(): Promise<void> {
  await chrome.storage.local.remove([STORAGE_KEYS.pairCode]);
}

async function finishApproved(attempt: ActivePairing, token: string): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.token]: token,
    [STORAGE_KEYS.tokenUrl]: attempt.wsUrl,
    [STORAGE_KEYS.serverRevision]: crypto.randomUUID(),
  });
  await clearPairCode();
  if (active) {
    active.state = 'approved';
  }
  stopPolling();
  log.info('[Pairing] Approved - token stored, reloading connection');
  onTokenApproved?.();
}

/**
 * Single poll of /pair/status. Exported for tests and popup-triggered checks.
 */
let polling: ActivePairing | undefined;

export async function pollPairStatusOnce(): Promise<'pending' | 'approved' | 'expired'> {
  const attempt = active;
  if (!attempt || attempt.state !== 'pending' || polling === attempt) return 'pending';
  polling = attempt;

  try {
    const url = `${attempt.origin}/pair/status?otp=${encodeURIComponent(attempt.otp)}`;
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      throw new Error(`pair/status failed: HTTP ${response.status}`);
    }
    const body = await response.json() as { state?: string; token?: string };

    return await updateSettings(async () => {
      if (attempt !== active) return 'pending';
      if (body.state === 'approved' && typeof body.token === 'string' && body.token) {
        await finishApproved(attempt, body.token);
        return 'approved';
      }
      if (body.state === 'expired' || Date.now() - attempt.startedAt > PAIRING_TTL_MS) {
        attempt.state = 'expired';
        stopPolling();
        await clearPairCode();
        return 'expired';
      }
      return 'pending';
    });
  } finally {
    if (polling === attempt) polling = undefined;
  }
}

function schedulePolling(): void {
  stopPolling();
  if (!active) return;
  active.pollTimer = setInterval(() => {
    pollPairStatusOnce().catch(() => {
      // Transient network errors keep the flow pending; the popup shows
      // them only if pairing finally expires.
      log.warn('[Pairing] Status poll failed');
    });
  }, POLL_INTERVAL_MS);
}

/**
 * Start a pairing flow against the effective server. Returns the OTP and the
 * approval link; polling runs in the background until approved/expired.
 */
export async function startPairing(): Promise<{ otp: string; approveUrl: string }> {
  if (active?.state === 'pending') {
    return {
      otp: active.otp,
      approveUrl: buildApproveUrl(active.origin, active.otp),
    };
  }

  const cfg = await getEffectiveConfig();
  const origin = httpOrigin(cfg);
  const wsUrl = buildDisplayUrl(cfg);
  const otp = generateOtp();

  const response = await fetch(`${origin}/pair/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ otp, connectionId: cfg.connectionId }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    active = {
      otp,
      origin,
      wsUrl,
      state: 'error',
      error: `pair/start failed: HTTP ${response.status}`,
      startedAt: Date.now(),
      pollTimer: null,
    };
    throw new Error(active.error);
  }

  await storePairCode(otp);
  active = { otp, origin, wsUrl, state: 'pending', startedAt: Date.now(), pollTimer: null };
  schedulePolling();
  log.info('[Pairing] Manual approval requested');

  return { otp, approveUrl: buildApproveUrl(origin, otp) };
}

/**
 * Resume or auto-start pairing after a service-worker restart:
 * - a stored `ajb.pairCode` means a flow was pending → resume polling;
 * - otherwise start only when the user configured a server URL and no
 *   effective token exists (avoids hammering servers without pairing on).
 */
export async function maybeAutoStartPairing(): Promise<void> {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.pairCode]);
  const pendingCode = typeof stored[STORAGE_KEYS.pairCode] === 'string'
    ? (stored[STORAGE_KEYS.pairCode] as string).trim()
    : '';
  const cfg = await getEffectiveConfig();

  if (pendingCode && !cfg.token) {
    const origin = httpOrigin(cfg);
    active = {
      otp: pendingCode,
      origin,
      wsUrl: buildDisplayUrl(cfg),
      state: 'pending',
      startedAt: Date.now(),
      pollTimer: null,
    };
    schedulePolling();
    log.info('[Pairing] Resumed pending manual approval');
    return;
  }

  if (pendingCode) {
    // Approved elsewhere while the SW was asleep.
    await clearPairCode();
    return;
  }

  if (cfg.token) return;
  // Auto-pair only against a URL the user or the package opted into, never
  // against the bare build default (a LAN server would get spammed and the
  // open-LAN mode must keep working without pairing).
  if (!(await hasStoredServerUrl()) && (await loadBundleConfig()) === null) return;
  const origin = httpOrigin(cfg);
  if (Object.values(SETUP_INSTANCES).some((instance) => instance.origin === origin)) return;

  try {
    await startPairing();
  } catch (error) {
    log.warn('[Pairing] Auto-start failed:', error);
  }
}
