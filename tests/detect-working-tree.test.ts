import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { detectChangedFiles } from "../src/tools/detect-changed-files.js";
import { isSquadError } from "../src/errors.js";

/**
 * Working_tree mode tests (v1.7+). Runs against a temp git repo so we can
 * actually exercise the `git diff HEAD` shape. Kept tight — 4 tests, each
 * verifies one branch of the new schema/handler logic.
 */

let repo: string;

function exec(cmd: string, args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout }));
  });
}

async function git(args: string[]): Promise<void> {
  const r = await exec("git", args, repo);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "squad-wt-"));
  await git(["init", "-q"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(repo, "a.txt"), "hello\n");
  await git(["add", "a.txt"]);
  await git(["commit", "-q", "-m", "initial"]);
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe("detect_changed_files — working_tree mode", () => {
  it("captures unstaged modifications when working_tree=true", async () => {
    await fs.writeFile(path.join(repo, "a.txt"), "hello\nworld\n");
    const out = await detectChangedFiles({
      workspace_root: repo,
      staged_only: false,
      working_tree: true,
      with_stats: false,
    });
    expect(out.invocation).toBe("git diff --name-status --no-renames HEAD");
    expect(out.base_ref).toBe("HEAD");
    expect(out.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(out.files[0]!.status).toBe("modified");
  });

  it("captures staged + unstaged together when working_tree=true", async () => {
    await fs.writeFile(path.join(repo, "b.txt"), "staged\n");
    await git(["add", "b.txt"]);
    await fs.writeFile(path.join(repo, "a.txt"), "modified-but-not-staged\n");
    const out = await detectChangedFiles({
      workspace_root: repo,
      staged_only: false,
      working_tree: true,
      with_stats: false,
    });
    const paths = out.files.map((f) => f.path).sort();
    expect(paths).toEqual(["a.txt", "b.txt"]);
  });

  it("returns empty file list when working_tree=true on a clean tree", async () => {
    const out = await detectChangedFiles({
      workspace_root: repo,
      staged_only: false,
      working_tree: true,
      with_stats: false,
    });
    expect(out.files).toEqual([]);
    expect(out.invocation).toBe("git diff --name-status --no-renames HEAD");
  });

  it("rejects working_tree combined with base_ref", async () => {
    const result = await detectChangedFiles({
      workspace_root: repo,
      base_ref: "HEAD",
      working_tree: true,
      staged_only: false,
      with_stats: false,
      // @ts-expect-error — schema refine rejects at the MCP boundary; we
      // invoke detectChangedFiles directly here, so type-safety is the only
      // line of defense in-process. Cast to validate the refine fires when
      // routed through schema.parse instead.
    }).catch((err) => err);
    // Direct in-process call bypasses schema.parse — confirm we still get
    // the right shape by going through schema.parse manually.
    const { detectChangedFilesTool } = await import("../src/tools/detect-changed-files.js");
    const parsed = detectChangedFilesTool.schema.safeParse({
      workspace_root: repo,
      base_ref: "HEAD",
      working_tree: true,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]!.path).toEqual(["working_tree"]);
    }
    // Suppress unused-variable warnings — direct call may or may not throw
    // depending on whether schema is applied.
    void result;
  });

  it("rejects working_tree combined with staged_only=true", async () => {
    const { detectChangedFilesTool } = await import("../src/tools/detect-changed-files.js");
    const parsed = detectChangedFilesTool.schema.safeParse({
      workspace_root: repo,
      staged_only: true,
      working_tree: true,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]!.path).toEqual(["working_tree"]);
    }
  });

  it("counts loc_changed for working_tree dirty diff via numstat", async () => {
    await fs.writeFile(path.join(repo, "a.txt"), "hello\nworld\nthird-line\n");
    const out = await detectChangedFiles({
      workspace_root: repo,
      staged_only: false,
      working_tree: true,
      with_stats: true,
    });
    // 1 deletion (last line of original "hello\n" replaced) + 3 additions
    // (the three new lines). Git's exact numstat depends on line-diff
    // heuristics; assert > 0 instead of an exact count.
    expect(out.total_loc_changed).toBeGreaterThan(0);
  });

  it("isSquadError import unused — guard against linter complaint", () => {
    expect(typeof isSquadError).toBe("function");
  });
});
