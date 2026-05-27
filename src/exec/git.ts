import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { promises as fs, statSync } from "node:fs";
import path from "node:path";
import { SquadError } from "../errors.js";
import { logger } from "../observability/logger.js";

const ALLOWED_SUBCOMMANDS = new Set(["diff", "status"]);

const REF_REGEX = /^[a-zA-Z0-9_/][a-zA-Z0-9_./-]*$/;
const FORBIDDEN_REF_SUBSTRINGS = ["..", "@{", ".lock"];
const REF_MAX_LEN = 200;

/**
 * Allowlist of long flags that the squad's git callers (today: `diff` and
 * `status`) legitimately pass. The two-phase grammar in `validateArg` rejects
 * everything else outright — a closed allowlist is the only defensible posture
 * against future flag additions in upstream git (e.g. `--output`,
 * `--exec-path`) that would otherwise sneak through a blocklist.
 *
 * Frozen at module load to keep runtime mutation off the table (a future
 * refactor cannot append to the set inadvertently).
 */
const ALLOWED_FLAGS: ReadonlySet<string> = Object.freeze(
  new Set([
    "--",
    "--cached",
    "--name-status",
    "--no-renames",
    "--no-ext-diff",
    // v1.7+: `detect_changed_files` with `with_stats: true` runs an extra
    // `git diff --numstat <range>` in parallel and sums insertions+deletions
    // to feed the `micro` mode auto-detect LOC cap. Without this entry the
    // numstat subprocess is rejected by `validateArg` before git is spawned.
    "--numstat",
  ] as const),
) as ReadonlySet<string>;

/**
 * Long flags that take a value (`--flag=value`). Each pattern matches the
 * whole arg so a hostile suffix like `--unified=3=4` or `--unified=abc`
 * cannot piggy-back on a permissive prefix match. Frozen at module load.
 */
const ALLOWED_FLAG_VALUE_PATTERNS: readonly RegExp[] = Object.freeze([/^--unified=\d+$/]);

const NUL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

const HARDENING_PREFIX = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.external=",
  "-c",
  `core.hooksPath=${NUL_DEVICE}`,
];

let resolvedGitPath: string | null | undefined;

export type SpawnFn = typeof spawn;

export interface RunGitOptions {
  spawnFn?: SpawnFn;
  timeoutMs?: number;
  maxStdout?: number;
  maxStderr?: number;
}

export interface RunGitResult {
  stdout: string;
  stderr: string;
  code: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_STDOUT = 1_048_576; // 1MB
const DEFAULT_MAX_STDERR = 262_144; //  256KB

function findGitOnPath(): string | null {
  const pathEnv = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32" ? [".exe"] : [""];
  const candidates: string[] = [];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      candidates.push(path.join(dir, "git" + ext));
    }
  }
  for (const c of candidates) {
    try {
      const stat = statSync(c);
      if (stat.isFile()) return c;
    } catch {
      // not here
    }
  }
  return null;
}

export function getResolvedGitPath(): string | null {
  if (resolvedGitPath === undefined) {
    resolvedGitPath = findGitOnPath();
    if (resolvedGitPath) {
      logger.info("git resolved", { details: { path: resolvedGitPath } });
    } else {
      logger.warn("git not found on PATH");
    }
  }
  return resolvedGitPath;
}

export function resetGitResolution(): void {
  resolvedGitPath = undefined;
}

export function validateRef(ref: string): void {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new SquadError("GIT_EXEC_DENIED", "ref must be a non-empty string");
  }
  if (ref.length > REF_MAX_LEN) {
    throw new SquadError("GIT_EXEC_DENIED", `ref length exceeds ${REF_MAX_LEN}`);
  }
  if (ref.startsWith("-")) {
    throw new SquadError("GIT_EXEC_DENIED", 'ref must not start with "-"');
  }
  if (!REF_REGEX.test(ref)) {
    throw new SquadError("GIT_EXEC_DENIED", "ref contains disallowed characters", { ref });
  }
  for (const sub of FORBIDDEN_REF_SUBSTRINGS) {
    if (ref.includes(sub)) {
      throw new SquadError("GIT_EXEC_DENIED", `ref must not contain "${sub}"`, {
        ref,
      });
    }
  }
  if (ref.endsWith(".")) {
    throw new SquadError("GIT_EXEC_DENIED", 'ref must not end with "."', {
      ref,
    });
  }
}

