import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatOfScope, currentChatId, newChat, saveChat, scopeOf, setCurrentChat } from '@/sidepanel/chats';

/** In-memory chrome.storage.local: enough for the chat persistence helpers. */
let store: Record<string, unknown>;
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
      set: async (items: Record<string, unknown>) => Object.assign(store, JSON.parse(JSON.stringify(items))),
    },
  },
});

beforeEach(() => {
  store = {};
});

describe('scopeOf', () => {
  it('binds a grouped tab to its group and a loose tab to itself', () => {
    expect(scopeOf({ id: 7, groupId: 3 })).toBe('g:3');
    expect(scopeOf({ id: 7, groupId: -1 })).toBe('t:7');
    expect(scopeOf({ id: 7 })).toBe('t:7');
    expect(scopeOf({ groupId: 3 })).toBeUndefined();
  });
});

describe('per-tab session', () => {
  it('chatOfScope returns the most recent chat saved for the scope', async () => {
    const old = { ...newChat(), scope: 't:7', title: 'vieja' };
    await saveChat({ ...old, items: [{ kind: 'user', text: 'vieja' }] });
    await new Promise((r) => setTimeout(r, 2));
    const fresh = { ...newChat(), scope: 't:7', title: 'nueva' };
    await saveChat({ ...fresh, items: [{ kind: 'user', text: 'nueva' }] });
    const found = await chatOfScope('t:7');
    expect(found?.items[0].text).toBe('nueva');
    expect(await chatOfScope('g:3')).toBeUndefined();
  });

  it('setCurrentChat survives a reopen: currentChatId returns the cleared conversation', async () => {
    const c = newChat();
    await saveChat({ ...c, items: [{ kind: 'user', text: 'hola' }] });
    await setCurrentChat(c.id);
    expect(await currentChatId()).toBe(c.id);
  });
});
