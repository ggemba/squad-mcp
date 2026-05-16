# Implementer — Angular framework supplement

Idiomatic Angular (19+) conventions to follow when writing the code. Use alongside the core role and the language supplement. Skip items that don't apply.

## Structure

- **Standalone components / directives / pipes** — no NgModules in new code.
- **`inject()` over constructor injection** — cleaner with composition; `providedIn: 'root'` for app-wide singletons.
- **Lazy-load routes** via `loadComponent` / `loadChildren`.

## State

- **Signals for synchronous state** (`signal`, `computed`, `effect`); async streams stay in RxJS and convert at the edge with `toSignal()`.
- **`effect()` only for side effects** — never to write another signal (use `computed`).

## Templates

- **New control flow** (`@if` / `@for` / `@switch`) over `*ngIf` / `*ngFor`.
- **`@for` requires `track`** with a stable identity.
- **`async` pipe** for observables; no manual `subscribe` without an unsubscribe path (`takeUntilDestroyed()`).
- **No function calls in templates** — use a `computed` signal.

## Forms

- **Typed reactive forms** — `FormGroup` / `FormControl` with explicit type parameters; custom validators pure and testable.
