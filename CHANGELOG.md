# Changelog

All notable changes to `squad-mcp` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-05-16

### Added — framework-aware advisory supplements

`compose_advisory_bundle` now detects UI frameworks (React, Vue, Angular,
Svelte) from the changed-file list and injects per-agent framework checklists
the same way language supplements are injected. New `detectFrameworks()` in
`src/exec/detect-languages.ts` (pure, path-based) and
`readAgentFrameworkSupplement(s)()` in the agent loader.

- `agents/<agent>.frameworks/<fw>.md` for `reviewer`, `developer`, `qa`,
  `implementer` — each a framework lens scoped to that agent's role
  (reviewer = idioms, developer = runtime bugs, qa = testing, implementer =
  idiomatic patterns).
- `agents/reviewer.langs/java.md` and `agents/reviewer.langs/go.md` added.

### Changed — token-efficiency pass

- Skill `description` fields trimmed across all 9 skills (always-on cost).
- `skills/squad/SKILL.md` split into a stable core plus per-mode files under
  `skills/squad/modes/` (`task.md`, `implement.md`, `review.md`) — an
  invocation now loads the core plus only the mode that runs.
- `agents/reviewer.md` language checklists moved out to
  `agents/reviewer.langs/` and `agents/reviewer.frameworks/`, loaded
  conditionally per detected stack instead of inline on every dispatch.
- Telemetry contract extracted to `shared/_Telemetry-Contract.md` and
  referenced instead of restated in each skill.
- Prose trimmed across the agent definitions; load-bearing rules unchanged.

## [1.1.0] - 2026-05-16

### Added — `/squad:pipeline` cradle-to-grave orchestration skill (Fase 3)

A new skill that chains the six squad skills — brainstorm → grillme → tasks →
next → implement → review — into one guided sequence, so a feature can be taken
from idea to verified change without remembering what command comes next.

- **Stateful advisor, not an executor.** Each `/squad:pipeline` invocation
  reconstructs how far the feature has progressed from the conversation
  context, recommends the exact next command (arguments pre-filled, depth flag
  forwarded), and explains the gate decision. The user fires every command
  themselves — that hand-off IS the human gate.
- **Recommend-next-command, never auto-run.** The pipeline only prints the next
  command; it never invokes a sub-skill on the user's behalf. Auto-execution
  would collapse the Gate 1 / Gate 2 human checkpoints that make the squad
  workflow safe.
- **No telemetry, no persistence.** The pipeline calls no `record_run` and
  writes no `.squad/` state — a pipeline run is just N sub-skill runs, each
  already tracked by its own telemetry, aggregated by `/squad:stats`. State
  lives only in the conversation context; there is no MCP tool and no state
  file.
- **`--from <phase>` flag.** Enter the pipeline mid-sequence. The value is
  validated against a closed set (`brainstorm | grillme | tasks | next |
implement | review`); an unknown phase stops with an error and the valid set.
- **Inner loop.** Once `tasks` produces a backlog, `next → implement → review`
  repeats once per task until the backlog is empty.
- **Gate semantics.** After each phase the user picks `proceed` / `adjust` /
  `skip` / `exit`; `skip` is allowed only for `grillme` and `review`.
- Ships `skills/pipeline/SKILL.md` and `commands/pipeline.md` (registered in
  `.claude-plugin/plugin.json`). No MCP tool, no schema change.

### Added — auto-journaling distillation + retrieval (PR2 / Fase 1b)

Builds on the PR1 capture plumbing. The squad now distills durable lessons,
retrieves them smartly into advisory prompts, and folds the work trail into
run telemetry.

- **Learnings schema v2 → v3.** `.squad/learnings.jsonl` rows gain three
  optional, additive fields: `lesson` (a distilled imperative one-liner),
  `trigger` (a retrieval glob), and `evidence` (a `run:<id>` pointer). The
  store accepts BOTH `schema_version` 2 and 3 — existing v2 rows read
  unchanged. `finding` becomes optional; every row must carry at least one of
  `finding` / `lesson`. There is deliberately no stored recurrence counter —
  recurrence is derived at read time.
- **Per-store schema-version constants.** The single shared
  `CURRENT_SCHEMA_VERSION` is split into `RUNS_SCHEMA_VERSION` (stays 2) and
  `LEARNINGS_SCHEMA_VERSION` (now 3) so a learnings bump never touches the
  runs read gate.
- **`JsonlStore` version generic + acceptance predicate.** The generic store
  takes a version type parameter and an `isAcceptedVersion` predicate; the
  read gate calls the predicate instead of a hard literal, letting the
  learnings store accept a mixed-version journal.
- **Smart retrieval.** `read_learnings` derives recurrence by counting
  entries that share a normalised title; an entry recurring ≥ 3 times is
  always injected (like a promoted entry). Below the threshold, an entry is
  injected only when its `trigger` (or legacy `scope`) glob matches a changed
  file. The distilled-lesson injection path no-ops when `.squad.yaml`
  `journaling` is not `opt-in`.
- **Consolidator distillation.** The `tech-lead-consolidator` emits 0-3
  distilled lessons in a `squad-distilled-lessons` fenced block; the squad
  skill parses it (fail-silent on any malformation) and records each lesson
  via `record_learning` with `agent: tech-lead-consolidator`.
- **`drain_journal` MCP tool.** Drains the pending-journal staging buffer and
  returns the de-duplicated set of touched file paths. The squad skill calls
  it in Phase 10 and folds `touched_paths` into the terminal RunRecord (new
  optional `touched_paths` field, capped at 100 paths).
- **Security.** `lesson` is checked against the `REFUSE_PATTERNS`
  instruction-shaped-payload gate at record time (the same gate `reason`
  gets); `finding` stays exempt. `lesson` / `trigger` / `evidence` are
  sanitised at render time; `trigger` is restricted to a glob-safe character
  class.

