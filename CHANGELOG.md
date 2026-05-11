# Changelog

All notable changes to `squad-mcp` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.11.3] - 2026-05-11

Patch release: last CI matrix slot. v0.11.2 left one job red — `test (windows-latest, 20)` — on the concurrent-append test in `tests/learning-store.test.ts`.

### Fixed

- **`src/util/file-lock.ts` now maps EPERM to retry** alongside EEXIST. Background: POSIX returns `EEXIST` when `fs.open(path, "wx")` collides with an existing lock file; Windows returns `EPERM` under the same condition because of NTFS mandatory locking (the file is held open by the rival writer). Without the EPERM mapping, the 30-way concurrent `appendLearning` test in `tests/learning-store.test.ts` would throw an unhandled exception out of the backoff loop on `windows-latest` instead of looping back to retry. The fix is a one-line additional code-class check; the semantics ("another holder owns the lock right now") are identical.

No source-code changes beyond the file-lock branch. Confirmed locally; `windows-latest` node 22 was already green in v0.11.2.

## [0.11.2] - 2026-05-11

Patch release: closes the remaining CI breakages after v0.11.1 fixed the prettier drift. Two issues that v0.11.1's narrower scope did not surface:

### Fixed

- **`tests/smoke.mjs` had a stale tool list** that pre-dated v0.9.0 (no `record_run`, `list_runs`) and v0.11.0 (no `prune_learnings`). The mismatch surfaced as `SMOKE FAILED: tool count mismatch: 26 vs 23` on ubuntu jobs. Added the three missing names. The smoke script is now in sync with `tests/integration/server-lifecycle.test.ts`.
- **`tests/runs-store.test.ts` "creates the file with mode 0o600"** asserted POSIX file modes which NTFS does not honour — `fs.stat` returns `0o666` on Windows regardless of the mode passed to `fs.open`. Wrapped with `it.skipIf(process.platform === "win32")` (matching the pattern already used by `tests/agent-loader.test.ts` for the same reason). The mode contract is still enforced on POSIX runners where multi-user filesystem leakage is the relevant risk.

No source-code changes.

## [0.11.1] - 2026-05-11

Patch release: CI was red since v0.10.0 because `prettier --check .` ran in CI but was not part of the local `npm run lint` script — a drift the v0.11.0 release surfaced when the user looked at the runs. Two root causes:

### Fixed

- **`INSTALL.md` had non-conforming markdown table alignment** that `prettier --check .` flagged on every runner. Formatted in place. Pure whitespace inside the table-header separator row.
- **Windows runners checked out CRLF line endings** while `.prettierrc` declares `endOfLine: lf`, so every text file failed the format-check on `windows-latest`. Added a `.gitattributes` with `* text=auto eol=lf` so the working copy stays LF regardless of the platform's git config. The 135-files-failed cascade on Windows traced back to this single root cause.
- **`npm run lint` now includes `prettier --check .`** alongside `tsc --noEmit` and `eslint .`. Pre-push local validation now matches what CI runs — a v0.11.0 retrospective fix; the previous gap meant a release could be tagged "lint clean" while CI's stricter check was failing on the same commit.

No source-code changes. No schema changes. No new tests required.

## [0.11.0] - 2026-05-11

Closes the **learnings loop** end-to-end. Before v0.11.0, `read_learnings` was wired into Phase 5 of the squad skill but `record_learning` was a buried manual call — the write side of the cycle never fired in practice. v0.11.0 makes the cycle automatic: after `/squad:review` consolidates findings, the skill batches them into a single Phase 12 "Save as precedents?" prompt, the user picks accept/reject per finding, and the squad stops re-raising things the team already decided. Adds lifecycle plumbing (archive + promote), agent-visible past-decision inlining, and a `prune_learnings` MCP tool for housekeeping. Backward-compatible at the journal level — additive optional fields, v0.10.x readers see new fields as unknown and strip them.

### Cycle-2 fixes (Phase 11 reject-loop)

The first implementation pass shipped with three Blockers caught in the post-impl review:

- **B1 — Promoted-first ordering was broken end-to-end.** The original `[...promoted, ...rest]` array was passed through `tailRecent.slice(-limit)` (which keeps the tail, dropping promoted at the head when journal > limit), then `formatLearningsForPrompt.reverse()` (which pushed promoted to the bottom of rendered output). Three reviewers (architect, developer, QA) independently identified the bug. Fixed by partitioning visible entries, capping promoted at `MAX_PROMOTED_IN_PROMPT = 10` (architect Major M2), applying user filters only to non-promoted, and feeding the formatter a pre-shaped input that survives its internal reverse. Test now pins `idxPromoted < idxRegular` and the `entries.length > limit` regression.
- **B2 — Atomic rewrite step-4 failure had no rollback.** Between `<file>→.prev` and `.tmp→<file>` renames, a failure of the second left the journal MISSING with no recovery hint surfaced. Fixed by catching the failure, attempting `<file>.prev → <file>` rollback, and emitting a new `ATOMIC_REWRITE_FAILED` SquadError. Double-failure path embeds `mv <file>.prev <file>` recovery instructions in the message. Tests mock `fs.rename` to exercise both paths.
- **B3 — LLM prompt injection persisted via `reason`.** `formatLearningsForPrompt` interpolated user-supplied text raw into every advisor prompt thereafter; a hostile commit to a shared `.squad/learnings.jsonl` (or a one-time paste-and-record) persistently subverted future runs. Fixed by adding render-time `sanitizeForPrompt` (strips C0/C1 control bytes, bidi-control codepoints U+202A–202E + U+2066–2069, zero-width codepoints U+200B–200D + U+FEFF) and wrapping `reason` in a Markdown blockquote. New Inviolable Rule in `skills/squad/SKILL.md` Phase 12 instructs the orchestrator to refuse `because` clauses containing instruction-shaped patterns.

Plus the surrounding Major cluster:

- **`min_recurrence: 1` was a footgun** — promoted every singleton accept, defeating the "team policy" signal. Schema now rejects via `.refine` + runtime guard in the handler (covers programmatic callers that bypass the dispatcher). Acceptable values are `0` (disable) or `>= 2`.
- **`unchanged_count` arithmetic was fragile** — relied on three simultaneous invariants holding. Replaced with a `Set<number>` of touched indices, robust under future refactoring.
- **`SafeString` hardening was incomplete** — `branch` and `scope` accepted NUL bytes despite the v0.11.0 release-note claim. Promoted both at the tool boundary AND the store schema (defense-in-depth so a future caller bypassing the tool still gets rejected).
- **`normalizeFindingTitle` accepted mismatched quote pairs** (`"foo'` → `foo`). Tightened to per-quote-class regex; only true pairs strip. Added `PASS ORDER IS LOAD-BEARING` block-comment to deter future reordering.
- **Stats panel `📚` glyph contradicted its own single-cyan rule.** Rewrote panel item 2a to use `▸` directly; dropped the example emoji that walked itself back in prose.
- **Orphan "Phase 14" references in `src/tools/record-learning.ts` and `skills/squad/SKILL.md:50`** updated to the current Phase 12 batched flow.

Cycle-2 also pinned coverage gaps QA called out: `learnings.enabled: false` no-op in `prune_learnings`, schema round-trip for `archived` + `promoted` through `appendLearning`, promotion tie-break on identical ts, NUL-byte rejection on branch/scope.

### Added

- **Phase 12 batched "Save as precedents?" prompt** in `skills/squad/SKILL.md` — appears at the end of every `/squad:review` after `apply_consolidation_rules` returns. Groups findings by agent + severity (Blocker / Major / Minor; Suggestions discarded), surfaces a numbered list, parses casual responses (`accept 1,2,3` / `reject 4` / `all accept` / `skip` / `because <reason>`), and calls `record_learning` for each marked finding. The single record path — Phase 14's per-finding restate flow is REMOVED to avoid double-prompting.
- **`prune_learnings` MCP tool** — lifecycle maintenance for `.squad/learnings.jsonl`. Two passes inside one atomic-rewrite under the file lock: (1) entries older than `max_age_days` are marked `archived: true` and suppressed from default `read_learnings`; (2) entries grouped by `normalizeFindingTitle` with ≥ `min_recurrence` accept decisions get `promoted: true` on the most-recent matching entry. Never auto-runs (`max_age_days` defaults to 0). `dry_run: true` for inspection without mutating.
- **`archived: boolean` and `promoted: boolean` optional fields** added to the learning entry schema at the store level (not just the tool layer — critical to prevent round-trip data loss when prune rewrites the file). Both default to undefined, both are additive — a v0.10.x reader stripping them via Zod's default `strip-unknown` semantics is a tolerated downgrade.
- **`src/learning/normalize.ts`** — single canonical `normalizeFindingTitle(s)` helper used by both `read_learnings` (matching live findings against past learnings) and `prune_learnings` (grouping for promotion-recurrence counting). lowercase + trim + strip trailing `.,;` + strip surrounding quotes/backticks + strip trailing parenthetical + collapse whitespace.
- **`src/util/atomic-rewrite-jsonl.ts`** — shared atomic-rewrite primitive (lock + write `<file>.tmp` + rename `<file>` → `<file>.prev` + rename `<file>.tmp` → `<file>`). POSIX rename atomicity means concurrent readers see either the pre-rewrite or post-rewrite file in full, never a torn write. `.prev` is the rollback snapshot.
- **⭐ PROMOTED tag** rendered inline by `formatLearningsForPrompt` for entries with `promoted: true`. Advisors are instructed in Phase 5 to treat promoted entries as team policy, not ordinary precedent.
- **Stats panel learnings line** (`skills/stats/SKILL.md` §Panel order item 2a) — `learnings: <total> total · <promoted> promoted · <archived> archived` under the trend sparkline. Fetched via `read_learnings({limit: 0, include_archived: true, include_summary: true, include_rendered: false})` — the `limit: 0` short-circuits entry rendering and returns just the summary object. Omitted entirely when `total === 0`.
- **`include_archived` and `include_summary` flags on `read_learnings`** — default false. `include_archived: true` opts back in to archived rows (debug / audit). `include_summary: true` returns a `summary` object with `{total, active, archived, promoted}` counts computed over the FULL file before any agent / decision / scope filter. Used by the stats panel and by future "you haven't pruned in a while" prompts.
- **Past-decision interlock for advisors** — Phase 5 advisory prompt template (`skills/squad/SKILL.md`) gains an explicit section telling agents to honor ⭐ PROMOTED entries as binding and to use `normalizeFindingTitle`-style matching when judging whether a live finding restates a past learning. The advisor sees the rendered learning block inline, not via a separate tool call.

