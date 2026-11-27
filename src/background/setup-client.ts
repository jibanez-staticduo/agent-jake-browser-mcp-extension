import { normalizeLabel } from '@/config/runtime';
import { SETUP_INSTANCES, type SetupInstance } from '@/config/setup-instances';

type SetupGrant = { approvalCode: string; pollSecret: string };
type SetupConfig = {
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

export async function requestSetupStatus(instance: SetupInstance, pollSecret: string, signal: AbortSignal): Promise<SetupStatus | null> {
  const body = await setupPost(instance, 'status', { pollSecret }, signal) as { state?: unknown; config?: Partial<SetupConfig> } | null;
  if (!body) return null;
  if (body.state === 'pending' || body.state === 'expired') return { state: body.state };

  const expected = SETUP_INSTANCES[instance];
  const config = body.config;
  if (body.state !== 'approved' || config?.wsUrl !== expected.wsUrl || config.baseUrl !== expected.baseUrl
    || config.mcpUrl !== expected.mcpUrl || !isCredential(config.token) || !isCredential(config.apiKey)
    || !isCredential(config.mcpToken) || typeof config.label !== 'string' || !config.label
    || config.label !== normalizeLabel(config.label) || typeof config.connectionId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(config.connectionId)) {
    throw new Error('La configuración recibida no coincide con el servidor seleccionado.');
  }
  return { state: 'approved', config: config as SetupConfig };
}
