# squad-mcp

MCP server that exposes the squad-dev workflow (task classification, risk scoring, agent selection, advisory orchestration) as MCP tools, prompts, and resources. Host LLMs (Claude Code, Warp, Cursor, Claude Desktop) consume the building blocks; the orchestration is left to the host.

## What it provides

### Tools (deterministic)

| Tool | Purpose |
|------|---------|
| `score_risk` | Compute Low/Medium/High from boolean signals (auth, money, migration, files_count, new_module, api_change). |
| `select_squad` | Select advisory agents for a work type. Combines matrix + path hints + content sniff. Returns evidence per file. |
| `slice_files_for_agent` | Filter a file list to those owned by a single agent. Used to build sliced advisory prompts. |
| `list_agents` | List configured agents with role, ownership, naming conventions. |
| `get_agent_definition` | Return the full markdown system prompt for an agent (local override → embedded default). |
| `init_local_config` | Copy embedded defaults to the local override directory so they can be edited. |
| `apply_consolidation_rules` | Aggregate advisory reports → verdict (APPROVED / CHANGES_REQUIRED / REJECTED). |

### Prompts

- `squad_orchestration` — full Phase 0–12 flow guide.
- `agent_advisory` — sliced prompt for one advisory agent.
- `consolidator` — final verdict prompt for TechLead-Consolidator.

### Resources

- `agent://<name>` for each of the 9 agents.
- `severity://_severity-and-ownership`, `severity://skill-squad-dev`, `severity://skill-squad-review`.

## Local override

Agent markdown is loaded with this priority:

1. `$SQUAD_AGENTS_DIR` (env var, if set)
2. `%APPDATA%\squad-mcp\agents` (Windows) / `$XDG_CONFIG_HOME/squad-mcp/agents` (Unix)
3. Embedded defaults (bundled in this package)

Run the `init_local_config` tool once to seed the local directory with defaults you can edit.

## Detection strategy (select_squad / slice_files_for_agent)

Three layers, in order of strength:

1. **Content sniff** — reads the first 16KB of each file, matches token regexes (e.g. `class : DbContext`, `[ApiController]`, `services.AddScoped<>`, `[Fact]`). Strong signal, name-agnostic.
2. **Path hint** — file path regex (e.g. `*Repository.cs`, `Migrations/`, `Controller.cs`). Cheap, complementary.
3. **Conventions in agents** — each agent flags non-conformant naming as a finding so future detections improve over time.

Output of `select_squad` includes per-file `evidence` with confidence and `low_confidence_files` for unclassified files. Override via the `force_agents` parameter or by editing local agent definitions.

## Install

```bash
npm install
npm run build
```

## Run

```bash
node dist/index.js
```

stdio transport — designed to be spawned by an MCP-aware client.

## Client configs

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "squad": {
      "command": "node",
      "args": ["C:/Users/Gustavo/OneDrive/Pessoal/Projetos/squad-mcp/dist/index.js"],
      "env": {
        "SQUAD_AGENTS_DIR": "C:/Users/Gustavo/AppData/Roaming/squad-mcp/agents"
      }
    }
  }
}
```

### Warp

In Warp settings → MCP servers, add a server with command `node` and arg pointing at `dist/index.js`.

### Cursor

`.cursor/mcp.json` (workspace) or global Cursor settings:

```json
{
  "mcpServers": {
    "squad": {
      "command": "node",
      "args": ["C:/Users/Gustavo/OneDrive/Pessoal/Projetos/squad-mcp/dist/index.js"]
    }
  }
}
```

## Tests

```bash
npm test          # unit tests (vitest)
node tests/smoke.mjs   # stdio JSON-RPC smoke test (requires npm run build first)
```

## Repo layout

```
squad-mcp/
├── src/
│   ├── index.ts              # stdio entry
│   ├── tools/                # MCP tools
│   ├── resources/            # MCP resources + agent loader
│   ├── prompts/              # MCP prompt templates
│   └── config/
│       └── ownership-matrix.ts   # agents, work types, content/path patterns
├── agents/                   # bundled defaults (copied from C:\ObsGustavo\AI-Agents)
├── tests/                    # vitest + stdio smoke
└── dist/                     # compiled JS (gitignored, published)
```

## Status

Phase 1–5 complete. Skill `/squad` and `/squad-review` continue to work in parallel; they will be retired after the MCP is exercised in real workflows.
