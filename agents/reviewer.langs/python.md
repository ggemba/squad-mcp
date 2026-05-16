# Reviewer — Python supplement

Idiomatic checklist for Python. Apply alongside the Cross-Cutting checks in the core role. Skip items that don't apply to the diff.

## Typing

- Type hints on every public function/method signature and dataclass/Pydantic model. PRs adding `def foo(x, y):` without annotations silently regress the type baseline in any project running mypy/pyright in CI.
- PEP 604 unions (`X | Y`, `T | None`) over `Optional`/`Union`; PEP 585 builtins (`list[int]`, `dict[str, int]`) over `List`/`Dict`. Don't mix old and new in one file.
- `typing.Protocol` for structural typing instead of ABCs when duck typing fits.
- Avoid `Any` (a hole in the type system); prefer `object` or a bounded `TypeVar`. `cast(...)` is a claim — verify it.
- `# type: ignore[code]` with the specific code, never bare `# type: ignore` (suppresses everything, including a different error landing later on the same line).

## Data modeling

- `@dataclass(frozen=True, slots=True)` for internal value objects (no validation needed).
- Pydantic v2 `BaseModel` at trust boundaries (HTTP input, config, external data) — validates and coerces.
- Don't pass plain `dict`s as ad-hoc data carriers; use `TypedDict` (structural) or `dataclass` (behaviour-bearing).

## Async

- `async def` only when the function awaits something — otherwise it misleads.
- No blocking calls in async functions (`time.sleep`, `requests.get`, sync DB drivers) — they block the whole event loop. Use `asyncio.sleep`, `httpx.AsyncClient`, async drivers.
- `asyncio.gather` / `asyncio.TaskGroup` (3.11+) for fan-out; `gather` rejects on first failure — `return_exceptions=True` for partial-failure semantics.
- Always pass `timeout=` to network calls; propagate `asyncio.CancelledError`, don't swallow it.
- A forgotten `await` returns a coroutine object, not the result — silent bug.
- `asyncio.sleep(0)` to yield is a smell — usually a CPU-bound block that belongs in `run_in_executor`.

## Errors

- No bare `except:` (swallows `KeyboardInterrupt` / `SystemExit`) or `except Exception:` without re-raise. Narrow to specific exceptions.
- Custom exception classes inherit from a project base.
- `raise X from err` to preserve the cause chain; `raise X` inside `except Y as e:` silently drops `e`'s context.
- `assert` is stripped by `python -O` — never use it for runtime or security validation; use explicit `if not ...: raise`.

## Idioms

- Context managers (`with` / `async with`) for files, locks, sessions, transactions, sockets, connections — a manual `open(); ...; close()` leaks the descriptor on exception.
- f-strings over `%` / `.format()`; but logging uses lazy interpolation: `logger.info("msg %s", arg)`, not f-strings.
- Comprehensions over `map`/`filter` + `lambda` — but flag the over-clever 4-line ones; a `for` loop reads better.
- `pathlib.Path` over `os.path`.
- Mutable default arguments (`def foo(items=[])`) share state across calls — use a `None` sentinel.
- A function building a list the caller iterates once should `yield` (generator) — saves memory.
- `match/case` (3.10+) for structural pattern matching, not as a `switch` substitute. Walrus `:=` only when it improves readability.

## Layout & style

- PEP 8 via `ruff` / `black`; flag if missing.
- Public symbols in `__all__`; private prefixed `_`. Avoid module-level mutable state.
- Prefer dependency injection (function args) over global singletons.

## Performance

- `+=` on strings in a loop is O(n²) on CPython — use `"".join([...])`.
- `dict.get(k)` (optional key) vs `dict[k]` (mandatory key, raises `KeyError`) — flag mismatches.

## Testing-adjacent

- `pytest.raises` without `match="..."` can pass for the wrong exception subclass.
- `mock.patch` paths must point where the name is LOOKED UP, not defined — `patch("module.helper")` misses a `from helpers import helper`.
