# Senior-Implementer — C# / .NET supplement

Use alongside the core role.

## Project / build conventions

- **`*.csproj` SDK-style** — `<Project Sdk="Microsoft.NET.Sdk">`. Old verbose .csproj is legacy.
- **`Directory.Build.props` / `Directory.Packages.props`** for shared MSBuild config + central package version management. Don't redeclare versions in each csproj.
- **Nullable reference types enabled** — `<Nullable>enable</Nullable>` in csproj or `#nullable enable` per-file. New code should be nullable-aware.
- **`<TreatWarningsAsErrors>true</TreatWarningsAsErrors>`** if the project sets it — don't introduce warnings.

## Type discipline

- **`record` for immutable data** — value equality + `with` expressions for free.
- **`record class` vs `record struct`** — class for reference types (typical), struct for small value-equality types where allocation matters.
- **`required` modifier** (C# 11+) for mandatory init properties — compiler enforces at construction.
- **`init`-only setters** for one-time-set after construction.
- **Nullable annotations** — `string?` for "may be null", `string` for "must not be null". `!` non-null assertion is a claim; verify it.

## Async patterns

- **`async Task<T>`** for async methods returning a value; `async Task` for void; **never `async void`** outside event handlers.
- **`ConfigureAwait(false)`** in library code; not needed in app code (no sync context). Match surrounding convention.
- **`CancellationToken`** as the LAST parameter on every async method on a cancellable code path. Pass it through to all child async calls.
- **`ValueTask<T>`** for hot paths that frequently complete synchronously (cache hits).
- **`IAsyncEnumerable<T>`** for streaming results over `Task<List<T>>` when the consumer can process incrementally.

## Naming / style

- **PascalCase** for type names, method names, properties, constants.
- **camelCase** for parameters and local variables.
- **`_camelCase`** for private fields (convention varies — match the project).
- **`I` prefix for interfaces** — `IUserRepository`, `IPaymentService`.
- **`Async` suffix on async methods** — `GetUserAsync`. (Not universal; check project convention.)

## Error handling

- **Custom exception classes** for domain errors — `class UserNotFoundException : Exception`.
- **Re-throw with bare `throw;`** inside `catch` — never `throw ex;` (resets stack trace).
- **`exception filters` with `when`** — `catch (HttpRequestException ex) when (ex.StatusCode == 404)` is more idiomatic than nested `if` inside catch.
- **`IDisposable` / `IAsyncDisposable`** with `using var` declarations for cleanup.
- **`ArgumentNullException.ThrowIfNull(...)`** (NET 6+) over manual null checks.

## Project conventions / build verification

- **`dotnet build`** must succeed without warnings.
- **`dotnet test`** — existing tests + new ones from the plan.
- **`dotnet format`** — code style normalisation. Match the project's `.editorconfig`.
- **EF migrations** — `dotnet ef migrations add <Name>` after model change. The migration goes in source; don't edit auto-generated migrations to "improve" them — re-generate.

## Idiom

- **Primary constructors** (C# 12+) — `public class UserService(IUserRepository repo)` reduces boilerplate.
- **Collection expressions** (C# 12+) — `int[] x = [1, 2, 3]` over `new int[] { 1, 2, 3 }`.
- **Target-typed `new`** — `List<int> x = new()` over `new List<int>()`.
- **Switch expressions** over switch statements for value-returning logic.
- **Pattern matching** — `if (obj is User u && u.IsActive)` over `if (obj is User && ((User)obj).IsActive)`.
- **String interpolation** — `$"User {user.Id}"` over `String.Format(...)` or concatenation.
- **`var`** when the type is obvious from the right-hand side; explicit type when it adds clarity. Match project convention.

## Project-specific reminders

- **No emojis in code** (project rule).
- **Method names in English** (project rule).
- **`using` directive sorting** — `System.*` first, then alphabetical. `dotnet format` handles this.
