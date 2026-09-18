<script setup lang="ts">
/**
 * Runtime server settings: editable WS URL + token (S2), pairing flow,
 * persistent connectionId and current connection state.
 */
import { computed } from 'vue';
import { useServerStore } from '../stores';

const server = useServerStore();

const pairingStateText = computed(() => {
  switch (server.pairing.state) {
    case 'pending': return 'PARPENDIENTE';
    case 'approved': return 'PAREADO';
    case 'expired': return 'CADUCADO';
    case 'error': return 'ERROR';
    default: return '';
  }
});

const connectionText = computed(() => (server.connected ? 'CONECTADO' : 'DESCONECTADO'));
</script>

<template>
  <div class="server-panel">
    <div class="panel-title">
      <span>Servidor MCP</span>
      <span class="conn-state" :class="{ online: server.connected }">{{ connectionText }}</span>
    </div>

    <div class="field">
      <label class="field-label" for="server-url">URL del servidor</label>
      <input
        id="server-url"
        v-model="server.serverUrlInput"
        class="field-input"
        type="text"
        spellcheck="false"
        placeholder="wss://agent-browser.example.com"
        @input="server.markDraftTouched()"
      >
      <span class="field-hint">
        Vacío = valor compilado en el build.
        <template v-if="server.effectiveUrl"> En uso: {{ server.effectiveUrl }}</template>
      </span>
    </div>

    <div class="field">
      <label class="field-label" for="server-token">Token</label>
      <input
        id="server-token"
        v-model="server.tokenInput"
        class="field-input"
        type="password"
        spellcheck="false"
        autocomplete="off"
        placeholder="token de seguridad"
        @input="server.markDraftTouched()"
      >
      <span v-if="server.info && server.info.hasToken && !server.tokenInput" class="field-hint">
        Token activo presente (compilado o emparejado).
      </span>
    </div>

    <div v-if="server.error" class="panel-error">{{ server.error }}</div>

    <div class="actions">
      <button
        class="btn btn-save"
        type="button"
        :disabled="server.saving"
        @click="server.save()"
      >
        {{ server.saving ? 'Guardando…' : 'Guardar' }}
      </button>
      <button
        class="btn btn-pair"
        type="button"
        :disabled="server.pairingLoading || server.pairing.state === 'pending'"
        @click="server.startPairing()"
      >
        {{ server.pairing.state === 'pending' ? 'Esperando…' : 'Parear' }}
      </button>
      <span v-if="server.savedFlash" class="saved-flash">Guardado</span>
    </div>

    <div v-if="server.pairing.state === 'pending' && server.pairing.otp" class="pairing-box">
      <div class="pairing-label">Código de pairing</div>
      <div class="pairing-otp">{{ server.pairing.otp }}</div>
      <a
        v-if="server.pairing.approveUrl"
        class="pairing-link"
        :href="server.pairing.approveUrl"
        target="_blank"
        rel="noreferrer"
      >{{ server.pairing.approveUrl }}</a>
      <div class="pairing-hint">Abre el enlace en el servidor y aprueba para emitir el token.</div>
    </div>
    <div v-else-if="server.pairing.state !== 'idle'" class="pairing-status">
      Pairing: {{ pairingStateText }}
      <span v-if="server.pairing.error" class="pairing-error"> — {{ server.pairing.error }}</span>
    </div>

    <div v-if="server.connectionId" class="conn-id" :title="server.connectionId">
      connectionId: {{ server.connectionId }}
    </div>
  </div>
</template>

<style scoped>
.server-panel {
  margin-top: 16px;
  padding: 14px 16px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.panel-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--accent-primary);
}

.conn-state {
  color: var(--text-tertiary);
}

.conn-state.online {
  color: var(--accent-success);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field-label {
  font-family: var(--font-mono);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-tertiary);
}

.field-input {
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 8px 10px;
  outline: none;
  width: 100%;
  box-sizing: border-box;
}

.field-input:focus {
  border-color: var(--accent-primary);
}

.field-hint {
  font-size: 9px;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  word-break: break-all;
}

.panel-error {
  font-size: 10px;
  color: var(--accent-danger);
  font-family: var(--font-mono);
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn {
  appearance: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 1px;
  padding: 7px 12px;
  text-transform: uppercase;
  transition: all 0.2s ease;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-save {
  background: var(--accent-primary);
  border: 1px solid var(--accent-primary);
  color: var(--bg-deepest);
}

.btn-pair {
  background: transparent;
  border: 1px solid var(--accent-secondary);
  color: var(--accent-secondary);
}

.saved-flash {
  font-size: 10px;
  color: var(--accent-success);
  font-family: var(--font-mono);
}

.pairing-box {
  border: 1px dashed var(--accent-secondary);
  border-radius: var(--radius-md);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pairing-label {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
}

.pairing-otp {
  font-family: var(--font-mono);
  font-size: 18px;
  letter-spacing: 4px;
  color: var(--accent-secondary);
}

.pairing-link {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--accent-primary);
  word-break: break-all;
}

.pairing-hint {
  font-size: 9px;
  color: var(--text-tertiary);
}

.pairing-status {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-secondary);
}

.pairing-error {
  color: var(--accent-danger);
}

.conn-id {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--text-tertiary);
  word-break: break-all;
}
</style>
