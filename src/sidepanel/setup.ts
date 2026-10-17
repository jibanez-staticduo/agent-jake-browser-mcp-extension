/**
 * Plain-language state of the copilot for the chat and Opciones: what is missing (one rule,
 * copilotMissing in types/copilot.ts), errors the user can act on, and tabs that cannot be driven.
 */
import { copilotMissing, type CopilotField, type CopilotSettings } from '@/types/copilot';

/** DOM id of each setting's input in Opciones, for «Abrir Opciones» and the «ir» links. */
export const FIELD_IDS: Record<CopilotField, string> = {
  baseUrl: 'copilot-baseUrl',
  apiKey: 'copilot-apiKey',
  model: 'copilot-model',
};

const FIELD_NAMES: Record<CopilotField, string> = {
  baseUrl: 'el endpoint',
  apiKey: 'la API key',
  model: 'el modelo',
};

/** Spanish summary of what is missing, or '' when nothing is. */
export function missingText(settings: CopilotSettings): string {
  const missing = copilotMissing(settings);
  if (!missing.length) return '';
  const names = missing.map((f) => FIELD_NAMES[f]);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}` : names[0];
  const url = missing.includes('baseUrl') && settings.baseUrl.trim()
    ? ' El endpoint debe ser una URL https válida (o localhost).' : '';
  return `Falta ${list} en Opciones.${url}`;
}

export interface Explained {
  title: string;
  why: string;
  /** The button that fixes it, when there is one. */
  action: 'options' | null;
}

/** Turns a loop error into «what happened + what to do»; null when it is not a known case. */
export function explainError(message: string): Explained | null {
  if (/^LLM (401|403)\b/.test(message)) {
    return { title: 'La API key no vale', why: 'El endpoint ha rechazado la key. Puede estar caducada o rotada.', action: 'options' };
  }
  if (/^LLM 404\b/.test(message)) {
    return { title: 'El endpoint no conoce ese modelo', why: 'Elige otro modelo en el selector o revisa el endpoint en Opciones.', action: 'options' };
  }
  if (/^LLM 429\b/.test(message)) {
    return { title: 'Demasiadas peticiones', why: 'El modelo está limitando el uso. Espera un momento o prueba otro modelo.', action: null };
  }
  if (/^LLM 5\d\d\b/.test(message)) {
    return { title: 'El modelo ha fallado', why: 'El endpoint devolvió un error de servidor. Reintenta o prueba otro modelo.', action: null };
  }
  if (/failed to fetch|networkerror|network error|timed? ?out|timeout|econn|enotfound|load failed/i.test(message)) {
    return { title: 'No llego al endpoint', why: 'No hay respuesta del servidor del modelo. Revisa el endpoint y tu conexión.', action: 'options' };
  }
  return null;
}

/** chrome://, the Web Store, extension pages and blank tabs cannot be driven by the agent. */
export function isControllable(url: string): boolean {
  return /^(https?|file):/i.test(url) && !/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url);
}
