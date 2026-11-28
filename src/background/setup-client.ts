import { normalizeLabel } from '@/config/runtime';
import { SETUP_INSTANCES, type SetupInstance } from '@/config/setup-instances';

type SetupGrant = { approvalCode: string; pollSecret: string };
export type SetupConfig = {
  connectionId: string;
  wsUrl: string;
  token: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  mcpUrl: string;
  mcpToken: string;
};
type SetupStatus = { state: 'pending' | 'expired' } | { state: 'approved'; config: SetupConfig };

export function isSetupSecret(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]{43}$/.test(value);
}

function isCredential(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]+$/.test(value);
}

async function setupPost(
  instance: SetupInstance, endpoint: 'start' | 'status', body: object, signal: AbortSignal,
): Promise<unknown> {
  const origin = SETUP_INSTANCES[instance].origin;
  const timer = new AbortController();
  const abort = () => timer.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) timer.abort();
  const timeout = setTimeout(abort, 10_000);
  try {
    const res = await fetch(`${origin}/setup/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: timer.signal,
    });
    return res.status === (endpoint === 'start' ? 201 : 200) ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

export async function requestSetup(instance: SetupInstance, signal: AbortSignal): Promise<SetupGrant> {
  const grant = await setupPost(instance, 'start', {}, signal) as Partial<SetupGrant> | null;
  if (!isSetupSecret(grant?.approvalCode) || !isSetupSecret(grant?.pollSecret) || grant.approvalCode === grant.pollSecret) {
    throw new Error('No se pudo iniciar la configuración. Comprueba el acceso al servidor desde la LAN.');
  }
  return { approvalCode: grant.approvalCode, pollSecret: grant.pollSecret };
}

export function isSetupConfig(instance: SetupInstance, config: unknown, allowCleared = false): config is SetupConfig {
  const expected = SETUP_INSTANCES[instance];
  const value = config as Partial<SetupConfig> | null | undefined;
  const validCredential = (credential: unknown) => isCredential(credential) || (allowCleared && credential === '');
  return value?.wsUrl === expected.wsUrl && value.baseUrl === expected.baseUrl && value.mcpUrl === expected.mcpUrl
    && validCredential(value.token) && validCredential(value.apiKey) && validCredential(value.mcpToken)
    && typeof value.label === 'string' && (allowCleared || !!value.label) && value.label === normalizeLabel(value.label)
    && typeof value.connectionId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.connectionId);
}

export async function requestSetupStatus(instance: SetupInstance, pollSecret: string, signal: AbortSignal): Promise<SetupStatus | null> {
  const body = await setupPost(instance, 'status', { pollSecret }, signal) as { state?: unknown; config?: unknown } | null;
  if (!body) return null;
  if (body.state === 'pending' || body.state === 'expired') return { state: body.state };
  if (body.state !== 'approved' || !isSetupConfig(instance, body.config)) {
    throw new Error('La configuración recibida no coincide con el servidor seleccionado.');
  }
  return { state: 'approved', config: body.config };
}
