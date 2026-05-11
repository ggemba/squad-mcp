# Senior-Developer — C# / .NET supplement

Use alongside the core role. Skip items that don't apply.

## Correctness

- **Nullable reference types** — `#nullable enable` should be on for new code. PRs disabling it for a file need justification (interop with non-annotated libraries is the usual one).
- **`!` non-null assertion** is a claim, same as TS `!`. Verify each.
- **Unchecked arithmetic** — by default integer overflow wraps silently in release builds. Code doing arithmetic on user-supplied values needs `checked { ... }` or explicit overflow handling.
- **Floating-point equality** — `if (a == b)` for `double`/`float` is almost never right. Use `Math.Abs(a - b) < epsilon` or `decimal` for money.
- **`string.Equals` ordinal vs current culture** — comparing identifiers/protocols/URLs needs `StringComparison.Ordinal`. Default current-culture comparison can break in different locales (Turkish I problem).

## Robustness

- **`Task` exceptions need to be observed** — fire-and-forget `Task.Run(...)` discarded without `.ContinueWith` or `await` produces an `UnobservedTaskException` and may crash the process at GC time.
- **`CancellationToken` propagation** — every async method on a code path that should cancel needs to take and pass the token.
- **`try` blocks around `await`** — exceptions inside `await` propagate up; the original stack trace is preserved through `Task` machinery, but custom rethrows lose it.
- **Graceful shutdown via `IHostApplicationLifetime`** — request `ApplicationStopping` hook to drain work; without it, container kill drops in-flight requests.

## API contracts

- **`ProblemDetails` (RFC 7807)** for API error responses — Microsoft.AspNetCore returns these by default for ProblemDetails-typed exceptions. Custom error envelopes that diverge from ProblemDetails fragment the consumer surface.
- **`[FromBody]` / `[FromQuery]` explicit binding** — implicit binding can silently pull data from the wrong source.
- **Versioned endpoints** — `/v1/users` vs `/v2/users` separation. Adding fields to a versioned response is backward-compatible; removing/renaming is breaking.
- **DateTime over DateTimeOffset** at boundaries — DateTime loses timezone info; DateTimeOffset preserves it. Use DateTimeOffset at any boundary that crosses systems.
- **JsonSerializerOptions** consistency — capitalisation (camelCase vs PascalCase), enum-as-string vs enum-as-int. Mismatch between client and server is a contract bug.

## External integrations

- **`HttpClient` lifetime** — `new HttpClient()` per call leaks sockets. Use `IHttpClientFactory` for proper pooling and DNS refresh.
- **HTTP timeouts** — default `HttpClient.Timeout` is 100s. New client with no `Timeout` set risks hung requests.
- **Polly for resilience** — `IAsyncPolicy<HttpResponseMessage>` for retry/circuit-breaker over manual loops. Ad-hoc retry without backoff hammers services.
- **Database connection pooling** — `DbConnection` / `SqlConnection` should be opened/closed per use; the pool reuses underlying connections. PRs with module-level open connections leak.
- **HMAC verification with `CryptographicOperations.FixedTimeEquals`** for webhook signatures (constant-time comparison).

## Observability

- **`ILogger<T>` injection** — DI-resolved logger carries type-name as category. PRs using `Logger.Create()` ad-hoc lose this categorisation.
- **Structured logging** — `_logger.LogInformation("User {UserId} logged in", userId)` over `_logger.LogInformation($"User {userId} logged in")`. The named template makes the log searchable; the interpolated string doesn't.
- **`LoggerMessage.Define`** for hot-path logging avoids per-call allocation of the structured args dictionary.
- **OpenTelemetry / `Activity` propagation** — async work via `Task.Run` may lose the parent activity unless explicitly captured.
- **Sensitive data scrubbing** — `_logger.LogInformation("Auth header: {Header}", req.Headers["Authorization"])` leaks secrets. Flag any logging of headers, tokens, body of auth-touching code.

## Performance

- **`StringBuilder` vs string concatenation in loops** — `+=` rebuilds; `StringBuilder.Append` is O(1) amortised.
- **`ValueTask<T>` over `Task<T>`** for hot paths that often complete synchronously (cache hits) — avoids Task allocation. Don't use ValueTask for paths that always async.
- **`Memory<T>` / `Span<T>`** for zero-copy slicing in performance-critical code.
- **EF Core compiled queries** for hot read paths — `EF.CompileAsyncQuery(...)` skips the per-call expression-tree compile.
- **`Parallel.ForEachAsync` (NET 6+)** for bounded parallelism over async iteration.

## DI / lifetimes

- **Singleton holding scoped** is the classic bug. Singleton service that takes `IDbContext` (Scoped) leaks request 1's context across all requests.
- **`IServiceScopeFactory.CreateScope()`** to manually create a scope inside a singleton when scoped work is needed.
- **`AddTransient` for stateful services** is wasteful — every injection creates a new instance. Use `AddScoped` for request-scoped state, `AddSingleton` for app-scoped.
