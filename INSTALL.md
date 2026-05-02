# Installation guide

This guide walks through installing `squad-mcp` in every supported host: Claude Code (as a plugin), and any other MCP-capable client (Claude Desktop, Cursor, Warp, Continue, etc.) via the npm package.

After install you get:

- 12 deterministic MCP tools (Claude Code exposes them as `mcp__squad__*`; other hosts may use a different prefix)
- 12 MCP resources (`agent://*`, `severity://*`)
- 3 MCP prompts (`squad_orchestration`, `agent_advisory`, `consolidator`)
- 2 slash commands (`/squad`, `/squad-review`) — Claude Code only

## Prerequisites

- Node.js 20+ on `PATH`. Both the npm path and the Claude Code plugin path shell out to `node` (the plugin manifest runs `node ${CLAUDE_PLUGIN_ROOT}/dist/index.js`); CI tests on Node 20 and 22.
- A host that speaks MCP (Claude Code, Claude Desktop, Cursor, Warp, Continue, …)
- Git available on `PATH` (used by `detect_changed_files`)

Verify Node:

```bash
node --version   # v20+
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

3. **Restart Claude Code** (close and reopen). The slash-command registry is populated at startup, so the new `/squad` and `/squad-review` commands and the `squad` MCP server only become available after a restart.

4. **Verify the install.** In a fresh prompt:

   - Type `/squad ` (with the trailing space) — the autocomplete should suggest `/squad <task description>`.
   - Type `/squad-review` — same check.
   - Open Settings → MCP. You should see `squad` listed and connected.
   - Ask Claude to call the `list_agents` tool from the `squad` MCP server. It should return 9 agents (`po`, `tech-lead-planner`, `tech-lead-consolidator`, `senior-architect`, `senior-dba`, `senior-developer`, `senior-dev-reviewer`, `senior-dev-security`, `senior-qa`).

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

### Version pinning and provenance

The default `npx -y @gempack/squad-mcp` resolves to the latest published version on every host launch. To pin a specific version, append `@<version>`:

```bash
npx -y @gempack/squad-mcp@0.4.0
```

Releases are published from CI with [npm provenance](https://docs.npmjs.com/generating-provenance-statements). Verify the published tarball before configuring a host:

```bash
npm audit signatures @gempack/squad-mcp
```

Pin in your host config the same way (e.g. `args: ["-y", "@gempack/squad-mcp@0.4.0"]`).

> **Note:** the per-host examples below use the unpinned default (`@gempack/squad-mcp`) for readability. For production setups, replace `@gempack/squad-mcp` with `@gempack/squad-mcp@<version>` in every host's `args` array.

### Smoke test

Verify the binary downloads and runs:

```bash
npx -y @gempack/squad-mcp
```

The server starts on stdio and waits silently for JSON-RPC on stdin (Ctrl+C to exit). Any error during `npx` resolution prints to stderr.

### Claude Desktop

Edit the config file:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json` (unofficial — not all Claude Desktop builds support Linux)

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
- **Args:** `["-y", "@gempack/squad-mcp"]`. If your Warp build's UI takes a single space-separated string instead, enter `-y @gempack/squad-mcp`.

Save. The server status should turn green.

### Continue (VS Code / JetBrains)

In `~/.continue/config.json` (or the workspace equivalent):

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

Reload the Continue extension.

