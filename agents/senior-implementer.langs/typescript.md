# Senior-Implementer — TypeScript / JavaScript supplement

Use alongside the core role. The core covers HOW to implement (workflow / output format / boundaries); this covers idiomatic TS conventions you should follow when writing the code.

## Module / build conventions

- **ESM imports MUST include `.js` extension** for relative imports — even when the source is `.ts`. The project is `"type": "module"`. `import { foo } from "./bar"` fails at runtime; must be `from "./bar.js"`.
- **`import type`** for type-only imports. Erased at compile time, smaller bundles.
- **Named exports over default** — easier to grep, refactor, and rename. Use default only when interop requires it (React component default exports for lazy loading).
- **One concept per file** — a 200-line file with three unrelated exports is a refactor target, not a finished implementation.

## Type discipline

- **Default to `unknown` over `any`** when the input type is genuinely uncertain. Narrow with type guards.
- **Avoid `as Foo` casts** — they silently lie to the type system. Use `satisfies Foo` (TS 4.9+) when you want both type checking AND value preservation.
- **`readonly` on function-parameter arrays** — `function foo(items: readonly string[])` documents that the function won't mutate. Easier to compose with frozen data.
- **Discriminated unions over interface inheritance** — `type Result = { ok: true; value: T } | { ok: false; error: E }` over class hierarchies. Cleaner exhaustiveness check.

## Async patterns

- **Always `await` or `void` a Promise** — never let it float. `void foo()` is the explicit "I know this is fire-and-forget".
- **Top-level `try/catch` in entry points** — without it, unhandled rejections crash the process (Node 15+ default).
- **`Promise.all` for independent parallel work** — don't `await` in a loop unless ordering matters.
- **`AbortController` for cancellation** — `clearTimeout` in finally; abort in success path too if work is cancellable.

## Naming / style

- **`const` by default, `let` when reassignment is needed, `var` never.**
- **`null` vs `undefined`** — pick one per API surface and stick with it. The project convention should win.
- **Boolean parameter names** — prefer named-arg objects over positional booleans. `delete({ recursive: true })` over `delete(true)`.
- **Async function naming** — `getUserAsync` vs `getUser`. Convention varies (Node generally drops the suffix; .NET uses it). Check the surrounding code; consistency wins.

## Error handling

- **Custom Error subclasses** for domain errors — `class NotFoundError extends Error`. Lets callers `instanceof`-check.
- **`cause: originalErr`** when wrapping (`new Error("wrapping reason", { cause: originalErr })`) — preserves the chain.
- **Don't catch what you can't handle** — `catch (err) { logger.error(err); throw err; }` adds nothing. If you can't add context or handle, don't catch.

## Build / test verification

- **Run `npm run lint` AFTER edits** — TSC + ESLint + Prettier. Failure blocks ship.
- **Run `npm test` (or specific test files)** — ALL existing tests must still pass; new logic needs new tests if the plan called for them.
- **Don't commit auto-generated files** — `dist/`, `.turbo/`, `.next/` are usually gitignored. Verify.
- **Pre-commit hooks** — the project may have husky / lint-staged. They run on `git commit` (which YOU don't run, but the user will).

## Project-specific reminders

- **No emojis in code** (project rule). No `Co-Authored-By` AI attribution in any commit message you suggest the user run.
- **Method names in English** (project rule). Even when comments are in another language, identifiers are English.
- **Per-file imports** — group external imports first, then `node:` modules, then internal `../` / `./` imports. Match existing file convention.
