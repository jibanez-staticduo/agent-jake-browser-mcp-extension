import { buildDisplayUrl, normalizeLabel, resolveServer, STORAGE_KEYS } from '@/config/runtime';
import { isSetupInstance, SETUP_INSTANCES, type SetupInstance, type SetupPairingInfo } from '@/config/setup-instances';
import { COPILOT_PROVISIONED_KEY, COPILOT_SETTINGS_KEY, type CopilotSettings } from '@/types/copilot';
import { normalizeCopilotSettings } from '@/utils/copilot-settings';
import { isSetupIdentity, isSetupSecret, requestSetup, requestSetupStatus, type SetupConfig } from './setup-client';
import { updateSettings } from './settings-update';

const PENDING_SETUP = 'ajb.pendingSetup';
const SAVED_SETUPS = 'ajb.savedSetups';
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

type SavedSetups = Partial<Record<SetupInstance, SetupConfig>>;

function isSavedSetup(instance: SetupInstance, value: unknown): value is SetupConfig {
  const config = value as Partial<SetupConfig> | null | undefined;
  return !!config && isSetupIdentity(instance, config, true)
    && typeof config.token === 'string' && typeof config.baseUrl === 'string' && typeof config.apiKey === 'string'
    && typeof config.mcpUrl === 'string' && typeof config.mcpToken === 'string';
}

async function readSetups() {
  const stored = await chrome.storage.local.get([
    SAVED_SETUPS, COPILOT_SETTINGS_KEY, STORAGE_KEYS.serverUrl, STORAGE_KEYS.token, STORAGE_KEYS.tokenUrl,
    STORAGE_KEYS.connectionId, STORAGE_KEYS.label,
  ]);
  const saved = stored[SAVED_SETUPS] as Partial<Record<SetupInstance, unknown>> | undefined;
  const settings = stored[COPILOT_SETTINGS_KEY] as Partial<CopilotSettings> | undefined;
  const setups: SavedSetups = {};
  const rawUrl = stored[STORAGE_KEYS.serverUrl];
  const wsUrl = buildDisplayUrl(await resolveServer(typeof rawUrl === 'string' ? rawUrl : ''));
  const rawConnectionId = stored[STORAGE_KEYS.connectionId];
  const connectionId = typeof rawConnectionId === 'string' ? rawConnectionId : '';
  const label = normalizeLabel(stored[STORAGE_KEYS.label]);
  const rawToken = stored[STORAGE_KEYS.token];
  const token = typeof rawToken === 'string' && stored[STORAGE_KEYS.tokenUrl] === wsUrl ? rawToken : '';
  const baseUrl = typeof settings?.baseUrl === 'string' ? settings.baseUrl : '';
  const mcpUrl = typeof settings?.mcpUrl === 'string' ? settings.mcpUrl : '';
  const apiKey = baseUrl && settings?.apiKeyUrl === baseUrl && typeof settings.apiKey === 'string' ? settings.apiKey : '';
  const mcpToken = mcpUrl && settings?.mcpTokenUrl === mcpUrl && typeof settings.mcpToken === 'string' ? settings.mcpToken : '';
  const current = { wsUrl, connectionId, label, token, baseUrl, apiKey, mcpUrl, mcpToken };
  let activeInstance: SetupInstance | undefined;

  for (const [key, endpoint] of Object.entries(SETUP_INSTANCES)) {
    const instance = key as SetupInstance;
    const config = saved?.[instance];
    if (isSavedSetup(instance, config)) {
      const matchesCurrent = config.wsUrl === wsUrl && config.connectionId === connectionId;
      setups[instance] = matchesCurrent ? current : config;
      if (matchesCurrent) activeInstance = instance;
    } else if (saved === undefined && baseUrl === endpoint.baseUrl && mcpUrl === endpoint.mcpUrl
      && token && apiKey && mcpToken && isSavedSetup(instance, current)) {
      // The single-destination version wrote only the active, fully bound preset.
      setups[instance] = current;
      activeInstance = instance;
    }
  }
  return { setups, settings, activeInstance };
}

export async function getPairedInstances(): Promise<SetupInstance[]> {
  return Object.keys((await readSetups()).setups) as SetupInstance[];
}

/** Preserve edits made to the active destination before a manual URL change. */
export async function rememberPairedSetups(): Promise<void> {
  const { setups } = await readSetups();
  if (Object.keys(setups).length) await chrome.storage.local.set({ [SAVED_SETUPS]: setups });
}

async function applySetup(
  instance: SetupInstance,
  config: SetupConfig,
  { setups, settings: previous }: Awaited<ReturnType<typeof readSetups>>,
  firstSetup: boolean,
): Promise<void> {
  const { wsUrl, token, label, connectionId, baseUrl, apiKey, mcpUrl, mcpToken } = config;
  const settings = normalizeCopilotSettings({
    ...previous, baseUrl, apiKey, apiKeyUrl: baseUrl, mcpUrl, mcpToken, mcpTokenUrl: mcpUrl,
    ...(firstSetup ? { vision: true, maxSteps: 200, stepsView: 'extended' } as const : {}),
  });
  await chrome.storage.local.set({
    [PENDING_SETUP]: null,
    [SAVED_SETUPS]: { ...setups, [instance]: config },
    [STORAGE_KEYS.connectionId]: connectionId,
    [STORAGE_KEYS.serverUrl]: wsUrl,
    [STORAGE_KEYS.token]: token,
    [STORAGE_KEYS.tokenUrl]: wsUrl,
    [STORAGE_KEYS.label]: label,
    [STORAGE_KEYS.serverRevision]: crypto.randomUUID(),
    [COPILOT_SETTINGS_KEY]: settings,
    [COPILOT_PROVISIONED_KEY]: {},
  });
  clearTimeout(active?.timer);
  active?.controller.abort();
  active = undefined;
  info = { state: 'approved', instance };
  onApproved?.();
}

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
        try {
          const stored = await readSetups();
          await applySetup(instance, status.config, stored, !Object.keys(stored.setups).length);
        } catch {
          // The server can return the same grant until it expires.
          info = { state: 'pending', instance, error: 'No se pudo guardar la configuración. Reintentando…' };
          schedulePoll(attempt);
        }
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

export async function startSetup(
  instance: SetupInstance,
  beforeStart: () => Promise<void>,
  windowId?: number,
  rePair = false,
  reopen = false,
): Promise<void> {
  const attempt = await updateSettings(async () => {
    if (info.instance === instance && info.state === 'starting') return;
    const stored = await readSetups();
    const saved = stored.setups[instance];
    if ((!saved || rePair || reopen) && active?.pending?.instance === instance && Date.now() < active.pending.expiresAt) {
      await openApproval(active.pending, windowId).catch(() => { throw new Error('No se pudo abrir la página de aprobación.'); });
      return;
    }
    if (reopen || (!rePair && stored.activeInstance === instance)) return;
    if (saved && !rePair) {
      await beforeStart();
      await applySetup(instance, saved, stored, false);
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
