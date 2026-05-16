# Reviewer — Angular (19+) framework supplement

Apply alongside the detected language checklist and the Cross-Cutting checks in the core role. Skip items that don't apply to the diff.

**Standalone & zoneless**

- All new components/directives/pipes are **standalone**; no NgModules in new code
- Project should be moving toward zoneless; components must be `OnPush` or signal-based to be zoneless-compatible
- Lazy load routes via `loadComponent`/`loadChildren` returning a dynamic import

**Signals as primary state**

- Synchronous render state → **signals** (`signal()`, `computed()`, `effect()`)
- Async streams (events, websockets, debounced inputs) → RxJS, then `toSignal()` at the consumption edge
- Avoid mixing signals and observables for the same piece of state — pick one
- `effect()` only for side effects (logging, DOM, third-party libs); never to write to other signals (use `computed`)

**Dependency injection**

- Prefer **`inject()`** over constructor injection; better for `@if`/composition and avoids decorator metadata
- `providedIn: 'root'` for app-wide singletons; scoped providers at the route/component level when state must be isolated
- Use `InjectionToken` for non-class deps (config, strings, factories)

**Templates**

- Use new control flow (`@if`, `@for`, `@switch`) over structural directives (`*ngIf`, `*ngFor`)
- `@for` requires `track` (stable identity) — flag missing or `track $index` when an id exists
- `async` pipe for observables; never manually subscribe in components without unsubscribe path
- Avoid function calls in templates — they run every change detection cycle; use `computed` or memoized signal

**Lifecycle**

- With signals + `effect`, most `ngOnInit`/`ngAfterViewInit` usage becomes obsolete — flag legacy patterns in new code
- `takeUntilDestroyed()` (or `DestroyRef.onDestroy`) for RxJS cleanup; no manual `Subject` + `unsubscribe`

**Forms**

- Typed reactive forms (Angular 14+); `FormGroup`/`FormControl` with explicit type params
- Validators composed; custom validators pure and testable
