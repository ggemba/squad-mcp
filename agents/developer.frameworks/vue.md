# Developer — Vue framework supplement

Framework-specific correctness, robustness, and performance pitfalls. Use alongside the core role and the language supplement. Skip items that don't apply.

## Correctness

- **Destructuring a `reactive` object** — `const { count } = reactive(obj)` snapshots the value and loses reactivity; the UI silently stops updating. Use `toRefs()` or access through the object.
- **`ref` without `.value` in script** — `if (myRef)` tests the Ref wrapper (always truthy), not the value. Only templates auto-unwrap.
- **Mutating a prop** — props are one-way; mutating one triggers a Vue warning and desyncs parent and child. Emit an event or use a local copy.
- **`computed` with side effects** — a `computed` getter must be pure; side effects inside it run unpredictably against the cache.
- **`v-for` key as index** — same DOM-reuse hazard as React; use a stable id.

## Robustness

- **Async `<script setup>`** — a top-level `await` makes the component async; it must sit under a `<Suspense>` boundary or it never renders.
- **Watcher cleanup** — a `watch` / `watchEffect` that registers a listener or interval must use the `onCleanup` callback, or it leaks on re-run and unmount.

## Performance

- **Deep `watch` on a large structure** — deep-watching a big object is expensive. Watch a specific path, or use `shallowRef` / `shallowReactive` when deep reactivity is wasted.
- **Module-level reactive singletons** — a `reactive()` / `ref()` at module scope is shared global state: intended for stores only, and never cleaned up.
- **Logic in templates** — an expression beyond a property read re-runs every render; move it to `computed`.
