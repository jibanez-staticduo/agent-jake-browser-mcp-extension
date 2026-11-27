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
  getServerSettings,
  httpOrigin,
} from '@/config/runtime';
import { SETUP_INSTANCES } from '@/config/setup-instances';
import { log } from '@/utils/logger';
import { updateSettings } from './settings-update';

const OTP_LENGTH = 8;
// Ambiguity-free alphabet (no 0/O/1/I).
const OTP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const POLL_INTERVAL_MS = 2000;
const PAIR_REQUEST_TIMEOUT_MS = 10_000;
const PAIRING_TTL_MS = 10 * 60 * 1000;
// The server starts its TTL after registration and may retain an approved token.
// Allow for the registration request, the next poll, and its response.
const PAIRING_RECOVERY_MS = PAIR_REQUEST_TIMEOUT_MS + POLL_INTERVAL_MS + PAIR_REQUEST_TIMEOUT_MS;

export type PairingStatusState = 'idle' | 'pending' | 'approved' | 'expired' | 'error';

export interface PairingInfo {
  state: PairingStatusState;
  otp?: string;
  approveUrl?: string;
  error?: string;
}

interface PendingPairing {
  otp: string;
  wsUrl: string;
  serverRevision: string | null;
  connectionId: string;
  startedAt: number;
}

interface ActivePairing extends PendingPairing {
  origin: string;
  state: PairingStatusState;
  error?: string;
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

export async function clearPairCode(): Promise<void> {
  await chrome.storage.local.remove([STORAGE_KEYS.pairCode]);
}

type ServerSettings = Awaited<ReturnType<typeof getServerSettings>>;

function isCurrent(pending: PendingPairing, { effectiveUrl, serverRevision, config }: ServerSettings): boolean {
  return pending.wsUrl === effectiveUrl && pending.serverRevision === serverRevision
    && pending.connectionId === config.connectionId;
}

function canRecover({ startedAt }: PendingPairing): boolean {
  const age = Date.now() - startedAt;
  return age >= 0 && age < PAIRING_TTL_MS + PAIRING_RECOVERY_MS;
}

function readPendingPairing(value: unknown): PendingPairing | null {
  if (!value || typeof value !== 'object') return null;
  const pending = value as Partial<PendingPairing>;
  if (typeof pending.otp !== 'string' || !/^[A-HJ-NP-Z2-9]{8}$/.test(pending.otp)
    || typeof pending.wsUrl !== 'string' || typeof pending.connectionId !== 'string'
    || pending.serverRevision !== null && typeof pending.serverRevision !== 'string'
    || typeof pending.startedAt !== 'number' || !Number.isSafeInteger(pending.startedAt)) return null;
  return pending as PendingPairing;
}

async function expire(attempt: ActivePairing): Promise<'expired' | 'pending'> {
  if (attempt !== active) return 'pending';
  attempt.state = 'expired';
  stopPolling();
  await clearPairCode();
  return 'expired';
}

async function finishApproved(attempt: ActivePairing, token: string): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.pairCode]: null,
    [STORAGE_KEYS.token]: token,
    [STORAGE_KEYS.tokenUrl]: attempt.wsUrl,
    [STORAGE_KEYS.serverRevision]: crypto.randomUUID(),
  });
  attempt.state = 'approved';
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
    const current = await getServerSettings();
    if (attempt !== active) return 'pending';
    if (!canRecover(attempt) || !isCurrent(attempt, current)) return await updateSettings(() => expire(attempt));
    const url = `${attempt.origin}/pair/status?otp=${encodeURIComponent(attempt.otp)}`;
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(PAIR_REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`pair/status failed: HTTP ${response.status}`);
    }
    const body = await response.json() as { state?: string; token?: string };

    return await updateSettings(async () => {
      if (attempt !== active) return 'pending';
      if (body.state === 'expired' || !canRecover(attempt)) {
        return expire(attempt);
      }
      if (body.state === 'approved' && typeof body.token === 'string' && body.token) {
        const latest = await getServerSettings();
        if (attempt !== active) return 'pending';
        if (!isCurrent(attempt, latest) || !canRecover(attempt)) return expire(attempt);
        await finishApproved(attempt, body.token);
        return 'approved';
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
  const current = await getServerSettings();
  if (active?.state === 'pending' && isCurrent(active, current) && canRecover(active)) {
    return {
      otp: active.otp,
      approveUrl: buildApproveUrl(active.origin, active.otp),
    };
  }

  if (active?.state === 'pending') await expire(active);
  const origin = httpOrigin(current.config);
  const otp = generateOtp();
  const pending: PendingPairing = {
    otp,
    wsUrl: current.effectiveUrl,
    serverRevision: current.serverRevision,
    connectionId: current.config.connectionId,
    startedAt: Date.now(),
  };

  const response = await fetch(`${origin}/pair/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ otp, connectionId: pending.connectionId }),
    redirect: 'error',
    signal: AbortSignal.timeout(PAIR_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    active = {
      ...pending,
      origin,
      state: 'error',
      error: `pair/start failed: HTTP ${response.status}`,
      pollTimer: null,
    };
    throw new Error(active.error);
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.pairCode]: pending });
  active = { ...pending, origin, state: 'pending', pollTimer: null };
  schedulePolling();
  log.info('[Pairing] Manual approval requested');

  return { otp, approveUrl: buildApproveUrl(origin, otp) };
}

/**
 * Resume or auto-start pairing after a service-worker restart:
 * Resume a current attempt even when it was started to renew an existing token.
 * New automatic attempts require an opted-in server and an empty effective token.
 */
export async function maybeAutoStartPairing(): Promise<void> {
  if (active?.state === 'pending') return;
  const stored = await chrome.storage.local.get([STORAGE_KEYS.pairCode]);
  const current = await getServerSettings();
  const origin = httpOrigin(current.config);
  const raw = stored[STORAGE_KEYS.pairCode];
  const pending = readPendingPairing(raw);
  if (pending && isCurrent(pending, current) && canRecover(pending)) {
    active = { ...pending, origin, state: 'pending', pollTimer: null };
    schedulePolling();
    log.info('[Pairing] Resumed pending manual approval');
    return;
  }

  if (raw !== undefined && raw !== null) {
    // A bare legacy OTP has no recorded destination or start time.
    await clearPairCode();
    return;
  }

  if (current.config.token) return;
  // Auto-pair only against a URL the user or the package opted into, never
  // against the bare build default (a LAN server would get spammed and the
  // open-LAN mode must keep working without pairing).
  if (current.config.source === 'build') return;
  if (Object.values(SETUP_INSTANCES).some((instance) => instance.origin === origin)) return;

  try {
    await startPairing();
  } catch (error) {
    log.warn('[Pairing] Auto-start failed:', error);
  }
}
