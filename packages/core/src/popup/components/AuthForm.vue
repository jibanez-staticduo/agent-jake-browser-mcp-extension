<script setup lang="ts">
/**
 * Sign-in form component.
 * Uses Pinia auth store for state management.
 */
import { ref } from 'vue';
import { useAuthStore } from '../stores';

const auth = useAuthStore();

const email = ref('');
const password = ref('');

function handleSubmit() {
  if (email.value && password.value) {
    auth.login(email.value, password.value);
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    handleSubmit();
  }
}
</script>

<template>
  <div class="auth-card">
    <div class="auth-card-content">
      <div class="auth-title">
        <span class="auth-title-icon">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
          </svg>
        </span>
        Sign In to Sortie
      </div>

      <div v-if="auth.error" class="auth-error">
        {{ auth.error }}
      </div>

      <div class="input-group">
        <label class="input-label" for="email">Email</label>
        <input
          v-model="email"
          type="email"
          id="email"
          class="input-field"
          placeholder="you@example.com"
          autocomplete="email"
          @keydown="handleKeydown"
        >
      </div>

      <div class="input-group">
        <label class="input-label" for="password">Password</label>
        <input
          v-model="password"
          type="password"
          id="password"
          class="input-field"
          placeholder="••••••••"
          autocomplete="current-password"
          @keydown="handleKeydown"
        >
      </div>

      <button
        class="btn-signin"
        :class="{ loading: auth.loading }"
        :disabled="auth.loading"
        @click="handleSubmit"
      >
        <span class="btn-text">Sign In</span>
        <div class="spinner"></div>
      </button>
    </div>
  </div>
</template>

<style scoped>
.auth-card {
  background: var(--bg-surface);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-subtle);
  overflow: hidden;
  position: relative;
}

.auth-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, var(--accent-primary), var(--accent-secondary));
}

.auth-card-content {
  padding: 20px;
}

.auth-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.auth-title-icon {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.auth-title-icon svg {
  width: 14px;
  height: 14px;
  stroke: var(--accent-primary);
}

.auth-error {
  padding: 10px 12px;
  background: var(--accent-danger-dim);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: var(--radius-md);
  color: var(--accent-danger);
  font-size: 12px;
  margin-bottom: 12px;
  animation: shake 0.4s ease;
}

.input-group {
  margin-bottom: 12px;
}

.input-label {
  display: block;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-tertiary);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.input-field {
  width: 100%;
  padding: 12px 14px;
  background: var(--bg-deepest);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: 14px;
  font-family: var(--font-sans);
  transition: all 0.2s ease;
  outline: none;
}

.input-field::placeholder {
  color: var(--text-tertiary);
}

.input-field:focus {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px var(--accent-primary-dim), var(--glow-primary);
}

.btn-signin {
  width: 100%;
  padding: 14px 20px;
  background: linear-gradient(135deg, var(--accent-primary), #00a8cc);
  border: none;
  border-radius: var(--radius-md);
  color: var(--bg-deepest);
  font-size: 14px;
  font-weight: 600;
  font-family: var(--font-sans);
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
  overflow: hidden;
}

.btn-signin:hover {
  transform: translateY(-1px);
  box-shadow: var(--glow-primary);
}

.btn-signin:active {
  transform: translateY(0);
}

.btn-signin:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
}

.btn-signin.loading {
  color: transparent;
}

.btn-signin.loading::after {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 200%;
  height: 100%;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.4) 50%,
    transparent 100%
  );
  animation: scan 1.5s ease-in-out infinite;
}

.btn-signin .spinner {
  display: none;
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 20px;
  height: 20px;
  border: 2px solid var(--bg-deepest);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.btn-signin.loading .spinner {
  display: block;
}
</style>
