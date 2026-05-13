# squad-mcp

[![npm version](https://img.shields.io/npm/v/@gempack/squad-mcp.svg)](https://www.npmjs.com/package/@gempack/squad-mcp)
[![ci](https://github.com/ggemba/squad-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ggemba/squad-mcp/actions/workflows/ci.yml)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

MCP server that exposes the `squad-dev` workflow as deterministic tools, prompts, and resources. It classifies a task, scores its risk, picks an advisory squad of specialist reviewers, slices the changed files per agent, validates the plan, and consolidates the advisory verdicts. The host LLM (Claude Code, Cursor, Warp, Claude Desktop, …) orchestrates; `squad-mcp` provides the building blocks.

It also ships as a Claude Code plugin that bundles the MCP server, the slash commands (`/squad:implement`, `/squad:review`, `/squad:question`, `/squad:debug`, `/squad:tasks`, `/squad:next`, `/squad:task`, `/squad:stats`, `/brainstorm`, `/commit-suggest`), and the matching skills behind a single `/plugin install`.

## Install

### Claude Code plugin (recommended)

```text
/plugin marketplace add ggemba/squad-mcp
/plugin install squad@gempack
```

The plugin bundles the MCP server plus the slash commands and skills (`/squad:implement`, `/squad:review`, `/squad:question`, `/squad:debug`, `/squad:tasks`, `/squad:next`, `/squad:task`, `/squad:stats`, `/brainstorm`, `/commit-suggest`). After install, restart Claude Code to pick up the new commands and the `squad` MCP server.

### npm package (any MCP client)

```bash
npx -y @gempack/squad-mcp
```

The package exposes the `squad-mcp` binary and works with any MCP-capable client. Examples below.

#### Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json` (Windows) / `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "squad": {
      "command": "npx",
      "args": ["-y", "@gempack/squad-mcp"]
    }
  }
}
```

#### Cursor

`.cursor/mcp.json` (workspace-scoped) or global Cursor settings:

```json
{
  "mcpServers": {
    "squad": {
      "command": "npx",
      "args": ["-y", "@gempack/squad-mcp"]
    }
  }
}
```

#### Warp

Settings → MCP servers → add. Command `npx`, args `["-y", "@gempack/squad-mcp"]`.

### From source (development)

```bash
git clone https://github.com/ggemba/squad-mcp.git
cd squad-mcp
npm install
npm run build
node dist/index.js
```

## Your first `/squad:implement` in 60 seconds

After install, the plugin is silent until you invoke it. Drop into a repo with at least one staged or recently committed change and run:

```text
/squad:implement add a /health endpoint that returns {"status":"ok"}
```

What happens, in order:

1. **Classification.** `compose_squad_workflow` looks at your prompt + changed files and prints something like `work_type: Feature, risk: Low, agents: [developer, qa]`.
2. **Depth resolution.** It also picks an execution depth — `quick`, `normal`, or `deep` — and surfaces it as `mode` + `mode_source` on the output. Auto-detect rules: `deep` on `risk == High` / Security work / auth-money-migration signals; `quick` on Low-risk diffs with ≤5 files and no high-risk signals; `normal` otherwise. Pass `--quick` / `--normal` / `--deep` to override. If you force `--quick` on a high-risk diff, `security` is force-included and a structured `mode_warning` is set so the host can surface it.
3. **Plan.** The skill drafts an implementation plan and sends it to `tech-lead-planner` for review (skipped in `quick`). You see the plan in chat.
4. **Gate 1.** The skill **stops** and asks you to approve. Reply `approved`, `go`, or equivalent to proceed; anything else cancels.
5. **Advisory squad.** After approval, every selected agent (architect, dba, dev, qa, security, reviewer — depends on the selection; capped at 2 for `quick`, expanded with architect+security for `deep`) reviews in **parallel** and emits a findings list + a `Score: NN/100`.
6. **Consolidation.** `tech-lead-consolidator` produces a verdict (`APPROVED` / `CHANGES_REQUIRED` / `REJECTED`) plus a scorecard like:
   ```
   SQUAD RUBRIC — weighted 82 / 100 (threshold 75)
   Application Code     ████████████████░░░░   82  ×18%  developer
   Testing & QA         ███████████████░░░░░   78  ×14%  qa
   ```
   The `tech-lead-consolidator` persona is skipped in `quick` mode; `apply_consolidation_rules` still runs to produce the verdict.
7. **Implementation.** If approved, the skill writes code. **Never** commits or pushes — that's your call.

Other commands to try once `/squad:implement` works:

- `/squad:review` — same agents, but on an existing diff or PR (no implementation).
- `/squad:question <question>` — fast read-only code Q&A. Spawns the `code-explorer` subagent to grep + excerpt the relevant lines and answers with `file:line` citations. Use it for "where is X defined?", "what calls Y?", "how does the auth flow work?". No plan, no gates, no implementation.
- `/squad:debug <issue>` — read-only bug investigation. Takes a bug description + optional stack trace + repro steps, orients via `code-explorer`, then dispatches the `debugger` persona to emit N ranked hypotheses (1 on `--quick`, 3 on `--normal`, 5 with a cross-check pass on `--deep`) with `file:line` evidence and verification steps. The missing middle between `/squad:question` (lookup) and `/squad:implement` (fix).
- `/squad:tasks docs/prd.md` — decompose a PRD into atomic tasks with confirmation before they land in `.squad/tasks.json`.
- `/squad:next` — pick the next ready task; `/squad:task 3` — work on a specific one.
- `/brainstorm <topic>` — exploratory Q&A, no code.
- `/commit-suggest` — generate a Conventional Commits message for staged changes.
- `/squad:stats` — observability dashboard over `.squad/runs.jsonl`. Bar charts (verdict mix, score buckets), Unicode sparkline trend, per-agent breakdown of avg wall-clock and estimated tokens. Read-only; never writes. Flags: `--quick` (last 7d), `--thorough` (full history + health panel), `--since <ISO>`, `--last <N>`, `--no-color`. Token figures are estimates (chars ÷ 3.5).

Stuck? Check `INSTALL.md` → Troubleshooting. The most common failures (`Failed to reconnect to plugin:squad:squad`, marketplace cache, SSH key) all have entries.

## What it provides

### Tools (deterministic, pure functions)

| Tool                        | Purpose                                                                                                                                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detect_changed_files`      | Hardened `git diff --name-status --no-renames` for a workspace. Allowlisted refs, 10s timeout, 1MB stdout cap.                                                                                                                                 |
| `classify_work_type`        | Heuristic `WorkType` from prompt + paths (`Feature` / `Bug Fix` / `Refactor` / `Performance` / `Security` / `Business Rule`) with Low/Medium/High confidence.                                                                                  |
| `score_risk`                | Compute Low/Medium/High from boolean signals (auth, money, migration, files_count, new_module, api_change).                                                                                                                                    |
| `select_squad`              | Select advisory agents for a work type. Combines matrix + path hints + content sniff. Returns evidence per file.                                                                                                                               |
| `slice_files_for_agent`     | Filter a file list to those owned by a single agent. Used to build sliced advisory prompts.                                                                                                                                                    |
| `validate_plan_text`        | Advisory check for inviolable-rule violations in a plan (commit/push fences, emojis in code blocks, non-English identifiers, impl-before-approval).                                                                                            |
| `compose_squad_workflow`    | One-call pipeline: `detect_changed_files` → `classify_work_type` → `score_risk` → `select_squad`.                                                                                                                                              |
| `compose_advisory_bundle`   | One-call full bundle: `compose_squad_workflow` + `slice_files_for_agent` per selected agent + `validate_plan_text`.                                                                                                                            |
| `apply_consolidation_rules` | Aggregate advisory reports → final verdict (APPROVED / CHANGES_REQUIRED / REJECTED). Returns weighted rubric scorecard when reports carry per-dimension scores.                                                                                |
| `score_rubric`              | Pure rubric calculator. Takes per-agent scores (0-100) + optional weight overrides, returns weighted score, per-dimension breakdown, and pre-formatted ASCII scorecard.                                                                        |
| `read_squad_config`         | Read and resolve `.squad.yaml` (or `.squad.yml`) at workspace_root. Returns effective weights, threshold, min_score, skip_paths, disable_agents.                                                                                               |
| `read_learnings`            | Load past accept/reject decisions from `.squad/learnings.jsonl`. Filters by agent / decision / changed-file scope. Returns entries plus a markdown block ready to inject into agent or consolidator prompts.                                   |
| `record_learning`           | Append one accept/reject decision to `.squad/learnings.jsonl`. Side-effecting; the skill (or CLI) is responsible for per-finding user authorisation.                                                                                           |
| `prune_learnings`           | Lifecycle maintenance (v0.11.0+): mark entries older than `max_age_days` as `archived` and entries with ≥ `min_recurrence` accepts on the same canonicalised finding as `promoted`. Atomic rewrite under file lock. Never auto-runs.           |
| `compose_prd_parse`         | Build a prompt + JSON schema for the host LLM to decompose a PRD into atomic tasks. Pure-MCP: server does NO LLM calls. Caller (skill) feeds the prompt to its model, then calls `record_tasks` after user confirmation.                       |
| `list_tasks`                | Read tasks from `.squad/tasks.json`. Filters: status, agent (matches `agent_hints`), changed_files (glob match against task `scope`).                                                                                                          |
| `next_task`                 | Pick the next ready task: candidate status (default pending), all dependencies done, optional agent / changed_files filter. Tiebreak priority then id. Returns null + reason when none ready.                                                  |
| `record_tasks`              | Bulk-create tasks. Allocates ids sequentially, validates dependencies resolve (forward refs in batch ok), rejects duplicates and self-deps. Atomic write.                                                                                      |
| `update_task_status`        | Flip a task or subtask status: pending / in-progress / review / done / blocked / cancelled.                                                                                                                                                    |
| `expand_task`               | Append subtasks to an existing task. Mechanical only — caller (skill or LLM) supplies the subtask inputs.                                                                                                                                      |
| `slice_files_for_task`      | Filter a file list to those matching a task's `scope` glob. Same glob primitive as `skip_paths` and learnings scope.                                                                                                                           |
| `list_agents`               | List configured agents with role, ownership, naming conventions.                                                                                                                                                                               |
| `get_agent_definition`      | Return the full markdown system prompt for an agent (local override → embedded default).                                                                                                                                                       |
| `init_local_config`         | Copy embedded defaults to the local override directory so they can be edited.                                                                                                                                                                  |
| `record_run`                | Append one `RunRecord` to `.squad/runs.jsonl`. Single-writer contract: only the squad skill calls this (Phase 1 `in_flight` + Phase 10 terminal). Validates against schema_version 1, enforces 4 KB per-record cap, file mode `0o600`.         |
| `list_runs`                 | Read-only journal read. Folds the two-row pair by id, filters (since / limit / agent / verdict / mode / invocation / work_type), and returns either the folded list or an aggregate bundle (outcomes + health + trend) when `aggregate: true`. |

### Prompts

- `squad_orchestration` — full Phase 0–12 orchestration guide.
- `agent_advisory` — sliced prompt for one advisory agent.
- `consolidator` — final verdict prompt for TechLead-Consolidator.

### Resources

- `agent://product-owner`, `agent://tech-lead-planner`, `agent://tech-lead-consolidator`, `agent://architect`, `agent://dba`, `agent://developer`, `agent://reviewer`, `agent://security`, `agent://qa`. (Renamed from PascalCase / `po` in v0.6.0 — older 0.5.x consumers must use `agent://po` instead.)
- `severity://_severity-and-ownership` — severity matrix + ownership rules.
- `severity://skill-squad-dev`, `severity://skill-squad-review` — full skill specs.

### Bundled skills

The plugin auto-registers these skills via `skills/`:

| Skill              | Trigger                     | Purpose                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/squad:implement` | implementation workflow     | Single skill, two modes. `/squad:implement <task>` builds an approved plan, distributes work to specialist subagents in parallel, implements the change, consolidates via tech-lead. `/squad:review [target]` is the same skill in review mode — never implements, just produces an advisory verdict on an existing diff/branch/PR. Optional `--codex` second-opinion.                         |
| `/squad:question`  | read-only code Q&A          | Spawns the `code-explorer` subagent (Haiku-class, read-only) to grep, glob, and excerpt the codebase, then synthesizes a `file:line`-cited answer. No plan, no gates, no implementation. Designed to be fast — single dispatch on the default `medium` budget, sub-second on `--quick`.                                                                                                        |
| `/squad:debug`     | read-only bug investigation | Bridges `/squad:question` (lookup) and `/squad:implement` (fix). Takes a bug description + optional stack trace + repro steps; dispatches `code-explorer` to locate suspect code, then the new `debugger` persona to emit N ranked hypotheses (1 on `--quick`, 3 on `--normal`, 5 with a cross-check pass on `--deep`) with `file:line` evidence and verification steps. Read-only end-to-end. |
| `/brainstorm`      | pre-implementation research | Web research in parallel + specialist agent perspectives → options matrix with cited sources and a recommendation. Produces no code. Position: `/brainstorm` decides what to build, `/squad:implement` implements, `/squad:review` reviews.                                                                                                                                                    |
| `/commit-suggest`  | commit message generator    | Read-only suggester for Conventional Commits messages. Runs only an allowlist of git commands; never executes mutations; never adds AI co-author trailers. The user runs the commit themselves.                                                                                                                                                                                                |
| `/squad:stats`     | observability dashboard     | Read `.squad/runs.jsonl`, render a single-screen ANSI panel: verdict mix, score buckets, sparkline trend (14 days default), per-agent avg wall-clock + estimated tokens. One accent colour (cyan), Unicode block bars at 1/8 granularity. Flags: `--quick`, `--thorough`, `--since <ISO>`, `--last <N>`, `--no-color`. Token figures are estimates (chars ÷ 3.5).                              |

### Bundled subagents

The plugin's `agents/` directory registers eleven native Claude Code subagents you can also dispatch directly via `Task(subagent_type=…)`:

`product-owner`, `architect`, `dba`, `developer`, `reviewer`, `security`, `qa`, `tech-lead-planner`, `tech-lead-consolidator`, plus two utility roles: `code-explorer` (fast read-only code search; Haiku-class; dispatched by the planner for context gathering or by `/squad:question` for direct Q&A) and `debugger` (hypothesis-first bug investigation; Haiku-class; dispatched by `/squad:debug` to emit ranked root-cause hypotheses with `file:line` evidence and verification steps). Neither utility role scores the rubric or is auto-selected by the matrix.

The `/squad:implement` skill orchestrates them. For non-Claude-Code MCP clients (Cursor, Claude Desktop, Warp), the same role markdowns are accessible through the MCP `agent://…` resources and `get_agent_definition` tool.

Workflow positioning:

```
/brainstorm   ->  decide what to build
     v
/squad:implement        ->  implement what was decided
     v
/squad:review ->  review what was implemented
     v
/commit-suggest -> craft the commit message
```

See [INSTALL.md](INSTALL.md#bundled-skills) for trigger examples and the optional `commit-msg` git hook + `permissions.deny` snippet that hard-enforce the read-only and no-AI-attribution invariants at the OS / Claude Code layer.

## Repo configuration — `.squad.yaml`

Drop a `.squad.yaml` (or `.squad.yml`) at the repo root to override defaults per-project. Versioned with the code, picked up automatically by `compose_squad_workflow` and `compose_advisory_bundle`.

```yaml
# .squad.yaml — example for a regulated fintech backend

# Rubric weights (must sum to 100 across the agents you list).
# Agents NOT listed are zeroed out — listing weights is an explicit choice
# of which dimensions count for this repo.
weights:
  security: 30 # PCI compliance — security weighted higher
  dba: 22 # double-entry ledger, money on the line
  developer: 20
  architect: 15
  qa: 13

# Per-dimension flag threshold (default 75). Below this, the dimension is
# marked with ⚠ in the scorecard.
threshold: 80

# Quality floor: APPROVED with weighted score below this becomes
# CHANGES_REQUIRED. Severity rules (Blocker/Major) take precedence.
min_score: 75

# Files excluded from advisory. Glob syntax: ** for any depth, * for one
# segment, ? for one char. Useful for docs-only or generated paths.
skip_paths:
  - "docs/**"
  - "**/*.md"
  - "**/generated/**"
  - "vendor/**"

# Agents not relevant for this repo (e.g. internal tool, no PO involved).
disable_agents:
  - product-owner
```

All keys are optional; partial files merge with package defaults. `force_agents` in tool calls still wins over `disable_agents` (config is a default policy, not a veto over explicit caller intent). Validation is strict: weights that don't sum to 100, unknown agent names, or invalid threshold ranges are rejected with a clear error.

The reader is cached by mtime — long-running MCP servers automatically pick up edits without a restart.

## Learnings — persistent accept/reject memory

Each time the team accepts or rejects an advisory finding, the decision can be appended to `.squad/learnings.jsonl`. Future runs of the squad load recent decisions and inject them into per-agent and consolidator prompts so the squad stops re-raising findings the team has already considered.

```jsonl
{"ts":"2026-04-12T15:02:31Z","pr":42,"agent":"security","severity":"Major","finding":"missing CSRF on POST /api/refund","decision":"reject","reason":"CSRF terminated at API gateway, see infra/edge.tf","scope":"src/api/**"}
{"ts":"2026-04-15T09:18:11Z","pr":47,"agent":"architect","severity":"Major","finding":"cross-module coupling Auth → Billing","decision":"accept","reason":"refactored to event bus"}
```

The file lives in git. Decisions are auditable in PR diffs.

### Recording decisions (v0.11.0+ Phase 12 prompt)

After `/squad:review` consolidates findings, the skill surfaces a single batched prompt at the end of the report. It groups the findings by agent + severity (Suggestion-level findings excluded) and asks one question:

> Save which findings as precedents? Reply: `accept N1,N2,N3` / `reject N4` / `all accept` / `skip` / `because <reason>` to attach a rationale.

Each affirmative pick fires one `record_learning` call. Examples:

- `accept 1,2 because we ship this pattern across services`
- `reject 3` (records the rejection without a reason; the squad will still suppress the same finding next run)
- `all accept` (accepts every Blocker / Major / Minor in the report)
- `skip` or empty response (records nothing)

**Per-finding authorisation is required** — silence or "thanks" is not authorisation. The skill never invents a reason; the text after `because` flows verbatim to `record_learning.reason`.

For non-MCP environments, use the CLI helper:

```bash
node tools/record-learning.mjs --reject \
  --agent security \
  --finding "missing CSRF on POST /api/refund" \
  --reason "CSRF terminated at API gateway" \
  --scope "src/api/**" \
  --pr 42
```

### How the squad uses them

In Phase 5 (per-agent advisory) the skill calls `read_learnings(workspace_root, agent, changed_files)` and injects the rendered `## Past team decisions` block into the agent's prompt. In Phase 10 (consolidator) it does the same without an agent filter — the consolidator sees the full picture across agents.

Each agent is told: when a current finding matches a previously **rejected** decision (similar agent + similar finding text + matching scope), suppress or downgrade severity unless the diff materially changes the rationale. When a finding contradicts a previously **accepted** decision, flag the contradiction explicitly.

### Lifecycle (v0.11.0+): archive + promote

Two new optional fields on each entry let the journal age gracefully without manual surgery:

- `archived: true` — the entry is past the team's age cutoff and is hidden from default `read_learnings` injection. The row stays on disk for forensics.
- `promoted: true` — the same finding (matched by canonicalised title) has been accepted ≥ N times and now surfaces FIRST in the rendered block as `⭐ PROMOTED`. Advisors are instructed to treat promoted entries as team policy, not ordinary precedent.

Both flags are set by the **`prune_learnings`** MCP tool:

```
prune_learnings({
  workspace_root: <repo>,
  max_age_days: 180,    // entries older than this get archived: true
  min_recurrence: 3,    // accept-decisions on the same finding ≥ 3× get promoted: true
  dry_run: false        // set true to inspect counts without mutating
})
```

`prune_learnings` **never auto-runs.** The defaults are `max_age_days: 0` (= disabled) and `min_recurrence: 3` — invoking with no arguments is a safe no-op. Wire it into a cron or pre-commit hook if you want regular housekeeping. Each non-no-op run produces an atomic rewrite of `.squad/learnings.jsonl` under the same file lock used by `record_learning`; concurrent readers either see the pre-rewrite or post-rewrite file in full, never a torn write. A `.prev` snapshot is kept alongside the file as the rollback point.

The v0.11.0 schema is **additive and backward-compatible** — a v0.10.x reader strips the unknown `archived` / `promoted` fields silently and continues. No `schema_version` bump.

### Configuration

Override defaults via `.squad.yaml`:

```yaml
learnings:
  path: .squad/learnings.jsonl # default
  max_recent: 50 # how many recent entries to inject (hard cap 200)
  enabled: true # set false to disable injection without deleting the journal
```

The store reader is mtime-cached. The journal is append-only by design — the skill never amends or deletes past entries; correcting a stale decision means appending a new one.

## Tasks — PRD-decomposed atomic work units

The biggest source of token bloat in a long-running squad session is the squad re-analysing the whole repo for every prompt. The tasks store fixes that by decomposing a PRD into atomic tasks up front, then running the squad on ONE task's narrowed scope at a time.

```jsonc
// .squad/tasks.json (excerpt)
{
  "version": 1,
  "tasks": [
    {
      "id": 1,
      "title": "Add CSRF token to checkout flow",
      "status": "done",
      "dependencies": [],
      "priority": "high",
      "scope": "src/api/checkout/**",
      "agent_hints": ["security", "developer"],
      "test_strategy": "POST without token → 403; POST with token → 200.",
      "subtasks": [],
      "created_at": "2026-05-08T12:00:00Z",
      "updated_at": "2026-05-09T15:30:00Z"
    },
    {
      "id": 2,
      "title": "Wire CSRF middleware into refund endpoint",
      "status": "pending",
      "dependencies": [1],
      "priority": "high",
      "scope": "src/api/refund/**",
      "subtasks": [],
      ...
    }
  ]
}
```

`scope` (glob) and `agent_hints` are squad-mcp-specific additions on top of the claude-task-master shape — they let `slice_files_for_task` and `compose_squad_workflow` narrow the advisory automatically.

### Decomposing a PRD

Inside Claude Code:

```
/squad:tasks docs/prd-payments-refactor.md
```

The skill (Phase 0.5):

1. Calls `compose_prd_parse` with the PRD text.
2. Receives a prompt + JSON schema and runs them through Claude.
3. Shows you the parsed tasks — title, deps, priority, scope, agent_hints — for review.
4. Calls `record_tasks` only after you say "record" / "go" / "yes".

The parse is **pure-MCP**: the squad-mcp server never makes LLM calls. The host (Claude Code, Cursor, Warp) does the inference. No provider keys in the server, no surprises for non-Claude clients.

### Working tasks

```
/squad:next                # picks the highest-priority ready task
/squad:task 5              # explicit pick by id
```

For each task:

- `slice_files_for_task` narrows the changed-files list to the task's `scope`.
- `compose_squad_workflow` runs against that slice; if `agent_hints` is set, only those agents wake up.
- Phase 1 onward proceeds normally, just with much less context.
- When done, the skill flips status to `done` via `update_task_status`.

### Configuration

Override defaults via `.squad.yaml`:

```yaml
tasks:
  path: .squad/tasks.json # default
  enabled: true # set false to silence reads without deleting the file
```

Writes (`record_tasks`, `update_task_status`, `expand_task`) stay open even when reads are disabled — same policy as learnings. Disabling injection should not throw away the journal.

### CLI for non-MCP environments

Mirroring the post-review and record-learning helpers:

```bash
# decompose offline (you generate the JSON yourself or via another tool)
echo '[{"title":"Add CSRF","scope":"src/api/**"}]' | node tools/record-tasks.mjs

# inspect
node tools/list-tasks.mjs --status pending
node tools/next-task.mjs --json

# flip status from CI
node tools/update-task-status.mjs --task 5 --status done
```

The CLIs share `tools/_tasks-io.mjs` for read/write and require only node 18+. Schema validation is lighter than the MCP tool — production use should prefer the MCP path.

## Posting reviews to PRs (GitHub + Bitbucket Cloud)

Once the squad runs, you can post the verdict + scorecard as a PR review on **GitHub** or **Bitbucket Cloud**. The skill `/squad:review #42` runs the advisory and offers to post the result; default behaviour is **dry-run + confirmation** — Claude shows the exact request and the markdown body, then waits for your "go" before posting.

```bash
# auto-detect platform from `git remote get-url origin`
echo '<consolidation JSON>' | node tools/post-review.mjs --pr 42 --dry-run
echo '<consolidation JSON>' | node tools/post-review.mjs --pr 42

# force a platform
echo '<consolidation JSON>' | node tools/post-review.mjs --pr 31 --platform bitbucket-cloud --repo repos_acgsa/some-repo
```

The CLI maps verdict → review action deterministically:

| Verdict                                            | Score signal           | GitHub `gh` action                 | Bitbucket Cloud                            |
| -------------------------------------------------- | ---------------------- | ---------------------------------- | ------------------------------------------ |
| `REJECTED`                                         | —                      | `--request-changes` (blocks merge) | `POST /comments` + `POST /request-changes` |
| `CHANGES_REQUIRED`                                 | —                      | `--comment` (advisory)             | `POST /comments` only                      |
| `APPROVED` + `downgraded_by_score: true`           | weighted < `min_score` | `--comment`                        | `POST /comments` only                      |
| `APPROVED` + score < `request_changes_below_score` | (opt-in floor)         | `--request-changes`                | `POST /comments` + `POST /request-changes` |
| `APPROVED` otherwise                               | passes threshold       | `--approve`                        | `POST /comments` + `POST /approve`         |

### Platform auto-detection

`--platform auto` (default) parses `git remote get-url origin`:

- `github.com/<owner>/<repo>` → GitHub
- `bitbucket.org/<workspace>/<repo>` → Bitbucket Cloud
- Anything else → exit 6 with a clear error. Pass `--platform <name> --repo <a>/<b>` to override.

Bitbucket Server / Data Center (self-hosted) is **not** supported — it has a different REST API surface and would need a separate adapter.

### Auth

| Platform        | Mechanism                                                                       |
| --------------- | ------------------------------------------------------------------------------- |
| GitHub          | `gh` CLI on PATH + `gh auth login`. Exits 3 if missing.                         |
| Bitbucket Cloud | `SQUAD_BITBUCKET_EMAIL` + `SQUAD_BITBUCKET_TOKEN` env vars. Exits 5 if missing. |

For Bitbucket Cloud, generate an **API Token** at <https://id.atlassian.com/manage-profile/security/api-tokens> with the `pullrequest:write` scope (App Passwords were deprecated by Atlassian in 2025). Auth is HTTP Basic with `email:apiToken`.

### Severity budget (A.3, May 2026)

Cap how many findings get expanded inline in the PR body before collapsing the surplus into a footnote. Drops happen lowest-severity-first; **Blockers are never silently dropped**. Useful for big PRs and platforms with tight rate limits (Bitbucket Cloud is 1000 req/h per user).

CLI:

```bash
node tools/post-review.mjs --pr 42 --severity-cap 20 --drop-below Minor
```

Repo default via `.squad.yaml`:

```yaml
pr_posting:
  severity_budget:
    per_pr_max: 20 # cap total expanded findings (Blockers exempt)
    drop_below: Minor # hard floor — anything strictly below this drops FIRST
```

When the budget hides anything, the body carries a footnote like `_Severity budget hid 7 findings (4 minor, 3 suggestion). Tune pr_posting.severity_budget in .squad.yaml._` so it's never silent.

### SARIF / JSON output (A.2, May 2026)

Emit a SARIF 2.1.0 artefact for CI gating, IDE annotations, and dedup with linters. Three modes:

```bash
# markdown only (default — historical behaviour)
node tools/post-review.mjs --pr 42

# SARIF only — writes .squad/last-review.sarif.json, SKIPS the PR post
node tools/post-review.mjs --output-format sarif

# both — SARIF + post to PR
node tools/post-review.mjs --pr 42 --output-format both
```

Override path with `--sarif-path <file>`. Each `result` carries a `partialFingerprints.canonicalHash` (16-char sha256) built from `(agent, severity, normalized title)` — stable across rebases, enables future dedup-on-rerun and cross-tool dedup with Sonar / CodeQL.

Repo default via `.squad.yaml`:

```yaml
pr_posting:
  output_format: both # markdown | sarif | both (default markdown)
```

GitHub Code Scanning, GitLab SAST, Sonar, and most ingestion pipelines consume SARIF 2.1.0 directly.

### Auto-post (opt-in)

If `.squad.yaml` has `pr_posting.auto_post: true`, the skill posts without the second confirmation prompt — but **always shows the body first**. Auto-post means "skip the second yes/no", not "skip the preview".

```yaml
pr_posting:
  auto_post: true # default false — always asks
  request_changes_below_score: 50 # below this, post --request-changes instead of --approve
  omit_attribution_footer: false # default false — footer present
```

## Detection strategy (`select_squad` / `slice_files_for_agent`)

Three layers, in order of strength:

1. **Content sniff** — reads the first 16 KB of each file, matches token regexes (e.g. `class : DbContext`, `[ApiController]`, `services.AddScoped<>`, `from 'express'`, `prisma.<model>.findMany`, `from sqlalchemy`, `gorm.Open`, `gin.New`). Strong signal, name-agnostic. Patterns can be ext-gated (e.g. only `.py` for `from sqlalchemy`) to avoid cross-stack false positives.
2. **Path hint** — file path regex (e.g. `*Repository.cs`, `Migrations/`, `Controller.cs`, `api/`, `models/`). Cheap, complementary.
3. **Conventions** — each agent flags non-conformant naming as a finding so future detections improve over time.

Output of `select_squad` includes per-file `evidence` with `confidence` and `low_confidence_files` for unclassified files. Override via the `force_agents` parameter or by editing local agent definitions.

## Local override of agent definitions

The loader picks ONE local override directory:

- If `SQUAD_AGENTS_DIR` is set, that path is used **exclusively** (the platform default is not consulted).
- Otherwise: `%APPDATA%\squad-mcp\agents` on Windows, `$XDG_CONFIG_HOME/squad-mcp/agents` on Unix (falls back to `~/.config/squad-mcp/agents` if `XDG_CONFIG_HOME` is unset).

Per-file resolution: if the agent's `*.md` exists in the chosen local directory, it wins. Otherwise, the embedded default bundled in the package is used.

Override files are loaded verbatim and rendered into the LLM's context with full agent authority — treat the directory as code (user-only writable, not on shared volumes, never sourced from untrusted input).

Since v0.4.0, the override directory is validated against an allowlist (`HOME`, `APPDATA`, `LOCALAPPDATA`, `XDG_CONFIG_HOME`, `process.cwd()`); paths outside the allowlist are rejected with `OVERRIDE_REJECTED`. Set `SQUAD_AGENTS_ALLOW_UNSAFE=1` to bypass for unusual setups (logs a warn banner). See [INSTALL.md](INSTALL.md#local-override-of-agent-definitions) for the full security guidance.

Run the `init_local_config` tool once to seed the local directory with editable defaults.

## Repo layout

```text
squad-mcp/
├── .claude-plugin/             # Claude Code plugin manifest + marketplace
├── .github/workflows/          # CI + release workflows
├── agents/                     # Native subagents (one .md per subagent, kebab-case + frontmatter)
├── shared/                     # Severity matrix + skill specs (resources, not subagents — kept outside agents/ for the plugin manifest validator)
├── commands/                   # Slash commands (/squad:implement, /squad:review, /brainstorm, /commit-suggest)
├── skills/                     # Bundled skills
│   ├── squad/                  # single skill, two modes (implement | review)
│   ├── brainstorm/
│   └── commit-suggest/
├── src/
│   ├── index.ts                # stdio entry
│   ├── tools/                  # MCP tools (23 deterministic functions)
│   ├── resources/              # MCP resources + agent loader
│   ├── prompts/                # MCP prompt templates
│   ├── exec/git.ts             # hardened git execution layer
│   ├── observability/logger.ts # structured stderr JSON logs
│   ├── util/path-safety.ts     # path-traversal-safe resolution
│   └── config/
│       └── ownership-matrix.ts # agents, work types, content/path patterns
├── tests/                      # vitest unit + integration + stdio smoke
├── tools/
│   └── git-hooks/commit-msg    # opt-in hook rejecting AI-attribution trailers
└── dist/                       # compiled JS (gitignored, shipped via npm)
```

## Tests

```bash
npm test                # vitest (unit + integration)
node tests/smoke.mjs    # stdio JSON-RPC smoke test (requires npm run build first)
```

## Versioning + release

This project follows [SemVer](https://semver.org/). Releases are tagged `vX.Y.Z` on `main`, which triggers the `.github/workflows/release.yml` workflow to publish `@gempack/squad-mcp@X.Y.Z` to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements). See [CHANGELOG.md](CHANGELOG.md) for the version history.

## Contributing

Issues and PRs welcome at <https://github.com/ggemba/squad-mcp>. Run `npm test && npm run build` before opening a PR. CI runs on Linux + Windows on Node 20 and 22.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution and third-party dependencies.
