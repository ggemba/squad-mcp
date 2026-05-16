# QA — Svelte framework supplement

How to test Svelte components and what typically goes untested. Use alongside the core role. Skip items that don't apply.

## Test approach

- **`@testing-library/svelte` + Vitest.** `render()` the component, query by role/text, assert on the DOM.
- **`.svelte.ts` rune modules** need a Vitest setup that runs the Svelte compiler transform — runes (`$state`, `$derived`) throw if the module is loaded raw.
- **Assert rendered output and events, not internal `$state`.**

## Async

- **Svelte updates the DOM asynchronously** — `await tick()` (or rely on testing-library's auto-retrying queries) after an interaction before asserting.

## Coverage gaps to flag

- **Snippet rendering** — components taking `{#snippet}` / `{@render}` are usually tested only with default content.
- **`bind:` two-way bindings** — the value-back path.
- **`$derived` recompute** — that the derived value updates when its source changes.
- **`$effect` cleanup** — that destroying the component releases timers and listeners.
- **Loading / error / empty states** of every async component.
