# Installation guide

This guide walks through installing `squad-mcp` in every supported host: Claude Code (as a plugin), and any other MCP-capable client (Claude Desktop, Cursor, Warp, Continue, etc.) via the npm package.

After install you get:

- 12 deterministic MCP tools (`mcp__squad__*`)
- 12 MCP resources (`agent://*`, `severity://*`)
- 3 MCP prompts (`squad_orchestration`, `agent_advisory`, `consolidator`)
- 2 slash commands (`/squad`, `/squad-review`) — Claude Code only

## Prerequisites

- Node.js 20 or 22 (only required for the npm path; the Claude Code plugin pulls Node from your existing install)
- A host that speaks MCP (Claude Code, Claude Desktop, Cursor, Warp, Continue, …)
- Git available on `PATH` (used by `detect_changed_files`)

Verify Node:

```bash
node --version   # v20.x or v22.x
```

## Path A — Claude Code plugin (recommended)

The plugin bundles the MCP server, the slash commands, and the agent definitions behind a single install. No JSON config to edit.

1. **Add the marketplace.** In a Claude Code session, paste:

   ```text
   /plugin marketplace add ggemba/squad-mcp
   ```

   Wait for `marketplace added`.

2. **Install the plugin.**

   ```text
   /plugin install squad@gempack
   ```

   Wait for `plugin installed`.

3. **Restart Claude Code** (close and reopen, or run `/plugin reload`). This is required so the new slash commands and the `squad` MCP server are picked up.

4. **Verify the install.** In a fresh prompt:

   - Type `/squad ` (with the trailing space) — the autocomplete should suggest `/squad <task description>`.
   - Type `/squad-review` — same check.
   - Open Settings → MCP. You should see `squad` listed and connected.
   - Ask Claude to call the `list_agents` tool from the `squad` MCP server. It should return 9 agents (PO, tech-lead-planner, tech-lead-consolidator, senior-architect, senior-dba, senior-developer, senior-dev-reviewer, senior-dev-security, senior-qa).

5. **Use it.**

   ```text
   /squad add a /health endpoint that returns build SHA and uptime
   /squad-review
   /squad-review 1234        # PR number
   /squad-review feature/x   # branch
   ```

   `/squad` runs the full Phase 0–12 orchestration (classify → score risk → pick agents → plan → Gate 1 → advisory squad → Gate 2 → implement → consolidate). `/squad-review` is review-only — it never implements, commits, or pushes.

### Updating the plugin

```text
/plugin update squad@gempack
```

Then restart Claude Code.

### Uninstalling

```text
/plugin uninstall squad@gempack
/plugin marketplace remove gempack
```

## Path B — npm package (any MCP client)

Use this path for hosts that don't have a plugin marketplace (Claude Desktop, Cursor, Warp, Continue, etc.) or when you want the MCP server only without the slash commands.

The package is published as [`@gempack/squad-mcp`](https://www.npmjs.com/package/@gempack/squad-mcp). You don't need to install it globally — `npx` will fetch and cache it on first run.

Smoke-test the binary:

```bash
npx -y @gempack/squad-mcp --help
```

It speaks MCP over stdio, so it will sit waiting for JSON-RPC. Ctrl+C to exit.

### Claude Desktop

Edit the config file:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

Add (or merge) the `squad` entry:

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

Restart Claude Desktop. In a chat, the MCP indicator (hammer icon) should show the `squad` server with its tools.

### Cursor

Workspace-scoped: create `.cursor/mcp.json` in the repo root.
Global: open Cursor Settings → MCP and add the same JSON.

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

Reload Cursor. The `squad` server appears under Settings → MCP. Tools become callable from chat.

### Warp

Settings → MCP servers → Add server.

- **Name:** `squad`
- **Command:** `npx`
- **Args:** `-y @gempack/squad-mcp`

Save. The server status should turn green.

### Continue (VS Code / JetBrains)

In `~/.continue/config.json` (or the workspace equivalent):

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@gempack/squad-mcp"]
        }
      }
    ]
  }
}
```

Reload the Continue extension.

### Any other MCP client

Same shape. The server is a stdio MCP server. Command + args:

```text
command: npx
args:    -y @gempack/squad-mcp
```

Most hosts accept either a JSON config block or a UI form with these two fields.

## Path C — From source (development)

```bash
git clone https://github.com/ggemba/squad-mcp.git
cd squad-mcp
npm install
npm run build
node dist/index.js   # speaks MCP over stdio
```

To point a host at your local build, replace `command: npx, args: -y @gempack/squad-mcp` with:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/squad-mcp/dist/index.js"]
}
```

## Local override of agent definitions

The bundled agent markdowns can be overridden without forking. The loader resolves in this order:

1. `$SQUAD_AGENTS_DIR` — env var, if set
2. `%APPDATA%\squad-mcp\agents` (Windows) / `$XDG_CONFIG_HOME/squad-mcp/agents` (Unix)
3. Embedded defaults bundled in the package

Seed the local directory with editable copies:

```text
Call the `init_local_config` MCP tool from your host.
```

Then edit any `*.md` in that directory. Restart the host (or reconnect the MCP server) to pick up changes.

## Verification checklist

After install, regardless of host:

- [ ] `squad` MCP server shows as connected in the host's MCP settings.
- [ ] `list_agents` tool returns 9 agents.
- [ ] `compose_squad_workflow` runs against a real workspace and returns `work_type`, `risk`, `squad.agents`.
- [ ] Resources `agent://senior-architect` and `severity://_severity-and-ownership` are readable.
- [ ] (Claude Code only) `/squad` and `/squad-review` autocomplete.

## Troubleshooting

**`/plugin marketplace add` fails with "not found".**
Make sure you typed `ggemba/squad-mcp` exactly. The marketplace manifest lives at `.claude-plugin/marketplace.json` on the `main` branch of that repo.

**Plugin installed but `/squad` does not appear.**
Restart Claude Code. The slash command registry is populated at startup. If still missing, run `/plugin list` and confirm `squad@gempack` is listed and enabled.

**MCP server shows as failed / disconnected.**
Check the host's MCP log:

- Claude Code: Help → Show Logs → MCP.
- Claude Desktop: `%APPDATA%\Claude\logs\mcp-server-squad.log` (Windows) or `~/Library/Logs/Claude/mcp-server-squad.log` (macOS).

Common causes: Node not on `PATH`, corporate proxy blocking npm, or `npx` cache permission errors. Run `npx -y @gempack/squad-mcp` in a terminal to surface the real error.

**`detect_changed_files` returns an error.**
The tool runs `git diff --name-status` and is hardened (allowlisted refs, 10s timeout, 1MB stdout cap). Verify `git --version` works and the workspace is a git repo. Refs must match `^[A-Za-z0-9._/-]+$`.

**Tools work but the agents look wrong.**
You probably have a stale local override at `%APPDATA%\squad-mcp\agents`. Delete it (or edit it) — the loader prefers the local copy over the bundled defaults.

**Tools missing on Cursor / Warp after editing JSON.**
Both hosts cache the MCP server list. Fully quit and relaunch (not just reload window).

## Where to file issues

<https://github.com/ggemba/squad-mcp/issues> — include host name + version, OS, Node version, and the relevant log excerpt.
