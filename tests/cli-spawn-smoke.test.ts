import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Process-level smoke test for the `tools/*.mjs` CLIs. Replaces the deleted
 * `tests/cli-smoke.test.ts` incident-class guard. Guards two documented v1.4.2
 * incidents (see CHANGELOG.md):
 *
 *   (a) `tools/<file>.mjs` crashed with `path.isAbsolute(null)` when run
 *       without `--file` — the form documented in INSTALL.md and README.md.
 *   (b) `tools/post-review.mjs` imported `dist/format/pr-review.js` /
 *       `dist/format/sarif.js` which the single-bundle esbuild never emitted,
 *       so the CLI failed at module load.
 *
 * This test spawns each CLI with `--help` (a no-side-effect invocation) and
 * asserts the process did not crash with a module-load or syntax error. A
 * CLI is free to exit 0 ("help-handled"), 1 ("help-handled-with-error" —
 * many CLIs print help to stderr and exit non-zero), or 2 ("invalid-input").
 * Anything else, a signal termination, or a stderr line containing
 * `Cannot find module` / `SyntaxError` / `ReferenceError` / `is not defined`
 * / `TypeError` is treated as a crash.
 *
 * If a CLI file does not exist (renamed in a later refactor), the row is
 * skipped with a console.warn — the test surface should not fail purely
 * because the inventory list moved.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const CLI_FILES = [
  "list-tasks.mjs",
  "next-task.mjs",
  "record-tasks.mjs",
  "update-task-status.mjs",
  "record-learning.mjs",
  "post-review.mjs",
];

interface SpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runCli(relPath: string, args: string[], timeoutMs = 10_000): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [relPath, ...args], {
      cwd: REPO_ROOT,
      timeout: timeoutMs,
      // Inherit nothing on stdin so the CLI sees an immediate EOF on a pipe-read.
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ exitCode: code, signal, stdout, stderr });
    });
  });
}

const CRASH_PATTERNS = [
  /Cannot find module/,
  /SyntaxError/,
  /ReferenceError/,
  /is not defined/,
  /TypeError/,
];

// Filter the CLI list to only those files that exist; warn (don't fail) on
// missing files so a future rename doesn't break this guard.
const presentClis = CLI_FILES.filter((file) => {
  const abs = path.join(REPO_ROOT, "tools", file);
  const exists = existsSync(abs);
  if (!exists) {
     
    console.warn(`[cli-spawn-smoke] tools/${file} not found — skipping (was it renamed?)`);
  }
  return exists;
});

describe("tools/*.mjs CLIs — incident-class smoke (v1.4.2 regression guard)", () => {
  it.each(presentClis)(
    "tools/%s --help does not crash with a module-load / syntax / reference error",
    async (file) => {
      const result = await runCli(`tools/${file}`, ["--help"]);

      // No signal termination (SIGABRT / SIGSEGV / SIGKILL etc).
      expect(result.signal).toBeNull();

      // Exit code must be in the allowed set: 0 (ok), 1 (help-with-nonzero),
      // 2 (invalid-input). Anything outside that — including `null` (no exit
      // recorded) — is treated as a crash.
      expect(result.exitCode).not.toBeNull();
      expect([0, 1, 2]).toContain(result.exitCode);

      // The crash patterns must not appear in stderr.
      for (const pattern of CRASH_PATTERNS) {
        expect(
          pattern.test(result.stderr),
          `tools/${file} stderr matched crash pattern ${pattern}:\n${result.stderr}`,
        ).toBe(false);
      }
    },
  );

  it.each(presentClis)(
    "tools/%s with NO args does not crash with the v1.4.2 path.isAbsolute(null) class of error",
    async (file) => {
      const result = await runCli(`tools/${file}`, []);

      // Same envelope — no signal kill, exit in the allowed set, no crash
      // patterns. CLIs that need stdin (post-review.mjs reads consolidator
      // JSON on stdin) get an immediate EOF on the closed pipe; they may
      // exit 1 or 2 with a clear "no input" message — both are fine.
      expect(result.signal).toBeNull();
      expect(result.exitCode).not.toBeNull();
      expect([0, 1, 2]).toContain(result.exitCode);

      for (const pattern of CRASH_PATTERNS) {
        expect(
          pattern.test(result.stderr),
          `tools/${file} (no args) stderr matched crash pattern ${pattern}:\n${result.stderr}`,
        ).toBe(false);
      }
    },
  );
});
