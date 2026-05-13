# Implementer — Python supplement

Use alongside the core role.

## Module / build conventions

- **`pyproject.toml` is the modern config** — `setup.py` is legacy. New projects should use Hatch / Poetry / uv.
- **Absolute imports** over relative inside the project: `from myproject.module import foo` over `from ..module import foo`.
- **`__init__.py`** explicit re-exports — `from .foo import Foo` followed by `__all__ = ["Foo"]` makes the public API discoverable.
- **`if __name__ == "__main__":`** guard for entry-point scripts so they don't run on import.

## Type discipline

- **Type hints on all new code** — `def foo(x: int) -> str:`. Old code without hints can stay; new code adds them.
- **`Optional[T]` vs `T | None`** — PEP 604 syntax (`T | None`) for Python 3.10+. Consistency per file.
- **`Any` is a hole** — `from typing import cast` is the explicit "I know better than the checker" claim.
- **`TYPE_CHECKING` block** for imports needed only for type annotations — avoids circular imports.

## Async patterns

- **`async def` only when there's awaiting** — a function with no `await` should be sync.
- **`asyncio.gather(return_exceptions=True)`** for partial-failure semantics.
- **Don't mix sync and async** — `requests.get` inside `async def` blocks the loop. Use `httpx.AsyncClient` or `aiohttp`.
- **`await asyncio.sleep(0)`** to yield the loop is a smell; the underlying issue is usually CPU-bound work that should move to `run_in_executor`.

## Naming / style

- **PEP 8** — `snake_case` for functions and variables, `PascalCase` for classes, `UPPER_SNAKE` for constants.
- **`_` prefix for module-private** — convention, not enforced. Public-facing names stay unprefixed.
- **`__dunder__` only for protocol methods** — don't invent your own `__myhelper__`.
- **f-strings over `%` and `.format()`** — `f"User {user_id} not found"` is the modern idiom.

## Error handling

- **`raise X from Y`** preserves the cause chain.
- **`raise` (bare) inside `except`** to re-raise without losing context.
- **Specific exception types** — `raise NotFoundError(...)` over generic `raise Exception(...)`.
- **Custom exception classes** for domain errors. Inherit from a project base exception so callers can `except MyAppError:` to catch all.
- **Context managers (`with`)** for cleanup — never leave file handles, sockets, locks dangling.

## Project conventions / build verification

- **`pyproject.toml [tool.ruff]`** for linter — run before declaring done.
- **`mypy --strict`** if the project uses it — type errors block ship.
- **`pytest`** — run the existing suite + new tests added by the plan.
- **Virtual environments** — never `pip install` into the system Python; respect the project's venv (`.venv/`, `poetry shell`, `uv run`).

## Idiom

- **`pathlib.Path` over `os.path`** for new code.
- **`dataclass(frozen=True)`** for immutable structured records over manual `__init__` + `__eq__` + `__hash__`.
- **List/dict comprehensions** for short transformations; `for` loop for anything multi-statement or with side effects.
- **`enumerate(items)`** over `range(len(items))` then `items[i]`.
- **`zip(strict=True)`** (Python 3.10+) when iterables must be the same length.

## Project-specific reminders

- **No emojis in code** (project rule).
- **Method names in English** even when comments are in other languages.
- **Imports grouped**: standard library → third-party → local, separated by blank lines. `isort` / `ruff` enforces this — match its order.
