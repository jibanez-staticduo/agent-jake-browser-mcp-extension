import { STORAGE_KEYS } from '@/config/runtime';
import { isSetupInstance, SETUP_INSTANCES, type SetupInstance, type SetupPairingInfo } from '@/config/setup-instances';
import { COPILOT_PROVISIONED_KEY, COPILOT_SETTINGS_KEY, type CopilotSettings } from '@/types/copilot';
import { normalizeCopilotSettings } from '@/utils/copilot-settings';
import { isSetupSecret, requestSetup, requestSetupStatus } from './setup-client';
import { updateSettings } from './settings-update';

const PENDING_SETUP = 'ajb.pendingSetup';
const TTL_MS = 5 * 60 * 1000;
const POLL_MS = 2000;

type PendingSetup = {
  instance: SetupInstance;
  approvalCode: string;
  pollSecret: string;
  expiresAt: number;
};
type Attempt = {
  controller: AbortController;
  pending?: PendingSetup;
  timer?: ReturnType<typeof setTimeout>;
};

let active: Attempt | undefined;
let info: SetupPairingInfo = { state: 'idle' };
let onApproved: (() => void) | undefined;

export function setOnSetupApproved(callback: () => void): void {
  onApproved = callback;
}

export function getSetupPairingInfo(): SetupPairingInfo {
  return info;
}

async function clearAttempt(next: SetupPairingInfo): Promise<void> {
  active?.controller.abort();
  clearTimeout(active?.timer);
  active = undefined;
  info = next;
  await chrome.storage.local.remove(PENDING_SETUP);
}

// The caller holds the same settings lock as the approval commit.
export function cancelSetup(): Promise<void> {
  return clearAttempt({ state: 'idle' });
}

async function openApproval(pending: PendingSetup, windowId?: number): Promise<void> {
  const url = new URL('/setup', SETUP_INSTANCES[pending.instance].origin);
  url.searchParams.set('code', pending.approvalCode);
  await chrome.tabs.create({ url: url.href, ...(windowId === undefined ? {} : { windowId }) });
}

function schedulePoll(attempt: Attempt, delay = POLL_MS): void {
  attempt.timer = setTimeout(() => { void poll(attempt); }, delay);
}

async function poll(attempt: Attempt): Promise<void> {
  const pending = attempt.pending;
  if (!pending || attempt !== active) return;
  const { instance, pollSecret, expiresAt } = pending;

  try {
    const status = Date.now() >= expiresAt
      ? { state: 'expired' } as const
      : await requestSetupStatus(instance, pollSecret, attempt.controller.signal);

    await updateSettings(async () => {
      if (attempt !== active) return;
      if (status?.state === 'expired') {
        await clearAttempt({ state: 'expired', instance });
      } else if (status?.state === 'approved') {
        const { wsUrl, token, label, connectionId, baseUrl, apiKey, mcpUrl, mcpToken } = status.config;
        try {
          const stored = await chrome.storage.local.get(COPILOT_SETTINGS_KEY);
          const previous = stored[COPILOT_SETTINGS_KEY] as Partial<CopilotSettings> | undefined;
          const settings = normalizeCopilotSettings({
            ...previous, baseUrl, apiKey, apiKeyUrl: baseUrl, mcpUrl, mcpToken, mcpTokenUrl: mcpUrl,
            vision: true, maxSteps: 200, stepsView: 'extended',
          });
          // Clear the resume grant in the same write as the new identity and settings.
          await chrome.storage.local.set({
            [PENDING_SETUP]: null,
            [STORAGE_KEYS.connectionId]: connectionId,
            [STORAGE_KEYS.serverUrl]: wsUrl,
            [STORAGE_KEYS.token]: token,
            [STORAGE_KEYS.tokenUrl]: wsUrl,
            [STORAGE_KEYS.label]: label,
            [STORAGE_KEYS.serverRevision]: crypto.randomUUID(),
            [COPILOT_SETTINGS_KEY]: settings,
            [COPILOT_PROVISIONED_KEY]: {},
          });
        } catch {
          // The server can return the same grant until it expires.
          info = { state: 'pending', instance, error: 'No se pudo guardar la configuración. Reintentando…' };
          schedulePoll(attempt);
          return;
        }
        info = { state: 'approved', instance };
        active = undefined;
        onApproved?.();
      } else {
        schedulePoll(attempt);
      }
    });
  } catch {
    await updateSettings(async () => {
      if (attempt !== active) return;
      await clearAttempt({
        state: 'error', instance, error: 'No se pudo aplicar la configuración. Vuelve a emparejar el navegador.',
      });
    }).catch(() => undefined);
  }
}

export async function startSetup(instance: SetupInstance, beforeStart: () => Promise<void>, windowId?: number): Promise<void> {
  const attempt = await updateSettings(async () => {
    if (info.instance === instance && info.state === 'starting') return;
    if (active?.pending?.instance === instance && Date.now() < active.pending.expiresAt) {
      await openApproval(active.pending, windowId).catch(() => { throw new Error('No se pudo abrir la página de aprobación.'); });
      return;
    }
    await cancelSetup();
    await beforeStart();
    const next = { controller: new AbortController() };
    active = next;
    info = { state: 'starting', instance };
    return next as Attempt;
  });
  if (!attempt) return;

  try {
    const expiresAt = Date.now() + TTL_MS;
    const grant = await requestSetup(instance, attempt.controller.signal);
    await updateSettings(async () => {
      if (attempt !== active) return;
      const pending = { ...grant, instance, expiresAt };
      await chrome.storage.local.set({ [PENDING_SETUP]: pending });
      attempt.pending = pending;
      info = { state: 'pending', instance };
      try {
        await openApproval(pending, windowId);
      } finally {
        schedulePoll(attempt, 0);
      }
    });
  } catch {
    await updateSettings(async () => {
      if (attempt !== active) return;
      if (attempt.pending) {
        info = { state: 'pending', instance, error: 'No se pudo abrir la aprobación. Abre la página de nuevo.' };
      } else {
        await clearAttempt({
          state: 'error', instance, error: 'No se pudo iniciar la configuración. Comprueba el acceso desde la LAN.',
        });
      }
    });
  }
}

export function resumeSetup(): Promise<boolean> {
  return updateSettings(async () => {
    if (active) return true;
    const stored = await chrome.storage.local.get(PENDING_SETUP);
    const pending = stored[PENDING_SETUP] as Partial<PendingSetup> | null | undefined;
    if (!pending) return false;
    if (!isSetupInstance(pending.instance) || !isSetupSecret(pending.approvalCode) || !isSetupSecret(pending.pollSecret)
      || pending.approvalCode === pending.pollSecret || !Number.isFinite(pending.expiresAt)) {
      await cancelSetup();
      return false;
    }
    if (Date.now() >= pending.expiresAt!) {
      await clearAttempt({ state: 'expired', instance: pending.instance });
      return false;
    }
    const attempt = { pending: pending as PendingSetup, controller: new AbortController() };
    active = attempt;
    info = { state: 'pending', instance: pending.instance };
    schedulePoll(attempt, 0);
    return true;
  });
}