### Changed

- **`read_learnings` auto-filters archived rows by default.** Set `include_archived: true` to surface them. Promoted entries surface FIRST in the rendered markdown block regardless of `tailRecent` ordering — they represent crystallised team policy and always belong at the top.
- **`read_learnings.limit` widened from `positive()` to `nonnegative().max(200)`.** `limit: 0` is a valid sentinel meaning "summary-only, no entries" — used by `/squad:stats` to fetch counts without paging the file. Hard cap 200 unchanged.
- **Phase 14 (per-finding learning restate) REMOVED** from `skills/squad/SKILL.md`. The Phase 12 batched prompt is the single record path. Eliminates the double-prompt that would have asked the user about the same finding twice.
- **`record_learning.finding` and `record_learning.reason` hardened with `SafeString`** — NUL-byte rejection at the tool boundary. `reason` flows verbatim from the user's natural-language Phase 12 response ("accept 1 because we have CSRF at the gateway"), so closing the injection surface at the schema edge is cheap defense in depth.

### Schema migration

- **Additive only.** New optional fields: `archived?: boolean`, `promoted?: boolean`. No schema_version bump. v0.10.x readers strip the unknown fields silently via Zod default behaviour and continue. v0.11.0 readers consume both fields. Recurrence count is NOT stored on the row (would create a write-while-write race when parallel advisors record); promotion is computed lazily inside `prune_learnings` under the lock.

### Tests

- `tests/learning-normalize.test.ts` (new) — `normalizeFindingTitle` cases: case folding, whitespace collapse, trailing punctuation, surrounding quotes/backticks, parenthetical line-numbers, idempotency, equivalence of common decoration variants.
- `tests/atomic-rewrite-jsonl.test.ts` (new) — round-trip with shaped data, parent-dir creation, empty-rows edge case, `.prev` snapshot semantics, no stale `.tmp`, concurrent rewrites serialised under lock.
- `tests/prune-learnings.test.ts` (new) — empty / no-op cases, age cutoff archival, idempotent re-runs (no double-archive, no double-promote), promotion grouping by normalised title, reject decisions ignored when counting, archived entries excluded from recurrence count, `dry_run` doesn't mutate, archived rows hidden from default read path, full-field preservation on rewrite (no data loss), backward compat with v0.10.x rows.
- `tests/read-learnings-tool.test.ts` (new) — `include_summary` count correctness, `include_summary: false` omission, `limit: 0` short-circuit returning summary, `include_archived` default-off / opt-in, promoted-first ordering in entries array AND rendered block (⭐ PROMOTED tag emitted), backward compat with v0.10.x rows.
- `tests/dispatch-tool.test.ts` — `record_learning` rejects NUL byte in `finding` and `reason` at the SafeString boundary; `prune_learnings` is registered and accepts a default-args call.
- `tests/integration/server-lifecycle.test.ts` — tool list updated to include `prune_learnings` (25 tools total).

### Known issues

- The Phase 12 prompt is executed by the host LLM following the SKILL spec — there is no automated test that intercepts a real `/squad:review` response and verifies the batched parse produced the right `record_learning` calls. We rely on the LLM following the parsing grammar in `skills/squad/SKILL.md`. Same trust boundary as v0.10.0's debug / question / brainstorm telemetry hooks.
- `prune_learnings` is never invoked automatically. Users who want regular housekeeping run `prune_learnings({max_age_days: 180, min_recurrence: 3})` themselves or wire it into a cron / pre-commit hook. The default no-op was a deliberate trade-off — surprising diff churn on repos that commit `.squad/learnings.jsonl` is worse than letting old entries sit there.

## [0.10.1] - 2026-05-11

Patch release: pays the technical debt accumulated across v0.9.0 + v0.10.0. No new features, no schema change, no user-visible behavior change beyond `/squad:stats` now showing `/squad:question` and `/squad:brainstorm` invocations (they were in the enum but the SKILL files never emitted journal rows).

### Fixed

