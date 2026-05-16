# Reviewer — Svelte 5 (Runes) framework supplement

Apply alongside the detected language checklist and the Cross-Cutting checks in the core role. Skip items that don't apply to the diff.

**Runes**

- New code uses **runes** (`$state`, `$derived`, `$effect`, `$props`); flag `let` reactive declarations and `$:` labels in Svelte 5 components
- `$state.raw` for non-reactive deep structures (large arrays/objects you mutate yourself)
- `$derived` for computed values — must be pure; no side effects
- `$effect` only for side effects; avoid writing to `$state` inside `$effect` (creates loops)
- `$props()` destructured with defaults: `let { name = 'world' } = $props()`

**State outside components**

- Reactive state in `.svelte.ts` / `.svelte.js` files using runes — replaces most uses of stores
- "Reactive class" pattern: a class that holds `$state`-backed fields, exported as a singleton or factory
- Legacy `writable`/`readable`/`derived` stores still work but are not the default for new code
- Don't import `.svelte.ts` modules into non-Svelte test runners without configuring the compiler

**Components**

- Snippets (`{#snippet}` / `{@render}`) replace slots for parameterized rendering
- Props typed via TypeScript: `let { count }: { count: number } = $props()`
- `bind:` only when two-way binding is genuinely needed; otherwise prefer event callbacks

**Reactivity gotchas**

- `$state` is a deep proxy — `$state.snapshot()` to get a plain object (e.g., for logging or external libs)
- Fine-grained reactivity tracks property reads — destructuring `$state` objects loses reactivity (similar to Vue)

**Organization**

- Domain-based folders (`src/lib/domains/<domain>/`) for non-trivial apps
- One responsibility per `.svelte.ts` module; don't dump unrelated state into a shared file
