# Reviewer — Python supplement

Use alongside the core role. Skip items that don't apply.

## Type hints

- **Type hints in new code are non-optional** in any project that uses mypy / pyright in CI. PRs that add `def foo(x, y):` without annotations regress the type baseline silently.
- **`Optional[T]` vs `T | None`.** PEP 604 syntax (`T | None`) is preferred from Python 3.10+. Mixing both in the same file is a code smell.
- **`Any` is a hole** in the type system, same as TS `any`. `cast(Foo, value)` to suppress a checker warning is a claim — verify it.
- **`# type: ignore` without a code** (`# type: ignore[arg-type]`) suppresses everything; the code-specific form documents WHAT is being ignored and surfaces if a different error lands on the same line.

## Async / await

- **Mixing sync and async** at module scope is a runtime trap. `requests.get(...)` in an async function blocks the entire event loop — flag it. Use `httpx.AsyncClient` or `aiohttp`.
- **`asyncio.gather` vs `asyncio.wait_for`.** `gather` rejects on first failure; use `return_exceptions=True` for partial-failure semantics.
- **Forgotten `await`** on a coroutine returns a coroutine object, not the result. Tests that pass `assert await foo()` correctly often hide bugs where production code does `foo()` (no await).
- **`asyncio.sleep(0)`** to yield to the loop is a smell — the underlying issue is usually a CPU-bound block that should move to `run_in_executor`.

## Error handling

- **Bare `except:` or `except Exception:`** without rethrow swallows `KeyboardInterrupt` and `SystemExit` (bare) or every framework error (broad). Almost always the wrong default — narrow to specific exceptions or use `except BaseException` with re-raise.
- **`raise X from Y`** preserves the original cause. `raise X` (no `from`) inside an `except Y as e:` block silently drops `e`'s context — flag it.
- **Context managers (`with`)** for resource cleanup. A function that opens a file but doesn't use `with` (e.g. `f = open(); ...; f.close()`) leaks the descriptor on exception. Same for `socket`, `connection`, `lock`.
- **`assert` for runtime validation.** `python -O` strips asserts. Don't use `assert user.is_authenticated` for security-critical paths — use explicit `if not ...: raise`.

## Idiom

- **Mutable default arguments.** `def foo(items=[])` shares the list across calls. Use `def foo(items=None): if items is None: items = []`. This is a Python interview classic that still ships.
- **List/dict comprehensions** over `map`/`filter` chains for readability. But a 4-line comprehension is harder to read than a `for` loop — flag the over-clever ones.
- **Generator vs list returns.** A function that builds a list but the caller only iterates once should return a generator (`yield`) — saves memory.
- **`pathlib.Path` over `os.path`.** New code using `os.path.join(...)` instead of `Path(...) / ...` is missing the modern idiom.
- **`dataclass` / `NamedTuple` / `TypedDict`** for structured records. A function returning a dict with magic keys is harder to refactor than one returning a typed object.

## Performance

- **`+=` on strings in a loop** is O(n²) on CPython. Use `"".join([...])`.
- **`list.append` vs `list += [x]`** — `+=` rebuilds the list. Use `append` in hot paths.
- **`dict.get(k)` vs `dict[k]`** — `.get` is safe; `[k]` raises `KeyError`. The right choice depends on whether the key is supposed to exist (use `[k]` for mandatory, `.get` for optional). Flag mismatches.

## Testing-adjacent

- **`pytest.raises` without `match`** can pass for the wrong exception subclass. Add `match="..."` to pin the message.
- **`mock.patch` paths** must point at where the name is LOOKED UP, not defined. `patch("module.helper")` when `module` does `from helpers import helper` doesn't patch anything.
