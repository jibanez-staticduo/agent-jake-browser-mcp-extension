import { describe, expect, it } from 'vitest';
import { chatModels, groupChatModels, humanizeModel, isPaidModel, modelGroupOf, modelLabel } from '@/sidepanel/chats';

/**
 * model_name ids of k8s-litellm-pocharlies/k8s/manifest.yaml (chat aliases, 2026-10-03):
 * `grep -oE "model_name: *(qwen38|tooling|alibaba|or-)[a-z0-9.-]*" manifest.yaml | sort -u`.
 * Committed as a fixture so the test does not read ~/k8s.
 */
const LITELLM_IDS = [
  'alibaba-dsv41-fl',
  'alibaba-dsv4f0731',
  'alibaba-dsv4-pro',
  'alibaba-glm-52',
  'alibaba-glm-53',
  'alibaba-q36-flash',
  'alibaba-q37-max',
  'alibaba-q37-plus',
  'alibaba-q38-flash',
  'alibaba-q38-max',
  'or-code',
  'or-dots',
  'or-gemma-26b',
  'or-gemma-31b',
  'or-glm',
  'or-inkling',
  'or-inkling-small',
  'or-laguna-s',
  'or-laguna-xs',
  'or-lfm',
  'or-lightning',
  'or-minimax',
  'or-minimax-m27',
  'or-nemotron',
  'or-omni',
  'or-ultra',
  'qwen38-27b',
  'qwen38-27b-uncensored',
  'qwen38-flash-next',
  'qwen38-flash-next-uncensored',
  'qwen38-off',
  'qwen38-u-off',
  'tooling',
  'tooling-uncensored',
];

/** Ids the proxy also serves that a chat composer must never offer. */
const NON_CHAT_IDS = ['bge-m3', 'text-embedding-3', 'rerank-v2', 'whisper-large', 'kokoro-tts', 'flux-image', 'wan-video', 'omnivoice', 'stt-small', 'probe-x'];

describe('chatModels', () => {
  it('keeps every LiteLLM chat alias', () => {
    expect(chatModels(LITELLM_IDS)).toHaveLength(LITELLM_IDS.length);
  });

  it('drops embeddings, speech, image and video ids', () => {
    const out = chatModels([...LITELLM_IDS, ...NON_CHAT_IDS]);
    expect(out.filter((id) => /bge|embed|rerank|whisper|tts|image|video/i.test(id))).toEqual([]);
    expect(out).toHaveLength(LITELLM_IDS.length);
  });
});

describe('groupChatModels', () => {
  const groups = groupChatModels([...LITELLM_IDS, ...NON_CHAT_IDS]);

  it('orders the groups Local, Alibaba, OpenRouter', () => {
    expect(groups.map((g) => g.id)).toEqual(['local', 'alibaba', 'openrouter']);
  });

  it('puts every id in exactly one group', () => {
    const all = groups.flatMap((g) => g.models);
    expect(all.sort()).toEqual([...LITELLM_IDS].sort());
  });

  it('groups by alias prefix, tooling and qwen38 are local', () => {
    expect(modelGroupOf('alibaba-q38-max')).toBe('alibaba');
    expect(modelGroupOf('or-glm')).toBe('openrouter');
    expect(modelGroupOf('tooling')).toBe('local');
    expect(groups[0].models).toEqual(expect.arrayContaining(['qwen38-flash-next', 'tooling', 'tooling-uncensored', 'qwen38-off', 'qwen38-u-off']));
  });

  it('lists the resident qwen38-flash-next first, then A-Z', () => {
    expect(groups[0].models[0]).toBe('qwen38-flash-next');
    const rest = groups[0].models.slice(1);
    expect(rest).toEqual([...rest].sort());
  });

  it('skips empty groups', () => {
    expect(groupChatModels(['tooling']).map((g) => g.id)).toEqual(['local']);
  });
});

describe('modelLabel', () => {
  it('never shows an abbreviation or a raw alias as a name', () => {
    const ugly = /\b(dsv\d*\w*|fl|q\d+|u|off|uncensored|lfm|glm)\b/;
    for (const id of LITELLM_IDS) {
      const name = modelLabel(id);
      expect(name, id).not.toMatch(ugly);
      expect(name, id).not.toBe(id);
      expect(name, id).toMatch(/^[A-Z0-9]/);
    }
  });

  it('gives each alias a different name inside its group', () => {
    for (const g of groupChatModels(LITELLM_IDS)) {
      const names = g.models.map(modelLabel);
      expect(new Set(names).size, g.id).toBe(names.length);
    }
  });

  it('names the ones the designer flagged', () => {
    expect(modelLabel('alibaba-dsv41-fl')).toBe('DeepSeek V4.1 Flash');
    expect(modelLabel('qwen38-u-off')).toBe('Qwen 3.8 Flash · sin pensar y sin censura');
    expect(modelLabel('or-lfm')).toBe('LFM 2.5 2.6B');
  });

  it('humanizes an alias that is not in the map', () => {
    expect(humanizeModel('alibaba-new-model')).toBe('New Model');
    expect(humanizeModel('or-glm-9')).toBe('GLM 9');
    expect(humanizeModel('foo-27b')).toBe('Foo 27B');
  });
});

describe('isPaidModel', () => {
  it('marks only the OpenRouter group as paid', () => {
    expect(isPaidModel('or-glm')).toBe(true);
    expect(isPaidModel('alibaba-glm-53')).toBe(false);
    expect(isPaidModel('qwen38-flash-next')).toBe(false);
  });
});
