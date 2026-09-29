<script setup lang="ts">
/**
 * What the agent is waiting for: approval of an action, an answer, or a plan decision.
 */
import { computed, ref } from 'vue';
import type { UserRequest, UserResponse } from '@/types/copilot';
import { renderMarkdown } from './markdown';

const props = defineProps<{ request: UserRequest; answered?: string }>();
const emit = defineEmits<{ respond: [response: UserResponse, label: string] }>();

const text = ref('');
const args = computed(() => (props.request.kind === 'approve' ? JSON.stringify(props.request.args, null, 2) : ''));

function answer(value: string) {
  const v = value.trim();
  if (v) emit('respond', { kind: 'question', answer: v }, v);
}
</script>

<template>
  <div class="card" :class="[request.kind, { done: answered }]">
    <template v-if="request.kind === 'approve'">
      <div class="head">¿Permitir <code>{{ request.tool }}</code><span v-if="request.origin"> en {{ request.origin }}</span>?</div>
      <pre v-if="args !== '{}'">{{ args }}</pre>
      <div v-if="!answered" class="buttons">
        <button class="primary" @click="emit('respond', { kind: 'approve', decision: 'allow' }, 'Permitido')">Permitir</button>
        <button v-if="request.origin" @click="emit('respond', { kind: 'approve', decision: 'allow_site' }, `Siempre en ${request.origin}`)">Siempre en este sitio</button>
        <button class="danger" @click="emit('respond', { kind: 'approve', decision: 'deny' }, 'Denegado')">Denegar</button>
      </div>
    </template>

    <template v-else-if="request.kind === 'question'">
      <div class="head" v-html="renderMarkdown(request.question)" />
      <template v-if="!answered">
        <div v-if="request.options.length" class="buttons wrap">
          <button v-for="o in request.options" :key="o" @click="answer(o)">{{ o }}</button>
        </div>
        <form class="free" @submit.prevent="answer(text)">
          <input v-model="text" placeholder="Otra respuesta…">
          <button type="submit" :disabled="!text.trim()">Responder</button>
        </form>
      </template>
    </template>

    <template v-else>
      <div class="head">Plan propuesto</div>
      <div class="summary" v-html="renderMarkdown(request.summary)" />
      <ol><li v-for="(s, i) in request.steps" :key="i">{{ s }}</li></ol>
      <template v-if="!answered">
        <div class="buttons wrap">
          <button class="primary" @click="emit('respond', { kind: 'plan', decision: 'approve', execMode: 'auto' }, 'Aprobado · Auto')">Aprobar y ejecutar</button>
          <button @click="emit('respond', { kind: 'plan', decision: 'approve', execMode: 'ask' }, 'Aprobado · Preguntar')">Aprobar, preguntando cada acción</button>
        </div>
        <form class="free" @submit.prevent="text.trim() && emit('respond', { kind: 'plan', decision: 'reject', feedback: text.trim() }, `Cambios: ${text.trim()}`)">
          <input v-model="text" placeholder="Qué cambiarías del plan…">
          <button type="submit" :disabled="!text.trim()">Pedir cambios</button>
        </form>
      </template>
    </template>

    <div v-if="answered" class="answered">{{ answered === 'cancelled' ? 'Cancelado' : `→ ${answered}` }}</div>
  </div>
</template>

<style scoped>
.card {
  border: 1px solid var(--accent-warning); background: var(--accent-warning-dim);
  border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px;
}
.card.plan { border-color: var(--accent-secondary); background: var(--accent-secondary-dim); }
.card.question { border-color: var(--accent-primary); background: var(--accent-primary-dim); }
.card.done { opacity: 0.7; }
.head { font-weight: 600; }
.head :deep(p) { margin: 0; }
.summary :deep(p) { margin: 0 0 4px; }
ol { margin: 0; padding-left: 20px; }
pre { margin: 0; font-size: 11px; max-height: 120px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
code { font-family: var(--font-mono, monospace); }
.buttons { display: flex; gap: 6px; }
.buttons.wrap { flex-wrap: wrap; }
.free { display: flex; gap: 6px; }
.free input { flex: 1; min-width: 0; }
button.primary { border-color: var(--accent-success); background: var(--accent-success-dim); }
button.danger { border-color: var(--accent-danger); background: var(--accent-danger-dim); }
.answered { color: var(--text-secondary); font-style: italic; }
</style>
