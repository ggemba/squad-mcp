// Cross-platform `prepare` runner.
// npm `prepare` fires after `npm install` from a git checkout, and before
// `npm publish`. We need it to do two conditional things:
//   1. set up husky git hooks if husky is installed (skips on --production)
//   2. build dist/ if both esbuild and typescript are present
//
// Doing this in a shell one-liner with `[ -d ... ] && ...` breaks on
// Windows runners where npm dispatches scripts through cmd.exe rather than
// sh (cmd.exe has no POSIX test built-in). This script papers over that.

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

const has = (p) => existsSync(p);

function run(cmd, label) {
  try {
    execSync(cmd, { stdio: "inherit" });
  } catch (e) {
    console.error(`prepare: ${label} failed (exit ${e.status ?? "?"})`);
    process.exit(e.status ?? 1);
  }
}

// Husky hooks — non-fatal if it errors (e.g. not a git checkout).
if (has("node_modules/husky")) {
  try {
    execSync("husky", { stdio: "inherit" });
  } catch (e) {
    console.error(`prepare: husky setup skipped (${e.message})`);
  }
}

// Build — fatal if it fails (we don't want a half-built install).
if (has("node_modules/esbuild") && has("node_modules/typescript")) {
  run("npm run build", "build");
} else {
  console.log(
    "prepare: skipping build (devDeps absent — relying on prepublishOnly or shipped dist/)",
  );
}