- **Telemetry wired in `/squad:question` and `/squad:brainstorm`** — both SKILL.md files now emit the same two-phase `record_run` pair the squad + debug skills use. Closes the doc-vs-code drift that `CHANGELOG.md` v0.9.0 + `skills/squad/SKILL.md` documented but the question/brainstorm SKILLs never implemented.
- **`record_run` MCP tool description + internal doc-comment** updated to list all four legitimate callers (squad, debug, question, brainstorm). The contract surface was stale at v0.10.0 (listed only squad + debug).
- **`mode_warning.message` sanitised at the writer** (`appendRun`) in addition to the renderer. Direct file inspection (`cat .squad/runs.jsonl`) used to see raw ESC/C0/C1 bytes; now those bytes never reach disk. Defense in depth — the aggregator's render-time `stripControlChars` continues to apply for any field the writer doesn't sanitise.
- **`tests/runs-store.test.ts` mtime-invalidation test** dropped the 12 ms `setTimeout` (was a guard against ext4 1 s mtime granularity on coarse-mtime CI; superseded by v0.9.0's `(mtimeMs, size)` cache key plus the in-process `cache.delete` in `appendRun`).
- **`tests/runs-e2e.test.ts` lifecycle assert** now checks `health.completed`, `health.in_flight`, `health.aborted`, and `health.synthesized_aborted` — previously only `total_folded`, which would silently miss a foldById tiebreaker regression that picked the wrong row.
- **Workspace path leak in `SquadError` surface** — added `pathSafe(str)` + `pathSafeDetails(obj)` helpers in `src/util/path-safety.ts` and wired them at the MCP dispatch boundary (`src/tools/registry.ts:dispatchTool`). Absolute paths in `err.message` AND `err.details` are truncated to last 3 segments with `…/` prefix before crossing the wire to the MCP client. In-process errors still carry full paths for local debug.

### Changed

- **`InvocationEnum` lifted to a shared `INVOCATION_VALUES` const tuple** exported from `src/runs/store.ts` (parallel to `AGENT_NAMES_TUPLE`). Five duplicated `z.enum([...])` / `Record<...>` literals collapsed to one import. Adding a future invocation is now a single-line change. Aggregator's `invocation_counts` initialiser became data-driven (`Object.fromEntries(INVOCATION_VALUES.map(...))`), auto-extending when the tuple grows.
- **`agents-content.test.ts`** reinforced — pins `model: haiku` in the frontmatter of `senior-debugger.md` and `code-explorer.md`, plus the explicit forbidden-tool strings (`Edit`, `Write`, `NotebookEdit`) in the Boundaries section of both. Catches future relaxations of the utility-role contract.

### Tests

- `tests/runs-aggregate.test.ts`: foldById tiebreaker with differing `started_at` (locks the primary sort key); `aggregateOutcomes` invocation_counts on empty journal initialises every key to 0.
- `tests/runs-store.test.ts`: RECORD_FAILED fallback row shape accepted (Phase-C SKILL fallback contract); `mode_warning.message` writer sanitization strips C0/C1/ESC from disk bytes.
- `tests/runs-e2e.test.ts`: `status: "aborted"` write through dispatch (B1 carryforward from v0.9.0 QA); `list_runs aggregate: false` SerializedFoldedRun shape (B2 carryforward); `list_runs invocation: "debug"` filter (v0.10.0 C1); `list_runs work_type + aggregate: true` combined; `/squad:debug --deep` 3-agent record shape store roundtrip.
- `tests/path-safety.test.ts`: full coverage of `pathSafe` + `pathSafeDetails` — POSIX + Windows shapes, multi-path strings, error-message embedding, idempotency, ≤3-segment passthrough, recursive details sanitization.

### Known issues

The /squad:debug, /squad:question, and /squad:brainstorm telemetry hooks are spec'd in their respective SKILL.md files; the SKILL execution itself is performed by the host LLM. We rely on the LLM following the spec — there is no automated test that intercepts a real `/squad:question` invocation and verifies a row landed in the journal. If you observe missing rows in `/squad:stats`, it indicates the host LLM short-circuited the SKILL spec.

## [0.10.0] - 2026-05-11

Adds `/squad:debug` — read-only bug investigation skill that bridges `/squad:question` (lookup-only) and `/squad:implement` (writes code). Takes a bug description plus optional stack trace plus optional repro steps, dispatches `code-explorer` to locate suspect code, then a new `senior-debugger` persona to emit N ranked hypotheses (1 on `--quick`, 3 on `--normal`, 5 with a top-2 cross-check pass on `--deep`) with `file:line` evidence, verification steps, and confidence labels. Never writes code, never commits.

### Added

- **`/squad:debug` slash command + skill** (`commands/debug.md`, `skills/debug/SKILL.md`) — three-phase flow (A orient → B hypothesize → B' cross-check on `--deep` → C present). Inputs parsed best-effort into bug description (required) + stack trace (optional, capped at 4 KB) + repro steps (optional). Output is one rendered Markdown block: bug summary, code-explorer orientation, ranked hypotheses with verification steps, discrimination plan, next-action pointing to `/squad:implement`.
- **`senior-debugger` agent** (`agents/senior-debugger.md`) — hypothesis-first persona modeled after `code-explorer`. Utility role: weight 0 in the rubric, never auto-selected by the `SQUAD_BY_TYPE` matrix. Mirrors `code-explorer`'s untrusted-input clause. `model: haiku` (cheap; reasoning over file dumps).
- **`"debug"` invocation type** in `.squad/runs.jsonl`. The new skill's two-phase `record_run` hook writes Phase A `in_flight` and Phase C `completed | aborted` rows under the same single-writer contract as the squad skill. `schema_version` stays at 1 — adding an enum value routes downgrade-readback to the existing quarantine path (loud, recoverable), not silent loss. See "Known issues" below for the downgrade artefact.
- **`InvocationEnum` widened in three sites**: `src/runs/store.ts`, `src/tools/record-run.ts`, `src/tools/list-runs.ts` (filter schema + `Record<...>` literal). `aggregateOutcomes.invocation_counts.debug: 0` initialiser.

### Changed

- **`record_run` single-writer contract extended** — the doc-comment at `src/tools/record-run.ts:7-33` now lists both `skills/squad/SKILL.md` and `skills/debug/SKILL.md` as legitimate callers. Any other caller is still a bug.
- **`/squad:stats` panel** now lists `debug` in the invocation breakdown (`skills/stats/SKILL.md` §Panel order item 5).

### Security

- New persona carries the same "untrusted input" boundary as `code-explorer` — bug descriptions, stack traces, and repro steps are user-supplied text and must not be interpreted as commands directed at the agent.
- Stack trace capped at 4 KB before forwarding to the persona — bounds prompt size and the journal record size (the trace is never written to the journal, but the prompt cap protects downstream tools).

### Known issues

- **v0.9.0 reader downgrade artefact.** A user who downgrades from v0.10.0 → v0.9.0 with `invocation: "debug"` rows already in the journal will see those rows quarantined to `.squad/runs.jsonl.corrupt-<ts>.jsonl` on the next read, because Zod's enum check at the v0.9.0 reader rejects `"debug"` as a schema violation. The quarantine is loud (logger.warn + sibling file), not silent. Re-merge the quarantine back into the journal after re-upgrading.
- **Inherited from v0.9.0** — `CHANGELOG.md` (v0.9.0) and `skills/squad/SKILL.md:167` claim `/squad:question` and `/squad:brainstorm` invocations emit two-row journal records. They do not (only the squad implement/review SKILL does). Scheduled for v0.10.1.

### Tests

- `tests/runs-store.test.ts` — `invocation: "debug"` accepted by the Zod schema.
- `tests/runs-aggregate.test.ts` — `aggregateOutcomes.invocation_counts.debug` initialised to 0 and counts a `debug` run when present.
- `tests/agent-loader.test.ts` — `senior-debugger` resolves through `get_agent_definition` (added to the resolver test set).
- `tests/agents-content.test.ts` (new) — grep-based check that `agents/senior-debugger.md` carries the literal strings `read-only` and `no writes` (locks the inviolable boundary against accidental future relaxation).
- `tests/runs-e2e.test.ts` — full lifecycle: `record_run` Phase A in_flight + Phase C completed for an `invocation: "debug"` run, `list_runs` returns it via the folded result, invocation_counts.debug increments.

## [0.9.0] - 2026-05-11

Adds the **run journal** (`.squad/runs.jsonl`) and the `/squad:stats` skill. Every `/squad:implement`, `/squad:review`, `/squad:task`, `/squad:question`, and `/squad:brainstorm` invocation appends a two-row record (Phase 1 `in_flight` → Phase 10 `completed | aborted`, paired by id). The new skill reads the journal back as a single-screen ANSI dashboard with bar charts, score distribution, sparkline trend, and per-agent token / wall-clock breakdown.

### Added

- **`record_run` MCP tool** — single-writer append for `.squad/runs.jsonl`. The squad skill is the only legitimate caller (Phase 1 `in_flight` + Phase 10 terminal). Validates against `RunRecord` schema_version 1, enforces `MAX_RECORD_BYTES = 4_000` via the new `RECORD_TOO_LARGE` error code (rejects oversize instead of splitting rows), creates the file with mode `0o600` and parent dir with `0o700`.
- **`list_runs` MCP tool** — read-only. Folds the two-row pair by id (last-wins tiebreaker on `started_at` + append position), applies filters (`since` / `limit` / `agent` / `verdict` / `mode` / `invocation` / `work_type`), and returns either the folded list (`aggregate: false`) or a precomputed aggregate bundle (`aggregate: true`: outcomes + health + sparkline trend buckets). Missing journal returns an empty result, not an error.
- **`/squad:stats` skill** (`skills/stats/SKILL.md`) — observability dashboard. Renders the panel inside an ` ```ansi ` code-fence with one accent colour (cyan). Bars use Unicode block characters (`█▉▊▋▌▍▎▏`) at 1/8 granularity; trend uses sparkline glyphs (`▁▂▃▄▅▆▇█`). Flags: `--quick` (last 7 days, skip per-agent), `--thorough` (full history + health panel), `--since <ISO>`, `--last <N>`, `--no-color`. Honours `NO_COLOR` env. All token figures are estimates (chars ÷ 3.5) and labelled as such.
- **In-flight TTL** — `aggregate.ts` synthesises an `aborted` view for `in_flight` rows older than 1h with no terminal pair. The on-disk row is unchanged; only the aggregator's `synthesized_aborted` counter surfaces it.
- **Severity encoding** — per-agent findings tally collapses to a single `severity_score` integer (`B*1000 + M*100 + m*10 + s`) to fit PIPE_BUF budget on 9-agent runs. Inverse decoder exposed as `decodeSeverityScore` for drill-down views.
- **`.stats-seen` sentinel** — diagnostic file at `.squad/.stats-seen` written by the stats skill on the first invocation and every 10-run delta thereafter.

### Changed

- **Squad skill Phase 1 + Phase 10 wiring.** Phase 1 end writes the `in_flight` row before dispatching the planner / advisory; Phase 10 end writes the `completed | aborted` finalisation. Non-blocking try/catch: I/O errors are silent (telemetry loss never blocks a real review), `SquadError` codes surface to the user verbatim. On Phase 10 write failure, the skill writes a second row with `status: "aborted"` and `mode_warning: { code: "RECORD_FAILED", message }` so the in_flight row never strands.

### Security

- `.squad/runs.jsonl` and `.squad/runs.jsonl.lock` are gitignored by default — the journal contains branch refs (e.g. `feat/acme-acquisition`) and prompt-length signals that can leak business context.
- `mode_warning.message` is partially user-influenceable; `aggregate.stripControlChars` strips C0/C1/ESC before rendering. The recorded data stays intact for forensics; only the rendering path sanitises.
- Configured paths flow through `ensureRelativeInsideRoot` (lexical containment check) at the boundary where YAML config first becomes a real fs path.

### Tests

- `tests/runs-store.test.ts` — appendRun happy path, RECORD_TOO_LARGE, ENOENT empty, quarantine corrupt + unknown schema_version, mtime cache, file mode `0o600`, path traversal denied, concurrent append under lock.
- `tests/runs-aggregate.test.ts` — foldById tiebreaker, IN_FLIGHT_TTL synthesis, applyFilters, aggregateOutcomes empty + populated, aggregateHealth, trendByDay, renderBar / sparkline / formatDuration / formatTokens, stripControlChars; fast-check property tests for token estimation invariants.
- `tests/runs-e2e.test.ts` — full lifecycle through the MCP dispatch boundary.

## [0.8.2] - 2026-05-10

Second patch for the release pipeline. v0.8.0 / v0.8.1 on npm are functional — this release exists to actually verify the smoke job (v0.8.1's smoke fix was insufficient).

### Fixed

- **Real root cause: `dist/index.js` was published with mode `644` (not executable).** When npm installed the published tarball, the bin symlink `node_modules/.bin/squad-mcp` pointed at a non-executable target. The shell then reported `sh: 1: squad-mcp: not found` (which dash uses for both "missing on PATH" and "found but cannot exec"). Every release since v0.7.0 hit this. Fixed by appending `chmod +x dist/index.js` to the `build` script in `package.json` so the file is executable when packaged.
- **Smoke job no longer routes through npx for invocation.** Previously the smoke spawned `npx -y @scope/pkg` (and v0.8.1 tried the `--package=` long form) — both relied on npx to wire the bin onto PATH, which has been unreliable for scoped packages on Ubuntu CI. New approach: `npm install --no-save` into a temp dir, then `spawn("node", [absPath])` directly on `dist/index.js`. No PATH lookup, no npx, no shell-resolved bin name. Strictly proves the published tarball boots end-to-end and speaks JSON-RPC over stdio.
- Smoke timeout lowered from 90s to 30s — without the npx fetch+spawn ladder, the only cost is the server's own startup (~1-2s).

## [0.8.1] - 2026-05-10

Patch release for the release pipeline. The 0.8.0 package on npm is functionally identical — this release exists to validate the smoke job.

### Fixed

- **`release.yml` smoke job: `sh: 1: squad-mcp: not found`.** The post-publish smoke step spawned `npx -y @gempack/squad-mcp@<tag>` with no explicit bin name. In npm 10+ on Ubuntu CI, that short form has been unreliable for scoped packages — npx fails to wire the bin onto PATH and falls back to running the unscoped name as a shell command, which is not found. Switched both the warm-cache step and the smoke step to the long form `npx -y --package=@gempack/squad-mcp@<tag> squad-mcp`, which gives npm an explicit (package, bin) tuple to resolve.
- **Warm-cache step no longer silently masks failure.** The previous `|| true` at the end of the warm step had been hiding the same npx-bin-resolution failure for every release since v0.7.0. Removed — if the warm step fails now, the run aborts before wasting 90s on the smoke timeout.

## [0.8.0] - 2026-05-10

Three themes: **execution depth** (the user can size each run), **command surface cleanup** (no more stuttering `/squad:squad`), and **fast code Q&A** (new `code-explorer` subagent + `/squad:question` skill).

### Added

- **Execution depth `--quick` / `--normal` / `--deep`.** New `mode` field on `compose_squad_workflow` (optional, stable contract). Either the caller passes it explicitly or `selectMode` auto-detects from classify + risk signals: `deep` on High risk / Security work / auth-money-migration; `quick` on Low risk + ≤5 files + no high-risk signals; `normal` otherwise. Output carries `mode`, `mode_source` (`"user"` / `"auto"`), and a structured `mode_warning` (`{ code, message }`) when forced flags clash with risk shape or when `quick`'s 2-agent cap drops user `force_agents`. Same vocabulary on `/squad:implement`, `/squad:review`, and `/brainstorm`.
- **Squad shaping per mode.** `quick` caps the advisory squad to 2 (force-includes `senior-developer` for code-touching work types, `senior-dev-security` as a safety override when forced over a high-risk diff); `deep` force-includes `senior-architect` + `senior-dev-security`; `normal` is unchanged. Reject-loop ceiling rises from 2 to 3 in `deep`, drops to 1 in `quick`. `tech-lead-planner` and the `tech-lead-consolidator` persona are skipped in `quick` (the `apply_consolidation_rules` MCP tool still runs).
- **`src/tools/mode/exec-mode.ts`** module. Mode resolution and squad shaping live in their own bounded-context module with named constants (`QUICK_AUTO_MAX_FILES`, `TIEBREAKER_AGENT`, `FALLBACK_SECONDARY`, `DEEP_REQUIRED`), a structured `ModeWarning` type, and a `ModeWarningCode` enum. `compose-squad-workflow.ts` re-exports for backward-compat.
- **`code-explorer` subagent** (`agents/code-explorer.md`). Fast read-only code search specialist pinned to `model: haiku`. Tools restricted to `Read` / `Glob` / `Grep` + a read-only `Bash` allowlist (`git log` / `show` / `blame` / `grep` / `ls-files`); no `Edit` / `Write` / `NotebookEdit`. Accepts a `breadth` flag (`quick` / `medium` / `thorough`) that caps the search budget (≤5 / ≤12 / ≤25 tool calls). Returns `file:line` citations with 3–10 line excerpts — never full-file dumps. **Not an advisor** — has weight 0 in the rubric and is never auto-selected by `SQUAD_BY_TYPE` / `PATH_HINTS` / `CONTENT_SIGNALS`. Dispatched explicitly via `Task(subagent_type="code-explorer", …)` by the `/squad:question` skill or by `tech-lead-planner` for upfront context gathering.
- **Model strategy by mode.** Each agent declares its preferred model in its own frontmatter. `quick` and `normal` modes respect the frontmatter pin; `deep` mode **overrides every dispatch** with `model: "opus"` (planner, advisory, consolidator, and any code-explorer sub-dispatch). The `--deep` flag is the explicit user signal that depth matters more than cost or latency — there are no per-agent exceptions in `deep`.
- **Pinned models on three Sonnet-friendly advisors**: `product-owner`, `senior-dev-reviewer`, and `senior-qa` switched from `model: inherit` to `model: sonnet`. Their work is rubric-guided pattern recognition rather than open-ended reasoning, so Sonnet entrains 95% of the output quality at roughly half the per-call cost on `quick` / `normal` runs. `--deep` upgrades them back to opus per the global override. The other advisors (`senior-architect`, `senior-dba`, `senior-developer`, `senior-dev-security`) keep `model: inherit` — their reasoning is high-stakes enough that downgrading by default risks the squad's verdict quality.
- **`/squad:question` skill** (`skills/question/SKILL.md` + `commands/question.md`). Read-only code Q&A entry point. Takes a free-form question (`/squad:question [--quick|--thorough] <question>`), dispatches `code-explorer` with the resolved breadth, surfaces the cited report. No plan, no gates, no implementation. Built to be the fast path for "where is X defined?", "what calls Y?", "how does the auth flow work?" — questions where invoking the full `/squad:implement` ceremony was overkill.
- **`tech-lead-planner` may dispatch `code-explorer`.** New "Tool: dispatch `code-explorer` for context" section in `agents/tech-lead-planner.md` and a Phase 2 note in `skills/squad/SKILL.md` orient the planner persona on when to use it: large diff / unfamiliar file list / can't judge a design choice without grounded context. Use sparingly — one or two targeted dispatches beat five.

### Changed

- **BREAKING — slash commands renamed.** The whole `/squad:*` family now uses verbs instead of the stuttering `squad-*` prefix:
  - `/squad:squad` → `/squad:implement`
  - `/squad:squad-review` → `/squad:review`
  - `/squad:squad-tasks` → `/squad:tasks`
  - `/squad:squad-next` → `/squad:next`
  - `/squad:squad-task` → `/squad:task`

  `/squad:brainstorm` and `/squad:commit-suggest` are unchanged. No backward-compatible aliases — old invocations will return `command not found`. Migration is one-shot: update muscle memory, scripts, and CI snippets. Skill names and MCP tool names are unchanged.

- **`selectSquad` agent list is now insertion-ordered, not alphabetical.** Pre-v0.8.0 the output was sorted, contradicting the "ranked" contract in the docstring and silently shipping a `quick`-mode top-2 that did not match the matrix order (`core agents → signals → user force_agents`). Downstream consumers that key off ordering (notably `shapeSquadForMode` in `quick` mode) now get the order the docstring promises.

### Removed

- **`loc_changed` risk-signal heuristic.** Was a tautological `files_count × 30` constant that added no information past the `files_count` cap and could be foot-gunned by single-file giant rewrites. The auto-detect threshold for `quick` is now purely `files_count <= QUICK_AUTO_MAX_FILES` plus the no-high-risk gate.

## [0.7.0] - 2026-05-10

Six-phase response to the full-repo `/squad-review`. Verdict was REJECTED with 3 blockers + 20 majors; this release lands all of them.

### Fixed

- **`safeString` Zod refine was checking space (0x20), not NUL byte (0x00).** Across 7 tool schemas + `validateArg` in `exec/git.ts`, the refine source had a literal NUL byte embedded that the TypeScript compiler normalises to a space on emit. Every published tarball since this rule landed has rejected every realistic prompt with `must not contain NUL byte`. Replaced with the escape sequence `"\0"` (4 characters) which survives the build. `compose_advisory_bundle` and friends are now usable.
- **Schema validation was bypassed by every unit test.** Tests called handlers directly instead of going through `dispatchTool`, which is how the bug above slipped through CI. Added round-trip `dispatchTool` tests so any future schema regression fails immediately.
- **Path traversal via `.squad.yaml`.** `learnings.path` and `tasks.path` were `path.resolve`d against `workspaceRoot` without a containment check — a `.squad.yaml` with `learnings.path: ../../etc/whatever` gave the host LLM an arbitrary-write primitive (CWE-22). New `ensureRelativeInsideRoot` rejects absolute paths and `..` escapes in both the TS store and the `tools/*.mjs` CLIs.
- **`validateCwd` rejected legitimate git worktrees.** Setting `GIT_CEILING_DIRECTORIES = path.dirname(realCwd)` blocked git from following the `.git` file pointer that worktrees use. Now detects `.git` as a file and skips the ceiling for that case.
- **JSONL bad line bricked the entire learning store.** `readLearnings` threw on the first malformed line, making every read of `.squad/learnings.jsonl` fail forever after a hand-edit or partial write. Bad lines are now quarantined to `<file>.corrupt-<ts>.jsonl` and reading continues with the valid prefix.
- **`tools/post-review.mjs` could truncate the PR body.** `proc.stdin.write(body)` did not await backpressure; large bodies on small pipe buffers were silently truncated (`gh` exits 0 with the prefix only). Now respects the `write` return value and waits for `drain` before `end`.

### Added

- **`/squad-tasks`, `/squad-next`, `/squad-task` slash commands.** Referenced throughout `README` / `INSTALL` / the skill, but missing from `.claude-plugin/plugin.json` — users typing them got `command not found`. Now registered.
- **Cross-process file lock** (`src/util/file-lock.ts`). `O_EXCL`-based advisory lock with jittered backoff and stale-recovery after 30s. Wraps `recordTasks`, `updateTaskStatus`, `expandTask`, and `appendLearning` so multiple MCP server processes (e.g. two Claude clients open in the same repo) cannot race the read-modify-write cycle.
- **`.prev` snapshot for `tasks.json`.** Every successful write moves the prior generation to `<file>.prev` before the rename, so a future corruption has one recoverable backup.
- **JSONL entry truncation.** `appendLearning` truncates oversized `reason` / `finding` so the serialised line stays under `PIPE_BUF` (4096B) and `fs.appendFile` remains atomic w.r.t. concurrent appenders.
- **Centralised input schemas** (`src/tools/_shared/schemas.ts`). All tools that previously redeclared `safeString` now import `SafeString` from one place. The `*ToolDef` ↔ `*Tool` naming inconsistency across 23 tool files is acknowledged as follow-up.
- **Coverage threshold + smoke pipeline.** New `vitest.config.ts` with `lines>=80, statements>=80, functions>=75, branches>=70` thresholds on runtime modules. `tests/compose-prd-parse.test.ts` (was 202 LOC with zero tests). `tests/detect-changed-files.integration.test.ts` exercising real `git` against a tmpdir repo. `tests/smoke.mjs` wired into `ci.yml`. New post-publish smoke job in `release.yml` invokes `npx -y @gempack/squad-mcp@<TAG>` over stdio and asserts `tools/list`.
- **ESLint + Prettier.** `eslint.config.js` (flat config, ESLint 9 + typescript-eslint), `.prettierrc`, `.prettierignore`. Scripts: `lint` (`tsc --noEmit && eslint .`), `typecheck` (pure `tsc`), `format`, `format:check`, `test:coverage`, `smoke`.
- **README "Your first `/squad` in 60 seconds".** New post-install walkthrough with the expected scorecard shape and pointers to the other slash commands.
- **`INSTALL.md` troubleshooting entry** for `Failed to reconnect to plugin:squad:squad` pointing at v0.6.5+ and the `npx --version` diagnostic.

### Changed

- `examples/client-config-{claude-desktop,cursor}.json` now pin `@0.7.0` instead of the floating tag.
- `release.yml` adds a second job `smoke` that runs after `publish` and validates the published tarball boots over stdio.

## [0.6.5] - 2026-05-10

### Fixed

- **Plugin MCP server now runs from npm, not from gitignored `dist/`.** v0.6.4 (and all earlier releases) shipped a plugin manifest pointing at `${CLAUDE_PLUGIN_ROOT}/dist/index.js`. Claude Code's plugin install does a shallow `git clone` and never runs `npm install` / `npm run build`, so `dist/` (gitignored) was missing on disk and the MCP server failed to start with `Failed to reconnect to plugin:squad:squad`. The plugin manifest now uses `command: "npx"` + `args: ["-y", "@gempack/squad-mcp@<version>"]`, pulling the pre-built tarball published with provenance. The plugin still ships agents/commands/skills directly (those are static markdown). Side benefit: plugin and npm install paths now share a single MCP runtime.
- **`release.yml` version-pin guard** now also verifies the npx pin in `mcpServers.squad.args` matches the git tag — any future bump that forgets this field fails publish.

## [0.6.4] - 2026-05-10

### Changed

- **Skill + orchestration prompt: parallel dispatch is now an inviolable rule, not a hint.** Phase 5 of `skills/squad/SKILL.md` and the `squad_orchestration` MCP prompt both spell out the failure mode (multiplied wall time when one Task is dispatched per turn) and the fix (one assistant message with N concurrent `Task` tool_use blocks). Adds Inviolable Rule 9 to the skill header and an explicit anti-pattern block to Phase 5 so future orchestrator LLMs cannot miss it.
- **`agent_advisory` prompt arg description**: stale `po` reference → `product-owner` (kebab-case rename leftover).

## [0.6.3] - 2026-05-10

### Fixed

- **Plugin manifest `agents` and `commands` shape.** `/plugin install squad@gempack` rejected v0.6.2 with `Validation errors: agents: Invalid input`. Per the Claude Code plugin reference, `agents` and `commands` must be **arrays of explicit file paths**; only `skills` accepts a directory string. `.claude-plugin/plugin.json` now lists each of the 9 subagent `.md` paths and the 4 command `.md` paths explicitly. `skills` stays as `./skills/`.

## [0.6.2] - 2026-05-10

### Fixed

- **Marketplace version pin missed in v0.6.1.** `.claude-plugin/marketplace.json` was still pinned to `0.6.0` after v0.6.1 shipped, so `/plugin install squad@gempack` kept resolving to the broken v0.6.0 build. Bumped to `0.6.2`.
- **Release workflow now verifies all four version pins** (`package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `src/index.ts SERVER_VERSION`) match the git tag and fail the publish step otherwise. Future single-pin drift is caught before npm publish.

## [0.6.1] - 2026-05-10

### Fixed

- **Plugin manifest validation: shared docs lifted out of `agents/`.** Claude Code's `/plugin install` rejected v0.6.0 with `Validation errors: agents: Invalid input`. The plugin manifest's `agents: "./agents/"` directive iterated every `.md` file under `agents/`, including the three `_shared/*.md` reference docs (severity matrix + skill specs) which lack subagent frontmatter.
  - Moved `agents/_shared/` → top-level `shared/` so the agent validator only sees real subagent files.
  - `src/resources/agent-loader.ts` adds `getEmbeddedSharedDir()` (resolves to `<repo>/shared/`); `SHARED_FILES` now lists bare filenames; `resolveSharedFile` reads from the new dir; `initLocalConfig` mirrors shared docs to `<localOverrideDir>/shared/<file>` (was `<localOverrideDir>/_shared/<file>`).
  - `src/tools/consolidate.ts`, `skills/squad/SKILL.md`, `README.md` — references updated to `shared/_Severity-and-Ownership.md`.
- **Missing files in published npm tarball.** `package.json` now ships the `shared/` dir, the task CLI helpers (`tools/_tasks-io.mjs`, `tools/{list,next,record,update}-task*.mjs`), and `tools/record-learning.mjs`.

### Migration

Users with an existing local override at `~/.config/squad-mcp/agents/_shared/`: run `init_local_config` again to mirror to the new `shared/` sub-directory, or move the files manually. Override resolution in v0.6.1+ looks at `<localOverrideDir>/shared/<file>`; old `_shared/` overrides fall through to embedded defaults.

### CI

- **`fix(ci+docs)`** — switched two Windows-failing test assertions from forward-slash literals to `path.join()`; re-aligned README/INSTALL.md doc audit (tools count `12` → `23`, agent name `po` → `product-owner`, broken verification example, missing `.squad.yaml` / Tasks / Learnings / PR-posting sections).

## [0.6.0] - 2026-05-10 — features merged via this release window

This release bundles five independent feature streams that landed on `main` between the `0.5.0` cut and the `v0.6.0` tag. Listed by feature; no migration required.

### Added — Tasks: PRD-decomposed atomic work units (anti-bloat for the squad)

Borrows the core idea from claude-task-master and adapts it to squad-mcp's primitives. A PRD is decomposed by the host LLM into atomic tasks; each task carries optional `scope` (glob) and `agent_hints`; the squad runs against ONE task's scope at a time. Less context per pass, fewer tokens, less drift.

- `src/tasks/store.ts` — mutable JSON store with mtime-keyed cache, atomic write (tmp + rename), stable id-sorted serialisation. Schema (zod): `{ id, title, description, status, dependencies, priority, details, test_strategy, scope?, agent_hints?, subtasks[], created_at, updated_at }`. Status: pending / in-progress / review / done / blocked / cancelled. Schema-versioned (`version: 1`) so future breaking changes can ship cleanly.
- `src/tasks/select.ts` — pure helpers. `listTasks` filters by status / agent / scope. `nextTask` does topo-aware selection: candidate status (default pending), all deps in done_statuses, optional agent + changed_files filter; tiebreak priority then id; returns a structured result with `reason: no_candidates | all_blocked | ok` + the blocked list (so callers can show "X is next when Y completes").
- 7 new MCP tools:
  - `list_tasks`, `next_task`, `record_tasks`, `update_task_status`, `expand_task`, `slice_files_for_task` — the data-plane operations.
  - `compose_prd_parse` — pure-MCP composer that builds a prompt + JSON schema for the host LLM to decompose a PRD. Server does NO LLM calls; the host already has provider keys and user consent. Includes existing tasks in the prompt so the LLM doesn't duplicate.
- New `.squad.yaml` section `tasks`:
  - `path` (default `.squad/tasks.json`)
  - `enabled` (default true — turn off to silence reads without deleting the file; writes stay open, matching the learnings policy)
- `tools/{list-tasks,next-task,record-tasks,update-task-status}.mjs` — non-MCP CLI helpers sharing a tiny `tools/_tasks-io.mjs` module. Run anywhere with node 18+.
- `skills/squad/SKILL.md` adds:
  - **Phase 0.5 — Decompose PRD into tasks** (task-mode only). Build prompt → run LLM → preview → user-confirm → `record_tasks`. Inviolable: never bulk-record without per-list confirmation, never invent dependencies, never alter ids the user reviewed.
  - **Phase 0.6 — Pick a task** via `/squad-next` or `/squad-task <id>`. Slice files via `slice_files_for_task`, narrow squad via the task's `agent_hints`, run normal advisory. When done, flip status via `update_task_status`.
- 38 new tests cover store (read / record / update / expand / cache invalidation / on-disk format) and select (filter / topo / priority tiebreak / blocked surfacing). Smoke test now verifies 23 tools (was 16).

### Added — Learning JSONL: persistent accept/reject memory

Closes the squad's biggest UX gap: re-running review on the same repo no
longer re-raises findings the team already considered and rejected (with
reason). Every accept/reject decision becomes one append-only line in
`.squad/learnings.jsonl`, versioned in git, surfaced as a markdown block
injected into the next run's agent and consolidator prompts.

- `src/learning/store.ts` — JSONL store with mtime-keyed cache.
  `readLearnings`, `appendLearning`, and `tailRecent` (filterable by agent
  / decision). Schema: `{ ts, pr?, branch?, agent, severity?, finding,
decision, reason?, scope? }`. Schema violations on read are loud
  rejections — silent corruption is worse.
- `src/learning/format.ts` — pure formatter rendering a most-recent-first
  numbered list under a `## Past team decisions` heading. Filters scoped
  entries by glob match against `changedFiles`; entries without a scope
  are repo-wide and always pass. Returns `''` when no entries qualify
  (callers check before injecting — no empty headers in prompts).
- New tool `read_learnings` — load, filter (agent / decision / scope),
  return both raw entries and the rendered markdown block. Honors the
  master switch `learnings.enabled` from `.squad.yaml`.
- New tool `record_learning` — append a decision. Side-effecting; the
  skill (or CLI) is responsible for user confirmation per finding.
- New `.squad.yaml` section `learnings`:
  - `path` (default `.squad/learnings.jsonl`)
  - `max_recent` (default 50, hard cap 200)
  - `enabled` (default true — turn off to disable injection without
    deleting the journal)
- `tools/record-learning.mjs` — CLI helper for non-MCP clients. Direct
  JSONL append, no MCP round-trip. Same flags as the MCP tool plus
  `--workspace` / `--file`.
- `skills/squad/SKILL.md` adds **Phase 14 — Post-PR record decision**
  (opt-in, per-finding authorisation required) and injects
  `read_learnings` output into Phase 5 (per-agent advisory) and Phase 10
  (consolidator). Inviolable rules: never record without explicit
  per-finding authorisation, never invent a `reason`, never amend or
  delete past entries through the skill.

38 new tests cover the store (read / append / cache invalidation /
schema violations) and the formatter (limits, scope filtering,
rendering variants). Smoke test now verifies 16 tools (was 14).

### Added — Post `/squad-review` results as a GitHub PR review

Closes the loop from "advisory in your terminal" to "advisory on the PR
where the team works". The verdict + scorecard go up as a `gh pr review`
with the appropriate action (`--approve` / `--comment` / `--request-changes`)
chosen deterministically from verdict + score.

- `src/format/pr-review.ts` — pure formatter taking `ConsolidationOutput`
  plus options, returning markdown body, chosen `gh` action, and summary
  line. Header, fenced rubric scorecard, per-agent finding sections
  (sorted), severity totals, footer. Verdict-to-action mapping in
  `chooseGhAction` (exported separately for testability).
- `tools/post-review.mjs` — CLI helper that lives outside the MCP server
  (alongside the commit-msg hook). Reads consolidation JSON from stdin,
  formats, invokes `gh pr review --<action> --body-file -`. Supports
  `--dry-run`, `--repo owner/name`, `--request-changes-below N`,
  `--no-footer`, `--pr <n>` (required). Exit codes:
  `2` invalid input, `3` gh missing/unauthenticated, `4` gh failed.
- New `.squad.yaml` section `pr_posting`:
  - `auto_post: bool` (default false — skill always confirms)
  - `request_changes_below_score: number` (opt-in floor)
  - `omit_attribution_footer: bool` (default false)
- `skills/squad/SKILL.md` adds **Phase 13 — Post to PR** (review mode,
  opt-in). Inviolable rules: never post without showing the body first,
  never post `--request-changes` on someone else's PR without explicit
  user instruction, never amend or delete a posted review.

23 new tests cover the formatter (header variants, rubric block, findings
section, footer, summary, action mapping). The action mapping never
promotes a verdict (low-severity can't become approve) and only demotes
APPROVED — never downgrades CHANGES_REQUIRED further.

### Added — `.squad.yaml` repo configuration

Per-repo configuration file (versioned with the code) lets each project tune
the rubric, thresholds, and scope without editing call sites.

- `src/config/squad-yaml.ts` — reader with zod schema, mtime-keyed cache, and
  the `applySkipPaths` / `applyDisableAgents` helpers. YAML-to-zod path uses
  `js-yaml` (FAILSAFE_SCHEMA + numeric coercion for known fields). Looks up
  `.squad.yaml` then `.squad.yml` at workspace_root; absent file falls back to
  package defaults silently.
- New tool `read_squad_config` — MCP wrapper for direct introspection by
  non-Claude-Code clients or callers that build their own bundle.
- `compose_squad_workflow` now reads `.squad.yaml` and: applies `skip_paths`
  to changed_files BEFORE classification (skipped paths still count toward
  risk signals — disabling a file from advisory does not make the change
  less risky), then applies `disable_agents` to the selected squad. Returns
  the resolved `config`, `skipped_paths`, and `disabled_agents` so callers
  see why the slice list got narrower.
- `compose_advisory_bundle` propagates `skip_paths` filtering through to
  per-agent slices, so an agent never receives a path the composer hid.
- New `CONFIG_READ_FAILED` error code.
- New dep: `js-yaml` (^4.1) + `@types/js-yaml`. Battle-tested, MIT, ~70KB.
- `force_agents` in tool calls still wins over `config.disable_agents` —
  config is a default policy, not a veto over explicit caller intent.

Validation: weights that don't sum to 100 across the listed agents → reject.
Unknown agent names in `weights` or `disable_agents` → reject. Threshold or
min_score outside 0-100 → reject. Errors carry `source` (file path) for
diagnosability.

Example `.squad.yaml`:

```yaml
weights:
  senior-dev-security: 30 # PCI compliance
  senior-dba: 22
  senior-developer: 20
  senior-architect: 15
  senior-qa: 13
threshold: 80
min_score: 75
skip_paths:
  - "docs/**"
  - "**/*.md"
  - "**/generated/**"
disable_agents:
  - product-owner # internal tool, no PO involved
```

22 new tests cover reader (file presence, weights override, skip_paths,
disable_agents, caching, mtime invalidation, glob matching). Backward
compatible: callers that don't pass `workspace_root` to non-composer tools
get the legacy behaviour (no config read).

### Added — weighted rubric scorecard

Each advisory agent now represents a dimension of a multi-dimensional rubric
with a default weight. The consolidator emits a pre-formatted ASCII scorecard
alongside the legacy verdict.

- New tool `score_rubric` (`src/tools/score-rubric.ts`): pure function over
  per-agent scores (0-100) and optional weight overrides; returns
  `weighted_score`, per-dimension breakdown with bars, `passes_threshold`,
  `ignored_agents`, and a pre-formatted `scorecard_text`.
- `AgentDef` extended with `weight: number` and `dimension: string`. Default
  weights sum to 100 across the seven advisory agents (Architecture 18%,
  Security 18%, Application Code 18%, Data Layer 14%, Testing & QA 14%, Code
  Quality 10%, Business & UX 8%). Meta-agents (tech-lead-planner,
  tech-lead-consolidator) carry weight 0 — they don't score a dimension.
- `apply_consolidation_rules` accepts optional per-agent `score`/`score_rationale`,
  optional `weights` override, optional `threshold` (default 75), and optional
  `min_score`. Returns `rubric: RubricOutput | null` and `downgraded_by_score`.
  When `min_score` is set, an APPROVED verdict with weighted score below the
  floor is downgraded to CHANGES_REQUIRED. Backward compatible: callers that
  omit scores get the legacy output shape and verdict logic.
- Each advisory agent file (`agents/*.md`) now ships a `## Score` section with
  a calibration table (90-100 / 70-89 / 50-69 / 30-49 / 0-29 bands) specific
  to that dimension, plus the protocol for emitting `Score: NN/100`.
- Skill `skills/squad/SKILL.md` updated to capture per-agent scores into the
  reports array and surface `rubric.scorecard_text` verbatim in the final
  output. Tech-lead-planner/consolidator excluded (weight 0).
- Weight renormalisation: when only a subset of agents scores (partial pass),
  the rubric renormalises across the agents that actually scored. A 4-of-9
  advisory still produces a meaningful weighted score over those 4.
- `tests/score-rubric.test.ts` and `tests/consolidate-rubric.test.ts` cover
  the math (renormalisation, weight overrides, sum=100 validation, threshold
  edge cases), backward compatibility, and the `min_score` downgrade rule.

Planned for a future minor:

- Per-PR memory of accept/reject decisions feeding back into agent prompts.
- Inline line-by-line annotations on the diff (one `gh` review comment per finding with file:line links).
- GitHub Action wrapper for PR posting in CI.
- Streaming SHA-256 over `fs.createReadStream` for any large bundled asset
  reads (avoids `readFileSync` doubling memory).
- Property-based tests for severity/consolidation rules via `fast-check`.

### Architectural cleanup — separation of concerns

This release rationalizes the role of each layer of the project. The MCP server
owns deterministic primitives + agent definitions. The Claude Code plugin owns
packaging (skill, commands, native subagents, MCP wiring). One skill (`squad`)
hosts both `implement` and `review` modes — no client bifurcation, no skill
fragmentation. Agent markdowns live in **one** place per install: the plugin's
`agents/` directory at install time, exposed both as native Claude Code
subagents and as MCP `agent://…` resources for non-Claude-Code clients.

### Changed (BREAKING)

- **Agent markdown filenames renamed to kebab-case** with YAML frontmatter so
  Claude Code registers them as native subagents. Old (PascalCase) filenames
  no longer exist:
  - `agents/PO.md` → `agents/product-owner.md`
  - `agents/Senior-Architect.md` → `agents/senior-architect.md`
  - `agents/Senior-DBA.md` → `agents/senior-dba.md`
  - `agents/Senior-Developer.md` → `agents/senior-developer.md`
  - `agents/Senior-Dev-Reviewer.md` → `agents/senior-dev-reviewer.md`
  - `agents/Senior-Dev-Security.md` → `agents/senior-dev-security.md`
  - `agents/Senior-QA.md` → `agents/senior-qa.md`
  - `agents/TechLead-Planner.md` → `agents/tech-lead-planner.md`
  - `agents/TechLead-Consolidator.md` → `agents/tech-lead-consolidator.md`
- **Shared docs moved to `agents/_shared/`**: `_Severity-and-Ownership.md`,
  `Skill-Squad-Dev.md`, `Skill-Squad-Review.md`. They are not registered as
  subagents; they're reference material. Cross-references inside agent files
  updated accordingly.
- **AgentName `'po'` renamed to `'product-owner'`** across the type, AGENTS
  registry, AGENT_FILE_MAP, ownership matrix entries, MCP resource URI, and
  tests — full consistency with the file/frontmatter name. MCP resource URI
  changes from `agent://po` to `agent://product-owner`.
- **Plugin manifest declares `agents/`**: `.claude-plugin/plugin.json` now
  includes `"agents": "./agents/"`, registering the nine subagents natively
  in Claude Code.
- **Single `squad` skill replaces the two command-only entries.** Both
  `/squad` and `/squad-review` invoke `skills/squad/SKILL.md`; the entry
  command selects mode (`implement` vs `review`). Phases 2/4/8/9/11 only run
  in implement mode.

### Removed (BREAKING)

- **`tools/sync-agents.mjs` deleted.** The plugin install path is the canonical
  Claude Code distribution; non-Claude-Code MCP clients consume agent
  definitions over MCP. Users on the previous "npm install + sync to
  `~/.claude/`" flow should migrate to the plugin install (Path A in
  INSTALL.md).
- **`tests/sync-agents.test.ts` deleted** alongside the script.

### Migration

If you had `%APPDATA%\squad-mcp\agents` (Windows) or
`$XDG_CONFIG_HOME/squad-mcp/agents` (Unix) overrides for the old PascalCase
filenames, rename them to the new kebab-case names. The override allowlist and
loader semantics are unchanged. Shared-doc overrides moved into a `_shared/`
subdirectory under the same override root.

If you depended on `~/.claude/agents/` being populated by the sync script,
install the plugin (`/plugin install squad@gempack`) — Claude Code now
registers the agents directly from the plugin's bundled `agents/` directory.

### Added

- `initLocalConfig` ensures the `_shared/` subdirectory exists before copying
  shared docs (previously a latent bug on first init when the override root
  did not yet contain a subdirectory).

## [0.5.0] - 2026-05-04

### Added

- **`Senior-Dev-Reviewer` weighted scorecard.** Reviewer agent now produces a
  numeric scorecard (0–10 per dimension, weighted average overall) across Code
  Quality 20%, Security 20%, Maintainability 20%, Performance 20%,
  Async/Concurrency 8%, Error Handling 7%, Architecture Fit 5%. Includes
  per-stack idiomatic checklists for the top 5 backend (C#/.NET, Python, Java,
  Go, Node.js) and top 5 frontend (TypeScript, React, Vue, Angular, Svelte)
  stacks with auto-detection. Severity table drives the scorecard penalty.
  Dimensions lacking diff evidence are reported as `N/A` rather than zero.
- **`brainstorm` skill.** Collaborative pre-implementation exploration. Takes a
  problem, decision, or implementation idea; runs deep web research in parallel
  (market patterns, best practices, pitfalls, examples); spawns specialist
  agents for multi-domain perspectives; synthesizes findings into a sourced
  options matrix with a recommendation. Exploratory only — produces no code or
  file changes. Position in the workflow: `/brainstorm` decides _what_ to
  build; `/squad` implements; `/squad-review` reviews. Triggered via
  `/brainstorm` or natural-language asks ("brainstorm", "research approaches",
  "explore options", "what does the industry use"). Supports `--depth
quick|medium|deep`, `--no-web`, `--focus <domain>`, and `--sources <N>`.
- **`commit-suggest` skill.** Read-only Conventional Commits message suggester.
  Runs only an allowlist of git commands (`status`, `diff`, `log`, `rev-parse`,
  `config --get`, `ls-files`, `show <ref>:<path>`); never executes any
  state-mutating git command; never adds AI co-author trailers. Output is text
  only — the user runs the commit themselves. Triggered via `/commit-suggest`
  or natural-language asks ("suggest a commit", "commit message").
- **Plugin manifest exports `skills/`**. The `commit-suggest` skill (and any
  future skill bundled under `skills/`) is auto-registered when the plugin is
  enabled in Claude Code.
- **`tools/git-hooks/commit-msg`**. Optional opt-in hook that rejects commits
  whose messages contain AI-attribution trailers (`Co-Authored-By: Claude /
Anthropic / GPT / OpenAI / Gemini / Copilot / AI`, `Generated with [Claude
Code]`, `Made by AI`, `<noreply@anthropic.com>`). Install via `cp` to
  `.git/hooks/` or repo-wide via `git config core.hooksPath tools/git-hooks`.
- **`tools/sync-agents.mjs` skills sync.** Mirrors bundled skills to
  `~/.claude/skills/` for non-plugin clients (Claude Desktop, Cursor, Warp).
  Recursive walker; baseline-hash store at `~/.claude/skills/.bundle-hashes.json`
  with versioned envelope (`{version: 1, baselines: {...}}`); tri-state policy
  (identical / stale-baseline / user-modified) preserves user edits with a
  `skip-with-warning` log; symlink refusal at source, destination, leaf, and
  baseline-file layers; containment assert against escape-via-skill-name;
  `COPYFILE_EXCL` race guard with EEXIST recurse fallback; mode `0o600` on
  baseline file (Unix); atomic temp+rename writes; non-zero exit on
  `skillsFailed > 0`.
- **`tools/sync-agents.mjs` agents sync hardening.** Symmetric symlink-at-
  destination defense for the agents path: refuses to write through a symlinked
  `~/.claude/agents/<file>.md` (matches the existing skills behavior).
- **8 integration tests** for the skills sync (`tests/sync-agents.test.ts`):
  cold sync + baseline persistence, bundle update overwrites stale dst, user
  edits preserved, symlink-dst refused (Unix-only), corrupt baseline graceful
  fallback, idempotent rerun, HOME/USERPROFILE guard.

### Changed

- **Global `~/.claude/CLAUDE.md` rule** (user-side, not shipped): commits
  produced or suggested by Claude must never carry AI-attribution trailers.

### Documentation

- **`INSTALL.md` Path B note**: documents that npm-package users must run
  `node tools/sync-agents.mjs` to mirror agents and skills to `~/.claude/`,
  and that the manual sync is idempotent.
- **`INSTALL.md` Optional hardening section**: documents how to install the
  `commit-msg` hook and a recommended `permissions.deny` block in
  `.claude/settings.json` for structural enforcement of the read-only invariant.
- **`INSTALL.md` baseline file note**: documents that
  `~/.claude/skills/.bundle-hashes.json` is installer state and should not be
  edited or deleted manually.

## [0.4.0] - 2026-05-02

### Security

- **BREAKING:** `SQUAD_AGENTS_DIR` is now validated against an allowlist of
  user-controlled prefixes (`HOME`, `APPDATA`, `LOCALAPPDATA`, `XDG_CONFIG_HOME`,
  `process.cwd()`). Override directories outside the allowlist are rejected with
  a new structured `OVERRIDE_REJECTED` error. UNC and device-namespace paths on
  Windows (`\\?\…`, `\\.\…`, `\\server\share\…`) are rejected before any
  filesystem access. Migration: move the directory under one of the allowed
  prefixes, or set `SQUAD_AGENTS_ALLOW_UNSAFE=1` to bypass the allowlist (logs a
  warn-level banner once per process).
- **BREAKING:** Per-file resolution now realpath-checks each agent file. If a
  file inside the override directory is a symlink whose target escapes the
  directory, that file silently falls back to the embedded default — preserving
  the operator's per-file customizations while blocking the symlink-out
  primitive.
- Lexical AND realpath checks are both required for an override directory to
  match the allowlist (closes the lexical-allowed-but-symlinked-out bypass).
- `init_local_config` now creates the override directory with mode `0o700` and
  copied agent files with mode `0o600` on Unix (`fs.chmod` after `mkdir` /
  `copyFile` to override the umask). Windows relies on `%APPDATA%`'s default
  user-only DACL; custom paths outside `APPDATA` on Windows fall back to the
  parent directory's DACL — document and use with care.
- `agent-loader` warns once per process if the resolved override directory is
  world-writable (`mode & 0o002 !== 0`). Group-writable does not trigger the
  warning (single-user-host convention). Skipped on Windows since `fs.stat`
  does not surface DACL semantics.

### Added

- `src/util/override-allowlist.ts` — new module exposing `validateOverrideDir`
  and `validateOverrideFile`.
- `src/util/path-internal.ts` — extracted shared helpers (`rejectIfMalformed`,
  `realpathOrSelf`) reused by `path-safety` and `override-allowlist`.
- `OVERRIDE_REJECTED` added to `SquadErrorCode`.
- `SQUAD_AGENTS_ALLOW_UNSAFE=1` opt-in escape hatch for power users / CI on
  unusual paths.
- `tests/agent-loader.test.ts` and `tests/override-allowlist.test.ts` covering
  the accept/reject matrix, escape hatch, agent-name traversal guard, symlink
  escape, and Unix filesystem permissions (`0o700` dir, `0o600` files,
  world-writable warn-once).

### Changed

- `agent-loader` now logs a structured `agent override active` line on first
  resolution with `resolved_path`, `allowlist_match`, `has_unsafe_override`,
  `source` (`env` vs `platform_default`). Escape-hatch resolutions log at
  `warn` instead of `info`.
- `getLocalDir()` now returns `{ rawDir, explicit }` — the `list_agents` tool
  output exposes both `local_dir` (the raw path) and `local_dir_explicit`.

### Migration

- If you set `SQUAD_AGENTS_DIR` to a path under your home / APPDATA / XDG dir,
  no action is needed.
- If you set it to `/opt/...`, `/srv/...`, a CI runner path, or any other
  location outside those prefixes, you have two options:
  1. Move the directory under `~/`, `~/AppData/Local/`, `~/.config/`, or your
     project's working directory.
  2. Set `SQUAD_AGENTS_ALLOW_UNSAFE=1` in the environment that launches the MCP
     host. This bypasses the allowlist and logs a warning on every process
     start so the choice stays auditable.

## [0.3.1] - 2026-05-02

First public release on npm and as a Claude Code plugin.

### Added

#### Workflow composers

- `compose_squad_workflow` — single deterministic pipeline that runs
  `detect_changed_files` → `classify_work_type` → `score_risk` →
  `select_squad` and returns the union of their outputs. Risk signals
  (`touches_auth`, `touches_money`, `touches_migration`, `new_module`,
  `api_contract_change`) are auto-inferred from the changed-file paths;
  callers can override any of them, override `work_type`, or pass
  `force_agents`.
- `compose_advisory_bundle` — chains `compose_squad_workflow` with a
  `slice_files_for_agent` call per selected agent and a `validate_plan_text`
  pass on the supplied plan. Returns a single bundle ready for the host LLM
  to dispatch parallel advisory reviews.

#### Distribution

- Public npm package `@gempack/squad-mcp` with [provenance attestations](https://docs.npmjs.com/generating-provenance-statements).
  Any MCP-capable client (Claude Desktop, Cursor, Warp, …) can install with
  `npx -y @gempack/squad-mcp`.
- Claude Code plugin packaging: `.claude-plugin/plugin.json` registers the
  bundled MCP server (`${CLAUDE_PLUGIN_ROOT}/dist/index.js`) plus the
  `/squad` and `/squad-review` slash commands. Marketplace manifest at
  `.claude-plugin/marketplace.json` exposes the plugin under the `gempack`
  marketplace; users install via `/plugin marketplace add ggemba/squad-mcp`
  followed by `/plugin install squad@gempack`.
- Slash commands `commands/squad.md` and `commands/squad-review.md` codify
  the squad-dev orchestration flow as user-invocable commands inside the
  plugin. They reference the MCP tools and the inviolable rules
  (no-implementation-before-approval, Codex-requires-consent,
  TechLead-Consolidator-owns-final-verdict).

#### Continuous integration

- `.github/workflows/ci.yml` — runs `npm run lint`, `npm test`, and
  `npm run build` on every pull request and `main` push, on Linux + Windows,
  Node 20 + 22.
- `.github/workflows/release.yml` — triggered by tags matching `v*.*.*`.
  Verifies that `package.json` version matches the tag, then publishes to
  npm with `--access public --provenance` using `NPM_TOKEN` and the
  workflow's OIDC `id-token` permission.

#### Licensing

- Apache-2.0 `LICENSE` and `NOTICE` files added.
- `package.json` declares `"license": "Apache-2.0"`, `repository`, `bugs`,
  `homepage`, `keywords`, `author`, and a `publishConfig` block with
  `access: "public"` and `provenance: true`.

### Changed

- Package renamed from `@gustavo/squad-mcp` (private) to
  `@gempack/squad-mcp` (public).
- `package.json` `files` array extended to ship `commands/`, `skills/`,
  `.claude-plugin/`, `LICENSE`, `NOTICE`, and `CHANGELOG.md` alongside
  `dist/` and `agents/`.
- `.npmrc` access changed from `restricted` to `public`.
- `SERVER_VERSION` in `src/index.ts` bumped to `0.3.1`.
- README rewritten around the new install paths (Claude Code plugin first,
  then `npx -y @gempack/squad-mcp` for other clients) and includes
  badges for npm version, CI, and license.
- `tests/integration/server-lifecycle.test.ts` and `tests/smoke.mjs` updated
  to assert the full set of 12 registered tools.

## [0.3.0] - 2026-05-02

This release consolidates the work originally tracked as `0.2.0` (hardening,
observability, error model) with the new `0.3.0` capabilities (cross-stack
classification, changed-file detection, plan-text validation, multi-stack
content signals). No `0.2.0` git tag was created; that scope ships as part of
`0.3.0`.

### Added

#### New MCP tools

- `classify_work_type` — heuristic classifier mapping a user prompt + changed
  file paths to a `WorkType` (`Feature`, `Bug Fix`, `Refactor`, `Performance`,
  `Security`, `Business Rule`) with `Low`/`Medium`/`High` confidence and a
  per-signal evidence trail. Treated as a suggestion; the host can override.
- `detect_changed_files` — wraps a hardened `git diff --name-status` to return
  the changed files for a workspace. Supports `base_ref` (allowlisted refs
  only — no leading `-`, no `..` substring, no `@{`, max 200 chars) and
  `staged_only=true`. Default base is `HEAD~1..HEAD`. Enforces a 10s timeout
  and a 1MB stdout cap.
- `validate_plan_text` — advisory-only check for inviolable-rule violations in
  a plan text: `git commit`/`git push` fences inside code blocks, emojis in
  code blocks, non-English identifiers in code blocks, and implementation
  directives appearing before any approval marker. Never blocking — caller
  decides what to do with findings.

#### Cross-stack detection

- `CONTENT_SIGNALS` extended beyond .NET with patterns for:
  - **TypeScript / Node**: Express, Prisma, TypeORM, Sequelize, Mongoose,
    bcrypt, Passport, JWT (`jsonwebtoken`), React hooks, Next.js.
  - **Python**: SQLAlchemy, Django/Flask/FastAPI, Alembic, pytest, unittest,
    `@app.route` / `@router.<verb>` HTTP routes.
  - **Go**: GORM, sqlx, gin, chi, echo.
- `ContentSignal.ext_filter` (optional list of lowercase extensions) gates
  patterns to specific file types so cross-stack tokens (e.g. `Schema(`,
  `describe(...)`) do not fire in unrelated languages.
- `PATH_HINTS` extended with `models/`, `api/`, `handlers/`, `middleware/`,
  `services/` folder conventions.
- `AGENT_NAMES` and `AGENT_NAMES_TUPLE` exported from `ownership-matrix.ts` so
  zod schemas and external consumers can derive the canonical agent list from
  a single source of truth.

#### Error model

- `SquadError` class with stable `SquadErrorCode` codes:
  `PATH_TRAVERSAL_DENIED`, `PATH_REQUIRES_WORKSPACE`, `PATH_INVALID`,
  `AGENT_DIR_MISSING`, `UNKNOWN_AGENT`, `INVALID_INPUT`, `INTERNAL_ERROR`,
  `GIT_EXEC_DENIED`, `GIT_EXEC_TIMEOUT`, `GIT_NOT_FOUND`,
  `GIT_OUTPUT_TOO_LARGE`, `GIT_NOT_A_REPO`. Codes propagate to MCP tool
  responses as `{ error: { code, message, details } }`.

#### Hardened git execution

- `src/exec/git.ts` provides a single `runGit(subcommand, args, cwd, opts)`
  entry point with multiple defenses:
  - **Subcommand allowlist**: only `diff` and `status`.
  - **Argument validation**: rejects `-c`, `--config`, `--exec-path`,
    `--upload-pack`, `--receive-pack`, and arguments containing NUL bytes.
  - **Ref validation**: regex allowlist, no leading `-`, no `..`/`@{`/`.lock`
    substrings, no trailing `.`, max 200 chars.
  - **CWD validation**: must be absolute, must exist, must be a directory,
    must contain a `.git` entry. Resolved via `realpath`.
  - **Hardening prefix**: every invocation prepends `-c core.fsmonitor=false
-c diff.external= -c core.hooksPath=NUL` (or `/dev/null`).
  - **Environment scrub**: drops user env, sets `GIT_TERMINAL_PROMPT=0`,
    `GIT_OPTIONAL_LOCKS=0`, `GIT_CONFIG_NOSYSTEM=1`,
    `GIT_CEILING_DIRECTORIES=<parent of cwd>`.
  - **Resource caps**: 10s default timeout, 1MB stdout cap, 256KB stderr cap.
    Oversize output and timeout each kill the child (SIGTERM, then SIGKILL
    after 1s) and surface as distinct error codes.
  - **Binary resolution**: resolves `git` from `PATH` once and caches; on
    Windows requires a `.exe` extension.

#### Path safety

- `src/util/path-safety.ts` exposes `resolveSafePath(workspaceRoot, file, ctx)`
  with two modes:
  - When `workspaceRoot` is `undefined`, the path is returned verbatim and
    callers must treat it as path-only (no fs reads). Absolute or
    `..`-bearing paths are rejected.
  - When `workspaceRoot` is set, both the root and the candidate are
    resolved through `realpath` and the relative result is checked
    lexically. Symlink escape is rejected.
- Rejects malformed input up front: NUL bytes, leading `~`, NTFS Alternate
  Data Stream markers (`:` after drive letter).
- `readSnippet(absPath)` reads up to `MAX_BYTES` (16 KB) from a previously
  validated path and returns `null` for missing/unreadable files (silent).
- Documented residual TOCTOU window between `realpath()` and `fs.open()` —
  acceptable for a single-user dev tool.

#### Structured observability

- `src/observability/logger.ts` provides a JSON-line logger that writes to
  **stderr only** (stdout is reserved for JSON-RPC frames in stdio mode).
- Levels: `error` / `warn` / `info` / `debug`. Active level is read from
  `SQUAD_LOG_LEVEL` env var (defaults to `info`) and can be overridden via
  `setLogLevel`.
- `LogEntry` carries `tool`, `request_id`, `duration_ms`, `outcome`
  (`success` / `tool_error` / `invalid_input` / `unknown_tool` /
  `internal_error`), `input_shape`, `output_shape`, `error_code`, `details`.
- Free-form values are truncated to 256 chars and arrays/objects are reduced
  to shape descriptors so logs cannot leak full inputs.
- `setupProcessHandlers()` installs `unhandledRejection` and
  `uncaughtException` handlers that emit a final structured record before
  exiting with code `1`.

#### Tool dispatcher tracing

- `dispatchTool` now generates a `request_id` per call and emits one log
  entry on entry, one on validation failure, and one on completion (with
  `duration_ms` and `outcome`). Errors are mapped: `SquadError` → tool
  response with the original code; everything else → `INTERNAL_ERROR` with a
  redacted message.
- Resource registry mirrors the same pattern for `agent://*` and
  `severity://*` URIs.

#### Tests

- `tests/path-safety.test.ts` (15 tests).
- `tests/exec-git.test.ts` (21 tests).
- `tests/classify-work-type.test.ts` (11 tests).
- `tests/validate-plan-text.test.ts` (26 tests).
- `tests/dispatch-tool.test.ts` (5 tests).
- `tests/consolidate-extended.test.ts` (3 tests).
- `tests/select-squad-extended.test.ts` (6 tests).
- `tests/integration/stdout-purity.test.ts` — guards that the server emits
  only JSON-RPC frames on stdout under both happy and failure paths.
- `tests/integration/server-lifecycle.test.ts` — drives a real stdio server
  through `initialize`, `tools/list`, `tools/call`, `resources/list`,
  `prompts/list`, and clean shutdown; includes a cross-stack fixture
  scenario (`tests/fixtures/express.ts`, `fastapi.py`, `gin.go`).

#### Tooling

- `tools/sync-agents.mjs` mirrors the bundled `agents/` markdowns into
  `~/.claude/agents/<agent>.md`, normalizing each file's frontmatter so the
  Claude Code native agent loader can pick them up. Also copies
  `_Severity-and-Ownership.md`, `Skill-Squad-Dev.md`, and
  `Skill-Squad-Review.md` into `~/.claude/agents/_squad-shared/`.

### Changed

- `ContentSignal` interface gains the optional `ext_filter: string[]`
  property. Existing signals without `ext_filter` continue to match all file
  types — purely additive.
- `dispatchTool` wraps every handler in a uniform error envelope and stops
  surfacing raw `Error.message` text on the wire. Callers depending on the
  old plain-text errors must read `error.code` instead.
- Resource registry uses `SquadError('UNKNOWN_AGENT', …)` instead of
  throwing a plain `Error` for unknown URIs.

### Fixed

- `SERVER_VERSION` in `src/index.ts` is now `0.3.0`, matching `package.json`.
  Previously it lagged at `0.2.0` and the MCP `initialize` response
  advertised the wrong version to clients.

## [0.1.0] - 2026-05-02

Initial scaffold. Marked here for completeness — no `0.1.0` git tag was
created; the scaffold lives at commit `548adc2` and the agent guardrail
update at commit `052c2ad`.

### Added

- MCP server skeleton over stdio with `@modelcontextprotocol/sdk` and Zod
  schemas.
- Deterministic tools: `score_risk`, `select_squad`,
  `slice_files_for_agent`, `apply_consolidation_rules`.
- Agent registry tools: `list_agents`, `get_agent_definition`,
  `init_local_config` (copies bundled defaults to
  `%APPDATA%\squad-mcp\agents` or `$XDG_CONFIG_HOME/squad-mcp/agents`).
- Agent loader with override priority: `$SQUAD_AGENTS_DIR` env var → local
  config dir → bundled `agents/`.
- 9 agent markdowns + 3 shared docs bundled: `PO`, `TechLead-Planner`,
  `TechLead-Consolidator`, `Senior-Architect`, `Senior-DBA`,
  `Senior-Developer`, `Senior-Dev-Reviewer`, `Senior-Dev-Security`,
  `Senior-QA`, `_Severity-and-Ownership`, `Skill-Squad-Dev`,
  `Skill-Squad-Review`.
- Resources for each agent (`agent://<name>`) and shared spec
  (`severity://<slug>`).
- Prompts: `squad_orchestration`, `agent_advisory`, `consolidator`.
- Domain-specific guardrails added to senior agents (`052c2ad`):
  Senior-DBA query budget + concurrency, Senior-Developer
  application-level concurrency + failure-mode analysis, Senior-Architect
  conformance audit, Senior-Dev-Security dependency CVE scanning,
  Senior-QA property-based testing.
- Smoke test (`tests/smoke.mjs`) plus initial unit tests for `score_risk`,
  `select_squad`, `consolidate`.

[Unreleased]: https://github.com/ggemba/squad-mcp/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/ggemba/squad-mcp/releases/tag/v0.5.0
[0.4.0]: https://github.com/ggemba/squad-mcp/releases/tag/v0.4.0
[0.3.1]: https://github.com/ggemba/squad-mcp/releases/tag/v0.3.1
[0.3.0]: https://github.com/ggemba/squad-mcp/releases/tag/v0.3.0
[0.1.0]: https://github.com/ggemba/squad-mcp/commit/548adc2
