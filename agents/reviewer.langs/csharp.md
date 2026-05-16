# Reviewer — C# / .NET supplement

Idiomatic checklist for C# / .NET (C# 12 / .NET 8+). Apply alongside the Cross-Cutting checks in the core role. Skip items that don't apply to the diff.

## Modern syntax

- Prefer `record` for immutable data carriers — value equality and `with` expressions for free. Mutable state stays in `class`; flag `class` used for an immutable DTO.
- `required` modifier for mandatory init-only properties — the compiler catches missing-field construction at the call site instead of a runtime throw.
- Primary constructors only when params are dependencies or used in initializers; avoid for DTOs better expressed as records.
- File-scoped namespaces (`namespace Foo;`); target-typed `new()` when the type is obvious; collection expressions (`[1, 2, 3]`) over `new[] {...}`.
- Pattern matching and switch expressions over `if/else` chains and classic `switch`.
- `is null` / `is not null` over `== null` / `!= null`.
- Mark classes `sealed` by default unless designed for inheritance.

## Nullability

- Project must have `<Nullable>enable</Nullable>`; flag code that disables it locally (`#nullable disable`) without justification — one annotation is cheaper than one production NRE.
- The `!` null-forgiving operator is a silent claim ("the analyzer is wrong") — verify every instance.
- Null-conditional `?.` and null-coalescing `??` / `??=`; `ArgumentNullException.ThrowIfNull(arg)` over manual null checks at boundaries.

## Async / await

- No `async void` except event handlers — exceptions can't reach the caller. Use `async Task` / `async ValueTask`.
- No `.Result` / `.Wait()` / `GetAwaiter().GetResult()` — deadlock risk in legacy sync contexts. Async top-down.
- `ConfigureAwait(false)` in library code; not needed in ASP.NET Core app code — flag the inconsistency.
- `Task.Run` does not make sync code async — it just moves work to a pool thread. Flag misuse.
- Propagate `CancellationToken` to every async child (`SaveChangesAsync(ct)`, not `SaveChangesAsync()`) — missing token plumbing breaks cancellation.
- `ValueTask` only for hot paths that frequently complete synchronously; `IAsyncEnumerable<T>` with `await foreach` for streaming.

## Resources & disposal

- `using var` (preferred for new code) or `using` statements for `IDisposable`; `await using` for `IAsyncDisposable` (e.g. a transaction held across an `await`).
- Disposable acquisition always inside `using` — an exception before `Dispose` in a `try/catch` leaks the resource.
- Prefer `readonly` fields and `init`-only properties for DTOs; `ImmutableArray` / `FrozenDictionary` for shared lookup tables.

## LINQ & collections

- Don't enumerate `IEnumerable<T>` twice (`.Count()` then `.Where()`); materialize once with `.ToList()` if multiple passes are needed.
- `.Any()` over `.Count() > 0` on `IEnumerable` — `.Any()` short-circuits.
- `SingleOrDefault` asserts exactly-one; `FirstOrDefault` where the data shape is exactly-one masks silent wrong-row bugs.
- `await Task.WhenAll(items.Select(DoAsync))` for async fan-out; watch hidden allocations in hot loops.

## Error handling

- `throw;` not `throw ex;` inside a `catch` — `throw ex` resets the stack trace.
- `catch (Exception)` is too broad without re-throw or specific handling logic.
- Custom typed exceptions for domain errors (`AuthorizationException`), not `Exception` / `ApplicationException` / `InvalidOperationException("not authorized")`.
- Structured logging via `ILogger` message templates, not string interpolation in the template.

## DI / lifetimes

- A singleton capturing a Scoped/Transient dependency is the classic .NET footgun — a singleton holding `DbContext` leaks the first request's context across all requests.
- A singleton that needs Scoped work uses `IServiceScopeFactory` to create a fresh scope per use.

## Idiom

- String interpolation (`$"User {id} not found"`) over `String.Format` / concatenation.
- `var` vs explicit type — flag inconsistency with the repo convention, not the choice itself.
