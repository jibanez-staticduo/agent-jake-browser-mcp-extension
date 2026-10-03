/**
 * Saved copilot conversations (chrome.storage.local, trusted contexts only).
 */
import type { PlanStep, UserRequest } from '@/types/copilot';

export const CHATS_KEY = 'copilotChats';
export const CURRENT_CHAT_KEY = 'copilotCurrentChat';
const MAX_CHATS = 50;

export interface Item {
  kind: 'user' | 'assistant' | 'tool' | 'error' | 'info' | 'request';
  text: string;
  /** tool call id or request id */
  id?: string;
  ok?: boolean;
  detail?: string;
  /** assistant: still receiving deltas */
  streaming?: boolean;
  /** assistant: text emitted alongside tool calls, not a final answer */
  interim?: boolean;
  reasoning?: string;
  request?: UserRequest;
  /** request: what the user answered, or 'cancelled' */
  answered?: string;
}

export interface Chat {
  id: string;
  title: string;
  updatedAt: number;
  items: Item[];
  plan: PlanStep[];
}

export function newChat(): Chat {
  return { id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title: 'Nueva conversación', updatedAt: Date.now(), items: [], plan: [] };
}

export function titleOf(items: Item[]): string {
  const first = items.find((i) => i.kind === 'user')?.text ?? '';
  const oneLine = first.replace(/\s+/g, ' ').trim();
  return oneLine ? (oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine) : 'Nueva conversación';
}

export async function listChats(): Promise<Chat[]> {
  const stored = await chrome.storage.local.get(CHATS_KEY);
  const chats = stored[CHATS_KEY];
  return Array.isArray(chats) ? (chats as Chat[]).sort((a, b) => b.updatedAt - a.updatedAt) : [];
}

export async function saveChat(chat: Chat): Promise<void> {
  if (!chat.items.length) return;
  const chats = (await listChats()).filter((c) => c.id !== chat.id);
  const saved: Chat = { ...chat, title: titleOf(chat.items), updatedAt: Date.now() };
  // Plain JSON: Vue proxies do not survive structured cloning.
  const next = [JSON.parse(JSON.stringify(saved)) as Chat, ...chats].slice(0, MAX_CHATS);
  await chrome.storage.local.set({ [CHATS_KEY]: next, [CURRENT_CHAT_KEY]: chat.id });
}

export async function deleteChat(id: string): Promise<void> {
  const chats = (await listChats()).filter((c) => c.id !== id);
  await chrome.storage.local.set({ [CHATS_KEY]: chats });
}

export async function currentChatId(): Promise<string | null> {
  const stored = await chrome.storage.local.get(CURRENT_CHAT_KEY);
  return typeof stored[CURRENT_CHAT_KEY] === 'string' ? stored[CURRENT_CHAT_KEY] as string : null;
}

/** The resident local model: first in its group and the default (DEFAULT_COPILOT_SETTINGS.model). */
const RESIDENT = 'qwen38-flash-next';
const NON_CHAT = /(bge|embed|rerank|whisper|stt|tts|omnivoice|imagine|image|video|probe)/i;

/** Models a chat composer should offer: drop embeddings, audio, image and probes. */
export function chatModels(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => !NON_CHAT.test(id)))].sort();
}

export type ModelGroupId = 'local' | 'alibaba' | 'openrouter';

export interface ModelGroup {
  id: ModelGroupId;
  label: string;
  models: string[];
}

export const MODEL_GROUPS: { id: ModelGroupId; label: string }[] = [
  { id: 'local', label: 'Local · gratis' },
  { id: 'alibaba', label: 'Plan Alibaba' },
  { id: 'openrouter', label: 'Pago · OpenRouter' },
];

export function modelGroupOf(id: string): ModelGroupId {
  if (id.startsWith('alibaba-')) return 'alibaba';
  if (id.startsWith('or-')) return 'openrouter';
  return 'local';
}

/** Chat models split by where they run (LiteLLM alias prefix), local resident first, then A-Z. */
export function groupChatModels(ids: string[]): ModelGroup[] {
  const chat = chatModels(ids);
  return MODEL_GROUPS
    .map((g) => ({
      ...g,
      models: chat.filter((id) => modelGroupOf(id) === g.id)
        .sort((a, b) => Number(b === RESIDENT) - Number(a === RESIDENT) || a.localeCompare(b)),
    }))
    .filter((g) => g.models.length);
}

/**
 * Readable names, by LiteLLM alias (litellm manifest `model_name`; the underlying model in the
 * comment of each group). An alias missing here falls back to humanizeModel().
 */
const MODEL_NAMES: Record<string, string> = {
  // local: the resident and its variants
  'qwen38-flash-next': 'Qwen 3.8 Flash (residente)',
  'qwen38-flash-next-uncensored': 'Qwen 3.8 Flash · sin censura',
  'qwen38-off': 'Qwen 3.8 Flash · sin pensar',
  'qwen38-u-off': 'Qwen 3.8 Flash · sin pensar y sin censura',
  'qwen38-27b': 'Qwen 3.8 27B',
  'qwen38-27b-uncensored': 'Qwen 3.8 27B · sin censura',
  tooling: 'Tooling',
  'tooling-uncensored': 'Tooling · sin censura',
  // Alibaba plan
  'alibaba-q38-max': 'Qwen 3.8 Max',
  'alibaba-q38-flash': 'Qwen 3.8 Flash',
  'alibaba-q37-max': 'Qwen 3.7 Max',
  'alibaba-q37-plus': 'Qwen 3.7 Plus',
  'alibaba-q36-flash': 'Qwen 3.6 Flash',
  'alibaba-dsv41-fl': 'DeepSeek V4.1 Flash',
  'alibaba-dsv4-pro': 'DeepSeek V4 Pro',
  'alibaba-dsv4f0731': 'DeepSeek V4 Flash 0731',
  'alibaba-glm-53': 'GLM 5.3',
  'alibaba-glm-52': 'GLM 5.2',
  // OpenRouter
  'or-nemotron': 'Nemotron 3 Super 120B',
  'or-ultra': 'Nemotron 3 Ultra 550B',
  'or-lightning': 'Nemotron 3.5 Lightning',
  'or-omni': 'Nemotron 3 Nano Omni 30B',
  'or-code': 'North Mini Code',
  'or-minimax': 'MiniMax M3',
  'or-minimax-m27': 'MiniMax M2.7',
  'or-dots': 'Dots 3 Note',
  'or-laguna-s': 'Laguna S 2.1',
  'or-laguna-xs': 'Laguna XS 2.1',
  'or-lfm': 'LFM 2.5 2.6B',
  'or-inkling': 'Inkling',
  'or-inkling-small': 'Inkling Small',
  'or-glm': 'GLM 5.2',
  'or-gemma-26b': 'Gemma 4 26B',
  'or-gemma-31b': 'Gemma 4 31B',
};

const ACRONYMS = /^(glm|lfm|llm|ai|ocr)$/i;

/** Fallback for an alias with no entry: prefix off, words capitalised, acronyms and sizes upper-case. */
export function humanizeModel(id: string): string {
  return id.replace(/^(alibaba|or)-/, '').split('-').filter(Boolean)
    .map((w) => (ACRONYMS.test(w) || /^\d+(\.\d+)?b$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ') || id;
}

/** Readable name of a model alias. */
export function modelLabel(id: string): string {
  return MODEL_NAMES[id] ?? humanizeModel(id);
}

/** OpenRouter models are the paid group: the picker and the composer chip carry a «Pago» badge. */
export function isPaidModel(id: string): boolean {
  return modelGroupOf(id) === 'openrouter';
}
