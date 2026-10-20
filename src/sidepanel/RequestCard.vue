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
  <!-- Como las preguntas de Claude (SC-2825): texto como el de un mensaje, opciones en filas numeradas, sin cajas. -->
  <div class="card" :class="[request.kind, { done: answered }]">
    <template v-if="request.kind === 'approve'">
      <div class="head">¿Permitir <code>{{ request.tool }}</code><span v-if="request.origin"> en {{ request.origin }}</span>?</div>
      <pre v-if="args !== '{}'">{{ args }}</pre>
      <ol v-if="!answered" class="options">
        <li><button @click="emit('respond', { kind: 'approve', decision: 'allow' }, 'Permitido')"><span class="n">1</span>Permitir</button></li>
        <li v-if="request.origin"><button @click="emit('respond', { kind: 'approve', decision: 'allow_site' }, `Siempre en ${request.origin}`)"><span class="n">2</span>Siempre en este sitio</button></li>
        <li><button class="deny" @click="emit('respond', { kind: 'approve', decision: 'deny' }, 'Denegado')"><span class="n">{{ request.origin ? 3 : 2 }}</span>Denegar</button></li>
      </ol>
    </template>

    <template v-else-if="request.kind === 'question'">
      <div class="head" v-html="renderMarkdown(request.question)" />
      <ol v-if="!answered" class="options">
        <li v-for="(o, i) in request.options" :key="o"><button @click="answer(o)"><span class="n">{{ i + 1 }}</span>{{ o }}</button></li>
        <li>
          <form class="free" @submit.prevent="answer(text)">
            <input v-model="text" placeholder="Otra respuesta…" aria-label="Otra respuesta">
            <button v-if="text.trim()" type="submit" class="link">Responder</button>
          </form>
        </li>
      </ol>
    </template>

    <template v-else>
      <div class="label">Plan propuesto</div>
      <div class="head" v-html="renderMarkdown(request.summary)" />
      <ol class="steps"><li v-for="(s, i) in request.steps" :key="i">{{ s }}</li></ol>
      <ol v-if="!answered" class="options">
        <li><button @click="emit('respond', { kind: 'plan', decision: 'approve', execMode: 'auto' }, 'Aprobado · Auto')"><span class="n">1</span>Aprobar y ejecutar</button></li>
        <li><button @click="emit('respond', { kind: 'plan', decision: 'approve', execMode: 'ask' }, 'Aprobado · Preguntar')"><span class="n">2</span>Aprobar, preguntando cada acción</button></li>
        <li>
          <form class="free" @submit.prevent="text.trim() && emit('respond', { kind: 'plan', decision: 'reject', feedback: text.trim() }, `Cambios: ${text.trim()}`)">
            <input v-model="text" placeholder="Qué cambiarías del plan…" aria-label="Qué cambiarías del plan">
            <button v-if="text.trim()" type="submit" class="link">Pedir cambios</button>
          </form>
        </li>
      </ol>
    </template>

    <div v-if="answered" class="answered">{{ answered === 'cancelled' ? 'Cancelado' : `→ ${answered}` }}</div>
  </div>
</template>

<style scoped>
.card { display: flex; flex-direction: column; gap: 10px; line-height: 1.7; word-break: break-word; }
.head :deep(p) { margin: 0 0 10px; }
.head :deep(p:last-child) { margin-bottom: 0; }
.head :deep(ul), .head :deep(ol), .steps { margin: 4px 0; padding-left: 20px; }
.label { color: var(--text-secondary); font-size: 12px; }
pre { margin: 0; font-size: 11px; max-height: 120px; overflow: auto; white-space: pre-wrap; word-break: break-all; background: var(--bg-surface); padding: 6px; border-radius: var(--radius-sm); }
code { font-family: var(--font-mono, monospace); background: var(--bg-elevated); padding: 1px 4px; border-radius: 4px; font-size: 12px; }
.options { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--border-default); }
.options li { border-bottom: 1px solid var(--border-default); }
.options li > button { display: flex; align-items: baseline; gap: 12px; width: 100%; padding: 8px 6px; border: none; border-radius: 0; background: none; text-align: left; line-height: 1.5; }
.options li > button:hover { background: var(--bg-hover); }
.options li > button.deny { color: var(--accent-danger); }
.n { flex: none; min-width: 1ch; color: var(--text-tertiary); font-size: 12px; font-variant-numeric: tabular-nums; }
.free { display: flex; align-items: center; gap: 6px; }
.free input { flex: 1; min-width: 0; border: none; background: none; padding: 8px 6px; }
/* El foco se ve en la fila, no como un anillo naranja alrededor del campo. */
.free input:focus-visible { outline: none; }
.options li:has(.free:focus-within) { border-bottom-color: var(--accent-primary); }
.answered { color: var(--text-secondary); font-size: 12px; }
</style>
