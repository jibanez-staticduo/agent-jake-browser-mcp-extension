/**
 * Shared types for handler modules.
 */
import type { TabManager } from '../../tab-manager';
import type { ToolContext } from '../utils';
import type { Coordinates } from '@/types/messages';

export type Handler = (payload: unknown) => Promise<unknown>;
export type HandlerMap = Record<string, Handler>;

/**
 * Extended context for tool handlers.
 * Adds dispatchMouseEvent and dispatchKeyEvent wrappers
 * that resolve key names and use typed mouse event types.
 */
export interface HandlerContext extends ToolContext {
  dispatchMouseEventTyped: (
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
    x: number,
    y: number,
    button?: 'left' | 'right' | 'middle',
    clickCount?: number,
  ) => Promise<void>;
  dispatchKeyEventTyped: (
    type: 'keyDown' | 'keyUp' | 'char',
    key: string,
    text?: string,
  ) => Promise<void>;
}

export type { Coordinates };