Rollback degradation: a binary rolled back to a pre-PR2 build reads v3
learnings rows but its schema-version gate skip+logs them — no data loss, no
quarantine. The v3 entries are simply invisible until the binary is upgraded
again.

### Added — auto-journaling capture plumbing (PR1 / Fase 1a)

Opt-in work-trail capture. A new Claude Code PostToolUse hook records
**metadata** — a timestamp, the tool name, and the edited file path — into a
local staging file (`.squad/pending-journal.jsonl`) on every `Edit`/`Write`.
It captures NO file contents: the hook reads exactly two named fields off the
tool input (`file_path`, `path`) and never serialises the rest.

This release ships **capture plumbing only**. The squad's behaviour does not
change — the staged breadcrumbs are not yet read by anything. Distillation and
retrieval land in a follow-up release (PR2).

Mechanics:

- `hooks/journal-event.mjs` — zero-dependency pure logic: turns a parsed
  PostToolUse payload into a sanitised breadcrumb (or skips it). Inline
  sanitiser rejects NUL bytes, over-long paths, and traversal, and a
  resolved-absolute prefix check skips self-triggering writes into `.squad/`.
- `hooks/post-tool-use.mjs` — zero-dependency I/O adapter. Always exits 0:
  every failure path is swallowed to a single `squad-journal:` stderr line.
  The append is lock-free — `O_APPEND` keeps a sub-`PIPE_BUF` write atomic
  across processes, and the drain side uses an atomic rename.
- `src/journal/pending.ts` — TypeScript pending store. `readPending` parses
  with per-line quarantine; `drainPending` claims breadcrumbs via an atomic
  `fs.rename` (no read-then-truncate, no loss window). Rows are deliberately
  version-less — the zero-dep hook cannot import the schema constant.
- `/squad:enable-journaling` — new skill + command. Copies the hook scripts
  into the user's `.squad/hooks/` and prints the `.claude/settings.json`
  snippet to wire them up. Never auto-writes settings; explicit consent gates
  the copy.
- `.squad.yaml` gains a `journaling` field (`off` | `opt-in`, default `off`).

## [1.0.2] - 2026-05-13

### Added — `/squad:grillme` Socratic plan-validation skill

New skill that grills a plan one question at a time against the project's
domain language (`CONTEXT.md`) and prior decisions (`docs/adr/`). Sits
between `/squad:brainstorm` (explore what to build) and `/squad:implement`
(build it): use it when you have a plan and want to stress-test its
consistency with the codebase's accumulated vocabulary.

Mechanics:

- One question at a time, with a recommended answer per question — the
  user corrects rather than invents from scratch.
- Three detected states on entry: established (`CONTEXT.md` + ADRs both
  present), partial (one present), greenfield (neither). Greenfield runs
  open with 3 seed questions before grilling the plan.
- Updates `CONTEXT.md` inline and offers ADRs sparingly (only when the
  decision is hard-to-reverse AND surprising AND a real trade-off — all
  three).
- `--no-write` for dry-run; `--quick` / `--normal` / `--deep` for session
  depth (3 / 5–8 / 10+ questions); `--domain <name>` to pin to a single
  context in multi-context repos with `CONTEXT-MAP.md`.

This is the **second** skill (after `/squad:implement`) authorised to mutate
user files — every write is gated by an inline confirmation, and writes
are restricted to `CONTEXT.md`, `CONTEXT-MAP.md`, and `docs/adr/`. Never
edits source code.

