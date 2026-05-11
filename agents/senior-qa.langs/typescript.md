# Senior-QA — TypeScript / JavaScript supplement

Use alongside the core role. Skip items that don't apply.

## Test framework patterns

- **Vitest vs Jest** — Vitest (esm-native, vite-aligned) is now the default for new TS projects. Jest still appears in older codebases. Flag mixed-framework projects (test:vitest + test:jest scripts both running) — usually unintended.
- **`describe.concurrent`** in Vitest runs sibling tests in parallel within the same file. Powerful but breaks tests that share module-level state. Flag PRs adding `.concurrent` without auditing shared state.
- **`beforeEach` vs `beforeAll`** — `beforeEach` runs per test (slower, isolated); `beforeAll` runs once (faster, shared state). Tests that mutate shared state from `beforeAll` are flaky bombs.
- **`it.only` / `describe.only`** committed by accident — silent regression of "all tests passing" because only one ran. CI should fail on these; flag at review time too.

## Mock realism

- **`vi.mock` / `jest.mock`** at module level hoists to the top — variables referenced inside MUST be pre-declared. The order-of-evaluation footgun bites every new dev once.
- **Auto-mocked modules** silently return `undefined` for every property. A test passing `expect(mockedHelper).toHaveBeenCalled()` is testing the mock, not the code — verify the mock returns realistic shapes.
- **Mock factories with `Object.assign(realThing, { stubMethod: vi.fn() })`** to keep partial real behaviour are a smell — usually means the mock should be a real instance with the seam at a higher level.
- **Network mocks (msw, nock)** vs full `fetch` mocking — `fetch` mocks miss request-shape bugs (wrong headers, wrong URL params). Network-level mocks are higher fidelity.

## Async test gotchas

- **`async test(...)` returning a promise** — vitest/jest await it. But forgetting `await` inside the test body lets the assertion fire AFTER the test resolved, with no failure surfaced. Flag `expect(...).toBe(...)` calls inside non-awaited promise chains.
- **`waitFor` and explicit timeouts** — `await waitFor(() => expect(mock).toHaveBeenCalled())` silently times out at default 1000ms. Tests that "pass locally, flake in CI" are usually waitFor-default issues.
- **Fake timers** — `vi.useFakeTimers()` MUST pair with `vi.useRealTimers()` in afterEach, or every subsequent test gets stuck timers and flakes.
- **`process.nextTick`, `setImmediate`, `setTimeout(0)`** all yield differently. Mixing them in test setup produces ordering bugs.

## Coverage gaps to flag

- **Missing negative-path test** for every error-throwing condition. `if (!user) throw new NotFoundError()` needs a test that exercises the missing-user case.
- **No test for the "user clicks twice rapidly" case** in any handler that mutates state. Common production bug.
- **No test for empty array / null / undefined** in any function taking a collection. Edge cases aren't optional.
- **Snapshot tests for non-stable output** (Date.now(), random IDs) flake. Either freeze time + seed RNG or don't snapshot.
- **No integration test** for code that crosses a boundary (DB, HTTP, queue). Unit tests with mocks confirm the wiring inside; only integration confirms the wiring outside.

## E2E / browser

- **Playwright `page.waitForSelector` with timeout** — default 30s. Flake budget on CI is much tighter — flag implicit-wait usage.
- **Test isolation** — `beforeEach` setting up a fresh user / DB row vs sharing across tests. Sharing is fast and flaky; isolation is slow and stable.
- **Cypress `cy.intercept` ordering** — set up the intercept BEFORE the action that triggers the request, or it doesn't fire.

## Realistic edge-case generation prompts

When reviewing a payment/finance/auth diff specifically, push the author for tests covering: idempotency boundary (retry produces same result), partial failure (charge succeeds, webhook fails), clock skew (transaction window), concurrent requests (double submit), downstream rate-limit response (429 misclassified as retryable), expired tokens mid-operation. The diff almost certainly has 3 of these tested and 5 unaddressed — the QA's value is naming the missing 5.
