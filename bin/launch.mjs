#!/usr/bin/env node
// First-run builder + MCP server entrypoint.
//
// Background: Claude Code installs plugins via `git clone + npm install
// --ignore-scripts`. The --ignore-scripts flag is a sensible defence against
// malicious postinstall scripts in transitive deps, but it also means our own
// `prepare` script never fires. devDeps are installed (esbuild, typescript are
// on disk) but dist/index.js — the actual MCP server entrypoint — never gets
// built. The MCP host then tries to spawn `node .../dist/index.js`, that path
// doesn't exist, and the plugin fails to start.
//
// This wrapper bridges the gap: if dist/ is missing it builds once, then
// dynamically imports the bundled server in-process. The src/index.ts module
// has top-level await that connects the stdio transport on import, so a plain
// `await import(...)` is enough to bring the server up — no extra child spawn,
// no second Node startup cost.
//
// Stdio discipline: the MCP wire protocol owns stdout. Every byte of build
// output below is routed to stderr (fd 2) so it can't corrupt a JSON-RPC
// frame.

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = resolve(root, "dist/index.js");

if (!existsSync(dist)) {
  process.stderr.write("[squad-mcp] First run: building dist/ (one-time, ~3-5s)...\n");
  try {
    execSync("npm run build", {
      cwd: root,
      // Route child stdout AND stderr to our stderr — both fds map to 2.
      // Keeps stdout pure for the MCP host that will own it after import.
      stdio: ["ignore", 2, 2],
    });
  } catch (err) {
    process.stderr.write(
      `[squad-mcp] Build failed (exit ${err.status ?? "?"}).\n` +
        "[squad-mcp] Required devDeps: esbuild, typescript. If you installed " +
        "this package with --omit=dev or --production, reinstall without.\n",
    );
    process.exit(err.status ?? 1);
  }
  if (!existsSync(dist)) {
    process.stderr.write(
      "[squad-mcp] Build reported success but dist/index.js is still missing.\n" +
        `[squad-mcp] Looked at: ${dist}\n`,
    );
    process.exit(1);
  }
}

// dist/index.js does its own top-level await transport.connect() — importing
// it is enough to start the server. No second Node process needed.
await import(pathToFileURL(dist).href);
