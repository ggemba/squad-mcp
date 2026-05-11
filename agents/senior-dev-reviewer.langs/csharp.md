# Senior-Dev-Reviewer — C# / .NET supplement

Use alongside the core role. Skip items that don't apply.

## Type system / nullability

- **Nullable reference types** (`#nullable enable` or per-project) — flag PRs that disable it for a file via `#nullable disable` without justification. The cost of one annotation is much lower than one production NRE.
- **`!` null-forgiving operator** is a silent claim, same as TS `!`. Each instance is the dev saying "the analyzer is wrong, this can't be null". Verify the claim.
- **`required` modifier** (C# 11+) — when a class has only mandatory init properties, mark them `required` so the compiler catches missing-field constructors at the call site.
- **`record` vs `class`** — records get value equality + `with` expressions for free. Mutable state should still be in `class`. Flag PRs using `class` for immutable DTOs.

## Async / await

- **`async void` outside event handlers** is broken — exceptions can't be caught by the caller. Use `async Task` (or `async ValueTask` for hot paths). Event handlers (button clicks, etc) are the only legit `async void`.
- **`ConfigureAwait(false)`** in library code — without it, the continuation captures the synchronization context and risks a deadlock when the caller blocks (`.Result`, `.Wait()`). New library code should default to `ConfigureAwait(false)`. App-level code (ASP.NET Core, console) doesn't have a sync context, so it doesn't matter — flag the inconsistency.
- **`.Result` / `.Wait()` / `GetAwaiter().GetResult()`** in async chains is a deadlock risk in legacy sync contexts. Prefer top-down async.
- **`Task.Run` to "make sync code async"** doesn't help — it just moves the work to a thread pool thread. If the underlying API is sync, the only win is releasing the request thread while the work runs elsewhere. Flag misuse.
- **`CancellationToken` propagation** — a method that takes a token but doesn't pass it to its async children (e.g. `await db.SaveChangesAsync()` instead of `await db.SaveChangesAsync(ct)`) breaks cancellation. Flag missing token plumbing.

## Disposal / resource management

- **`using var` vs `using (...)` vs explicit `Dispose`** — for new code, `using var x = ...;` is preferred (cleaner). Disposable types in fields need to implement `IDisposable` themselves.
- **`IAsyncDisposable` for async resources** — a database transaction held open across `await` boundaries needs `await using` to dispose asynchronously.
- **Forgotten Dispose** in `try/catch` blocks — exceptions before `Dispose` leak the resource. Always wrap disposable acquisition in `using`.

## LINQ / collections

- **Multiple enumeration of `IEnumerable<T>`** — methods that take `IEnumerable<T>` and call `.Count()` then `.Where(...)` enumerate twice. Materialize to `.ToList()` once if you need multiple passes.
- **`.Any()` vs `.Count() > 0`** — `.Any()` short-circuits on the first match; `.Count()` always walks the full sequence. Flag `.Count() > 0` on `IEnumerable`.
- **`async LINQ`** — `await Task.WhenAll(items.Select(i => DoAsync(i)))` is the pattern; `items.ForEachAsync(...)` and `Parallel.ForEach` have very different semantics.
- **`SingleOrDefault` vs `FirstOrDefault`** — `Single` is a contract assertion that exactly one matches. Using `First` where the data shape says exactly-one masks bugs (silent wrong-row selection).

## Error handling

- **`throw ex;` vs `throw;`** — `throw ex` resets the stack trace. Almost always wrong. Always re-throw with bare `throw;` inside a `catch`.
- **`Exception` as catch type** is too broad — flag `catch (Exception)` without re-throw or specific handling logic.
- **Custom exceptions for business rules** — throwing `InvalidOperationException("user not authorized")` from the domain layer is a smell. Use a typed `AuthorizationException` so callers can handle it specifically.

## DI / lifetimes

- **Singleton holding scoped/transient** is the classic .NET DI footgun. A singleton service that captures `IDbContext` (Scoped by default) leaks the first request's context across all subsequent requests.
- **`ServiceLifetime.Scoped` in singleton constructors** — needs `IServiceScopeFactory` to create a fresh scope per use.

## Idiom

- **Primary constructors** (C# 12+) reduce boilerplate; flag PRs that introduce a new class without one when the convention is established.
- **`var` vs explicit type** — convention varies per repo; flag inconsistency, not the choice itself.
- **`String.Format` / string concatenation** instead of interpolation is a missed idiom. `$"User {id} not found"` is preferred.
- **Collection expressions** (C# 12+: `int[] x = [1, 2, 3]`) over `new int[] { 1, 2, 3 }`.
