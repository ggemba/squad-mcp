# QA — Vue framework supplement

How to test Vue components and what typically goes untested. Use alongside the core role. Skip items that don't apply.

## Test approach

- **Vue Test Utils + Vitest.** `mount` (real children) vs `shallowMount` (stubbed children) — `shallowMount` hides parent/child integration bugs; default to `mount` unless a child is genuinely expensive.
- **Assert via DOM and emitted events, not `wrapper.vm` internals** — testing internal refs couples the test to implementation.
- **`emitted()`** to assert a component fired the right custom events with the right payload.

## Async

- **Vue updates the DOM asynchronously** — after a state change, `await wrapper.vm.$nextTick()` or `await flushPromises()` before asserting, or the assertion races the render.

## Mocks / state

- **Pinia** — use `createTestingPinia()`; decide deliberately whether actions are stubbed or real. Stubbed actions isolate the component; real actions test the integration.

## Coverage gaps to flag

- **Slot rendering** — components with named/scoped slots are usually tested only with default content.
- **`v-model` two-way binding** — the update-back path (child → parent) is often untested.
- **Prop validation** — the invalid / missing required-prop branch.
- **Loading / error / empty states** of every async component.