/**
 * Two-phase argument grammar:
 *  1. byte-level rejections (NUL, CR/LF, length cap)
 *  2. structural classification — long flag (`--…`), short flag (`-…`),
 *     or positional. Long flags must be in `ALLOWED_FLAGS` or match one of
 *     `ALLOWED_FLAG_VALUE_PATTERNS`. Short flags are rejected categorically
 *     BEFORE a `--` separator is seen. Once `--` has appeared in the arg
 *     list, every subsequent arg is treated as positional and only the
 *     byte-level checks apply — that is how a caller passes a path like
 *     `-file.txt` safely.
 *
 * Closed allowlist deliberately: a blocklist of forbidden long flags
 * (the pre-v1.5 design) silently accepted `--output=/tmp/x` and Unicode
 * homoglyph variants like `––unified=3`. The allowlist makes the next
 * upstream git flag addition a no-op instead of a regression.
 *
 * Every rejection path throws `SquadError("GIT_EXEC_DENIED", …)`. The error
 * code is load-bearing: tests grep on it and the dispatch boundary keys on
 * it for the sanitised tool-error response.
 *
 * `afterDoubleDash` is the caller's tracking flag: once a `--` arg has
 * been seen, pass `true` for every subsequent arg.
 */
function validateArg(arg: string, afterDoubleDash: boolean): void {
  if (typeof arg !== "string") {
    throw new SquadError("GIT_EXEC_DENIED", "arg must be string");
  }
  if (arg.indexOf("\0") !== -1) {
    throw new SquadError("GIT_EXEC_DENIED", "arg contains NUL byte");
  }
  if (arg.indexOf("\r") !== -1 || arg.indexOf("\n") !== -1) {
    throw new SquadError("GIT_EXEC_DENIED", "arg contains control character");
  }
  if (arg.length > 4096) {
    throw new SquadError("GIT_EXEC_DENIED", "arg too long");
  }
  if (afterDoubleDash) {
    // Past `--`, every arg is a positional path. Skip the flag classification.
    return;
  }
  // Defense against Unicode dash homoglyphs: en-dash (U+2013), em-dash
  // (U+2014), fullwidth hyphen-minus (U+FF0D), and the rest of the
  // Unicode-Pd "dash" punctuation class look like an ASCII hyphen to a
  // human reviewer but are NOT classified as a flag prefix by git itself.
  // Without this gate, a hostile caller could smuggle `––unified=3`
  // (en-dash en-dash) past the allowlist because the arg does not start
  // with ASCII `-`. Forward such args through the flag-allowlist path so
  // they reject with the same "flag not in allowlist" error code.
  const firstCp = arg.codePointAt(0);
  const looksLikeFlagViaUnicodeDash =
    firstCp !== undefined && firstCp !== 0x2d /* `-` */ && UNICODE_DASH_CODEPOINTS.has(firstCp);
  if (looksLikeFlagViaUnicodeDash) {
    throw new SquadError("GIT_EXEC_DENIED", `flag not in allowlist: ${arg}`);
  }
  if (arg.startsWith("--")) {
    if (ALLOWED_FLAGS.has(arg)) return;
    for (const pattern of ALLOWED_FLAG_VALUE_PATTERNS) {
      if (pattern.test(arg)) return;
    }
    throw new SquadError("GIT_EXEC_DENIED", `flag not in allowlist: ${arg}`);
  }
  if (arg.startsWith("-")) {
    // Short flags (-c, -p, -foo) are never required by the squad's callers
    // and have a long-flag-with-value cousin that IS narrowly allowlisted
    // when needed. Reject categorically.
    throw new SquadError("GIT_EXEC_DENIED", `short flags not allowed: ${arg}`);
  }
  // Positional argument: ref, path. Accept.
}

/**
 * Subset of Unicode dash characters that are visually confusable with ASCII
 * `-` (U+002D). Args whose first codepoint is one of these are forced
 * through the flag allowlist (which is ASCII-only) so a homoglyph cannot
 * smuggle a flag past the validator. Codepoints sourced from the General
 * Punctuation block plus the fullwidth and small forms variants used in
 * CJK input methods.
 */
const UNICODE_DASH_CODEPOINTS: ReadonlySet<number> = Object.freeze(
  new Set<number>([
    0x2010, // hyphen
    0x2011, // non-breaking hyphen
    0x2012, // figure dash
    0x2013, // en dash
    0x2014, // em dash
    0x2015, // horizontal bar
    0x2212, // minus sign
    0xfe58, // small em dash
    0xfe63, // small hyphen-minus
    0xff0d, // fullwidth hyphen-minus
  ]),
) as ReadonlySet<number>;

