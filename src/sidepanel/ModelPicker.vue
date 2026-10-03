<script setup lang="ts">
/**
 * Model chooser for the composer: a chip that opens a sheet with a search box and the chat
 * models grouped Local / Alibaba / OpenRouter (grouping and filtering live in chats.ts).
 */
import { computed, nextTick, ref } from 'vue';
import { MODEL_GROUPS, groupChatModels, modelGroupOf, modelLabel } from './chats';

const props = defineProps<{ modelValue: string; models: string[]; loading: boolean; error: string }>();
const emit = defineEmits<{ 'update:modelValue': [id: string]; options: [] }>();

const open = ref(false);
const query = ref('');
const cursor = ref(0);
const search = ref<HTMLInputElement | null>(null);

// The current model stays pickable even when the list could not be fetched.
const groups = computed(() => {
  const q = query.value.trim().toLowerCase();
  const ids = props.models.includes(props.modelValue) ? props.models : [props.modelValue, ...props.models];
  return groupChatModels(ids)
    .map((g) => ({ ...g, models: g.models.filter((id) => !q || id.toLowerCase().includes(q) || modelLabel(id).toLowerCase().includes(q)) }))
    .filter((g) => g.models.length);
});
const flat = computed(() => groups.value.flatMap((g) => g.models));
const groupLabel = (id: string) => MODEL_GROUPS.find((g) => g.id === modelGroupOf(id))?.label ?? '';

async function show() {
  open.value = true;
  query.value = '';
  cursor.value = Math.max(0, flat.value.indexOf(props.modelValue));
  await nextTick();
  search.value?.focus();
}

function close() {
  open.value = false;
}

function pick(id: string) {
  emit('update:modelValue', id);
  close();
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = flat.value.length;
    if (n) cursor.value = (cursor.value + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
  } else if (e.key === 'Enter' && flat.value[cursor.value]) {
    e.preventDefault();
    pick(flat.value[cursor.value]);
  }
}
</script>

<template>
  <button type="button" class="chip" :title="`Modelo: ${modelValue} · ${groupLabel(modelValue)}`" aria-haspopup="dialog"
    :aria-expanded="open" @click="show">
    <span class="name">{{ modelLabel(modelValue) }}</span>
    <span class="grp">{{ groupLabel(modelValue) }}</span>
    <span aria-hidden="true">▾</span>
  </button>

  <div v-if="open" class="scrim" @click.self="close" @keydown="onKey">
    <div class="sheet" role="dialog" aria-label="Elegir modelo">
      <input ref="search" v-model="query" class="search" type="search" placeholder="Buscar modelo" aria-label="Buscar modelo"
        spellcheck="false" @input="cursor = 0">
      <div v-if="error" class="msg">
        <strong>No se pudo listar los modelos.</strong>
        <span>{{ error }} Puedes seguir con el modelo actual.</span>
        <button type="button" @click="close(); emit('options')">Revisar la key en Opciones</button>
      </div>
      <div v-if="loading && !models.length" class="skeleton" aria-busy="true"><i /><i /><i /></div>
      <div class="list" role="listbox">
        <template v-for="g in groups" :key="g.id">
          <div class="gtitle">{{ g.label }}</div>
          <button v-for="id in g.models" :key="id" type="button" role="option" class="row"
            :class="{ current: id === modelValue, cursor: flat[cursor] === id }" :aria-selected="id === modelValue" @click="pick(id)">
            <span class="rname">{{ modelLabel(id) }}<code>{{ id }}</code></span>
            <span v-if="id === modelValue" class="cur">✓ Actual</span>
          </button>
        </template>
        <p v-if="!groups.length && !loading" class="none">Ningún modelo coincide con «{{ query }}»</p>
      </div>
      <p class="foot">Los modelos que no son de chat (embeddings, voz, imagen, vídeo) no se muestran.</p>
    </div>
  </div>
</template>

<style scoped>
.chip { display: flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; min-height: 32px; padding: 3px 8px; background: var(--bg-elevated); color: var(--text-primary); border: 1px solid var(--border-default); border-radius: 6px; cursor: pointer; font: inherit; }
.chip .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.chip .grp { color: var(--text-secondary); font-size: 11px; white-space: nowrap; }
.scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); display: flex; align-items: flex-end; z-index: 50; }
.sheet { width: 100%; max-height: 80%; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--bg-surface); border-top: 1px solid var(--border-default); border-radius: 12px 12px 0 0; box-sizing: border-box; }
.search { background: var(--bg-deep); color: var(--text-primary); border: 1px solid var(--border-default); border-radius: 6px; padding: 8px; font: inherit; }
.list { overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.gtitle { margin-top: 6px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-secondary); }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 38px; padding: 4px 8px; background: none; color: var(--text-primary); border: 1px solid transparent; border-radius: 6px; cursor: pointer; font: inherit; text-align: left; }
.row.current { background: var(--bg-elevated); }
.row.cursor { border-color: var(--accent-primary); }
.rname { display: flex; flex-direction: column; min-width: 0; }
.rname code { font-family: var(--font-mono, monospace); font-size: 11px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; }
.cur { color: var(--accent-primary); font-size: 11px; white-space: nowrap; }
.msg { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; padding: 8px; border-left: 3px solid var(--accent-danger); background: var(--bg-deep); border-radius: 4px; font-size: 12px; }
.msg button { min-height: 32px; padding: 3px 10px; background: var(--accent-primary-dim); color: var(--text-primary); border: 1px solid var(--border-default); border-radius: 6px; cursor: pointer; font: inherit; }
.skeleton { display: flex; flex-direction: column; gap: 6px; }
.skeleton i { height: 30px; border-radius: 6px; background: var(--bg-elevated); opacity: 0.6; }
.none, .foot { margin: 4px 0; color: var(--text-secondary); font-size: 11.5px; }
</style>
