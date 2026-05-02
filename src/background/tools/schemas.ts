/**
 * Zod validation schemas for browser automation tool parameters.
 * Each schema validates the input payload for its corresponding tool.
 */

import { z } from 'zod';

export const schemas = {
  browser_navigate: z.object({
    url: z.string().url(),
  }),

  browser_click: z.object({
    ref: z.string().describe('Element reference from snapshot (e.g., s1e42)'),
    selector: z.string().optional().describe('CSS selector fallback'),
  }),

  browser_type: z.object({
    ref: z.string(),
    text: z.string(),
    clear: z.boolean().optional().default(false),
  }),

  browser_hover: z.object({
    ref: z.string(),
    selector: z.string().optional(),
  }),

  browser_drag: z.object({
    startRef: z.string(),
    endRef: z.string(),
  }),

  browser_select_option: z.object({
    ref: z.string(),
    value: z.string().optional(),
    label: z.string().optional(),
    index: z.number().optional(),
  }),

  browser_press_key: z.object({
    key: z.string().describe('Key name like "Enter", "Tab", "ArrowDown", or "a"'),
  }),

  browser_wait: z.object({
    time: z.number().min(0).max(30).describe('Time to wait in seconds'),
  }),

  browser_new_tab: z.object({
    url: z.string().url(),
  }),

  browser_switch_tab: z.object({
    tabId: z.number(),
  }),

  browser_get_text: z.object({
    ref: z.string(),
  }),

  browser_get_attribute: z.object({
    ref: z.string(),
    attribute: z.string(),
  }),

  browser_wait_for_element: z.object({
    ref: z.string(),
    timeout: z.number().optional().default(10000),
  }),

  browser_highlight: z.object({
    ref: z.string(),
  }),

  browser_is_visible: z.object({
    ref: z.string(),
  }),

  browser_evaluate: z.object({
    code: z.string().describe('JavaScript code to evaluate via CDP (CSP-safe)'),
  }),

  browser_iframe_eval: z.object({
    iframeSelector: z.string().describe('CSS selector for the target iframe'),
    code: z.string().describe('JavaScript code to evaluate in the iframe contentWindow'),
  }),

  browser_iframe_click: z.object({
    iframeSelector: z.string().describe('CSS selector for the target iframe'),
    targetSelector: z.string().describe('CSS selector inside the iframe to click'),
    waitForNavigation: z.boolean().optional().default(false),
    timeout: z.number().optional().default(10000),
  }),

  browser_resize_viewport: z.object({
    width: z.number().int().min(320).max(3840),
    height: z.number().int().min(200).max(2160),
  }),

  browser_upload_file: z.object({
    ref: z.string().optional(),
    selector: z.string().optional(),
    filePath: z.string(),
  }),
} as const;

export type ToolName = keyof typeof schemas;
export type ToolPayload<T extends ToolName> = z.infer<typeof schemas[T]>;
