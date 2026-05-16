# Implementer — Vue framework supplement

Idiomatic Vue 3 (Composition API) conventions to follow when writing the code. Use alongside the core role and the language supplement. Skip items that don't apply.

## Component shape

- **`<script setup lang="ts">`** is the default — not the Options API.
- **`defineProps` / `defineEmits` typed** via TypeScript generics.

## Reactivity

- **`ref()` for primitives and reassignable values; `reactive()` for objects.** Never wrap a primitive in `reactive`.
- **Don't destructure a `reactive` object** — it breaks reactivity; use `toRefs()`.
- **`computed()` for derived values** (keep getters pure); **`watch` / `watchEffect`** for side effects.

## Composition & state

- **Composables named `useXxx`**, returning refs/reactive, with no side effects on import.
- **Pinia for cross-component state** — one store per domain. Don't use `provide` / `inject` as a global store.

## Templates

- **`v-for` with a stable `:key`** (a domain id, not the index).
- **No logic in templates** beyond a property read — push it to `computed`.
