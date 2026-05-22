import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Smoke tests for the standalone CLIs under tools/.
 *
 * Covers two pre-existing bugs fixed for 1.4.2:
 *
 *  Bug 1 — the task/learning CLIs crashed when `--file` was omitted: parseArgs
 *  defaulted `file: null`, the guard `if (file !== undefined)` let `null`
 *  through to `path.isAbsolute(null)`, which throws. Each of the five CLIs is
 *  run here WITHOUT `--file` against an isolated temp workspace; they must not
 *  crash and must produce the documented exit code + stdout / file effect.
 *
 *  Bug 2 — `tools/post-review.mjs` imports `../dist/format/pr-review.js` and
 *  `../dist/format/sarif.js`, which the `bundle` script never emitted. The
 *  build now bundles them; this suite runs `post-review.mjs --dry-run` (the
 *  first real exercise of that import path) and asserts the two emitted
 *  modules expose their named exports.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TOOLS = path.join(ROOT, "tools");

const LIST_TASKS = path.join(TOOLS, "list-tasks.mjs");
const NEXT_TASK = path.join(TOOLS, "next-task.mjs");
const RECORD_TASKS = path.join(TOOLS, "record-tasks.mjs");
const UPDATE_TASK_STATUS = path.join(TOOLS, "update-task-status.mjs");
const RECORD_LEARNING = path.join(TOOLS, "record-learning.mjs");
const POST_REVIEW = path.join(TOOLS, "post-review.mjs");

const FORMAT_PR_REVIEW = path.join(ROOT, "dist", "format", "pr-review.js");
const FORMAT_SARIF = path.join(ROOT, "dist", "format", "sarif.js");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn a CLI via the real node binary. `stdin`, when provided, is written to
 * the child's stdin and the pipe closed; otherwise stdin is left empty so
 * stdin-reading CLIs see EOF immediately.
 */
