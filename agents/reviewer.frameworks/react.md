# Reviewer — React (19+) framework supplement

Apply alongside the detected language checklist and the Cross-Cutting checks in the core role. Skip items that don't apply to the diff.

**Compiler era**

- React Compiler (when enabled) auto-memoizes — flag manual `useMemo`/`useCallback`/`React.memo` that the compiler would handle, unless profiling shows benefit
- If compiler not enabled, `useMemo`/`useCallback` are still legitimate but require justification (passed to memoized child, expensive computation)

**Hooks**

- Rules of hooks: top-level only, no conditionals/loops; same order each render
- Custom hooks named `useXxx`; encapsulate shared stateful logic
- `useEffect` is **not** for data fetching — use `use()` + Suspense, Server Components, or TanStack Query/SWR
- `useEffect` legitimate uses: subscriptions, DOM imperative APIs, syncing with non-React systems
- Always provide cleanup functions for subscriptions/timers/listeners
- Dependency arrays exhaustive (enable `react-hooks/exhaustive-deps` lint); don't lie to the linter

**Common bugs**

- No state updates in the render body — they cause infinite re-render loops; move to `useEffect` or an event handler
- A controlled input must not flip to uncontrolled mid-lifecycle (value going `undefined` → defined or back) — React warns on every keystroke

**State**

- Lift state only as far as needed; co-locate
- Derive, don't duplicate — if it can be computed from props/state, compute it
- `useReducer` for complex transitions or coupled fields; `useState` for independent flags
- Server state belongs in a server-state library (TanStack Query, SWR), not `useState`

**Server Components / Actions (RSC)**

- Server Components are async by default and run on the server — no hooks, no event handlers, no browser APIs
- Mark client boundaries with `'use client'`; keep them at the leaves
- Server Actions: validate inputs, never trust client-sent IDs without authorization checks
- Streaming: use `<Suspense>` boundaries to progressively render

**Performance**

- Stable keys in lists (id, not index, unless static)
- Avoid creating new object/array/function literals as props if the child is memoized
- Code-split heavy routes/components with `lazy` + `Suspense`

**Accessibility**

- Semantic HTML over `<div onClick>`
- `alt` on images, `aria-*` on custom widgets, focus management on route changes
- Color contrast checked; keyboard nav works