/**
 * Inspect cwd and confirm it is a git working tree (either a normal repo
 * with `.git` as a directory, or a worktree with `.git` as a file pointing
 * to the gitdir). Returns the realpath plus whether this is a worktree so
 * the env builder can skip `GIT_CEILING_DIRECTORIES` (which would otherwise
 * block git from resolving the gitdir reference).
 */
async function validateCwd(cwd: string): Promise<{ real: string; isWorktree: boolean }> {
  if (!path.isAbsolute(cwd)) {
    throw new SquadError("GIT_EXEC_DENIED", "cwd must be absolute", { cwd });
  }
  let stat;
  try {
    stat = await fs.stat(cwd);
  } catch {
    throw new SquadError("GIT_EXEC_DENIED", "cwd does not exist", { cwd });
  }
  if (!stat.isDirectory()) {
    throw new SquadError("GIT_EXEC_DENIED", "cwd is not a directory", { cwd });
  }
  const real = await fs.realpath(cwd);
  const gitMarker = path.join(real, ".git");
  let markerStat;
  try {
    markerStat = await fs.stat(gitMarker);
  } catch {
    throw new SquadError("GIT_NOT_A_REPO", "cwd has no .git entry", {
      cwd: real,
    });
  }
  return { real, isWorktree: markerStat.isFile() };
}

function buildEnv(realCwd: string, isWorktree: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  // In a worktree, `.git` is a file pointing at the parent repo's gitdir.
  // Setting GIT_CEILING_DIRECTORIES to dirname(realCwd) blocks git from
  // following that pointer and breaks every command. Skip it for worktrees.
  if (!isWorktree) {
    env.GIT_CEILING_DIRECTORIES = path.dirname(realCwd);
  }
  return env;
}

export async function runGit(
  subcommand: string,
  args: string[],
  cwd: string,
  opts: RunGitOptions = {},
): Promise<RunGitResult> {
  if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
    throw new SquadError("GIT_EXEC_DENIED", `subcommand not allowed: ${subcommand}`);
  }
  let seenDoubleDash = false;
  for (const a of args) {
    validateArg(a, seenDoubleDash);
    if (a === "--") seenDoubleDash = true;
  }
  const { real: realCwd, isWorktree } = await validateCwd(cwd);

  const gitBin = getResolvedGitPath();
  if (!gitBin) {
    throw new SquadError("GIT_NOT_FOUND", "git binary not found on PATH");
  }
  if (process.platform === "win32" && !gitBin.toLowerCase().endsWith(".exe")) {
    throw new SquadError("GIT_NOT_FOUND", `git binary must be .exe on Windows, got ${gitBin}`);
  }

  const argv = [...HARDENING_PREFIX, subcommand, ...args];
  const spawnFn = opts.spawnFn ?? spawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdout = opts.maxStdout ?? DEFAULT_MAX_STDOUT;
  const maxStderr = opts.maxStderr ?? DEFAULT_MAX_STDERR;

  return new Promise<RunGitResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnFn(gitBin, argv, {
        cwd: realCwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: buildEnv(realCwd, isWorktree),
      });
    } catch (err) {
      reject(new SquadError("GIT_NOT_FOUND", err instanceof Error ? err.message : String(err)));
      return;
    }
    const stdoutStream = child.stdout as Readable | null;
    const stderrStream = child.stderr as Readable | null;
    if (!stdoutStream || !stderrStream) {
      reject(new SquadError("GIT_EXEC_DENIED", "spawn returned without stdout/stderr streams"));
      return;
    }

    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let killed = false;
    let killReason: "timeout" | "oversize_stdout" | "oversize_stderr" | null = null;

    const killWith = (reason: typeof killReason) => {
      if (killed) return;
      killed = true;
      killReason = reason;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 1000).unref();
    };

    const timer = setTimeout(() => killWith("timeout"), timeoutMs);

    stdoutStream.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) {
        killWith("oversize_stdout");
        return;
      }
      stdoutChunks.push(chunk);
    });
    stderrStream.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderr) {
        killWith("oversize_stderr");
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new SquadError("GIT_NOT_FOUND", "git binary missing"));
      } else {
        reject(new SquadError("GIT_EXEC_DENIED", err.message));
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killReason === "timeout") {
        logger.warn("git timeout", { details: { subcommand, timeoutMs } });
        reject(
          new SquadError("GIT_EXEC_TIMEOUT", `git ${subcommand} timed out after ${timeoutMs}ms`),
        );
        return;
      }
      if (killReason === "oversize_stdout" || killReason === "oversize_stderr") {
        logger.warn("git output oversize", {
          details: { subcommand, stream: killReason },
        });
        reject(new SquadError("GIT_OUTPUT_TOO_LARGE", `git ${subcommand} output exceeded cap`));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}
