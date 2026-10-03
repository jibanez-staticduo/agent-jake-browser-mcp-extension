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

/** Readable name for a LiteLLM alias: group prefix off, words capitalised ("alibaba-q38-max" -> "Q38 Max"). */
export function modelLabel(id: string): string {
  return id.replace(/^(alibaba|or)-/, '').split('-').filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || id;
}
