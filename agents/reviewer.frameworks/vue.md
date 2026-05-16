# Reviewer — Vue 3 (Composition API) framework supplement

Apply alongside the detected language checklist and the Cross-Cutting checks in the core role. Skip items that don't apply to the diff.

**Setup**

- `<script setup lang="ts">` is the default; flag Options API in new components without justification
- `defineProps` / `defineEmits` / `defineExpose` typed via TS generics
- Don't mix Options API and `<script setup>` in the same component

**Reactivity**

- `ref()` for primitives and reassignable references; access via `.value` in script (auto-unwrapped in template)
- `reactive()` for objects/maps/sets; never wrap a primitive in `reactive`
- **Don't destructure** a `reactive` object — breaks reactivity; use `toRefs()` if needed
- `computed()` for derived values; never call mutating logic inside `computed`
- `watch` vs `watchEffect`: `watch` for explicit deps + access to old/new; `watchEffect` for auto-tracked side effects
- `shallowRef`/`shallowReactive` for large structures where deep reactivity is wasteful

**Composables**

- Named `useXxx`, return refs/reactive, no side effects on import
- Pure functions where possible; lifecycle hooks inside composables only when called from `setup` context
- Avoid module-level reactive singletons unless they are intentional global stores

**Template**

- `v-for` with explicit `:key` (stable id, not index)
- No logic in templates beyond computed property reads — push to `computed`
- `v-if` vs `v-show`: `v-if` for rare toggles, `v-show` for frequent
- `v-model` with explicit modifier (`v-model:foo`) on custom components

**State management**

- Pinia for cross-component state; one store per domain
- Don't use `provide`/`inject` as a global state replacement
