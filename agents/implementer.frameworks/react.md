# Implementer — React framework supplement

Idiomatic React (19+) conventions to follow when writing the code. Use alongside the core role and the language supplement. Skip items that don't apply.

## Components & hooks

- **Function components only.** Hooks at the top level — no conditionals, no loops.
- **Don't fetch data in `useEffect`** — use a Server Component, the `use()` hook with Suspense, or a server-state library (TanStack Query, SWR).
- **Derive, don't sync** — compute a value from props/state inline; don't mirror it into `useState` and update it via an effect.
- **`useEffect` only for** subscriptions, DOM imperative APIs, and syncing with non-React systems — always with a cleanup return.

## State

- **Lift state only as far as it is needed**; co-locate the rest.
- **`useReducer`** for coupled or complex transitions; **`useState`** for independent flags.

## Server Components / Actions

- **Server Components by default**; mark client boundaries with `'use client'` and keep them at the leaves.
- **Server Actions validate every input** and never trust a client-sent id without an authorization check.

## Performance

- **Don't hand-memoize when React Compiler is enabled** — it auto-memoizes; manual `useMemo` / `useCallback` is noise. If the compiler is off, memoize only measured hot spots.
- **Stable list keys** — a domain id, never the array index (unless the list is static).
