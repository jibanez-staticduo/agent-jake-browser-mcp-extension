import { describe, expect, it, vi } from 'vitest';
import { loadChatModelCatalog } from '@/sidepanel/model-catalog';
import { SETUP_INSTANCES } from '@/config/setup-instances';

const base = 'https://example.test/v1';
const signal = new AbortController().signal;
const response = (data: unknown[]) => Response.json({ data });

describe('loadChatModelCatalog', () => {
  it('keeps compatible chat and bridged GPT aliases, and filters account routes and non-chat modes', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response([
      { id: 'gpt-6.2-sol', mode: 'responses' },
      { id: 'chat-with-image-input', mode: 'chat' },
      { id: 'explicit-chat', model_info: { mode: 'responses', supported_endpoints: ['/v1/chat/completions'] } },
      { id: 'other-responses', mode: 'responses', supported_endpoints: ['/v1/responses'] },
      { id: 'chatgpt/gpt-6.2-sol', mode: 'chat' },
      { id: 'chatgpt-defend1/gpt-6.2-sol', mode: 'chat' },
      { id: 'chatgpt-account2/gpt-6.2-sol', mode: 'responses' },
      { id: 'chatgpt-account27/gpt-6.2-sol', mode: 'responses' },
      { id: 'chatgpt-staticduo/gpt-6.2-sol', mode: 'chat' },
      { id: 'aliased-encoder', mode: 'embedding' },
      { id: 'gpt-6.2-vision', mode: 'image_generation' },
      { id: 'gpt-6.2-realtime', mode: 'realtime' },
      { id: 'speech', metadata: { mode: 'audio_transcription' } },
      { id: 'some-provider/*', mode: 'chat' },
    ]));

    await expect(loadChatModelCatalog(base, 'example-key', signal, request)).resolves.toEqual([
      'chat-with-image-input', 'explicit-chat', 'gpt-6.2-sol',
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(new URL(`${base}/models?include_metadata=true`), {
      headers: { Authorization: 'Bearer example-key' }, cache: 'no-store', redirect: 'error', signal,
    });
  });

  it('uses model info only for unresolved aliases visible to this key', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([
        { id: 'team-chat' }, { id: 'opaque' }, { id: 'collision' }, { id: 'configured-embedding', mode: 'embedding' },
      ]))
      .mockResolvedValueOnce(response([
        { model_name: 'team-chat', model_info: { mode: 'chat' } },
        { model_name: 'collision', model_info: { mode: 'chat' } },
        { model_name: 'collision', model_info: { mode: 'embedding' } },
        { model_name: 'configured-embedding', model_info: { mode: 'chat' } },
        { model_name: 'not-visible', model_info: { mode: 'chat' } },
      ]));

    await expect(loadChatModelCatalog(`${base}/chat/completions/`, '', signal, request)).resolves.toEqual(['team-chat']);
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      `${base}/models?include_metadata=true`, `${base}/model/info`,
    ]);
    expect(request.mock.calls[1][1]?.headers).toEqual({});
  });

  it('keeps already classified chat models when detailed metadata is unavailable', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([{ id: 'vision-chat', mode: 'chat' }, { id: 'opaque' }]))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(loadChatModelCatalog(base, 'example-key', signal, request)).resolves.toEqual(['vision-chat']);
  });

  it('offers standard OpenAI models from a manual endpoint without a model info route', async () => {
    const rows = [
      'gpt-4.1-mini', 'text-embedding-3-small', 'chatgpt-defend1/gpt-4.1',
      'gpt-realtime', 'gpt-live-1.1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe-diarize',
    ].map(id => ({
      id, object: 'model', created: 123, owned_by: 'fixture',
    }));
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response(rows))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(loadChatModelCatalog(base, 'example-key', signal, request)).resolves.toEqual(['gpt-4.1-mini']);
  });

  it('requires capability metadata on the configured LiteLLM endpoints', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([{ id: 'opaque-name', object: 'model', owned_by: 'fixture' }]))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(loadChatModelCatalog(SETUP_INSTANCES.nas.baseUrl, '', signal, request)).rejects.toThrow('HTTP 404');
  });

  it('reports a listing failure without using its response body', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('invalid example-key', { status: 401 }));
    await expect(loadChatModelCatalog(base, 'example-key', signal, request)).rejects.toThrow(/^HTTP 401$/);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
