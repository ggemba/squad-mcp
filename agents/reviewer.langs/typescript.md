# Reviewer — TypeScript / JavaScript supplement

Idiomatic checklist for TypeScript / JavaScript (Node backend and frontend). Apply alongside the Cross-Cutting checks in the core role. Skip items that don't apply to the diff.

## Project setup

- `tsconfig.json` with `"strict": true` (the floor — flag if disabled), plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `useUnknownInCatchVariables`.
- ESM by default (`"type": "module"`); flag CJS in new code without justification. In pure-ESM projects relative imports need the `.js` extension (`from "./foo.js"`).
- Dependencies pinned; `engines.node` set.

## Type system

- `any` is a smell — `unknown` + narrowing or a typed parameter is almost always better. `as any` usually masks a real type bug.
- `as` casts are claims ("I know better than the compiler") — verify each; prefer type guards (`function isFoo(x): x is Foo`) or a Zod parse.
- `!` non-null assertion in a production hot path = NPE waiting; acceptable in tests, suspicious otherwise.
- `@ts-ignore` / `@ts-expect-error` both need a `// reason:` comment; prefer `@ts-expect-error` (surfaces when the error goes away).
- Discriminated unions for variant / result / state types (`type Result = { ok: true; value: T } | { ok: false; error: E }`) over class hierarchies — exhaustiveness via `never`.
- `satisfies` to check a value against a type without widening; `as const` for literal preservation; branded types (`string & { __brand }`) for non-interchangeable IDs.
- Prefer `type` for unions/intersections, `interface` for extendable object shapes.
- Avoid `enum` (use a union of string literals or an `as const` object) except where interop demands it.
- Constrain generics (`<T extends Foo>`); don't over-genericize — concrete types read easier. A `: never` return promises the function never returns normally; misuse breaks exhaustiveness checks.

## Async

- `async/await` everywhere; no raw `.then` chains in new code.
- Always `await` or `return` a promise — a floating promise swallows rejections. Fire-and-forget must be explicit: `void foo()` or `foo().catch(...)`.
- `await` in a loop serialises what could be parallel — `await Promise.all(xs.map(foo))` unless ordering is load-bearing.
- `Promise.all` rejects on first failure; `Promise.allSettled` when partial failure is acceptable.
- `AbortController` / `AbortSignal` propagated through requests, DB calls, timers; `clearTimeout` in `finally`. Always set timeouts on outbound HTTP / DB calls.

## Errors

- `catch (err)` is typed `unknown` (TS 4.4+) — narrow (`err instanceof Error`) before accessing `err.message`.
- Custom error classes extend `Error` with `name`, `code`, and `cause` (`throw new MyError("...", { cause: err })`) — `new Error(orig.message)` loses the stack.
- Empty `catch {}` or log-only catch needs a written justification — otherwise the caller's `await` resolves with no signal something failed.
- Validate input at the edge (Zod, Valibot, class-validator); never trust raw `req.body`. Centralized error middleware keeps route handlers clean.

## Logging & ops

- Structured logging (pino, winston) with correlation IDs; no `console.log` in production code.
- Never log secrets, tokens, PII; flag `JSON.stringify` of full request bodies.

## Modules & naming

- Named exports over default exports (easier to refactor, rename, re-export); barrel `index.ts` only when it does not create circular deps.
- `import type` for type-only imports — smaller bundles, safe across boundaries.
- `const` over `let`; `var` should not appear in new code.
- Pick `null` or `undefined` per project — mixing forces every caller to handle both falsy cases.
- No positional booleans on public APIs (`delete({ recursive: true })`, not `delete(true)`).
- `async` on a function with no `await` is a red flag — wasteful, or it forgot to await something.
