/**
 * Minimal CDP bridge used by Reverb commands.
 */
import { TabManager } from './tab-manager';

export class CdpProxy {
  constructor(private tabManager: TabManager) {}

  async handleCommand(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<unknown> {
    return this.tabManager.sendDebuggerCommand(method, params);
  }
}
