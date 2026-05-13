# Developer — TypeScript / JavaScript supplement

Use alongside the core role. Skip items that don't apply.

## Correctness

- **Strict null checks** — `string | undefined` requires narrowing before access. `obj.foo!` non-null assertion is a claim; verify it with bounded reasoning, not "the test passes".
- **`Array.find` returning `T | undefined`** — code chaining `.find(...).id` is an unsafe access. Pair with `if` narrowing or `??` default.
- **`JSON.parse` returns `any`** by default — code that types it as a specific shape is asserting at the boundary. Use Zod or io-ts for runtime validation when the JSON comes from user input / external service.
- **Number coercion in equality** — `==` is forbidden in modern TS. `===` is mandatory. The `==` comparisons that survived a tsc upgrade should be flagged in the PR.

## Robustness

- **Promise rejection handling** — top-level `await` in entry-point modules without try/catch terminates the process unhandled. CLI entrypoints especially.
- **`process.on("uncaughtException")` handler** that logs and continues is a common but dangerous pattern — the process is in an unknown state. Prefer `process.exit(1)` after logging and rely on a process supervisor (systemd, pm2, k8s).
- **`SIGTERM` handling** in long-running processes — code that doesn't drain in-flight work on SIGTERM loses requests on rolling deploy.
- **Backpressure on streams** — writing to a Node stream without checking `write()`'s return value (false = drain needed) accumulates memory. `pipeline()` handles this; manual `.on("data", ...)` does not.

## API contracts

- **HTTP response shape** — code that returns `{ data: T }` in some routes and bare `T` in others breaks the consumer. Pin a wrapper type and use it consistently.
- **Status codes vs response body** — a 200 response carrying `{ error: "..." }` is a contract bug — clients check status, not body. Use proper status codes.
- **Versioned endpoints** — adding a field to a v1 response is a backward-compatible change; removing or renaming is breaking. Reviewers flag the latter.
- **`undefined` vs `null` in JSON** — `JSON.stringify({ a: undefined })` → `{}`. Code that relies on `null` to mean "explicitly cleared" needs to write null, not leave undefined.
- **Date serialisation** — ISO 8601 strings vs Unix timestamps vs Date objects. Mixing them across boundary is a contract footgun.

## External integrations

- **Retry with backoff** for transient errors (5xx, network timeout) — naïve retry without backoff hammers a flapping service. Cap retries.
- **Idempotency keys** on mutation calls (POST that creates a resource) — without them, retries duplicate.
- **HTTP client timeouts** — `fetch` with no `signal: AbortController` waits forever. Real production code needs timeouts.
- **Connection pooling** — `new MongoClient(...)` per request leaks connections. One client per process; reuse.
- **Webhook signature verification** — code that takes a webhook body but doesn't verify the signature is impersonatable.

## Observability

- **Structured logging over string interpolation** — `logger.info("user logged in", { userId })` beats `console.log(\`user ${userId} logged in\`)`. Searchable, filterable, no PII leak in keys.
- **Log level discipline** — `error` for "an action failed", `warn` for "degraded but continued", `info` for normal operations, `debug` for development. Code that logs every successful operation at `info` is a noise bomb.
- **Error context in catch** — `logger.error("payment failed", { err, userId, amount })` beats `logger.error(err)`. The minimum context is the operation, the input identifiers, and the error itself.
- **Trace propagation** — code using OpenTelemetry / W3C trace context must propagate across async boundaries. `setTimeout` and `setImmediate` lose context unless the code explicitly captures it.

## Performance

- **Async parallelism via `Promise.all`** is the right default for I/O-bound work; CPU-bound work needs worker threads.
- **`for...of` on arrays vs `forEach`** — `forEach` doesn't await async callbacks. PRs converting `for...of (await foo)` to `.forEach(async ...)` silently break ordering.
- **Memory leaks via unbounded caches** — `const cache = new Map(); cache.set(...)` with no eviction. Use LRU caches in long-running processes.
- **JSON serialisation hot paths** — repeatedly stringifying large objects is CPU. Pre-stringify static parts.