> Older Continue releases (pre-1.x) used `experimental.modelContextProtocolServers` with a `transport` envelope. If your build does not pick up the `mcpServers` key, check the [Continue MCP docs](https://docs.continue.dev/customize/deep-dives/mcp) for the schema your version expects.

### Any other MCP client

Same shape. The server is a stdio MCP server. Command + args:

```text
command: npx
args:    -y @gempack/squad-mcp
```

Most hosts accept either a JSON config block or a UI form with these two fields.

### Faster startup / offline / corporate-proxy setups

Install once globally and reference the binary by name (avoids the per-launch `npx` resolution):

```bash
npm install -g @gempack/squad-mcp
```

Then in any host config, replace `command: npx` + `args: ["-y", "@gempack/squad-mcp"]` with:

```json
{
  "command": "squad-mcp",
  "args": []
}
```

This also works behind a registry proxy that rejects on-the-fly `npx` lookups.

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

The bundled agent markdowns can be overridden without forking. The loader picks ONE local override directory:

- If `SQUAD_AGENTS_DIR` is set, that path is used **exclusively** (the platform default is not consulted).
- Otherwise: `%APPDATA%\squad-mcp\agents` on Windows, `$XDG_CONFIG_HOME/squad-mcp/agents` on Unix (falls back to `~/.config/squad-mcp/agents` if `XDG_CONFIG_HOME` is unset).

Per-file resolution: if the agent's `*.md` exists in the chosen local directory, it wins. Otherwise, the embedded default bundled in the package is used.

**Security: override files are agent system prompts.** Files in the local override directory are loaded verbatim and rendered into the LLM's context with full agent authority. Treat the directory as code:

- It must be writable only by the running user.
- Never place it on a shared volume, network mount, or world-writable path.
- `SQUAD_AGENTS_DIR` must never be set from untrusted input (env files, CI variables sourced from PRs, etc.).

### Allowlist (since v0.4.0)

The override directory is validated at load time. It must resolve (after symlink realpath) inside one of these user-controlled prefixes:

- `os.homedir()` — your home directory
- `APPDATA` and `LOCALAPPDATA` (Windows)
- `XDG_CONFIG_HOME` or `~/.config` (Unix)
- `process.cwd()` — the host's working directory at launch

UNC paths (`\\server\share\…`) and device-namespace paths (`\\?\…`, `\\.\…`) on Windows are rejected before any filesystem access. Per-file symlinks that escape the override directory silently fall back to the embedded default for that file.

If the validation fails, the MCP server throws `OVERRIDE_REJECTED` on the first tool call that resolves an agent. The host shows the structured error so the misconfiguration surfaces immediately rather than degrading silently.

### Escape hatch: SQUAD_AGENTS_ALLOW_UNSAFE

For power users on unusual paths (NixOS, custom CI runners, `/opt/…`), set `SQUAD_AGENTS_ALLOW_UNSAFE=1` in the environment that launches the MCP host. This bypasses the allowlist while still rejecting malformed input (NUL bytes, ADS markers, tilde-prefixed paths). Every load logs a warn-level banner so the decision stays auditable.

### Filesystem permissions (since v0.4.0)

`init_local_config` creates the override directory and copied agent files with restrictive permissions:

- **Unix:** directory is `chmod 0o700` (user-only rwx) and each agent file is `chmod 0o600` (user-only rw). The explicit `chmod` overrides any permissive `umask`.
- **Windows:** `%APPDATA%` typically inherits a user-only DACL on stand-alone profiles, and the loader does not verify Windows ACLs at runtime. On managed, domain-joined, or VDI machines the inherited DACL may be broader; verify with `icacls "$env:APPDATA\squad-mcp\agents"` if the host is multi-user. For custom `SQUAD_AGENTS_DIR` paths outside `APPDATA`, the directory inherits the parent's DACL — set the ACL explicitly before pointing the env var there.

`agent-loader` checks the resolved override directory at startup and emits a `warn`-level log once per process if it is world-writable (`mode & 0o002 !== 0` on Unix). To remediate:

```bash
chmod 700 "$SQUAD_AGENTS_DIR"
chmod 600 "$SQUAD_AGENTS_DIR"/*.md
```

The warning does not block the override — it is advisory. Override files are still loaded and used.

Seed the local directory with editable copies:

```text
Call the `init_local_config` MCP tool from your host.
```

Then edit any `*.md` in that directory. Restart the host (or reconnect the MCP server) to pick up changes.

## Verification checklist

After install, regardless of host:

- [ ] `squad` MCP server shows as connected in the host's MCP settings.
- [ ] `list_agents` tool returns 9 agents.
- [ ] `compose_squad_workflow` with arguments `{"workspace_root": ".", "user_prompt": "smoke"}` returns `work_type`, `risk`, `squad.agents`. Requires a git repo with at least one prior commit (the tool defaults `base_ref` to `HEAD~1` internally).
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
- Claude Desktop: `%APPDATA%\Claude\logs\mcp-server-squad.log` (Windows), `~/Library/Logs/Claude/mcp-server-squad.log` (macOS), `~/.config/Claude/logs/mcp-server-squad.log` (Linux — note that Claude Desktop on Linux is unofficial; verify your build).

The log can include workspace file paths and `git diff` output. Review and redact before sharing for support.

Common causes: Node not on `PATH`, corporate proxy blocking npm, or `npx` cache permission errors. Run `npx -y @gempack/squad-mcp` in a terminal to surface the real error.

**`detect_changed_files` returns an error.**
The tool runs `git diff --name-status --no-renames` (renames are reported as add+delete pairs) and is hardened: 10s timeout, 1MB stdout cap, allowlisted subcommands only. Verify `git --version` works and the workspace is a git repo. Refs must satisfy: matches `^[a-zA-Z0-9_/][a-zA-Z0-9_./-]*$`, max 200 chars, no leading `-`, no trailing `.`, must not contain `..`, `@{`, or `.lock`.

**Tools work but the agents look wrong.**
You probably have a stale local override. If `SQUAD_AGENTS_DIR` is set, only that directory is consulted; otherwise check `%APPDATA%\squad-mcp\agents` (Windows) or `$XDG_CONFIG_HOME/squad-mcp/agents` / `~/.config/squad-mcp/agents` (Unix). Delete or edit the file — the loader prefers the local copy over the bundled defaults.

**Tools missing on Cursor / Warp after editing JSON.**
Both hosts cache the MCP server list. Fully quit and relaunch (not just reload window).

## Where to file issues

<https://github.com/ggemba/squad-mcp/issues> — include host name + version, OS, Node version, and the relevant log excerpt.
