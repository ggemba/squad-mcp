# Telemetry contract (shared)

How squad skills write the two-phase run journal (`.squad/runs.jsonl`) via
`record_run`. Referenced by: `squad`, `brainstorm`, `debug`, `grillme`,
`question`. Single-writer rule — each skill is the ONLY legitimate caller of
`record_run` for its own run.

## Run id

`"rt" + Date.now().toString(36) + "-" + 6 random chars from [a-z0-9]`. Generate
once at the start; hold `id` + `started_at` for the terminal write.

## Two-phase write

1. **in_flight** — before dispatching any subagent / research, append a row with
   `status: "in_flight"`, `started_at`, and the pre-populated `agents` array
   (metrics zero until the terminal write).
2. **terminal** — after the run completes (or early-stops), append a row with the
   SAME `id` and `started_at`, `status: "completed"` (or `"aborted"` on early
   stop / interruption / dispatch throw), `completed_at`, `duration_ms`, and the
   `agents` array with `batch_duration_ms` / `prompt_chars` / `response_chars`
   filled in.

If the in_flight write fails, set a flag and SKIP the terminal write — never
leave an orphan terminal row without a paired in_flight.

## Non-blocking try/catch

Wrap every `record_run` call:

- **I/O error** (filesystem full, permissions, lock contention): log silently,
  continue. Telemetry loss must NEVER block a real run.
- **SquadError** (`RECORD_TOO_LARGE` / `INVALID_INPUT` / `PATH_TRAVERSAL_DENIED`):
  surface `code` + `message` to the user verbatim. Security #7 — these are
  security-class signals the user must see.

## SquadError fallback (terminal write only)

On `SquadError` during the terminal write, attempt one fallback row with the
same `id`, `status: "aborted"`, and
`mode_warning: { code: "RECORD_FAILED", message: <reason, truncated to 200 chars> }`.
If the fallback also fails, log and continue — the aggregator's 1h TTL
synthesises an aborted view at the next `/squad:stats`.
