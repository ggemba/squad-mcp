import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The drift checker (scripts/check-skill-drift.mjs) spawns the built server
 * and compares its registered tool names against SKILL.md Phase 0's bulleted
 * list. This test pins the in-sync invariant: after the Phase 0 list has been
 * reconciled, running the checker against the current repo must exit 0.
 *
 * The checker needs dist/index.js; we build once in beforeAll so the test is
 * self-contained and does not depend on test ordering or a prior CI step.
 */
const ROOT = path.resolve(__dirname, "..");
const CHECKER = path.join(ROOT, "scripts", "check-skill-drift.mjs");

describe("skill-drift checker", () => {
  beforeAll(() => {
    // NOTE: the `existsSync` build guard is non-atomic — on a clean local run
    // with parallel test files, two suites could both see dist/ missing and
    // race two `npm run build` invocations. In CI dist/ already exists from
    // the build step, so this guard is never hit there.
    if (!existsSync(path.join(ROOT, "dist", "index.js"))) {
      const build = spawnSync("npm", ["run", "build"], {
        cwd: ROOT,
        encoding: "utf8",
        shell: process.platform === "win32",
      });
      expect(build.status, build.stderr).toBe(0);
    }
  }, 120_000);

  it("exits 0 — SKILL.md Phase 0 is in sync with the registry", () => {
    const result = spawnSync("node", [CHECKER], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/skill-drift OK/);
  }, 30_000);
});
