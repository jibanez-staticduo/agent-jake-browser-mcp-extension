<script setup lang="ts">
/**
 * Searchable model catalog for the composer.
 */
import { computed, nextTick, ref, watch } from 'vue';
import { MODEL_GROUPS, groupChatModels, isExternalModel, modelGroupOf, modelLabel } from './chats';

const props = defineProps<{ modelValue: string; models: string[]; loading: boolean; error: string }>();
const emit = defineEmits<{ 'update:modelValue': [id: string]; options: []; retry: [] }>();

const EXTERNAL_HINT = 'Este modelo corre fuera de casa: tus datos salen a un tercero.';
const open = ref(false);
const query = ref('');
const cursor = ref(0);
const search = ref<HTMLInputElement | null>(null);
const sheet = ref<HTMLElement | null>(null);
const chipEl = ref<HTMLButtonElement | null>(null);
const rowId = (id: string) => `model-opt-${id}`;

const groups = computed(() => {
  const q = query.value.trim().toLowerCase();
  return groupChatModels(props.models)
    .map((g) => ({ ...g, models: g.models.filter((id) => !q || id.toLowerCase().includes(q) || modelLabel(id).toLowerCase().includes(q)) }))
    .filter((g) => g.models.length);
});
const flat = computed(() => groups.value.flatMap((g) => g.models));
const groupLabel = (id: string) => MODEL_GROUPS.find((g) => g.id === modelGroupOf(id))?.label ?? '';

watch(flat, () => { cursor.value = Math.min(cursor.value, Math.max(0, flat.value.length - 1)); });

watch(cursor, () => {
  void nextTick(() => document.getElementById(rowId(flat.value[cursor.value] ?? ''))?.scrollIntoView({ block: 'nearest' }));
});

async function show() {
  open.value = true;
  query.value = '';
  cursor.value = Math.max(0, flat.value.indexOf(props.modelValue));
  await nextTick();
  search.value?.focus();
}

function close() {
  open.value = false;
  void nextTick(() => chipEl.value?.focus());
}

function pick(id: string) {
  emit('update:modelValue', id);
  close();
}

function trapTab(e: KeyboardEvent) {
  if (e.key !== 'Tab') return;
  const fields = sheet.value?.querySelectorAll<HTMLElement>('input, button:not([tabindex="-1"])');
  if (!fields?.length) return;
  const from = e.shiftKey ? fields[0] : fields[fields.length - 1];
  if (document.activeElement !== from) return;
  e.preventDefault();
  (e.shiftKey ? fields[fields.length - 1] : fields[0]).focus();
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = flat.value.length;
    if (n) cursor.value = (cursor.value + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
  } else if (e.key === 'Enter' && !e.isComposing && flat.value[cursor.value]) {
    e.preventDefault();
    pick(flat.value[cursor.value]);
  }
}
</script>

<template>
  <button ref="chipEl" type="button" class="chip" :title="`Modelo: ${modelValue} · ${groupLabel(modelValue)}`" aria-haspopup="dialog"
    :aria-expanded="open" @click="show">
    <span class="name">{{ modelLabel(modelValue) || 'Elegir modelo' }}</span>
    <span v-if="isExternalModel(modelValue)" class="external" :title="EXTERNAL_HINT">Externo</span>
    <span class="grp">{{ groupLabel(modelValue) }}</span>
    <span aria-hidden="true">▾</span>
  </button>

  <div v-if="open" class="scrim" @click.self="close" @keydown.esc.prevent.stop="close">
    <div ref="sheet" class="sheet" role="dialog" aria-modal="true" aria-label="Elegir modelo" @keydown="trapTab">
      <input ref="search" v-model="query" class="search" type="search" placeholder="Buscar modelo" aria-label="Buscar modelo"
        role="combobox" aria-controls="model-list" aria-expanded="true" :aria-activedescendant="flat[cursor] ? rowId(flat[cursor]) : undefined"
        spellcheck="false" @input="cursor = 0" @keydown="onKey">
      <div v-if="error" class="msg">
        <strong role="alert">{{ error }}</strong>
        <button type="button" @click="emit('retry'); search?.focus()">Reintentar</button>
        <button type="button" @click="close(); emit('options')">Abrir Opciones</button>
      </div>
      <p v-if="loading" class="none" role="status">Cargando modelos…</p>
      <p v-else-if="!error && models.length && modelValue && !models.includes(modelValue)" class="none">
        El modelo configurado no aparece en el catálogo.
      </p>
      <div id="model-list" class="list" role="listbox">
        <template v-for="g in groups" :key="g.id">
          <div class="gtitle">{{ g.label }}</div>
          <button v-for="id in g.models" :id="rowId(id)" :key="id" type="button" tabindex="-1" role="option" class="row"
            :class="{ current: id === modelValue, cursor: flat[cursor] === id }" :aria-selected="id === modelValue" @click="pick(id)">
            <span class="rname">{{ modelLabel(id) }}<code>{{ id }}</code></span>
            <span class="tags">
              <span v-if="isExternalModel(id)" class="external" :title="EXTERNAL_HINT">Externo</span>
              <span v-if="id === modelValue" class="cur">✓ Actual</span>
            </span>
          </button>
        </template>
      </div>
      <p v-if="!groups.length && !loading && !error" class="none" role="status">
        {{ query.trim() && models.length ? `Ningún modelo coincide con «${query}»` : 'El catálogo no tiene modelos de chat disponibles.' }}
      </p>
    </div>
  </div>
</template>

<style scoped>
/* Plano (INFRA-881): el modelo es texto del pie, no un botón con su propio marco. */
.chip { display: flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; min-height: 0; padding: 0; border: none; background: none; color: var(--text-secondary); font-size: 12px; }
.external { border: 1px solid var(--accent-warning); color: var(--accent-warning); border-radius: 4px; padding: 0 5px; font-size: 10.5px; font-weight: 600; white-space: nowrap; }
.tags { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
@media (max-width: 379px) { .chip .grp { display: none; } }
.chip .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: var(--text-primary); }
.chip .grp { color: var(--text-secondary); font-size: 11px; white-space: nowrap; }
.scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); display: flex; align-items: flex-end; z-index: 50; }
.sheet { width: 100%; max-height: 80%; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--bg-surface); border-top: 1px solid var(--border-default); border-radius: 12px 12px 0 0; box-sizing: border-box; }
.search { padding: 8px; }
.list { overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.gtitle { position: sticky; top: 0; z-index: 1; background: var(--bg-surface); padding: 6px 0 2px; margin-top: 4px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-secondary); }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 38px; background: none; border-color: transparent; text-align: left; }
.row.current { background: var(--bg-elevated); }
.row.cursor { border-color: var(--accent-primary); }
.rname { display: flex; flex-direction: column; min-width: 0; }
.rname code { font-family: var(--font-mono, monospace); font-size: 11px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; }
.cur { color: var(--accent-primary); font-size: 11px; white-space: nowrap; }
.msg { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; padding: 8px; border-left: 3px solid var(--accent-danger); background: var(--bg-deep); border-radius: 4px; font-size: 12px; }
.none { margin: 4px 0; color: var(--text-secondary); font-size: 11.5px; }
</style>
