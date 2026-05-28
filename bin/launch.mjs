#!/usr/bin/env node
// First-run builder + MCP server entrypoint.
//
// Background: Claude Code installs plugins via `git clone` (no `npm install`
// at all in practice — empirically verified across v1.7.1/1.7.2/1.7.3/1.7.4
// releases on Windows; the cache directory under
// `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` ships with
// source + bin + skills + agents but no `node_modules/` and no `dist/`).
// Our build needs devDeps (esbuild, typescript) AND a built `dist/index.js`.
// The MCP host then tries to spawn `node .../bin/launch.mjs`, this wrapper
// fires up and finds neither — until v1.7.5 it died with `'tsc' is not
// recognized` and the plugin failed to start, forcing the user to do
// `npm install + npm run build` by hand inside the cache after every release.
//
// This wrapper bridges the gap on first run:
//   1. If `node_modules/` is missing → `npm install --no-audit --no-fund`.
//   2. If `dist/index.js` is missing → `npm run build`.
//   3. Dynamically import the bundled server. The src/index.ts module has
//      top-level await that connects the stdio transport on import, so a
//      plain `await import(...)` brings the server up — no extra child
//      spawn, no second Node startup cost.
//
// Both bootstrap steps run ONCE per cache version (the artifacts persist).
// Subsequent boots skip directly to step 3.
//
// Stdio discipline: the MCP wire protocol owns stdout. Every byte of
// install/build output is routed to stderr (fd 2) so it can't corrupt a
// JSON-RPC frame.

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = resolve(root, "dist/index.js");
const nodeModules = resolve(root, "node_modules");

// Step 1: ensure devDeps are installed. The `prepare` script that would
// normally do this never fires when Claude Code uses `git clone` without
// a follow-up `npm install`, so we do it explicitly here on first run.
if (!existsSync(nodeModules)) {
  process.stderr.write("[squad-mcp] First run: installing dependencies (one-time, ~30-45s)...\n");
  try {
    execSync("npm install --no-audit --no-fund --loglevel=error", {
      cwd: root,
      stdio: ["ignore", 2, 2],
    });
  } catch (err) {
    process.stderr.write(
      `[squad-mcp] npm install failed (exit ${err.status ?? "?"}).\n` +
        "[squad-mcp] Try running it manually: cd " +
        root +
        " && npm install\n",
    );
    process.exit(err.status ?? 1);
  }
  if (!existsSync(nodeModules)) {
    process.stderr.write(
      "[squad-mcp] npm install reported success but node_modules/ is still missing.\n" +
        `[squad-mcp] Looked at: ${nodeModules}\n`,
    );
    process.exit(1);
  }
}

// Step 2: ensure dist/ is built. Same one-time bootstrap pattern as Step 1.
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
        "[squad-mcp] Required devDeps: esbuild, typescript. If install completed " +
        "but build still fails, try running it manually: cd " +
        root +
        " && npm run build\n",
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
