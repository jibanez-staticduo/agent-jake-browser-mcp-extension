/**
 * Shared TypeScript interfaces for popup components.
 */

export interface AuthUser {
  id: number;
  name: string;
  email: string;
}

export interface AuthState {
  isAuthenticated: boolean;
  user: AuthUser | null;
  isConnected: boolean;
  connectionState?: string;
  statusMessage?: string;
  reconnectAttempt?: number;
  lastError?: string | null;
}

export interface TabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
  connected: boolean;
  favIconUrl?: string;
  windowId?: number;
}

export interface Status {
  connected: boolean;
  tabId: number | null;
  tabs: TabInfo[];
}

export type ActivityType = 'connection' | 'tab' | 'tool' | 'error' | 'auth';
export type ActivityFilter = 'all' | ActivityType;

export interface ActivityEntry {
  id: string;
  timestamp: number;
  type: ActivityType;
  action: string;
  description: string;
  details?: Record<string, unknown>;
  success: boolean;
  durationMs?: number;
}

export interface ActivityLogResponse {
  activities: ActivityEntry[];
  total: number;
}

export interface LoginResponse {
  success: boolean;
  token?: string;
  user?: AuthUser;
  error?: string;
}

export type PairingState = 'idle' | 'pending' | 'approved' | 'expired' | 'error';

export interface PairingInfo {
  state: PairingState;
  otp?: string;
  approveUrl?: string;
  error?: string;
}

export interface ServerConfigInfo {
  effectiveUrl: string;
  fromStorage: boolean;
  storedServerUrl: string;
  storedToken: string;
  hasToken: boolean;
  connectionId: string;
  connected: boolean;
  pairing: PairingInfo;
}