function runCli(script: string, args: string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [script, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (stdin !== undefined) proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

describe("CLI smoke — tools/*.mjs", () => {
  // Bug-2 build artefacts must exist before the post-review / format-export
  // tests run. Mirror the build-guard pattern in tests/check-skill-drift.test.ts
  // so a clean checkout does not fail spuriously. The guard keys off the
  // Bug-2 module specifically (not dist/index.js) since that is the new output.
  beforeAll(() => {
    if (!existsSync(FORMAT_PR_REVIEW)) {
      const build = spawnSync("npm", ["run", "build"], {
        cwd: ROOT,
        encoding: "utf8",
        shell: process.platform === "win32",
      });
      expect(build.status, build.stderr).toBe(0);
    }
  }, 120_000);

  let workspace: string;

  afterEach(async () => {
    if (workspace) {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  describe("Bug 1 — task/learning CLIs run without --file", () => {
    it("list-tasks.mjs — exit 0, empty-table stdout against a fresh workspace", async () => {
      workspace = await fs.mkdtemp(path.join(os.tmpdir(), "squad-cli-smoke-"));
      const r = await runCli(LIST_TASKS, ["--workspace", workspace]);
      expect(r.code, r.stderr).toBe(0);
      // readTasksFile returns an empty task list for a missing file; the table
      // renderer prints the documented placeholder.
      expect(r.stdout).toContain("(no tasks match filters)");
    });

    it("next-task.mjs — exit 1 (documented no-ready-task code), reason on stderr", async () => {
      workspace = await fs.mkdtemp(path.join(os.tmpdir(), "squad-cli-smoke-"));
      const r = await runCli(NEXT_TASK, ["--workspace", workspace]);
      // next-task.mjs documents: text mode exits 1 when no ready task. That is
      // the intended no-pending-task signal for shell pipelines — NOT a crash.
      // A crash would surface as exit 2 with a stack trace.
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("no pending tasks");
      expect(r.stderr).not.toMatch(/isAbsolute|TypeError/);
    });

    it("record-tasks.mjs — valid task JSON on stdin → exit 0, task recorded", async () => {
      workspace = await fs.mkdtemp(path.join(os.tmpdir(), "squad-cli-smoke-"));
      const input = JSON.stringify([{ title: "smoke task", priority: "high" }]);
      const r = await runCli(RECORD_TASKS, ["--workspace", workspace], input);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain("recorded: 1 task(s)");
      // The task landed in the default store under the temp workspace.
      const storePath = path.join(workspace, ".squad", "tasks.json");
      const store = JSON.parse(await fs.readFile(storePath, "utf8"));
      expect(store.tasks).toHaveLength(1);
      expect(store.tasks[0].title).toBe("smoke task");
      expect(store.tasks[0].status).toBe("pending");
    });

    it("update-task-status.mjs — after seeding a task → exit 0, status updated", async () => {
      workspace = await fs.mkdtemp(path.join(os.tmpdir(), "squad-cli-smoke-"));
      // Seed one task via record-tasks (itself a no---file run).
      const seed = await runCli(
        RECORD_TASKS,
        ["--workspace", workspace],
        JSON.stringify([{ title: "task to flip" }]),
      );
      expect(seed.code, seed.stderr).toBe(0);

      const r = await runCli(UPDATE_TASK_STATUS, [
        "--workspace",
        workspace,
        "--task",
        "1",
        "--status",
        "in-progress",
      ]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain("updated: task 1 -> in-progress");

      const store = JSON.parse(
        await fs.readFile(path.join(workspace, ".squad", "tasks.json"), "utf8"),
      );
      expect(store.tasks[0].status).toBe("in-progress");
    });

    it("record-learning.mjs — exit 0, entry appended to default .squad/learnings.jsonl", async () => {
      workspace = await fs.mkdtemp(path.join(os.tmpdir(), "squad-cli-smoke-"));
      const r = await runCli(RECORD_LEARNING, [
        "--workspace",
        workspace,
        "--accept",
        "--agent",
        "developer",
        "--finding",
        "smoke finding",
      ]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain("recorded: accept on developer");

      const jsonlPath = path.join(workspace, ".squad", "learnings.jsonl");
      const lines = (await fs.readFile(jsonlPath, "utf8")).trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]!);
      expect(entry.decision).toBe("accept");
      expect(entry.agent).toBe("developer");
      expect(entry.finding).toBe("smoke finding");
    });
  });

  describe("Bug 2 — post-review.mjs format imports resolve after build", () => {
    it("post-review.mjs --dry-run — minimal consolidation JSON on stdin → exit 0", async () => {
      // Exercises the Bug-2 path: post-review.mjs statically imports
      // ../dist/format/pr-review.js + ../dist/format/sarif.js at module load.
      // If the build did not emit them, the process aborts before main().
      const consolidation = {
        verdict: "APPROVED",
        blockers: [],
        majors_unjustified: [],
        forwarded: [],
        not_evaluated: [],
        severity_counts: { Blocker: 0, Major: 0, Minor: 0, Suggestion: 0 },
        agents_involved: ["developer"],
        summary: "all clear",
        rubric: null,
        downgraded_by_score: false,
      };
      const r = await runCli(
        POST_REVIEW,
        ["--pr", "1", "--dry-run"],
        JSON.stringify(consolidation),
      );
      expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(r.stdout).toContain("DRY RUN");
      expect(r.stdout).toContain("# Action: approve");
      // A failed import would surface as ERR_MODULE_NOT_FOUND on stderr.
      expect(r.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
    });

    it("emits dist/format modules with their expected named exports", async () => {
      expect(existsSync(FORMAT_PR_REVIEW), "dist/format/pr-review.js missing").toBe(true);
      expect(existsSync(FORMAT_SARIF), "dist/format/sarif.js missing").toBe(true);

      // File existence alone is insufficient — the modules must be importable
      // ESM and expose the named exports post-review.mjs destructures.
      const prReview = await import(FORMAT_PR_REVIEW);
      expect(typeof prReview.formatPrReview).toBe("function");

      const sarif = await import(FORMAT_SARIF);
      expect(typeof sarif.formatSarif).toBe("function");
    });
  });
});
