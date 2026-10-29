type Witness = { tabId: number; targetId: string };
type WindowRecord = { windowId: number; witnesses: Witness[] };
const STORAGE_KEY = 'ajb.agentWindowProvenance';

/** Persisted numeric IDs require a live Chrome target UUID before they grant ownership. */
export class AgentWindows {
  private static pending: Promise<unknown> = Promise.resolve();

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = AgentWindows.pending.then(operation);
    AgentWindows.pending = result.catch(() => undefined);
    return result;
  }

  private async load(): Promise<WindowRecord[]> {
    const stored: unknown = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    if (!Array.isArray(stored)) return [];
    const targets = await chrome.debugger.getTargets();
    const records: WindowRecord[] = [];
    for (const entry of stored) {
      if (!Number.isSafeInteger(entry?.windowId) || entry.windowId <= 0 || !Array.isArray(entry.witnesses)) continue;
      const witnesses: Witness[] = [];
      for (const witness of entry.witnesses) {
        if (!Number.isSafeInteger(witness?.tabId) || typeof witness.targetId !== 'string' || !witness.targetId) continue;
        if (!targets.some(target => target.type === 'page' && target.tabId === witness.tabId && target.id === witness.targetId)) continue;
        try {
          if ((await chrome.tabs.get(witness.tabId)).windowId === entry.windowId) witnesses.push(witness);
        } catch { /* Closed between target enumeration and tab lookup. */ }
      }
      if (witnesses.length) records.push({ windowId: entry.windowId, witnesses });
    }
    return records;
  }

  private async save(records: WindowRecord[]): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY]: records });
  }

  async openTab(url: string, windowId?: number): Promise<{ tab: chrome.tabs.Tab; windowCreated: boolean }> {
    return this.serialize(async () => {
      const records = await this.load();
      let record = records.find(entry => entry.windowId === windowId);
      let tab: chrome.tabs.Tab;
      const windowCreated = !record;
      if (record) {
        tab = await chrome.tabs.create({ windowId: record.windowId, url, active: false });
      } else {
        const created = await chrome.windows.create({ url, focused: false, state: 'normal' });
        if (!created?.id || !created.tabs?.[0]?.id) throw new Error('Chrome returned no agent window/tab');
        tab = created.tabs[0];
        record = { windowId: created.id, witnesses: [] };
        records.push(record);
      }
      try {
        const target = (await chrome.debugger.getTargets()).find(target => target.type === 'page' && target.tabId === tab.id);
        if (!target?.id) throw new Error('Cannot prove agent tab provenance');
        record.witnesses.push({ tabId: tab.id!, targetId: target.id });
        await this.save(records);
      } catch (error) {
        await chrome.tabs.remove(tab.id!).catch(() => undefined);
        throw error;
      }
      return { tab, windowCreated };
    });
  }

  async prune(): Promise<void> {
    return this.serialize(async () => this.save(await this.load()));
  }

  async closeWindow(windowId: number, tabIds: number[], beforeClose: (id: number) => Promise<void>): Promise<{ windowId: number; closed: boolean; closedTabIds: number[] }> {
    if (!Number.isSafeInteger(windowId) || windowId <= 0 || !Array.isArray(tabIds) || tabIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
      throw new Error('Window and tab IDs must be positive integers');
    }
    return this.serialize(async () => {
      const records = await this.load();
      if (!records.some(entry => entry.windowId === windowId)) {
        await this.save(records);
        throw new Error(`NOT_AGENT_WINDOW: window ${windowId} has no live provenance`);
      }
      const closedTabIds: number[] = [];
      for (const id of new Set(tabIds)) {
        let tab: chrome.tabs.Tab;
        try { tab = await chrome.tabs.get(id); } catch { continue; }
        if (tab.windowId !== windowId) continue;
        await beforeClose(id);
        // Disconnect can yield to a user moving this tab. Check its window again.
        try { tab = await chrome.tabs.get(id); } catch { continue; }
        if (tab.windowId !== windowId) continue;
        try {
          await chrome.tabs.remove(id);
          closedTabIds.push(id);
        } catch (error) {
          try { await chrome.tabs.get(id); } catch { continue; }
          throw error;
        }
      }
      let closed = false;
      try { await chrome.windows.get(windowId); } catch { closed = true; }
      await this.save(await this.load());
      return { windowId, closed, closedTabIds };
    });
  }
}
