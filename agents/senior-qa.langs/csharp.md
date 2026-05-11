# Senior-QA — C# / .NET supplement

Use alongside the core role. Skip items that don't apply.

## Test framework patterns

- **xUnit vs NUnit vs MSTest** — xUnit is the default for new .NET projects. Mixing in one solution is a smell.
- **`[Fact]` vs `[Theory]`** — `[Theory]` with `[InlineData]` covers parameterised cases compactly. PRs duplicating `[Fact]` methods that differ only by input value should consolidate to `[Theory]`.
- **`IClassFixture<T>` vs `ICollectionFixture<T>`** — class fixture shares one instance across all tests in the class (efficient for expensive setup like a test container); collection fixture shares across multiple test classes. Misusing class fixture for stateful setup creates inter-test coupling.
- **xUnit per-test isolation** — every test method gets a fresh class instance by default. Tests relying on state set in another test in the same class are silently broken (different instances).

## Mock realism

- **Moq vs NSubstitute** — both common; mixing in the same project is a refactor smell.
- **`Mock<IInterface>` vs concrete class mock** — Moq can mock virtual methods on classes but not non-virtual or sealed. A test that "mocks" a non-virtual method via `Mock<MyClass>` is testing nothing.
- **`Setup` without `Verifiable`** + `Verify()` chain — `mock.Setup(x => x.Foo()).Returns(...)` configures a return but doesn't assert the method was called. Add `.Verifiable()` then `mock.Verify()` if the call is the contract being tested.
- **Strict mocks (`MockBehavior.Strict`)** throw on any unconfigured call — useful for "no surprise calls" assertions, but brittle. Use sparingly.
- **`It.IsAny<T>()`** in setup matches anything — over-permissive matchers hide bugs where the code passes the wrong argument. Pin specific values when the contract requires it.

## Async test gotchas

- **`async Task` vs `async void` in tests** — `async void` test methods don't await — exceptions go unhandled and the test "passes". xUnit catches some but not all cases. Flag any `async void` in test code.
- **`ConfigureAwait(false)` in tests** — usually unnecessary (no sync context in test runners) but harmless.
- **`.Result` / `.Wait()` in test** — same deadlock risk as in production. xUnit's test runner has no sync context, but Razor / ASP.NET test hosts may.
- **Test isolation under `Parallelize`** — xUnit parallelises class fixtures by default. Tests sharing static state will flake. `[Collection]` attributes serialise.

## Coverage gaps to flag

- **Missing test for `ArgumentNullException` paths** — a method that does `if (foo is null) throw new ArgumentNullException(nameof(foo))` needs a test for the null case.
- **Missing test for cancellation token propagation** — code that takes `CancellationToken` should have a test that cancels and asserts `OperationCanceledException`.
- **Missing test for transaction rollback** — DbContext code that wraps in a transaction needs a failure-path test.
- **Snapshot/Verify-style tests** without normalised output (Guids, timestamps) flake. Use `Verify` library's scrubbers.
- **No test for nullable reference types** — `#nullable enable` code that takes a `string?` should have tests for both `null` and non-null.

## EF Core / data layer

For PRs touching EF: tests for migration up + down, query that triggers N+1 (count `DbCommand` invocations via interceptor), compiled query vs ad-hoc, cache invalidation on update, transaction across multiple `SaveChanges` calls.

## ASP.NET Core specifics

- **`WebApplicationFactory<TStartup>`** — every test class creating a fresh factory is slow but isolated; sharing a factory via `IClassFixture` is fast but couples tests through the in-memory DB state.
- **Authentication test schemes** — overriding `AddAuthentication` to a test scheme is the standard pattern; PRs that skip auth via `[AllowAnonymous]` in tests instead of overriding the scheme silently change the production code.
- **HttpClient lifetime** — `IHttpClientFactory` vs raw `new HttpClient()`. Test code can cheat with raw clients, but flag if the production code does.

## Realistic edge cases by domain

For a controller change: tests for 200/400/401/403/404/500, malformed JSON body, missing required header, oversized payload, content-negotiation mismatch.

For a SignalR / WebSocket change: tests for client reconnect, message ordering under load, connection-drop mid-stream, unauthorized message after auth expiry.
