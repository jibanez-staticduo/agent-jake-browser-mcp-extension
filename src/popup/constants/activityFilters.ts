/**
 * Activity filter options for the activity log UI.
 */
import type { ActivityFilter } from '../types';

export interface FilterOption {
  value: ActivityFilter;
  label: string;
}

export const ACTIVITY_FILTERS: FilterOption[] = [
  { value: 'all', label: 'Todo' },
  { value: 'auth', label: 'Acceso' },
  { value: 'connection', label: 'Conexión' },
  { value: 'tab', label: 'Pestaña' },
  { value: 'tool', label: 'Herramienta' },
  { value: 'error', label: 'Error' },
];

/** Spanish labels for the entry type and for the actions the background logs (description is derived from the action). */
export const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  connection: 'conexión', tab: 'pestaña', tool: 'herramienta', error: 'error', auth: 'acceso',
};

export const ACTIVITY_ACTION_LABELS: Record<string, string> = {
  ws_connect: 'Conectado al servidor MCP',
  ws_close: 'Conexión con el servidor cerrada',
  ws_error: 'Error de conexión con el servidor MCP',
  ws_disconnect: 'Desconectado del servidor MCP',
  ws_reconnecting: 'Reintentando la conexión',
  ws_reconnect_failed: 'No se pudo reconectar con el servidor MCP',
  tab_connect: 'Pestaña conectada',
  tab_disconnect: 'Pestaña desconectada',
  unknown_tool: 'Herramienta desconocida',
  unknown: 'Evento sin clasificar',
};

export function describeActivity(entry: { action: string; description: string }): string {
  return ACTIVITY_ACTION_LABELS[entry.action] ?? entry.description;
}
