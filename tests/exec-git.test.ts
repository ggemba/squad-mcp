import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { runGit, validateRef } from "../src/exec/git.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

interface FakeChildOpts {
  stdoutChunks?: Buffer[];
  stderrChunks?: Buffer[];
  exitCode?: number;
  delayMs?: number;
  errorBeforeExit?: NodeJS.ErrnoException;
}

function createFakeChild(opts: FakeChildOpts) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
  };
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.kill = vi.fn(() => {
    child.killed = true;
    setTimeout(() => child.emit("close", null), 1);
    return true;
  });
  child.killed = false;

  setTimeout(() => {
    if (opts.errorBeforeExit) {
      child.emit("error", opts.errorBeforeExit);
      return;
    }
    for (const c of opts.stdoutChunks ?? []) child.stdout.push(c);
    for (const c of opts.stderrChunks ?? []) child.stderr.push(c);
    child.stdout.push(null);
    child.stderr.push(null);
    setTimeout(() => child.emit("close", opts.exitCode ?? 0), opts.delayMs ?? 5);
  }, 1);
  return child;
}

async function tmpRepoDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "squad-git-"));
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
  return dir;
}

describe("validateRef", () => {
  it.each([
    ["feat/foo", true],
    ["main", true],
    ["v0.2.0", true],
    ["release-2024", true],
    ["-evil", false],
    ["--upload-pack=x", false],
    ["feat..main", false],
    ["HEAD@{1}", false],
    ["foo.lock", false],
    ["trailing.", false],
    ["", false],
    ["a".repeat(201), false],
  ])('validateRef("%s") accepts=%s', (ref, accepted) => {
    if (accepted) {
      expect(() => validateRef(ref)).not.toThrow();
    } else {
      expect(() => validateRef(ref)).toThrow();
    }
  });
});

describe("runGit error paths", () => {
  it("rejects non-allowlisted subcommand", async () => {
    const dir = await tmpRepoDir();
    await expect(runGit("commit", [], dir)).rejects.toMatchObject({
      code: "GIT_EXEC_DENIED",
    });
  });

  it("rejects forbidden flag like -c", async () => {
    const dir = await tmpRepoDir();
    await expect(runGit("diff", ["-c", "foo=bar"], dir)).rejects.toMatchObject({
      code: "GIT_EXEC_DENIED",
    });
  });

  it("rejects --upload-pack arg", async () => {
    const dir = await tmpRepoDir();
    await expect(runGit("diff", ["--upload-pack=evil"], dir)).rejects.toMatchObject({
      code: "GIT_EXEC_DENIED",
    });
  });

  it("rejects relative cwd", async () => {
    await expect(runGit("diff", [], "relative/path")).rejects.toMatchObject({
      code: "GIT_EXEC_DENIED",
    });
  });

  it("rejects cwd without .git", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "squad-nogit-"));
    await expect(runGit("diff", [], dir)).rejects.toMatchObject({
      code: "GIT_NOT_A_REPO",
    });
  });

  it("honors timeout via injected spawnFn", async () => {
    const dir = await tmpRepoDir();
    const fakeSpawn = vi.fn(() => createFakeChild({ delayMs: 5_000 })) as never;
    await expect(
      runGit("diff", [], dir, { spawnFn: fakeSpawn, timeoutMs: 50 }),
    ).rejects.toMatchObject({
      code: "GIT_EXEC_TIMEOUT",
    });
  });

  it("enforces stdout cap mid-stream", async () => {
    const dir = await tmpRepoDir();
    const big = Buffer.alloc(2_000_000, 0x61);
    const fakeSpawn = vi.fn(() => createFakeChild({ stdoutChunks: [big] })) as never;
    await expect(
      runGit("diff", [], dir, { spawnFn: fakeSpawn, maxStdout: 1024 }),
    ).rejects.toMatchObject({
      code: "GIT_OUTPUT_TOO_LARGE",
    });
  });

  it("returns stdout/stderr/code on normal exit via injected spawnFn", async () => {
    const dir = await tmpRepoDir();
    const fakeSpawn = vi.fn(() =>
      createFakeChild({
        stdoutChunks: [Buffer.from("A\tfile1.ts\n")],
        exitCode: 0,
      }),
    ) as never;
    const result = await runGit("diff", [], dir, { spawnFn: fakeSpawn });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("file1.ts");
  });

  it("translates ENOENT into GIT_NOT_FOUND", async () => {
    const dir = await tmpRepoDir();
    const enoent: NodeJS.ErrnoException = Object.assign(new Error("not found"), { code: "ENOENT" });
    const fakeSpawn = vi.fn(() => createFakeChild({ errorBeforeExit: enoent })) as never;
    await expect(runGit("diff", [], dir, { spawnFn: fakeSpawn })).rejects.toMatchObject({
      code: "GIT_NOT_FOUND",
    });
  });

  it("accepts a worktree (.git as a file pointing to the gitdir) and omits GIT_CEILING_DIRECTORIES", async () => {
    // Worktrees have .git as a regular file with `gitdir: <path>` contents.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "squad-worktree-"));
    await fs.writeFile(path.join(dir, ".git"), "gitdir: /tmp/fake-gitdir\n", "utf8");
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const fakeSpawn = vi.fn(
      (_bin: string, _argv: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        capturedEnv = options.env;
        return createFakeChild({
          stdoutChunks: [Buffer.from("")],
          exitCode: 0,
        });
      },
    ) as never;
    const result = await runGit("diff", [], dir, { spawnFn: fakeSpawn });
    expect(result.code).toBe(0);
    expect(capturedEnv).toBeDefined();
    // Critical: ceiling not set so git can follow the gitdir pointer.
    expect(capturedEnv?.GIT_CEILING_DIRECTORIES).toBeUndefined();
    // Sanity: hardening env still present.
    expect(capturedEnv?.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("sets GIT_CEILING_DIRECTORIES for a regular repo (.git as directory)", async () => {
    const dir = await tmpRepoDir();
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const fakeSpawn = vi.fn(
      (_bin: string, _argv: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        capturedEnv = options.env;
        return createFakeChild({
          stdoutChunks: [Buffer.from("")],
          exitCode: 0,
        });
      },
    ) as never;
    const result = await runGit("diff", [], dir, { spawnFn: fakeSpawn });
    expect(result.code).toBe(0);
    expect(capturedEnv?.GIT_CEILING_DIRECTORIES).toBe(path.dirname(await fs.realpath(dir)));
  });
});
