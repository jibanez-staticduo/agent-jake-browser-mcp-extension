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
  getEffectiveConfig,
  hasStoredServerUrl,
  httpOrigin,
} from '@/config/runtime';
import { log } from '@/utils/logger';

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

async function clearPairCode(): Promise<void> {
  await chrome.storage.local.remove([STORAGE_KEYS.pairCode]);
}

async function finishApproved(token: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.token]: token });
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
export async function pollPairStatusOnce(): Promise<'pending' | 'approved' | 'expired'> {
  if (!active) return 'pending';

  const url = `${active.origin}/pair/status?otp=${encodeURIComponent(active.otp)}`;
  const response = await fetch(url, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`pair/status failed: HTTP ${response.status}`);
  }
  const body = await response.json() as { state?: string; token?: string };

  if (body.state === 'approved' && typeof body.token === 'string' && body.token) {
    await finishApproved(body.token);
    return 'approved';
  }
  if (body.state === 'expired') {
    if (active) {
      active.state = 'expired';
    }
    stopPolling();
    await clearPairCode();
    return 'expired';
  }

  if (Date.now() - active.startedAt > PAIRING_TTL_MS) {
    active.state = 'expired';
    stopPolling();
    await clearPairCode();
    return 'expired';
  }

  return 'pending';
}

function schedulePolling(): void {
  stopPolling();
  if (!active) return;
  active.pollTimer = setInterval(() => {
    pollPairStatusOnce().catch((error) => {
      // Transient network errors keep the flow pending; the popup shows
      // them only if pairing finally expires.
      log.warn('[Pairing] status poll failed:', error);
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
  const otp = generateOtp();

  const response = await fetch(`${origin}/pair/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ otp, connectionId: cfg.connectionId }),
  });

  if (!response.ok) {
    active = {
      otp,
      origin,
      state: 'error',
      error: `pair/start failed: HTTP ${response.status}`,
      startedAt: Date.now(),
      pollTimer: null,
    };
    throw new Error(active.error);
  }

  await storePairCode(otp);
  active = { otp, origin, state: 'pending', startedAt: Date.now(), pollTimer: null };
  schedulePolling();
  log.info(`[Pairing] OTP ${otp} registered at ${origin}`);

  return { otp, approveUrl: buildApproveUrl(origin, otp) };
}

/**
 * Resume or auto-start pairing after a service-worker restart:
 * - a stored `ajb.pairCode` means a flow was pending → resume polling;
 * - otherwise start only when the user configured a server URL and no
 *   effective token exists (avoids hammering servers without pairing on).
 */
export async function maybeAutoStartPairing(): Promise<void> {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.pairCode, STORAGE_KEYS.token]);
  const pendingCode = typeof stored[STORAGE_KEYS.pairCode] === 'string'
    ? (stored[STORAGE_KEYS.pairCode] as string).trim()
    : '';
  const hasToken = typeof stored[STORAGE_KEYS.token] === 'string'
    && (stored[STORAGE_KEYS.token] as string) !== '';

  if (pendingCode && !hasToken) {
    const cfg = await getEffectiveConfig();
    const origin = httpOrigin(cfg);
    active = {
      otp: pendingCode,
      origin,
      state: 'pending',
      startedAt: Date.now(),
      pollTimer: null,
    };
    schedulePolling();
    log.info(`[Pairing] Resumed pending pairing for OTP ${pendingCode}`);
    return;
  }

  if (pendingCode) {
    // Approved elsewhere while the SW was asleep.
    await clearPairCode();
    return;
  }

  if (hasToken) return;
  if (!(await hasStoredServerUrl())) return;

  try {
    await startPairing();
  } catch (error) {
    log.warn('[Pairing] Auto-start failed:', error);
  }
}