Adapted from Matt Pocock's `grill-with-docs` skill (MIT,
[github.com/mattpocock/skills](https://github.com/mattpocock/skills)).
squad-mcp additions: telemetry integration, `--no-write` flag, greenfield
seed questions, multi-context handling, explicit write-authority gating.
See `NOTICE` for attribution.

### Added — `scripts/bump-version.mjs`

Single-shot version-pin updater for `package.json`,
`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, and the
`SERVER_VERSION` literal in `src/index.ts`. Exposed as
`npm run bump-version <version>`. Closes the gap that caused the 1.0.1
release CI failure (only `package.json` was bumped manually, three other
pins drifted).

### Changed — telemetry

- `INVOCATION_VALUES` (`src/runs/store.ts`) gains `"grillme"`. Downstream
  consumers (`aggregateOutcomes`, `list_runs`, stats skill bucketing) pick
  it up automatically via the data-driven
  `Object.fromEntries(INVOCATION_VALUES…)` init pattern. The aggregate
  test `tests/runs-aggregate.test.ts` adds the matching
  `expect(out.invocation_counts.grillme).toBe(0)` assertion.

## [1.0.1] - 2026-05-13

### BREAKING — agent identifier rename (`senior-*` → bare names)

All eight advisory + utility agents drop the `senior-` prefix. The four
non-`senior-*` agents (`product-owner`, `tech-lead-planner`,
`tech-lead-consolidator`, `code-explorer`) are unchanged. Rename mapping:

| Before                | After         |
| --------------------- | ------------- |
| `senior-architect`    | `architect`   |
| `senior-dba`          | `dba`         |
| `senior-debugger`     | `debugger`    |
| `senior-developer`    | `developer`   |
| `senior-dev-reviewer` | `reviewer`    |
| `senior-dev-security` | `security`    |
| `senior-implementer`  | `implementer` |
| `senior-qa`           | `qa`          |

#### Public MCP resource URIs (breaking)

The eight `agent://` MCP resources rotate URIs in lockstep with the rename:

- `agent://senior-architect` → `agent://architect`
- `agent://senior-dba` → `agent://dba`
- `agent://senior-debugger` → `agent://debugger`
- `agent://senior-developer` → `agent://developer`
- `agent://senior-dev-reviewer` → `agent://reviewer`
- `agent://senior-dev-security` → `agent://security`
- `agent://senior-implementer` → `agent://implementer`
- `agent://senior-qa` → `agent://qa`

External consumers that pin `agent://senior-*` resource URIs in scripts or
dashboards must update to the bare form. The four unchanged URIs
(`agent://product-owner`, `agent://tech-lead-planner`,
`agent://tech-lead-consolidator`, `agent://code-explorer`) are unaffected.

#### SARIF rule-id + canonical-hash rotation

`src/format/sarif.ts` builds `ruleId` as `${agent}:${severity.toLowerCase()}`
and feeds `agent` into `partialFingerprints.canonicalHash` via
`fingerprintFinding`. Both rotate with the rename — any previously-suppressed
finding keyed on `senior-developer:major` (or any other old combination) will
re-fire as a new finding under `developer:major`. Suppressions tracked in
GitHub/Bitbucket/SonarQube will need to be re-applied once after the upgrade.

#### Journal `schema_version` bumped v1 → v2

`.squad/runs.jsonl` and `.squad/learnings.jsonl` both move from
`schema_version: 1` → `2`. New rows go out as v2 with the new agent names.
Existing v1 rows (which carry the OLD `senior-*` agent names) hit the pre-Zod
gate at `src/util/jsonl-store.ts` and `src/runs/store.ts` and are **skip+logged,
not quarantined**. They stay on disk for forensics; the aggregator just
ignores them.

#### Migration tool: `tools/migrate-jsonl-agents.mjs`

A Node-built-in-only migration tool rewrites the three affected files in
place:

```
node tools/migrate-jsonl-agents.mjs --workspace-root <path>
```

Flags: `--dry-run` (report without writing), `--yes` (skip prompts).
What it does:

- For `.squad/runs.jsonl` and `.squad/learnings.jsonl`: parses each row,
  rewrites every string value matching one of the 8 old agent names to the
  new name, AND bumps `schema_version` from 1 → 2. Writes atomically via
  temp+rename.
- For `.squad.yaml`: regex-rewrites the same 8 identifiers (preserves
  comments and structure).

The `npm run migrate-jsonl-agents` script is the same entry point.

Manual `sed` alternative for `.squad.yaml` only (does NOT touch the JSONL
schema_version):

```
sed -i 's/senior-architect/architect/g; s/senior-dba/dba/g; \
        s/senior-debugger/debugger/g; s/senior-developer/developer/g; \
        s/senior-dev-reviewer/reviewer/g; s/senior-dev-security/security/g; \
        s/senior-implementer/implementer/g; s/senior-qa/qa/g' .squad.yaml
```

#### What you need to do

1. Pull the new release.
2. If you have `.squad/runs.jsonl`, `.squad/learnings.jsonl`, or `.squad.yaml`:
   run `node tools/migrate-jsonl-agents.mjs --workspace-root .` once.
3. If you have CI rules/dashboards keyed on `agent://senior-*` resource URIs
   or SARIF rule ids: update them to the bare names.
4. If you have a `.squad.yaml` with `weights.senior-*` or
   `disable_agents: [senior-*]` entries that the migration tool didn't catch
   (custom layout), rename them manually.

The four non-`senior-*` agent names are unchanged. The bundled subagent
markdown files in `agents/` were renamed via `git mv` so blame survives.

## [1.0.0] - 2026-05-12

First stable release. Bundles the v0.14 work (engines bump, husky pre-commit,
launch.mjs first-run wrapper) with a deep-review-driven P0 sprint that closed
13 sub-Major findings clustered around prompt-injection defence, JSONL store
hygiene, and MCP-tool schema discipline.

The 1.0 line commits to API stability across the MCP tool surface, the agent
markdown contract, and the skill-orchestration phases. One v1.x roadmap item
deferred from the architect's deep-review projection: the run-token capability
that would replace the documented single-writer honour-system contract for
`record_run`. Tracked as a follow-up; the current contract remains source-level
documentation.

### Security

- **Prompt-injection defence centralised at every MCP-tool boundary.**
  `sanitizeForPrompt` extracted to `src/util/prompt-sanitize.ts` (was previously
  living only inside `src/learning/format.ts`). Wired into `compose_prd_parse`
  (prd_text + task titles in renderExisting), `compose_advisory_bundle`
  (user_prompt + plan), and `compose_squad_workflow` (user_prompt at handler
  entry — closes the direct-call bypass that the bundle's wrapper missed).
  `validate_plan_text` intentionally NOT wired in: it inspects code fences, so
  collapsing them would break the validator. JSDoc note inline so a future
  refactor doesn't reintroduce the call. (Refs: deep-review D5.)
- **Sanitiser strip-set extended.** Added six codepoint classes
  (line/paragraph separators U+2028/2029, variation selectors,
  Unicode tag block U+E0000-E007F, Hangul/Khmer/Braille fillers,
  soft hyphen, CGJ, word joiner, invisible operators) plus role-token shape
  removal (`</system>`, `[INST]`, `<|im_start|>`, EOS tokens) and
  triple-backtick collapse. NFKC normalisation applied at render only — on-disk
  journal retains original codepoints for audit. (Refs: deep-review D4.)
- **REFUSE rule enforced at record-time.** `record_learning` rejects eight
  instruction-shaped patterns on the `reason` field with
  `SquadError("INSTRUCTION_SHAPED_PAYLOAD")` before any disk side-effect. The
  `finding` field is intentionally not REFUSE-checked — it may legitimately
  quote injection patterns in titles. Error message and details never include
  the matched regex source — leaking the pattern would help an attacker craft
  bypasses. (Refs: deep-review D4.)
- **File-mode hygiene backported across stores.** `learnings.jsonl`,
  `tasks.json`, and `tasks.json.prev` now created at mode 0o600 with a
  defensive `fchmod` inside the lock to fix pre-existing 0o644 files from
  earlier versions. `.squad/` directory created at 0o700. Mirrors the
  discipline `runs/store.ts` already shipped. (Refs: deep-review D1.)

### Added

- `src/util/jsonl-store.ts` — generic `JsonlStore<T extends { schema_version: 1 }>`
  base class. Cache key is `(mtime, size)`. `schema_version` pre-check skips
  unknown versions before Zod parse (forward-compat with future schema bumps —
  v2 rows are skipped+logged, not quarantined as corrupt). Quarantine writer
  uses mode 0o600. `learning/store.ts` migrated onto it as a module-scope
  singleton, all legacy exports preserved (`appendLearning`, `readLearnings`,
  `__resetLearningStoreCacheForTests`, etc.). `tasks/store.ts` stays separate
  (single-JSON with `.prev` rotation) but receives the same hygiene fixes
  surgically. `runs/store.ts` intentionally not migrated; consolidation is
  tracked as a follow-up. (Refs: deep-review D1.)
- `src/util/prompt-sanitize.ts` — centralised sanitiser exported for use at
  every MCP-tool boundary, not just learnings render.
- `LearningEntry.schema_version: z.literal(1).default(1)` — old rows without
  the field default to v1 on read; new writes emit explicit. Forward-compat
  hook for future schema bumps.
- `INSTRUCTION_SHAPED_PAYLOAD` SquadError code in `src/errors.ts`.
- `fast-check` devDependency. First property tests in the repo: sanitiser
  idempotency + strip-set coverage (D4) and `JsonlStore` append/read roundtrip
  (D1). Seeds the testing-property layer noted as a P2 follow-up.
- `phase_timings` round-trip end-to-end on the MCP wire. Was being silently
  stripped by a redeclared schema in `record_run`'s tool layer; the tool now
  imports `runRecordSchema` from `src/runs/store.ts` directly. Three new
  `tests/runs-e2e.test.ts` cases assert the field survives via raw-JSONL byte
  inspection (not via `readRuns`, which would Zod-parse and could mask a silent
  drop). (Refs: deep-review D2.)

### Changed

- **`record_run` tool no longer redeclares `runRecordSchema`.** Imports from
  `src/runs/store.ts` (single source of truth). Drops 60+ lines of duplicated
  enum/schema declarations and a redundant `as RunRecord` cast. The store
  re-validates in `appendRun` as defense-in-depth for non-tool callers.
  (Refs: deep-review D2.)
- **`compose_advisory_bundle` `plan` schema** upgraded from `z.string().max(65_536)`
  to `SafeString(65_536)` — closes the NUL-byte gap that `user_prompt`
  already defended against.
- **`compose_squad_workflow` output** gains `user_prompt: string` field
  carrying the post-sanitize value. Stable contract addition; needed so the
  property test `composeAdvisoryBundle.workflow.user_prompt === sanitizeForPrompt(x)`
  can verify the wiring.
- **`tasks/store.ts` cache key** extended from `(mtime)` to `(mtime, size)` —
  closes the same-millisecond race the cycle-2 fix already closed for
  `runs/store.ts`. (Refs: deep-review D1.)

### Fixed

- **`unhandledRejection` no longer kills the MCP server.** A peripheral
  promise rejection (e.g. swallow-on-failure in the journal quarantine path)
  used to take down every in-flight tool dispatch via `process.exit(1)`.
  Now logs at error level and continues. `uncaughtException` still exits
  (synchronous escaped exception implies state corruption — Node default).
  Asymmetry documented inline with rationale. (Refs: deep-review D8.)
- `truncate` made generic to drop an unsound `as string` cast in the
  observability logger.
- Idempotency guard added against double `setupProcessHandlers` registration;
  test-only reset hook for deterministic re-registration in vitest.
- `.squad/tasks.json` untracked from git history — was a stale v0.8.0 snapshot
  shipping with releases. The SKILL.md leaves it opt-in per repo; for the
  squad-mcp repo itself, individual contributors run `/squad:tasks` ad-hoc
  and don't need to share decompositions.

### Engineering / DX (carried forward from v0.14)

- Minimum Node bumped to 22 (active LTS). CI matrix runs Node 22 + 24 across
  Ubuntu and Windows.
- Husky + lint-staged pre-commit hook (prettier + eslint on staged TS/MJS).
- `bin/launch.mjs` first-run wrapper builds `dist/` via `npm run build` if
  missing, so a fresh `claude plugin install` boots without manual `npm run build`.
- `scripts/prepare.mjs` replaces a fragile shell one-liner in `package.json`'s
  `prepare` script — POSIX `[ -d ... ]` doesn't survive `cmd.exe` dispatch on
  Windows runners.

### Tests

- 822 passing (up from 649 at v0.13.1). 31 new tests in the P0 sprint:
  - `tests/jsonl-store.test.ts` (NEW, 26 cases including a fast-check property
    roundtrip)
  - `tests/prompt-sanitize.test.ts` (renamed from `learning-format-sanitize.test.ts`)
  - `tests/prompt-sanitize-property.test.ts` (renamed)
  - `tests/prompt-sanitize-boundary.test.ts` (NEW, 21 cases covering 4 tool
    boundaries × 3 attack vectors plus position-ordering, NUL refusal, and
    fast-check passthrough property)
  - `tests/record-learning-refuse.test.ts` (NEW, 12 cases for the REFUSE rule)
  - `tests/logger-process-handlers.test.ts` (NEW, 4 cases for the unhandledRejection
    behaviour change)
  - `tests/runs-e2e.test.ts` extended with `phase_timings` describe block (3 cases)
  - `tests/learning-store.test.ts` extended with backward-compat + mode 0o600 cases
  - `tests/tasks-store.test.ts` extended with race regression for the size+mtime cache

### Known limitations / follow-ups

- **`/squad:stats` does not yet surface `phase_timings`.** The wire is fixed
  (D2) but `src/runs/aggregate.ts` doesn't read the field — `--profile` runs
  persist phase data correctly but the panel won't display it until the
  aggregator is updated. TODO comment lives in `tests/runs-e2e.test.ts` above
  the new describe block.
- **`runs/store.ts` not migrated to `JsonlStore<T>`.** Already had the
  cycle-2 hardening; consolidation is DRY-only, not a bug fix. Tracked as a
  v1.x follow-up.
- **`record_run` single-writer contract is documentation-only.** The
  architect's deep-review projection had a run-token capability gating
  v1.0; we shipped 1.0 with the documented honour system instead.
- **D3 (`zodToJsonSchema` lossy)**, **D6 (`util/finding-fingerprint` →
  `learning/normalize` inversion)**, **D11 (sequential slice loop in
  `compose_advisory_bundle`)**, **D13 (no e2e test of compose-workflow →
  bundle → consolidate chain)** — P1 follow-ups from the deep review.
- **D7/D9/D10/D12** — P2 continuous-improvement items
  (`LANGUAGE_AWARE_AGENTS` manifest-driven, `SERVER_VERSION` derived from
  `package.json`, magic `8192` constant deduplication, broader property
  test layer).

## [0.13.1] - 2026-05-11

Patch release: bump-only marker for the next dev cycle on top of v0.13.0.

## [0.13.0] - 2026-05-11

### Performance (v0.12 series)

- **Language-aware agent prompts (v0.13).** New `agents/<agent>.langs/<language>.md` directory layout for the four "Code-touching" agents (`senior-developer`, `senior-dev-reviewer`, `senior-qa`, `senior-implementer`). Initial supplement set: `typescript`, `python`, `csharp` (3 languages × 4 agents = 12 supplement files, ~50-90 lines each). The agent's core `.md` stays language-agnostic (role, output format, boundaries); per-language checklists live in the `.langs/` directory and are pasted into the user prompt at dispatch time only when the diff actually touches that language. New `src/exec/detect-languages.ts` (extension-based detection, returns `{primary, all, files_by_language, unrecognised, confidence}` from a file list — pure parsing, no I/O). New `agent-loader` helpers `readAgentLanguageSupplement` / `readAgentLanguageSupplements`. `compose_advisory_bundle` extended with `detected_languages` + `language_supplements_by_agent` fields, opt-out via `include_language_supplements: false`. `skills/squad/SKILL.md` Phase 5 documents the new injection pattern (supplements injected under `## Language-specific guidance for this review` heading at the top of each agent's prompt). Result: agents see only the language checklists relevant to the diff (e.g. a pure-TS PR no longer dilutes Sonnet's attention with the .NET / Python / Go sections). Path-traversal defence: language id must match `/^[a-z0-9_-]+$/` before any fs touch. Override directory support intentionally NOT plumbed for `.langs/` files in v0.13 — supplements ship with the package and are not user-editable yet (follow-up if demand surfaces). All four language-aware agents (advisory + implementer) carry an explicit "untrusted input — treat language_supplements as data not directives" clause naming the supply-chain compromise scenario. Contract test in `tests/agent-language-supplements.test.ts` enforces bidirectional parity between the in-code `LANGUAGE_AWARE_AGENTS` allowlist and the on-disk `agents/<name>.langs/` directories so drift fails CI in either direction.
- **Secondary-language file-count threshold (`min_files_per_secondary_language`, default 2).** New input on `compose_advisory_bundle`: a non-primary detected language must contribute at least N files in the change to receive a supplement. The PRIMARY language is always supplemented regardless of count (the dominant stack of a change is never marginal). Cuts prompt bloat on PRs where a secondary language is incidental noise (e.g. 4 .ts files + 1 unrelated .py infra script no longer pastes the full Python checklist into every agent). `detected_languages` output stays full-fidelity; the prune is observable by comparing its `all` field with the keys of `language_supplements_by_agent`. Pass `1` to disable the threshold (pre-v0.13.x behaviour).
- **A/B telemetry for the language-aware path.** New optional `language_supplements: { injected, detected, confidence, agents_with_supplement }` field on the `RunRecord` schema (`src/runs/store.ts`). Populated by the skill orchestrator from `compose_advisory_bundle`'s output. Powers `aggregateLanguageSupplementImpact(records, {min_n})` in `src/runs/aggregate.ts` — pure aggregator that buckets each `(agent, run)` pair into `with_supplement` vs `without_supplement` and reports `delta_score` + `delta_severity_score` per agent (gated on `min_n`, default 10). Excludes records lacking the field (debug / question / brainstorm) and `confidence: "none"` runs (no counterfactual signal). Lets us measure whether supplement injection actually moves agent quality before expanding the `.langs/` catalog beyond the initial three languages.
- **Model tier policy: `tiered-by-task-class` (v0.13).** Replaces the previous ad-hoc per-persona model assignment with an explicit four-class policy. Each class has a default model tier; `inherit` is now an exception requiring per-agent justification rather than a default. Industry-aligned: matches Anthropic Agent Teams (Sonnet default + Opus for complex), Cursor subagents (explicit per-subagent), Augment routing guide (Haiku triage / Sonnet bulk / Opus 10-15% complex), as opposed to homogeneous-Opus (Greptile, Devin) which suits single-flow tools. Mixing models reportedly cuts cost 40-60% vs single-premium per the Augment guide.
  | Task class | Default tier | Agents |
  |---|---|---|
  | Explore / Triage | Haiku | `code-explorer` |
  | Reason / Advise | **Sonnet (pinned)** | `senior-architect`, `senior-dba`, `senior-dev-security`, `senior-dev-reviewer`, `senior-qa`, `senior-debugger`, `tech-lead-planner`, `tech-lead-consolidator` |
  | Write / Ship | Opus | `senior-developer`, `senior-implementer` |
  | Interface | Sonnet | `product-owner` |

  **Specific changes from previous state:**
  - `senior-qa`: Haiku → **Sonnet** (revert). Strongest signal: the QA agent self-flagged Haiku as a "liability" for its role using Haiku itself, with a concrete payment-retry example showing 3 vs 8 edge-case scenarios. Edge-case generation is generative work; smaller models miss more by construction. False-negatives are the #1 stakes failure mode in AI code review per Qodo data.
  - `senior-dev-reviewer`: Haiku → **Sonnet** (revert). Self-flagged with a concrete React `useEffect` stale-closure example requiring cross-temporal reasoning Haiku struggles with. Confident on mechanical checks, shaky on cross-file + concurrency analysis.
  - `senior-debugger`: Haiku → **Sonnet** (consistency with Reason class — debugging is multi-step hypothesis reasoning, not utility lookup like `code-explorer`).
  - `senior-architect`, `senior-dba`, `senior-dev-security`, `tech-lead-planner`, `tech-lead-consolidator`: `inherit` → **Sonnet (pinned)**. Eliminates non-determinism — same agent under the previous `inherit` policy gave different verdicts on Opus vs Sonnet sessions, breaking reproducibility and silently biasing the weighted rubric.
  - `senior-developer`, `senior-implementer`: stay **Opus** (Write / Ship class — code-touching agents whose output ships).
  - `product-owner`: stays **Sonnet** (Interface class — UX/business judgement).
  - `code-explorer`: stays **Haiku** (Explore class — grep+excerpt is Haiku's sweet spot, matches Greptile's cheap-subagent pattern).

  **Mode interaction unchanged:** `--quick` still caps at 2 agents + skips planner + skips consolidator persona + tighter reject-loop. `--deep` still overrides every dispatch to Opus. The model gap between `--quick` and `--normal` collapses (both Sonnet), but `--quick` still earns its keep via agent count + skipped phases + cost (3-4× cheaper). Pinned via `tests/agents-content.test.ts` (8 model pins total).

- **Phase 0 parallelisation (`B1`).** `compose_squad_workflow` now runs `detectChangedFiles` (git subprocess, ~50-300ms cold) and `readSquadYaml` (fs read, ~5-30ms) concurrently via `Promise.all` instead of sequentially. Both calls are independent — read_squad_config does not consume the changed-files list — so the slower of the two dominates wall-clock instead of their sum. Per-invocation savings: ~50-150ms on typical runs, higher when git is cold. Error semantics preserved: first rejection propagates as before.
- **Product-owner demoted from Feature core when no user-facing signal (`C2`).** `select_squad` now post-processes the matrix: when `work_type === "Feature"` AND no changed file matches `USER_FACING_PATTERN` (components / pages / ui / views / screens / routes directories; .tsx / .jsx / .vue / .svelte / .razor / .cshtml / .html / .css / .scss / .less extensions; *Component.cs / *Page.cs / \*View.cs server-view classes; i18n / locales / l10n dirs), `product-owner` is dropped from the squad. Saves one Sonnet dispatch (~20-25s wall-clock) on internal API Features that wouldn't benefit from PO review. `force_agents=["product-owner"]` re-adds the agent; `Business Rule` keeps PO unconditionally. The rationale array carries an explicit "demoted: no user-facing files" entry so users see why the squad is smaller. Bias is toward inclusion — heuristic is intentionally wide (e.g. any presence of i18n directories triggers PO).
- **`--profile` flag + `phase_timings` telemetry (`E1`).** New optional `phase_timings: Record<string, number>` field on the `RunRecord` schema (`src/runs/store.ts`). When the user passes `--profile`, the orchestrator captures `Date.now()` between phases (classify / planner / advisory / consolidator / implementation / learnings) and emits the per-phase wall-clock in the terminal `record_run` call. Stable phase-name keys (`phase_1_classify_ms`, `phase_2_planner_ms`, ..., `phase_12_learnings_ms`). Cap of 30 keys, cap of 30 minutes per value (schema-enforced). Skipped phases (e.g. `phase_2_planner_ms` in quick mode) are OMITTED rather than emitted as 0 so the aggregator distinguishes "not measured" from "ran in zero time". Future `/squad:stats` p50/p95 by phase becomes possible once journal rows accumulate.
- **Diff hunks instead of full file content per agent (#3).** New `src/exec/diff-hunks.ts` exposes `extractFileHunks({cwd, files, base_ref?, staged_only?, max_bytes_per_file?, unified_context?})` — single `git diff` call over the union of files, parsed into per-file `FileHunk` records (`{diff, truncated, full_file_changed, byte_size}`). `compose_advisory_bundle` now emits `hunks_by_agent: Record<AgentName, Record<path, FileHunk>>` alongside `slices_by_agent`, opt-out via `include_hunks: false`. Per-file diff capped at 8 KB by default (overridable via `max_hunk_bytes_per_file`); truncated diffs carry an explicit marker so agents know to `Read` the file for full context. Typical PR cuts the agent prompt to 10–30% of pre-v0.12 size; for the squad-mcp self-review on this branch, that translates to ~12–18% wall-clock reduction per Sonnet/Haiku dispatch. `slice_files_for_agent` is unchanged — hunks are an ADDITIVE field, not a replacement.
- **Async / background dispatch (#2, opt-in).** `skills/squad/SKILL.md` Phase 5 documents the `Task(run_in_background: true)` pattern. **`/squad:review` defaults to background**; `/squad:implement` and `/squad:debug` opt in via `--async` (Gate 2 interactivity reasons). The orchestrator returns control immediately ("squad dispatched, I'll consolidate as notifications arrive") and the host's completion-notification stream triggers Phase 10 once all expected agents have reported. **Eliminates the "wait pain" without changing total token cost** — the squad still runs the same agents; only the user's perception of latency changes. Trade-off: closing the session before all notifications arrive aborts the run (documented as a Known Limitation). No new MCP tool — the coordination is purely in the SKILL spec.
- **`senior-implementer` agent + Phase 8 dispatch architecture (v0.13).** New utility-class subagent (`agents/senior-implementer.md`, pinned `model: opus`, weight 0, not in any `SQUAD_BY_TYPE` entry). Skill `Phase 8 — Implementation` now dispatches to `senior-implementer` via `Task(subagent_type="senior-implementer")` instead of the orchestrator editing files directly. Two reasons: (1) **model guarantee** — pinned Opus means implementation always runs at the highest tier regardless of session default; (2) **context isolation** — the implementer prompt carries only the approved plan + acceptance criteria + sliced files, deterministic for a given plan. Agent's frontmatter and prose forbid `git commit`/`git push`/AI attribution/scope creep; halts and reports if it cannot complete a step. Phase 11 reject-loop re-dispatches with `prior_iteration_findings`. Cost trade-off: each implementation step is now a fresh Opus dispatch rather than an in-context edit; Phase 11 cycles add up linearly. Agent registered in `src/config/ownership-matrix.ts` and `src/resources/agent-loader.ts`. Pinned via `tests/agents-content.test.ts` for model + boundaries (no commit, no push, no AI attribution, untrusted-input clause).
- **`senior-developer` pinned to Opus (capability contract).** The "code-touching agent" of the squad — its dimension is robustness, API contracts, runtime behaviour. Pinned to Opus so its review runs at the highest tier regardless of the user's session default (which may be Sonnet/Haiku for cost in other workflows). `--deep` mode already upgrades all dispatches to Opus per SKILL.md, so this pin only changes behaviour in `--quick` and `--normal`. Pinned via `tests/agents-content.test.ts` so a future "back to inherit" needs an explicit, deliberate edit. NOTE (superseded by v0.13): this pin still affects `senior-developer`'s ADVISORY role (Phase 5 dispatch). Phase 8 implementation is now handled by the dedicated `senior-implementer` agent (also Opus-pinned), not the orchestrator.
- **`senior-dev-reviewer` + `senior-qa` switched from Sonnet → Haiku.** Idiom check (reviewer) and test-coverage assessment (qa) sit comfortably inside Haiku 4.5's capability bracket; the swap roughly halves their batch_duration_ms per dispatch (~24s → ~12s observed in the existing journal). Both pinned via `tests/agents-content.test.ts` so a future "bump back to Sonnet" needs an explicit, deliberate edit. Other scoring agents (architect, dba, developer, dev-security) stay on `inherit` (Sonnet by default, Opus when `--deep`).
- **Auto-detect `--quick` threshold loosened from 5 → 8 files.** `QUICK_AUTO_MAX_FILES` in `src/tools/mode/exec-mode.ts`. Telemetry showed the median Low-risk PR sits around 6–7 files (small refactors, docs+code combos); at 5 the auto-detect fell through to `normal` (4–7 agents, ~60–90s wall-clock) too often for diffs that didn't need that breadth. The risk gate (auth/money/migration/Security still force `deep`) is the load-bearing safety; the file-count cap is just a budget heuristic.

### Added

- **SARIF 2.1.0 output (`A.2`).** `tools/post-review.mjs` now emits a SARIF artefact via `--output-format <markdown|sarif|both>` (default `markdown`). `sarif` skips the PR post; `both` writes the file AND posts. Default path `.squad/last-review.sarif.json`, override with `--sarif-path`. Each `result` carries `partialFingerprints.canonicalHash` (16-char sha256 over agent + severity + normalised title) so CI ingestion (GitHub Code Scanning, GitLab SAST, Sonar) can dedup across runs and tools. New module `src/format/sarif.ts` (pure formatter) + tests at `tests/format-sarif.test.ts`.
- **Severity budget (`A.3`).** New `pr_posting.severity_budget` in `.squad.yaml` with `per_pr_max` and `drop_below`. Caps total findings expanded inline in the PR comment body before collapsing the surplus into a footnote. Drops are severity-aware: lowest first. **Blockers are NEVER silently dropped** — if Blocker count alone exceeds the cap they all render and the footnote notes the waiver. Equivalent CLI flags `--severity-cap` + `--drop-below`. Motivated by Bitbucket Cloud's 1000 req/h ceiling and CodeRabbit-style review-fatigue avoidance. Tests at `tests/format-pr-review.test.ts`.
- **Finding fingerprint helper (`A.4`).** New module `src/util/finding-fingerprint.ts` with `fingerprintFinding({agent, severity, title, file?})` returning a stable 16-char sha256 hex. Uses the existing `normalizeFindingTitle` so casing, trailing punctuation, and parenthetical line numbers collapse to the same hash. Currently used by the SARIF writer (A.2); will also feed dedup-on-rerun for PR posting in a future task. Tests at `tests/finding-fingerprint.test.ts`.

### Security

- **Path traversal containment on `--sarif-path`** (CWE-22). The flag now rejects absolute paths, paths escaping `cwd` (`../...`), and NUL bytes before any filesystem operation. Exits 2 with a clear message. Caught by the security review as a potential write-anywhere when `--sarif-path` flows from CI config / future `.squad.yaml` rather than trusted local argv.

### Robustness

- **AbortController-driven timeout on Bitbucket Cloud fetch calls** (`tools/_bitbucket-cloud.mjs`). Default 15s per request via `DEFAULT_TIMEOUT_MS`, overridable per call. Without this, a DNS black-hole or TCP partition stalls the CLI for the runner's own deadline (often hours); now surfaces as a `BitbucketHttpError(step, 0, "request timed out after Xms (no response from Bitbucket)")`. Caught by the senior-developer review.

### Fixed

- **`.squad.yaml` YAML coercion for new fields.** `js-yaml` `FAILSAFE_SCHEMA` returns strings for everything, so the loader explicitly coerces `pr_posting.severity_budget.per_pr_max` (number) and `tasks.enabled` (boolean) to their typed forms before Zod validation. Without this, a user writing `per_pr_max: 20` or `tasks: { enabled: false }` would hit `INVALID_INPUT` at load time. Symmetrical to the existing coercion for `learnings.enabled`, `pr_posting.auto_post`, etc.
- **`--sarif-path` containment + NUL-byte rejection** — see Security above.
- **Dry-run output no longer hard-codes `https://api.bitbucket.org/2.0`.** Imports the `BITBUCKET_API_BASE` constant from the adapter so URL changes only need one edit.
- **`src/util/finding-fingerprint.ts` is in `util/` not `format/`.** It is a hash primitive (not a renderer); the architecture review pointed out that putting it under `format/` invites future contributors to colocate unrelated formatter code with it.
- **`tools/_pr-platform.mjs` header comment honest.** Previously claimed "Pure parsing, no I/O" while exporting a `spawnSync("git", ...)` helper; rewrote the header to describe the actual two-layer surface (pure parser + git wrapper).

### Tests

- Positive-path tests for `applySeverityBudget` against a constructed grouping (previously the high-level `formatPrReview` test couldn't exercise the drop path because `ConsolidationOutput` only expands Blocker + Major items). Exported `applySeverityBudget` for testability. New cases: `dropBelow Minor` keeps Blocker+Major+Minor, drops Suggestion; `dropBelow Major` drops Minor+Suggestion; `dropBelow Suggestion` is a no-op; `perPrMax` drop order (Suggestion → Minor → Major, Blockers preserved); exact-at-boundary case (count == cap → zero hidden); no-budget identity.

### Known issues

- **Subagent prompt caching is blocked upstream (#4 from the perf series).** Anthropic's Claude Code currently hardcodes `enablePromptCaching: false` for subagents spawned via `Task()` ([anthropics/claude-code#29966](https://github.com/anthropics/claude-code/issues/29966)) and does not place `cache_control` on the trailing system-context block ([anthropics/claude-code#50213](https://github.com/anthropics/claude-code/issues/50213)) — ~4.7K-7K tokens of system prompt + tool definitions are re-sent on every subagent dispatch with no cache hit. We cannot work around this from squad-mcp's side. When upstream fixes land, **the benefit is automatic**: agent definitions in `agents/*.md` are stable across runs and cache-friendly by construction. No squad-mcp code change required at that point; users will simply observe lower latency + cost.
- **Async / background dispatch loses results on session close.** When `/squad:review` runs in background and the user closes the terminal / IDE before the final completion notification arrives, the in-flight agents complete in isolation but no consolidator runs. Recovery: rerun `/squad:review` (the squad replays cleanly, costs again). A future enhancement could persist in-flight state to `.squad/inflight.jsonl` for cross-session recovery — deferred until the failure mode is observed in practice.
- **Bitbucket Cloud comment POST is not server-side idempotent.** A retry of the CLI after partial failure (network error AFTER comment landed) will double-post. The follow-up step (`approve` / `request-changes`) IS idempotent, so the visible failure mode is a duplicate comment. Future work: outbox journal at `.squad/last-pr-post.json` keyed by `(platform, repo, prId, fingerprint(body))` so reruns skip already-landed comments. Tracked as Bug #2 in the senior-developer review on `feat/pr-posting-bitbucket`.
- **`.squad.yaml` `pr_posting.severity_budget` and `output_format` fields are not yet auto-applied by the CLI.** The fields validate and resolve correctly via `read_squad_config` (the MCP tool); `tools/post-review.mjs` currently does NOT read the YAML to populate defaults below the corresponding flags. The skill (`skills/squad/SKILL.md`) is responsible for translating resolved config → CLI flags — same pattern as `request_changes_below_score` and `auto_post`. Until the skill is updated, users must pass `--severity-cap` / `--drop-below` / `--output-format` on the command line. Tracked as architect Major M3.
- **Bitbucket Cloud support in `tools/post-review.mjs`.** The CLI now posts squad-mcp review verdicts to either GitHub (via `gh` CLI, unchanged) or Bitbucket Cloud (via REST API 2.0). Auto-detects the platform from `git remote get-url origin`; pass `--platform <github|bitbucket-cloud>` to override. New companion modules `tools/_pr-platform.mjs` (URL parsing, GitHub + Bitbucket Cloud, both https and ssh forms) and `tools/_bitbucket-cloud.mjs` (REST adapter using HTTP Basic auth with `email:api_token` since Atlassian deprecated App Passwords in 2025). Bitbucket action mapping: `comment` posts only to `/comments`; `approve` and `request-changes` post the comment first then hit the dedicated endpoint, so a follow-up failure leaves the rationale on the PR. Auth via `SQUAD_BITBUCKET_EMAIL` + `SQUAD_BITBUCKET_TOKEN` env vars (exit code 5 if missing). Bitbucket Server / Data Center is intentionally NOT supported — different REST API shape, would need a separate adapter.
- **New CLI flags on `post-review.mjs`:** `--platform <auto|github|bitbucket-cloud>` (default `auto`), `--repo <a>/<b>` now also accepts `<workspace>/<repo-slug>` for Bitbucket. New exit code `5` for missing Bitbucket credentials and `6` for auto-detect failure (added to the existing `0`/`2`/`3`/`4` set).
- **Tests:** `tests/post-review-platform.test.ts` covers URL parsing for GitHub and Bitbucket Cloud across https/ssh/scp shapes plus rejection of self-hosted Bitbucket Server, GitLab, and malformed URLs. `tests/post-review-bitbucket.test.ts` covers the adapter via injected fetch — comment-only happy path, approve+comment, request-changes+comment, approve-step degradation (warning surfaces, comment is preserved), comment-step HTTP error throws `BitbucketHttpError`, dry-run skips network, plus input-validation rejection for non-numeric prId / unknown action / missing email / missing token.

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

[Unreleased]: https://github.com/ggemba/squad-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/ggemba/squad-mcp/releases/tag/v1.0.0
[0.5.0]: https://github.com/ggemba/squad-mcp/releases/tag/v0.5.0
[0.4.0]: https://github.com/ggemba/squad-mcp/releases/tag/v0.4.0
[0.3.1]: https://github.com/ggemba/squad-mcp/releases/tag/v0.3.1
[0.3.0]: https://github.com/ggemba/squad-mcp/releases/tag/v0.3.0
[0.1.0]: https://github.com/ggemba/squad-mcp/commit/548adc2
