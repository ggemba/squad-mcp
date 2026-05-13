# Reviewer — TypeScript / JavaScript supplement

Use this checklist alongside the core role. The core covers WHAT you review; this covers HOW that looks in TypeScript code specifically. Skip items that don't apply to the diff at hand.

## Type system

- **`any` is a smell.** `unknown` + narrowing or a typed parameter is almost always better. `as any` to silence tsc usually masks a real type bug.
- **`as` casts are claims.** Each `as Foo` is the dev asserting "I know better than the compiler". Verify the claim. Prefer type guards (`function isFoo(x): x is Foo`).
- **`!` non-null assertions** in a hot path = production NPE waiting. Acceptable in tests; suspicious in production code.
- **`@ts-ignore` / `@ts-expect-error`** — both need a `// reason: ...` comment. `@ts-ignore` without expectation drift makes future tsc upgrades silently start failing.
- **Discriminated unions vs class hierarchies.** When code does `if (foo.kind === "x")`, prefer `type Foo = { kind: "x"; ... } | { kind: "y"; ... }` over polymorphism. Easier exhaustiveness check via `never` in default arm.

## Async / await

- **`await` in a loop** serialises what could be parallel. `for (const x of xs) await foo(x)` → `await Promise.all(xs.map(foo))` unless ordering is load-bearing.
- **Floating promises.** `foo()` without `await` or `.catch` swallows rejections silently. If intentional (fire-and-forget), make it explicit: `void foo()` or `foo().catch(err => log(err))`.
- **`Promise.all` vs `Promise.allSettled`.** `all` rejects on first failure (other promises keep running but result is lost). `allSettled` collects all outcomes — use when partial-failure semantics matter (telemetry, fan-out fetches).
- **Microtask ordering.** A `setImmediate` does not wait for queued microtasks. Mixing `await` and `setTimeout` can produce surprising orderings — flag explicitly.
- **AbortController cleanup.** Cancellation that never fires `controller.abort()` on the success path leaks listeners. Always `clearTimeout` in finally and abort cancellation tokens explicitly when work completes.

## Error handling

- **`catch (err)` typed as `unknown`** since TS 4.4. `err.message` requires narrowing (`err instanceof Error`) — flag bare `err.message` accesses.
- **Swallowed errors** via empty `catch {}` or `catch (err) { /* log only */ }` need a written justification. Logging without rethrowing OR remediating means the caller's `await` resolves with no signal something failed.
- **Custom error classes** lose their stack trace if you `throw new Error(originalErr.message)`. Use `cause: originalErr` (Node 16.9+) or extend an Error subclass that captures it.

## React (when JSX/TSX present)

- **`useEffect` dependency array.** Stale closures over state or props are the #1 React bug. Run through the ESLint `exhaustive-deps` rule mentally. Empty `[]` for non-mount effects is almost always wrong.
- **Key prop on lists.** Index as key is a silent bug when the list reorders or filters. Use a stable id from the data.
- **Controlled vs uncontrolled inputs.** A field that becomes controlled mid-lifecycle (or vice versa) throws a React warning on every keystroke.
- **`useMemo` / `useCallback` overuse.** Adding them to "improve performance" without measuring usually adds work (the dependency-array equality check) instead of saving it.
- **Side effects in render.** State updates in the render body cause infinite re-render loops. Move to `useEffect` or event handlers.

## Module / build

- **ESM imports with `.js` extension** are required in pure-ESM projects (the project uses `"type": "module"`). `import { X } from "./foo"` will fail at runtime — must be `from "./foo.js"`. Flag missing extensions.
- **`import type`** preserves erased imports across boundaries that don't strip type-only imports. Improves bundle size.
- **`unknown` vs `never` returns.** A function with `: never` return type promises it does NOT return normally (throws or infinite loops). Misuse breaks exhaustiveness checks.
- **Default exports vs named.** Named exports are easier to refactor via grep and rename safely. Default exports lose their identity across re-exports.

## Naming / idioms

- **`const` over `let` over `var`.** `var` should not appear in new TS code at all; flag any introduction.
- **`null` vs `undefined`.** Pick one per project. Mixing both forces every caller to handle two falsy cases.
- **Boolean param names.** `delete(true)` is uninspectable; `delete({ recursive: true })` is. Flag positional booleans on public APIs.
- **`async` on a function that has no `await`** is a red flag — either it returns a value (waste) or it's calling something that should be awaited.
