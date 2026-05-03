# squad-mcp

[![npm version](https://img.shields.io/npm/v/@gempack/squad-mcp.svg)](https://www.npmjs.com/package/@gempack/squad-mcp)
[![ci](https://github.com/ggemba/squad-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ggemba/squad-mcp/actions/workflows/ci.yml)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

MCP server that exposes the `squad-dev` workflow as deterministic tools, prompts, and resources. It classifies a task, scores its risk, picks an advisory squad of specialist reviewers, slices the changed files per agent, validates the plan, and consolidates the advisory verdicts. The host LLM (Claude Code, Cursor, Warp, Claude Desktop, …) orchestrates; `squad-mcp` provides the building blocks.

It also ships as a Claude Code plugin that bundles the MCP server, four slash commands (`/squad`, `/squad-review`, `/brainstorm`, `/commit-suggest`), and the matching skills behind a single `/plugin install`.

## Install

### Claude Code plugin (recommended)

```text
/plugin marketplace add ggemba/squad-mcp
/plugin install squad@gempack
```

The plugin bundles the MCP server plus four slash commands and skills (`/squad`, `/squad-review`, `/brainstorm`, `/commit-suggest`). After install, restart Claude Code to pick up the new commands and the `squad` MCP server.

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

## What it provides

### Tools (deterministic, pure functions)

| Tool | Purpose |
|------|---------|
| `detect_changed_files` | Hardened `git diff --name-status --no-renames` for a workspace. Allowlisted refs, 10s timeout, 1MB stdout cap. |
| `classify_work_type` | Heuristic `WorkType` from prompt + paths (`Feature` / `Bug Fix` / `Refactor` / `Performance` / `Security` / `Business Rule`) with Low/Medium/High confidence. |
| `score_risk` | Compute Low/Medium/High from boolean signals (auth, money, migration, files_count, new_module, api_change). |
| `select_squad` | Select advisory agents for a work type. Combines matrix + path hints + content sniff. Returns evidence per file. |
| `slice_files_for_agent` | Filter a file list to those owned by a single agent. Used to build sliced advisory prompts. |
| `validate_plan_text` | Advisory check for inviolable-rule violations in a plan (commit/push fences, emojis in code blocks, non-English identifiers, impl-before-approval). |
| `compose_squad_workflow` | One-call pipeline: `detect_changed_files` → `classify_work_type` → `score_risk` → `select_squad`. |
| `compose_advisory_bundle` | One-call full bundle: `compose_squad_workflow` + `slice_files_for_agent` per selected agent + `validate_plan_text`. |
| `apply_consolidation_rules` | Aggregate advisory reports → final verdict (APPROVED / CHANGES_REQUIRED / REJECTED). |
| `list_agents` | List configured agents with role, ownership, naming conventions. |
| `get_agent_definition` | Return the full markdown system prompt for an agent (local override → embedded default). |
| `init_local_config` | Copy embedded defaults to the local override directory so they can be edited. |

### Prompts

- `squad_orchestration` — full Phase 0–12 orchestration guide.
- `agent_advisory` — sliced prompt for one advisory agent.
- `consolidator` — final verdict prompt for TechLead-Consolidator.

### Resources

- `agent://po`, `agent://tech-lead-planner`, `agent://tech-lead-consolidator`, `agent://senior-architect`, `agent://senior-dba`, `agent://senior-developer`, `agent://senior-dev-reviewer`, `agent://senior-dev-security`, `agent://senior-qa`.
- `severity://_severity-and-ownership` — severity matrix + ownership rules.
- `severity://skill-squad-dev`, `severity://skill-squad-review` — full skill specs.

### Bundled skills

The plugin auto-registers these skills via `skills/` (or sync them to `~/.claude/skills/` for non-plugin clients with `node tools/sync-agents.mjs`):

| Skill | Trigger | Purpose |
|-------|---------|---------|
| `/squad` | implementation workflow | Builds an approved plan, distributes work to specialist agents in parallel, implements the change, consolidates via tech-lead. Optional `--codex` second-opinion. New `--quick` mode reduces to 1 specialist + tech-lead with terse prompts (mutually exclusive with `--codex`; auto-fallback to normal mode on security/data-layer scope). |
| `/squad-review` | multi-perspective review | Auto-detects affected domains, spawns specialist agents in parallel, scores on a weighted rubric (Code Quality 20%, Security 20%, Maintainability 20%, Performance 20%, Async/Concurrency 8%, Error Handling 7%, Architecture Fit 5%), tech-lead consolidates the verdict. New `--quick` mode for fast iteration. |
| `/brainstorm` | pre-implementation research | Web research in parallel + specialist agent perspectives → options matrix with cited sources and a recommendation. Produces no code. Position: `/brainstorm` decides what to build, `/squad` implements, `/squad-review` reviews. |
| `/commit-suggest` | commit message generator | Read-only suggester for Conventional Commits messages. Runs only an allowlist of git commands; never executes mutations; never adds AI co-author trailers. The user runs the commit themselves. |

Workflow positioning:

```
/brainstorm   ->  decide what to build
     v
/squad        ->  implement what was decided
     v
/squad-review ->  review what was implemented
     v
/commit-suggest -> craft the commit message
```

See [INSTALL.md](INSTALL.md#bundled-skills) for trigger examples and the optional `commit-msg` git hook + `permissions.deny` snippet that hard-enforce the read-only and no-AI-attribution invariants at the OS / Claude Code layer.

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
├── agents/                     # Bundled agent markdown defaults
├── commands/                   # Plugin slash commands (/squad, /squad-review, /brainstorm, /commit-suggest)
├── skills/                     # Bundled skills (commit-suggest, brainstorm)
├── src/
│   ├── index.ts                # stdio entry
│   ├── tools/                  # MCP tools (12 deterministic functions)
│   ├── resources/              # MCP resources + agent loader
│   ├── prompts/                # MCP prompt templates
│   ├── exec/git.ts             # hardened git execution layer
│   ├── observability/logger.ts # structured stderr JSON logs
│   ├── util/path-safety.ts     # path-traversal-safe resolution
│   └── config/
│       └── ownership-matrix.ts # agents, work types, content/path patterns
├── tests/                      # vitest unit + integration + stdio smoke
├── tools/
│   ├── sync-agents.mjs         # mirror agents + skills into ~/.claude/ for non-plugin clients
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
