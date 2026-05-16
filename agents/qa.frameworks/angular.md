# QA — Angular framework supplement

How to test Angular components and what typically goes untested. Use alongside the core role. Skip items that don't apply.

## Test approach

- **`TestBed` + `ComponentFixture`.** Standalone components are imported directly — no NgModule test scaffolding.
- **`fixture.detectChanges()`** after every state change — Angular does not auto-run change detection in tests; a missing call leaves assertions on a stale view.
- **Assert rendered DOM and emitted outputs**, not component-class internals.

## Async

- **`fakeAsync` + `tick()`** for timer-based code; **`waitForAsync`** for real async. Mixing them, or forgetting `tick()`, produces tests that pass by luck.
- **`HttpTestingController`** for HTTP — `expectOne()`, `flush()` the response, and call `verify()` in `afterEach` to catch unmatched or outstanding requests.

## Mocks / signals

- **Spy injected services** via `TestBed` providers (`{ provide: X, useValue: spy }`).
- **Signals** — assert the signal's value directly; for `effect()` use `TestBed.flushEffects()`.

## Coverage gaps to flag

- **HTTP error branch** — the `error` callback / failed-request path.
- **`OnPush` change paths** — a state change that should (or should not) refresh the view.
- **Unsubscribe on destroy** — no test that destroying the component releases subscriptions.
- **Reactive-form validation** — invalid states and custom validators.
