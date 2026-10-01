/**
 * Activity log types for tracking extension events.
 * Used for debugging MCP connections, tool executions, and errors.
 */

export type ActivityType = 'connection' | 'tab' | 'tool' | 'error' | 'auth';

export interface ActivityEntry {
  /** Unique identifier (crypto.randomUUID) */
  id: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Category of activity */
  type: ActivityType;
  /** Specific action (e.g., 'ws_connected', 'browser_click') */
  action: string;
  /** Human-readable description */
  description: string;
  /** Additional details (tool payload, error stack, etc.) */
  details?: Record<string, unknown>;
  /** Whether the action succeeded */
  success: boolean;
  /** Duration in milliseconds (for tool executions) */
  durationMs?: number;
}

/** Input for creating a new activity entry (id and timestamp auto-generated) */
export type ActivityEntryInput = Omit<ActivityEntry, 'id' | 'timestamp'>;

/** Activity log query response */
export interface ActivityLogResponse {
  activities: ActivityEntry[];
  total: number;
}
