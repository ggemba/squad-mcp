# Developer — Python supplement

Use alongside the core role. Skip items that don't apply.

## Correctness

- **`Optional` / `T | None`** narrowing — code accessing `user.email` where `user: User | None` skips the None case. Type checker catches this; review for code that uses `# type: ignore` to silence it.
- **Mutable default arguments** — `def foo(items=[])` shares the list across calls. Bug magnet that ships in PRs from devs new to the language.
- **Truthy / falsy traps** — `if items:` is False for empty list, empty string, 0, None. PRs intending "is None" should use `if items is None:` explicitly.
- **`==` vs `is`** — `is` for identity (None, True, False, sentinels); `==` for equality. PRs using `if x == None:` should be `if x is None:`.

## Robustness

- **Bare `except:`** swallows `SystemExit` and `KeyboardInterrupt` — flag.
- **`logging.exception` vs `logging.error`** — `exception` includes the traceback automatically; `error(str(e))` loses it.
- **Process signal handling** — `signal.signal(SIGTERM, handler)` for graceful shutdown. Code that doesn't handle SIGTERM loses in-flight work on container restart.
- **Async event loop in long-running services** — `asyncio.run(main())` per request creates a new loop each time (slow). Reuse the loop.

## API contracts

- **Pydantic / dataclasses for request/response models** — typed boundaries prevent shape drift. Code returning bare dicts at API boundaries is a smell.
- **Error envelope consistency** — `{ "error": "..." }` vs raising HTTP status from FastAPI's `HTTPException(status_code=400, detail=...)`. Pick one per API.
- **Datetime serialisation** — `datetime.isoformat()` includes microseconds; clients may not parse them. Strip or document.
- **None-vs-omitted in JSON** — Pydantic serialises `None` as `null`; omitted fields are absent. The semantics differ for clients.

## External integrations

- **`requests.Session` reuse** — code creating a fresh `requests.Session()` per call leaks connections. Reuse a module-level session.
- **HTTP timeouts** — `requests.get(url)` with no `timeout=` waits up to OS limits (minutes). Always pass a timeout.
- **Retries** — `requests`/`httpx` need a retry adapter; ad-hoc retry loops without backoff hammer flapping services.
- **Webhook signature verification** — `hmac.compare_digest` (constant-time) over `==` to prevent timing attacks.
- **Database connection pooling** — `psycopg2.connect` per request is slow; use SQLAlchemy or asyncpg pool.

## Observability

- **`logging` module configuration** — `print()` in production code is a smell. Logger should be configured at process startup, not per-module.
- **Structured logging** — `logger.info("user logged in", extra={"user_id": user_id})` over f-strings. Some logging backends honor `extra`; some need `structlog`.
- **Log level discipline** — same as TS: error for failures, warn for degraded, info for normal, debug for dev.
- **`traceback.format_exc()`** for full stack in error reports.
- **OpenTelemetry / Sentry context propagation** through async boundaries — `asyncio.create_task` may lose context unless explicitly captured.

## Performance

- **GIL implications** — threading helps I/O-bound work but not CPU-bound. CPU-bound concurrency needs `multiprocessing` or `concurrent.futures.ProcessPoolExecutor`.
- **Generator vs list** — building a list when the caller only iterates once wastes memory.
- **Database N+1** — ORM code that does `for user in users: print(user.posts)` triggers N+1 queries. Use `joinedload` / `select_related`.
- **String concatenation in loops** — `"".join(parts)` over `s += x` for performance.
- **`dict` vs `dataclass(frozen=True)` vs `NamedTuple`** — frozen dataclasses are CPython-fast, NamedTuples are immutable, dicts are flexible. Pick by mutability + access pattern.

## Async / await specifics

- **`asyncio.run` per call** vs reusing the loop — first call creates loop, subsequent ones in same process should reuse via `get_running_loop`.
- **`asyncio.gather(return_exceptions=True)`** for partial-failure semantics; default `gather` raises on first failure.
- **`asyncio.shield`** to protect a critical operation from being cancelled when the parent task is.
- **Sync code inside `async def`** blocks the event loop. `requests.get` inside an async handler is a real bug.
