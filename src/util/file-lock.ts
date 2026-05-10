import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Cross-process advisory lock implemented via O_EXCL on a sibling `.lock`
 * file. Used to serialise read-modify-write on `.squad/tasks.json` and
 * appends to `.squad/learnings.jsonl` when multiple MCP server processes
 * share a workspace (a common case — two Claude clients open in the same
 * repo).
 *
 * Limitations:
 *  - Not a kernel-enforced lock. Cooperative — every writer must use this.
 *  - A crash mid-section can leave a stale lock. After STALE_AFTER_MS the
 *    lock is force-acquired (one unlink, then retry once). Mtime is the
 *    staleness signal; we do NOT trust pid inside the file because PIDs
 *    can be reused across containers.
 *  - Single-host. NFS rename + flock semantics are weaker; not in scope.
 */

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_BASE_MS = 15;
const DEFAULT_RETRY_MAX_MS = 75;
const STALE_AFTER_MS = 30_000;

export interface FileLockOptions {
  /** Total wall-clock budget to acquire the lock (ms). */
  timeoutMs?: number;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

async function tryAcquire(lockPath: string): Promise<boolean> {
  try {
    const fh = await fs.open(lockPath, "wx");
    // The body is for human inspection only; logic depends only on existence + mtime.
    await fh.writeFile(`${process.pid}\t${Date.now()}\n`, { encoding: "utf8" });
    await fh.close();
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    throw err;
  }
}

async function isStale(lockPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(lockPath);
    return Date.now() - stat.mtimeMs > STALE_AFTER_MS;
  } catch {
    // Lock vanished — treat as stale; the next tryAcquire will create it.
    return true;
  }
}

/**
 * Acquire the lock for `targetPath` (operates on `${targetPath}.lock`),
 * run `fn`, then release. The lock file is removed in a finally so a
 * thrown body still cleans up.
 */
export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  // The lock lives alongside the target. The body may be creating the target
  // for the first time so the parent directory may not exist yet — mkdir is
  // cheap and idempotent.
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let attempt = 0;
  let acquired = false;

  while (!acquired) {
    if (await tryAcquire(lockPath)) {
      acquired = true;
      break;
    }
    if (Date.now() > deadline) {
      // Last chance: if the existing lock looks stale, force-acquire.
      if (await isStale(lockPath)) {
        try {
          await fs.unlink(lockPath);
        } catch {
          // Another holder may have just removed it themselves — retry once.
        }
        if (await tryAcquire(lockPath)) {
          acquired = true;
          break;
        }
      }
      throw new Error(
        `file-lock: timed out acquiring ${lockPath} after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
      );
    }
    attempt += 1;
    // Jittered backoff to avoid lockstep contention between processes.
    const base = Math.min(DEFAULT_RETRY_BASE_MS * attempt, DEFAULT_RETRY_MAX_MS);
    await sleep(base + Math.floor(Math.random() * 10));
  }

  try {
    return await fn();
  } finally {
    try {
      await fs.unlink(lockPath);
    } catch {
      // Best-effort. If a stale-recovery removed it concurrently, that's fine.
    }
  }
}
