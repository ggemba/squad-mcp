# QA — React framework supplement

How to test React components and what typically goes untested. Use alongside the core role. Skip items that don't apply.

## Test approach

- **React Testing Library, query by role/text** — `getByRole`, `getByLabelText` over `getByTestId`. Test-id-only queries assert structure, not user-visible behaviour.
- **`userEvent` over `fireEvent`** — `userEvent` simulates real interaction (focus, key events); `fireEvent` skips them. Always `await` userEvent calls.
- **Test behaviour, not hooks** — prefer rendering the component and asserting output over `renderHook` on every hook. Hook-only tests miss integration bugs.

## Async / `act`

- **`act(...)` warnings are real bugs** — they mean a state update happened outside React's awareness, usually an un-awaited async update. Fix the test (await it); never suppress the warning.
- **`findBy*` for appearing elements, `waitFor` for assertions** — `getBy*` throws immediately; use `findBy*` when an element arrives after an async update.

## Mocks

- **Mock at the network boundary (msw)** — mocking `fetch` directly misses wrong-URL / wrong-header / wrong-param bugs.

## Coverage gaps to flag

- **Loading, error, and empty states** — the three states almost always shipped untested. Every data-driven component needs all three.
- **Effect cleanup** — no test that unmounting cancels the subscription or aborts the request.
- **Rapid double-click / double-submit** on any mutating handler.
- **Whole-component snapshots** — brittle; assert specific rendered output instead.
