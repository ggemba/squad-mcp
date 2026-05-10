# Changelog

All notable changes to `squad-mcp` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed — Plugin manifest `agents` and `commands` shape (Claude Code rejected v0.6.2)

`/plugin install squad@gempack` failed v0.6.2 with `Validation errors: agents: Invalid input` because `.claude-plugin/plugin.json` declared `"agents": "./agents/"` (string) and `"commands": "./commands/"` (string). Per the Claude Code plugin reference, those fields must be **arrays of explicit file paths** — only `skills` accepts a directory string.

- `.claude-plugin/plugin.json`: `agents` is now a 9-entry array listing each subagent's `.md` path; `commands` is a 4-entry array. `skills` stays as `./skills/`.
- Bumped to `0.6.3` across all four version pins (the release-yml guard added in v0.6.2 catches future drift).

### Fixed — Marketplace version pin missed in v0.6.1

`.claude-plugin/marketplace.json` was still pinned to `0.6.0` after v0.6.1 shipped, so `/plugin install squad@gempack` kept resolving to the broken v0.6.0 build. Bumped to `0.6.2` and added a release-workflow check that verifies all four version pins (`package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `src/index.ts SERVER_VERSION`) match the git tag. Future bumps fail loudly if any pin is forgotten.

### Fixed — Plugin manifest validation: shared docs lifted out of `agents/`

Claude Code's `/plugin install` rejected the v0.6.0 plugin with `Validation errors: agents: Invalid input`. The plugin manifest's `agents: "./agents/"` directive iterated every `.md` file under `agents/`, including the three `_shared/*.md` reference docs (severity matrix + skill specs) — they lack subagent frontmatter and fail validation.

- Moved `agents/_shared/` → top-level `shared/` so the plugin's agent validator only sees real subagent files.
- `src/resources/agent-loader.ts` adds `getEmbeddedSharedDir()` (resolves to `<repo>/shared/`); `SHARED_FILES` now lists bare filenames; `resolveSharedFile` reads from the new dir; `initLocalConfig` mirrors shared docs to `<localOverrideDir>/shared/<file>` (was `<localOverrideDir>/_shared/<file>`).
- `src/tools/consolidate.ts`, `skills/squad/SKILL.md`, `README.md` — references updated to `shared/_Severity-and-Ownership.md`.
- `package.json` now ships the `shared/` dir + the new task CLI helpers (`tools/_tasks-io.mjs`, `tools/{list,next,record,update}-task*.mjs`) and `tools/record-learning.mjs` in the published tarball (was missing).

Migration for users with an existing local override at `~/.config/squad-mcp/agents/_shared/`: run `init_local_config` again to mirror to the new `shared/` sub-directory, or move the files manually. Override resolution in v0.6.1 looks at `<localOverrideDir>/shared/<file>`; old `_shared/` overrides fall through to embedded defaults.

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

## [0.6.0] - 2026-05-10

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
