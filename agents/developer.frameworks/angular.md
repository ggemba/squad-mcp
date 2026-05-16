# Developer — Angular framework supplement

Framework-specific correctness, robustness, and performance pitfalls. Use alongside the core role and the language supplement. Skip items that don't apply.

## Correctness

- **`effect()` writing a signal it reads** — a feedback loop / `ExpressionChangedAfterItHasBeenChecked`. Derived values belong in `computed`, not `effect`.
- **`inject()` outside an injection context** — calling `inject()` in a callback or after construction throws at runtime. Call it in field initializers or the constructor.
- **`OnPush` + mutated reference** — an `@Input`-bound array/object mutated in place (no new reference) does not refresh an `OnPush` component. Replace the reference.
- **Mixing signals and observables for one piece of state** — pick one; bridging both ways desyncs.

## Robustness

- **Unsubscribed observables** — a manual `.subscribe()` without `takeUntilDestroyed()` (or the `async` pipe) leaks on every component destroy. The classic Angular leak.
- **HTTP without timeout / cancellation** — an `HttpClient` call with no `timeout` / `takeUntil` hangs and stacks up on rapid navigation.

## Performance

- **Function calls in templates** — `{{ compute() }}` runs every change-detection cycle. Use a `computed` signal or a memoized value.
- **Missing `track` in `@for`** — without `track` (stable identity) Angular re-creates every row's DOM on any list change.
- **Default change detection** — re-checks the whole tree; new components should be `OnPush` or signal-based to stay zoneless-compatible.
