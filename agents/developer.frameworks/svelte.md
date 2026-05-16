# Developer — Svelte framework supplement

Framework-specific correctness, robustness, and performance pitfalls. Use alongside the core role and the language supplement. Skip items that don't apply.

## Correctness

- **`$effect` writing `$state` it also reads** — an infinite update loop. Derived values belong in `$derived`, not `$effect`.
- **Destructuring `$state` / `$props`** — destructuring loses the reactive binding (fine-grained reactivity tracks property reads). Access through the object.
- **`$state` is a deep proxy** — passing it to an external library, `structuredClone`, or a logger sees the proxy. Use `$state.snapshot()` for a plain object.
- **`$derived` with side effects** — it must be pure; side effects inside recompute unpredictably.

## Robustness

- **`$effect` cleanup** — return a cleanup function for timers, listeners, and subscriptions, or they leak across re-runs.
- **Reactivity across the module boundary** — runes in a `.svelte.ts` file react only inside a Svelte context; importing such state into a plain test runner without the Svelte compiler configured throws.

## Performance

- **Deep reactivity on large structures** — `$state` proxies every nested property. Use `$state.raw` for big arrays/objects mutated wholesale.
- **Legacy store leaks** — a manual `.subscribe()` on a store inside a `.svelte.ts` module (no auto-`$` unsubscribe) leaks; prefer rune-based state.
