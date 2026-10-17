import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageEventLog } from '@/background/page-events';
import { createDevtoolsHandlers } from '@/background/tools/handlers/devtools';
import type { HandlerContext } from '@/background/tools/handlers/types';

/** What the call's pinned tab manager gives a devtools handler: one tab, its own captured events. */
const events = new PageEventLog();
const sendDebuggerCommand = vi.fn();
const handlers = createDevtoolsHandlers({
  tabManager: { tabId: () => Promise.resolve(101), eventsFor: () => events, sendDebuggerCommand },
} as unknown as HandlerContext);

beforeEach(() => {
  events.reset();
  sendDebuggerCommand.mockReset();
});

describe('browser_network_request redirect bodies', () => {
  it('does not return the final hop body for an earlier redirect hop', async () => {
    events.handle('Network.requestWillBeSent', { requestId: 'same', request: { url: 'https://example.test/start', hasPostData: true } });
    events.handle('Network.requestWillBeSent', {
      requestId: 'same',
      redirectResponse: { status: 302, headers: { location: '/final' } },
      request: { url: 'https://example.test/final' },
    });
    events.handle('Network.responseReceived', { requestId: 'same', response: { status: 200, mimeType: 'text/plain' } });
    sendDebuggerCommand.mockImplementation(async (method: string) =>
      method === 'Network.getResponseBody' ? { body: 'final-body', base64Encoded: false } : { postData: 'final-post' });

    const defaultResult = await handlers.browser_network_request({ index: 1 }) as Record<string, unknown>;
    expect(defaultResult).not.toHaveProperty('requestBody');
    expect(defaultResult).not.toHaveProperty('responseBody');

    const redirect = await handlers.browser_network_request({ index: 1, part: 'response-body' }) as Record<string, unknown>;
    expect(redirect.responseBody).toBe('(unavailable: redirect response)');
    const redirectRequest = await handlers.browser_network_request({ index: 1, part: 'request-body' }) as Record<string, unknown>;
    expect(redirectRequest.requestBody).toBeNull();
    expect(sendDebuggerCommand).not.toHaveBeenCalled();

    const final = await handlers.browser_network_request({ index: 2, part: 'response-body' }) as Record<string, unknown>;
    expect(final.responseBody).toBe('final-body');
    expect(sendDebuggerCommand).toHaveBeenCalledWith('Network.getResponseBody', { requestId: 'same' });
  });

  it('redacts sensitive headers regardless of casing without changing captured data', async () => {
    events.handle('Network.requestWillBeSent', { requestId: 'auth', request: {
      url: 'https://user:password@example.test/reset/path-secret?token=secret#fragment', headers: {
        cOoKiE: 'session=secret', AUTHORIZATION: 'Bearer secret', 'Proxy-Authorization': 'Basic secret',
        'X-Session-ID': 'secret', 'x-AuThToKeN': 'secret', 'X-Access-Key': 'secret',
        'X-Client-Secret': 'custom-secret', Referer: 'https://other.test/?code=referer-secret',
        Accept: 'application/json', 'Content-Length': '42',
      },
    } });
    events.handle('Network.responseReceived', { requestId: 'auth', response: { status: 200, headers: {
      'sEt-CoOkIe': 'session=secret; HttpOnly', 'Content-Type': 'application/json; boundary=secret',
      Location: 'https://other.test/?code=location-secret', 'Cache-Control': 'max-age=60, private',
    } } });

    const index = events.networkRequests()[0].index;
    const result = await handlers.browser_network_request({ index }) as Record<string, unknown>;
    expect(result.requestHeaders).toEqual({
      cOoKiE: '[REDACTED]', AUTHORIZATION: '[REDACTED]', 'Proxy-Authorization': '[REDACTED]',
      'X-Session-ID': '[REDACTED]', 'x-AuThToKeN': '[REDACTED]', 'X-Access-Key': '[REDACTED]',
      'X-Client-Secret': '[REDACTED]', Referer: '[REDACTED]', Accept: '[REDACTED]', 'Content-Length': '42',
    });
    expect(result.responseHeaders).toEqual({
      'sEt-CoOkIe': '[REDACTED]', 'Content-Type': 'application/json',
      Location: '[REDACTED]', 'Cache-Control': 'max-age=60, private',
    });
    expect(result.url).toBe('https://example.test');
    const list = await handlers.browser_network_requests({}) as { requests: Array<{ url: string }> };
    expect(list.requests[0].url).toBe('https://example.test');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(list)).not.toContain('secret');
    expect(events.networkRequest(index)?.requestHeaders.cOoKiE).toBe('session=secret');
    expect(result).not.toHaveProperty('requestBody');
    expect(result).not.toHaveProperty('responseBody');
    expect(sendDebuggerCommand).not.toHaveBeenCalled();
  });
});
