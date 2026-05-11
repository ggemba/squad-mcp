import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { extractFileHunks } from "../src/exec/diff-hunks.js";
import { resetGitResolution } from "../src/exec/git.js";

// Mirror of `detect-changed-files.integration.test.ts`: real `git` invocation
// against a temp repo. Skipped when git isn't on PATH. Each `it` sets up its
// own committed baseline + a follow-up change in `beforeEach` so we can ask
// `extractFileHunks` for `HEAD~1..HEAD` and get a deterministic shape.

let gitAvailable = true;

beforeAll(() => {
  const r = spawnSync("git", ["--version"]);
  gitAvailable = r.status === 0;
  resetGitResolution();
});

let repo: string;

beforeEach(async () => {
  if (!gitAvailable) return;
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "squad-hunks-int-"));
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.email", "test@example.com");
  run(repo, "config", "user.name", "Test");
  // Override any global `diff.external` setting that might survive into this
  // repo via ~/.gitconfig. The hardening prefix in runGit passes
  // `-c diff.external=`, but on some Windows configs that command-line
  // override does not reliably defeat a global setting; pinning it here
  // makes the test deterministic across dev machines.
  run(repo, "config", "diff.external", "");
  await fs.writeFile(path.join(repo, "a.txt"), "alpha\nline2\n");
  run(repo, "add", ".");
  run(repo, "commit", "-q", "-m", "baseline");
  // Modify a.txt + add b.txt for a 2-file diff.
  await fs.writeFile(path.join(repo, "a.txt"), "alpha-changed\nline2\n");
  await fs.writeFile(path.join(repo, "b.txt"), "beta-new\n");
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

describe("extractFileHunks — real git", () => {
  it("returns hunks for modified + added files in HEAD~1..HEAD", async () => {
    if (!gitAvailable) return;
    const out = await extractFileHunks({
      cwd: repo,
      files: ["a.txt", "b.txt"],
    });
    expect(Object.keys(out).sort()).toEqual(["a.txt", "b.txt"]);
    // a.txt was modified — diff carries the -alpha / +alpha-changed lines.
    expect(out["a.txt"]?.diff).toContain("-alpha");
    expect(out["a.txt"]?.diff).toContain("+alpha-changed");
    expect(out["a.txt"]?.full_file_changed).toBe(false);
    expect(out["a.txt"]?.is_binary).toBe(false);
    // b.txt was added in HEAD — `new file mode` marker present.
    expect(out["b.txt"]?.full_file_changed).toBe(true);
    expect(out["b.txt"]?.diff).toContain("new file mode");
  });

  it("returns empty object when files list is empty (no git call needed)", async () => {
    if (!gitAvailable) return;
    const out = await extractFileHunks({ cwd: repo, files: [] });
    expect(out).toEqual({});
  });

  it("returns empty object when files don't match anything in the diff range", async () => {
    if (!gitAvailable) return;
    // c.txt was never committed — git diff for it returns nothing.
    const out = await extractFileHunks({ cwd: repo, files: ["c.txt"] });
    expect(Object.keys(out)).toEqual([]);
  });

  it("honors max_bytes_per_file: truncated flag flips on a giant diff", async () => {
    if (!gitAvailable) return;
    // Append a large addition to a.txt and commit so the diff is huge.
    const giant = "x\n".repeat(2000); // ~4 KB
    await fs.writeFile(path.join(repo, "a.txt"), giant);
    run(repo, "add", ".");
    run(repo, "commit", "-q", "-m", "giant");

    const out = await extractFileHunks({
      cwd: repo,
      files: ["a.txt"],
      max_bytes_per_file: 256, // force truncation
    });
    expect(out["a.txt"]?.truncated).toBe(true);
    expect(out["a.txt"]?.diff).toContain("[... diff truncated by squad-mcp");
  });

  it("honors base_ref for arbitrary commit ranges (real SHA)", async () => {
    if (!gitAvailable) return;
    // Capture the baseline SHA (HEAD~1 after `beforeEach` setup).
    const sha = spawnSync("git", ["rev-parse", "HEAD~1"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    // Create a 3rd commit so the baseline → HEAD range spans both deltas.
    await fs.writeFile(path.join(repo, "a.txt"), "alpha-changed-2\nline2\n");
    run(repo, "add", ".");
    run(repo, "commit", "-q", "-m", "third");

    // Note: validateRef rejects tilde/caret syntax (e.g. "HEAD~2"); a real
    // commit SHA is the canonical input shape for base_ref.
    const out = await extractFileHunks({
      cwd: repo,
      files: ["a.txt", "b.txt"],
      base_ref: sha,
    });
    // Both files have changes since the baseline (a.txt twice, b.txt added).
    expect(out["a.txt"]?.diff).toContain("+alpha-changed-2");
    expect(out["b.txt"]?.full_file_changed).toBe(true);
  });
});
