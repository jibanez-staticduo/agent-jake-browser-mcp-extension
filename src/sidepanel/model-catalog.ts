const ACCOUNT_ROUTE = /^chatgpt(?:-[^/]+)?\//i;
const GENERAL_GPT = /^gpt-\d[^/]*$/i;

interface ModelMetadata {
  mode?: string | null;
  supported_endpoints?: string[] | null;
}

interface CatalogModel extends ModelMetadata {
  id?: string;
  model_name?: string;
  metadata?: ModelMetadata;
  model_info?: ModelMetadata;
}

function isSelectableId(id: unknown): id is string {
  return typeof id === 'string' && !!id.trim() && !ACCOUNT_ROUTE.test(id) && !id.includes('*');
}

function modelMode(model: CatalogModel): string | undefined {
  return model.mode || model.metadata?.mode || model.model_info?.mode || undefined;
}

function supportsChat(id: string, model: CatalogModel): boolean {
  const mode = modelMode(model);
  const endpoints = model.supported_endpoints ?? model.metadata?.supported_endpoints ?? model.model_info?.supported_endpoints;
  // LiteLLM bridges general GPT aliases from Chat Completions to Responses.
  return mode === 'chat' || (mode === 'responses' && (
    GENERAL_GPT.test(id) || (Array.isArray(endpoints) && endpoints.some((path) => /^\/(v1\/)?chat\/completions$/.test(path)))
  ));
}

async function fetchModels(url: URL, init: RequestInit, request: typeof fetch): Promise<CatalogModel[]> {
  const response = await request(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as { data?: unknown } | null;
  if (!Array.isArray(body?.data)) throw new Error('Formato de catalogo inesperado');
  return body.data.filter((row): row is CatalogModel => row !== null && typeof row === 'object');
}

/** Read only aliases visible to the configured key. Detailed metadata can classify those aliases. */
export async function loadChatModelCatalog(
  baseUrl: string,
  apiKey: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<string[]> {
  const base = new URL(baseUrl);
  base.pathname = base.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  base.search = '';
  base.hash = '';
  const listing = new URL(base);
  listing.pathname += '/models';
  listing.searchParams.set('include_metadata', 'true');
  const init: RequestInit = {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    cache: 'no-store',
    redirect: 'error',
    signal,
  };
  const available = (await fetchModels(listing, init, request)).filter(
    (model): model is CatalogModel & { id: string } => isSelectableId(model.id),
  );
  const models = new Set(available.filter((model) => supportsChat(model.id, model)).map(({ id }) => id));
  const unresolved = new Set(available.filter((model) => !modelMode(model)).map(({ id }) => id));
  if (unresolved.size) {
    const info = new URL(base);
    // LiteLLM accepts both /model/info and /v1/model/info.
    info.pathname += '/model/info';
    try {
      const deployments = await fetchModels(info, init, request);
      const compatible = new Set<string>();
      const incompatible = new Set<string>();
      for (const model of deployments) {
        const id = model.model_name;
        if (!id || !unresolved.has(id) || !modelMode(model)) continue;
        (supportsChat(id, model) ? compatible : incompatible).add(id);
      }
      for (const id of compatible) {
        if (!incompatible.has(id)) models.add(id);
      }
    } catch (error) {
      if (signal.aborted || !models.size) throw error;
    }
  }
  return [...models].sort();
}
