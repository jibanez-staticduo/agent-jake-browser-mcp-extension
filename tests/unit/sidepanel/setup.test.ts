import { describe, expect, it } from 'vitest';
import { explainError, isControllable, missingText } from '@/sidepanel/setup';
import { copilotMissing, DEFAULT_COPILOT_SETTINGS, isCopilotConfigured } from '@/types/copilot';

const ok = { ...DEFAULT_COPILOT_SETTINGS, baseUrl: 'https://llm.example/v1', apiKey: 'k' };

describe('copilotMissing', () => {
  it('lists endpoint and key on a fresh install', () => {
    expect(copilotMissing(DEFAULT_COPILOT_SETTINGS)).toEqual(['baseUrl', 'apiKey']);
  });

  it('asks for the key when the endpoint is remote', () => {
    expect(copilotMissing({ ...ok, apiKey: ' ' })).toEqual(['apiKey']);
    expect(isCopilotConfigured({ ...ok, apiKey: '' })).toBe(false);
  });

  it('does not need a key for a loopback endpoint', () => {
    expect(copilotMissing({ ...ok, baseUrl: 'http://127.0.0.1:4000/v1', apiKey: '' })).toEqual([]);
  });

  it('rejects an insecure remote endpoint and a blank model', () => {
    expect(copilotMissing({ ...ok, baseUrl: 'http://remote.test/v1' })).toEqual(['baseUrl']);
    expect(copilotMissing({ ...ok, model: ' ' })).toEqual(['model']);
  });
});

describe('missingText', () => {
  it('is empty when configured and names every missing field otherwise', () => {
    expect(missingText(ok)).toBe('');
    expect(missingText(DEFAULT_COPILOT_SETTINGS)).toBe('Falta el endpoint y la API key en Opciones.');
    expect(missingText({ ...ok, baseUrl: 'http://remote.test/v1' })).toContain('URL https válida');
  });
});

describe('explainError', () => {
  it('turns a 401 into a readable message with the Opciones action', () => {
    const e = explainError('LLM 401: {"error":"invalid key"}');
    expect(e).toMatchObject({ title: 'La API key no vale', action: 'options' });
  });

  it('explains network failures and rate limits', () => {
    expect(explainError('Failed to fetch')).toMatchObject({ title: 'No llego al endpoint', action: 'options' });
    expect(explainError('LLM 429: slow down')).toMatchObject({ action: null });
  });

  it('leaves unknown errors alone', () => {
    expect(explainError('Se perdió la conexión con el service worker.')).toBeNull();
  });
});

describe('isControllable', () => {
  it('accepts web pages and refuses browser and extension pages', () => {
    expect(isControllable('https://admin.skirmshop.es/orders')).toBe(true);
    expect(isControllable('chrome://extensions')).toBe(false);
    expect(isControllable('chrome-extension://abc/src/sidepanel/index.html')).toBe(false);
    expect(isControllable('about:blank')).toBe(false);
    expect(isControllable('https://chromewebstore.google.com/detail/x')).toBe(false);
  });
});
