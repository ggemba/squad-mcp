# Implementer — Svelte framework supplement

Idiomatic Svelte 5 (Runes) conventions to follow when writing the code. Use alongside the core role and the language supplement. Skip items that don't apply.

## Runes

- **New code uses runes** — `$state`, `$derived`, `$effect`, `$props`. No `$:` reactive labels or reactive `let` in Svelte 5 components.
- **`$derived` for computed values** — keep it pure.
- **`$effect` only for side effects** — return a cleanup function for timers/listeners; never write `$state` it also reads.
- **`$state.raw`** for large structures mutated wholesale (skips deep proxying).

## State outside components

- **Reactive state in `.svelte.ts` / `.svelte.js` modules** using runes — this replaces most store usage.
- The "reactive class" pattern (a class with `$state`-backed fields, exported as a singleton or factory) is the idiom for shared state.

## Components

- **Snippets (`{#snippet}` / `{@render}`)** over slots for parameterised rendering.
- **Props typed via `$props()`** — `let { count }: { count: number } = $props()`.
- **`bind:` only when two-way binding is genuinely needed** — otherwise event callbacks.
