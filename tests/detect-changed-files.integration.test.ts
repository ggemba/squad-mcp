import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import {
  detectChangedFiles,
  type DetectChangedFilesOutput,
} from "../src/tools/detect-changed-files.js";
import { resetGitResolution } from "../src/exec/git.js";

// Skip the whole suite when git isn't on PATH (rare, but CI matrices vary).
let gitAvailable = true;

beforeAll(() => {
  const r = spawnSync("git", ["--version"]);
  gitAvailable = r.status === 0;
  resetGitResolution();
});

let repo: string;

beforeEach(async () => {
  if (!gitAvailable) return;
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "squad-detect-int-"));
  // Minimal repo: init, configure identity, commit a baseline file, then make a change.
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.email", "test@example.com");
  run(repo, "config", "user.name", "Test");
  await fs.writeFile(path.join(repo, "a.txt"), "alpha\n");
  await fs.writeFile(path.join(repo, "b.txt"), "beta\n");
  run(repo, "add", ".");
  run(repo, "commit", "-q", "-m", "baseline");
  // Make a follow-up change so HEAD~1..HEAD has one modified and one added file.
  await fs.writeFile(path.join(repo, "a.txt"), "alpha2\n");
  await fs.writeFile(path.join(repo, "c.txt"), "gamma\n");
  run(repo, "add", ".");
  run(repo, "commit", "-q", "-m", "change");
});

afterEach(async () => {
  if (!repo) return;
  await fs.rm(repo, { recursive: true, force: true });
});

function run(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, stdio: "pipe" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${r.status}: ${r.stderr.toString()}`);
  }
}

describe("detectChangedFiles — real git", () => {
  it("returns modified + added files for HEAD~1..HEAD", async () => {
    if (!gitAvailable) return;
    const out: DetectChangedFilesOutput = await detectChangedFiles({
      workspace_root: repo,
      staged_only: false,
    });
    const byPath = new Map(out.files.map((f) => [f.path, f.status]));
    expect(byPath.get("a.txt")).toBe("modified");
    expect(byPath.get("c.txt")).toBe("added");
    expect(out.files).toHaveLength(2);
    expect(out.base_ref).toBe("HEAD~1");
  });

  it("honors staged_only=true (returns only files in the index)", async () => {
    if (!gitAvailable) return;
    await fs.writeFile(path.join(repo, "d.txt"), "delta\n");
    run(repo, "add", "d.txt");
    // a.txt is also dirty in working tree, but NOT staged
    await fs.writeFile(path.join(repo, "a.txt"), "alpha3\n");

    const out = await detectChangedFiles({
      workspace_root: repo,
      staged_only: true,
    });
    const paths = out.files.map((f) => f.path).sort();
    expect(paths).toContain("d.txt");
    expect(paths).not.toContain("a.txt");
  });

  it("rejects cwd that isn't a git repo", async () => {
    if (!gitAvailable) return;
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "squad-no-git-"));
    try {
      await expect(
        detectChangedFiles({ workspace_root: empty, staged_only: false }),
      ).rejects.toMatchObject({ code: "GIT_NOT_A_REPO" });
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  it("rejects refs with forbidden substrings (@{, .., leading -)", async () => {
    if (!gitAvailable) return;
    for (const badRef of ["HEAD@{1}", "feat..main", "-evil"]) {
      await expect(
        detectChangedFiles({
          workspace_root: repo,
          staged_only: false,
          base_ref: badRef,
        }),
      ).rejects.toMatchObject({ code: "GIT_EXEC_DENIED" });
    }
  });
});
