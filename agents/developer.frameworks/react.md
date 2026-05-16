# Developer — React framework supplement

Framework-specific correctness, robustness, and performance pitfalls. Use alongside the core role and the language supplement. Skip items that don't apply.

## Correctness

- **Stale closures** — an event handler or `useEffect` callback closes over `state`/`props` from the render that created it. A wrong or empty dependency array makes it read stale values. The #1 React correctness bug — verify every `useEffect` dep list.
- **`useEffect` race conditions** — an async fetch inside an effect can resolve AFTER unmount or after a newer request. Without an `ignore` flag or `AbortController` in the cleanup, a stale response overwrites fresh state.
- **State update in the render body** — calling `setState` during render is an infinite re-render loop. Updates belong in effects or handlers.
- **Derived state copied into `useState`** — a value computable from props/state but also stored separately drifts out of sync. Compute it inline.
- **Key as array index** on a reorderable/filterable list — React reuses the wrong DOM node; focus and local input state attach to the wrong row.

## Robustness

- **Missing effect cleanup** — subscriptions, timers, and listeners with no cleanup return leak across remounts; StrictMode's dev double-invoke surfaces this.
- **No error boundary** — an uncaught render error blanks the whole tree. Long-lived apps need boundaries around route/feature subtrees.
- **Server Actions** — never trust a client-sent id without an authorization check; treat every action input as untrusted (forward auth concerns to security).

## Performance

- **Context value re-created each render** — a fresh object/array as the Provider `value` re-renders every consumer. Memoize it.
- **New literal props to a memoized child** — inline `{}` / `[]` / `() => {}` defeat `React.memo`. (If React Compiler is on this is auto-handled — don't hand-memoize.)
- **Unvirtualized long lists** — thousands of rows mounted at once janks. Virtualize.
- **Fetch waterfalls** — independent requests `await`ed sequentially across nested Suspense boundaries; parallelize them.
