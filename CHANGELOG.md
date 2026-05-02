# Changelog

All notable changes to `squad-mcp` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Planned for a future minor:

- Promote bundled agent markdowns to Claude Code native plugin agents (rename to
  kebab-case + add YAML frontmatter), with a migration path for existing
  `%APPDATA%\squad-mcp\agents` overrides.
- Retire the legacy `/squad` and `/squad-review` skills now that the plugin
  ships them as slash commands.

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

### Added

- `src/util/override-allowlist.ts` — new module exposing `validateOverrideDir`
  and `validateOverrideFile`.
- `src/util/path-internal.ts` — extracted shared helpers (`rejectIfMalformed`,
  `realpathOrSelf`) reused by `path-safety` and `override-allowlist`.
- `OVERRIDE_REJECTED` added to `SquadErrorCode`.
- `SQUAD_AGENTS_ALLOW_UNSAFE=1` opt-in escape hatch for power users / CI on
  unusual paths.
- `tests/agent-loader.test.ts` and `tests/override-allowlist.test.ts` covering
  the accept/reject matrix, escape hatch, agent-name traversal guard, and
  symlink escape.

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

[Unreleased]: https://github.com/ggemba/squad-mcp/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/ggemba/squad-mcp/releases/tag/v0.3.1
[0.3.0]: https://github.com/ggemba/squad-mcp/releases/tag/v0.3.0
[0.1.0]: https://github.com/ggemba/squad-mcp/commit/548adc2
