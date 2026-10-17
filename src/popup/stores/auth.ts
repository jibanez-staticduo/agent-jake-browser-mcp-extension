/**
 * Authentication state store.
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { sendMessage } from './index';
import type { AuthState, LoginResponse } from '../types';
import { usePolling } from '../composables/usePolling';

export const useAuthStore = defineStore('auth', () => {
  // State
  const state = ref<AuthState>({
    isAuthenticated: false,
    user: null,
    isConnected: false,
  });
  const loading = ref(false);
  const error = ref<string | null>(null);

  // Polling

  // Actions
  async function refresh(): Promise<void> {
    try {
      state.value = await sendMessage<AuthState>('getAuthState');
    } catch (e) {
      console.error('[AuthStore] refresh failed:', e);
    }
  }

  async function login(email: string, password: string): Promise<boolean> {
    loading.value = true;
    error.value = null;

    try {
      const result = await sendMessage<LoginResponse>('login', { email, password });

      if (result.success) {
        await refresh();
        return true;
      } else {
        error.value = result.error || 'Login failed';
        return false;
      }
    } catch (e) {
      error.value = (e as Error).message;
      return false;
    } finally {
      loading.value = false;
    }
  }

  async function logout(): Promise<void> {
    try {
      await sendMessage('logout');
      await refresh();
    } catch (e) {
      console.error('[AuthStore] logout failed:', e);
    }
  }

  const { startPolling, stopPolling } = usePolling(refresh, 5000);

  return {
    // State
    state,
    loading,
    error,
    // Actions
    refresh,
    login,
    logout,
    startPolling,
    stopPolling,
  };
});
