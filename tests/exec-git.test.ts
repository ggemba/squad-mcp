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

  // ── v1.5 hardening: allowlist grammar ──────────────────────────────────
  // The argv validator is closed-set: a tight allowlist of long flags
  // (`--`, `--cached`, `--name-status`, `--no-renames`, `--no-ext-diff`)
  // plus `^--unified=\d+$`. Short flags are rejected categorically until
  // `--` is seen, after which every subsequent arg is a positional path
  // (the caller separator pattern).

  describe("validateArg — allowlist accepts the legitimate set", () => {
    it.each([
      ["--"],
      ["--cached"],
      ["--name-status"],
      ["--no-renames"],
      ["--no-ext-diff"],
      ["--unified=3"],
      ["--unified=0"],
      ["HEAD~1..HEAD"],
      ["src/foo.ts"],
    ])("accepts %s", async (arg) => {
      const dir = await tmpRepoDir();
      const fakeSpawn = vi.fn(() =>
        createFakeChild({ stdoutChunks: [Buffer.from("")], exitCode: 0 }),
      ) as never;
      await expect(runGit("diff", [arg], dir, { spawnFn: fakeSpawn })).resolves.toMatchObject({
        code: 0,
      });
    });

    it("accepts a positional path starting with `-` AFTER `--`", async () => {
      const dir = await tmpRepoDir();
      const fakeSpawn = vi.fn(() =>
        createFakeChild({ stdoutChunks: [Buffer.from("")], exitCode: 0 }),
      ) as never;
      // The caller-supplied `--` separator flips subsequent args into
      // positional mode; a path like `-file.txt` is then a legitimate
      // pathspec, not a short flag.
      await expect(
        runGit("diff", ["--", "-file.txt"], dir, { spawnFn: fakeSpawn }),
      ).resolves.toMatchObject({ code: 0 });
    });
  });

  describe("validateArg — allowlist rejects everything else with GIT_EXEC_DENIED", () => {
    const rejectCases: Array<[string, string]> = [
      ["--output=/tmp/x", "regression: was accepted in v1.4.2"],
      ["--exec-path=/tmp/x", "exec-path injection"],
      ["--config", "config flag"],
      ["--upload-pack=foo", "upload-pack"],
      ["--unified=abc", "value-format: non-numeric"],
      ["--unified=3=4", "value-format: repeated equals"],
      ["--unicode-flag", "unknown flag"],
      ["––unified=3", "en-dash homoglyph"],
      ["－－unified=3", "fullwidth homoglyph"],
      ["-c", "short flag (single dash)"],
      ["-foo", "short flag with body"],
      ["with\x00nul", "NUL byte"],
      ["with\rcr", "CR control character"],
      ["with\nlf", "LF control character"],
    ];
    it.each(rejectCases)("rejects %s — %s", async (arg) => {
      const dir = await tmpRepoDir();
      try {
        await runGit("diff", [arg], dir);
        throw new Error(`expected runGit to reject ${JSON.stringify(arg)}`);
      } catch (err) {
        expect((err as { code: string }).code).toBe("GIT_EXEC_DENIED");
      }
    });

    it("rejects an arg of length > 4096", async () => {
      const dir = await tmpRepoDir();
      const huge = "a".repeat(5_000);
      try {
        await runGit("diff", [huge], dir);
        throw new Error("expected runGit to reject 5k-char arg");
      } catch (err) {
        expect((err as { code: string }).code).toBe("GIT_EXEC_DENIED");
      }
    });
  });

  it("end-to-end regression: HARDENING_PREFIX still bypasses validateArg and positional refs pass", async () => {
    const dir = await tmpRepoDir();
    const fakeSpawn = vi.fn(() =>
      createFakeChild({ stdoutChunks: [Buffer.from("M\tfile.ts\n")], exitCode: 0 }),
    ) as never;
    // The shape squad callers actually use: `diff --name-status --no-renames
    // <rev>..<rev>`. Allowlist must accept it as a whole and the embedded
    // `-c core.fsmonitor=false …` hardening prefix must not get validated.
    const result = await runGit("diff", ["--name-status", "--no-renames", "HEAD~1..HEAD"], dir, {
      spawnFn: fakeSpawn,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("file.ts");
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
