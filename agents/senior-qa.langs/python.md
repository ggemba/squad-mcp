# Senior-QA — Python supplement

Use alongside the core role. Skip items that don't apply.

## Test framework patterns

- **pytest is the default** for new Python projects. unittest still appears; mixing styles in the same file is a code smell.
- **Fixtures with the right scope** — `function` (default), `class`, `module`, `session`. A `session`-scoped fixture that returns a mutable object is a flake bomb; subsequent tests can mutate it.
- **`@pytest.fixture(autouse=True)`** is invisible at the call site — silent setup that runs for every test. Flag overuse.
- **`@pytest.mark.parametrize`** — tests covering the same code path with multiple inputs should be parametrized, not duplicated. But parametrize is harder to debug when one case fails — flag overuse on truly different code paths.
- **`@pytest.fixture(scope="session")` for DB connections** without a tear-down clears nothing between tests. Combine with `pytest-django` / `pytest-asyncio` `db_blocker` for safe sharing.

## Mock realism

- **`unittest.mock.patch` lookup path** — patches WHERE THE NAME IS USED, not where it's defined. `patch("mymodule.helper")` when `mymodule` does `from helpers import helper` actually patches the name `helper` inside `mymodule`. Patching `helpers.helper` would not affect `mymodule`'s reference to the already-imported name.
- **`MagicMock` returns `MagicMock()` for every attribute access** — a test that does `mock.get_user().email == "foo@bar"` passes regardless of what the code does. Mock realism = explicit `return_value` for every method the code calls.
- **`spec=Class`** in MagicMock — without it, a typo on a method name (`mock.get_emial()`) silently returns a MagicMock instead of failing. Always spec real classes.
- **`monkeypatch` over `patch`** for fixture-style setup. Cleaner teardown (automatic).
- **HTTP mocks (`responses`, `httpx_mock`, `pytest-httpx`)** vs raw `requests.get` patching — network-level mocks catch URL/header bugs; method-level patches don't.

## Async test gotchas

- **`pytest-asyncio` mode** (`auto` vs `strict`) — `strict` requires `@pytest.mark.asyncio` on every async test. `auto` is implicit. PRs mixing both modes silently skip tests. Flag inconsistency.
- **Forgotten `await`** in a test produces a coroutine warning at exit; the test "passes" because the coroutine was never awaited. Loud-but-easy-to-miss.
- **`asyncio.sleep(0)` in a test** is almost always wrong — either a real sleep is needed, or the test setup is racy.
- **Event loop scope** — `pytest-asyncio` defaults to function-scoped event loop; session-scoped fixtures opening connections on a different loop will fail with cryptic errors.

## Coverage gaps to flag

- **Missing test for `__init__` validation** — classes that raise from `__init__` need a test that triggers each rejection path.
- **No test for empty collection / None inputs** in any function taking a list/dict/Optional.
- **No test for error responses from external services** — only happy-path mocks means the code never sees a 500/timeout.
- **No test for `pathlib.Path` edge cases** — paths with spaces, non-ASCII, very long paths, symlinks. Common silent failures on Windows / macOS / network filesystems.
- **`pytest.raises(Exception)`** without `match=` can pass for the wrong subclass — the test asserts "something raised" not "the right thing raised".

## Realistic edge cases by domain

For a Django/Flask/FastAPI request handler change: tests for unauthenticated user, user without permission, malformed JSON body, missing required field, payload over body-size limit, slow client (timeout), repeated POST (idempotency).

For a SQLAlchemy / async ORM change: tests for transaction rollback on partial failure, lazy-load triggering after session close, optimistic-lock conflict, connection pool exhaustion, schema mismatch (live migration window).

For a Celery / RQ / async worker change: tests for retry semantics on transient vs permanent failure, message ack timing, dead-letter routing, idempotent re-execution, large payload serialisation.

## Static-analysis adjacency

- **`mypy --strict`** failure surface is a coverage proxy — typed code with no runtime test for the type assertion still has the type as documentation. PRs that disable strict mode for a file need a justification.
- **`ruff` / `flake8`** disabled rules in `# noqa: E501` comments — flag accumulation; old `noqa`s tend to outlive their reason.
