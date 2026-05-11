import { promises as fs } from "node:fs";
import path from "node:path";
import { withFileLock } from "./file-lock.js";
import { SquadError } from "../errors.js";

/**
 * Atomically rewrite a JSONL file with a new set of rows. Survives crashes
 * mid-write and races with concurrent appenders that hold the same file
 * lock. Concurrent READERS (which do not take the lock today by design)
 * also survive — they either see the pre-rewrite file in full or the
 * post-rewrite file in full, never a half-written state. The protocol
 * uses POSIX rename semantics (atomic-within-filesystem).
 *
 * Used by:
 *   - `prune_learnings` (v0.11.0+) to mark entries archived/promoted in a
 *     full rewrite of `.squad/learnings.jsonl`.
 *
 * Protocol (executes inside the lock):
 *   1. Read current file contents into memory (caller does this BEFORE
 *      calling; we receive the new rows to write).
 *   2. Write new content to `<file>.tmp` with mode 0o600 (private).
 *   3. Rename current `<file>` → `<file>.prev` (atomic). This is the
 *      rollback point — if the next step fails, the user can manually
 *      `mv <file>.prev <file>` to recover.
 *   4. Rename `<file>.tmp` → `<file>` (atomic).
 *   5. Lock released by the caller's withFileLock wrapper.
 *
 * On failure between steps 3 and 4 (rare — both renames are usually a
 * single syscall on the same FS), the file goes missing for a moment but
 * `.prev` is intact. Step 4 retries inside the lock could be added; for
 * now, surface the error and let the caller decide.
 *
 * The function takes a `lock: false` escape hatch for tests that want to
 * exercise the rename sequence without taking the cross-process lock (we
 * never use it in production).
 */
export interface AtomicRewriteOptions {
  /** When false, skip the file-lock acquisition. Test-only. Default true. */
  lock?: boolean;
}

export async function atomicRewriteJsonl(
  filePath: string,
  rows: ReadonlyArray<object>,
  options: AtomicRewriteOptions = {},
): Promise<void> {
  const useLock = options.lock !== false;
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");
  const tmpPath = `${filePath}.tmp`;
  const prevPath = `${filePath}.prev`;

  const performRewrite = async (): Promise<void> => {
    // Ensure the directory exists. mkdir is idempotent.
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });

    // 1. Write the new content to <file>.tmp with private mode. fh.writeFile
    //    truncates if the file existed (we never reuse a stale tmp).
    const fh = await fs.open(tmpPath, "w", 0o600);
    try {
      await fh.writeFile(body, "utf8");
    } finally {
      await fh.close();
    }

    // 2. Move the current file to <file>.prev as a rollback snapshot. If the
    //    source doesn't exist (first-ever write), the rename is skipped.
    let prevMoved = false;
    try {
      await fs.rename(filePath, prevPath);
      prevMoved = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    // 3. Move the new tmp into place. Atomic on POSIX same-FS rename.
    //    v0.11.0 cycle-2 Blocker B2 fix: on failure here, attempt to rollback
    //    .prev → <file> so the caller never sees a missing journal. If the
    //    rollback also fails, surface a SquadError with the manual recovery
    //    command embedded so the user can `mv .prev <file>` themselves.
    try {
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      const step3Err = err as NodeJS.ErrnoException;
      if (!prevMoved) {
        // First-ever write — no .prev to roll back. Clean up tmp and rethrow.
        try {
          await fs.unlink(tmpPath);
        } catch {
          /* swallow — tmp cleanup is best-effort */
        }
        throw step3Err;
      }
      // We moved source → .prev and now the second rename failed. Try to
      // put .prev back so the journal isn't missing.
      try {
        await fs.rename(prevPath, filePath);
        // Rollback succeeded. Cleanup tmp.
        try {
          await fs.unlink(tmpPath);
        } catch {
          /* swallow */
        }
        throw new SquadError(
          "ATOMIC_REWRITE_FAILED",
          `failed to swap new content into place (${step3Err.message}). Rollback applied: original journal restored from .prev. No data loss.`,
          {
            step: "rename_tmp_to_file",
            path: filePath,
            errno: step3Err.code,
          },
        );
      } catch (rollbackErr) {
        // Rollback failed too — surface manual recovery instructions.
        if ((rollbackErr as { code?: string }).code === "ATOMIC_REWRITE_FAILED") {
          // The error from the success-rollback branch above; bubble unchanged.
          throw rollbackErr;
        }
        throw new SquadError(
          "ATOMIC_REWRITE_FAILED",
          `failed to swap new content into place AND failed to rollback .prev → original. ` +
            `To recover manually: mv ${prevPath} ${filePath}`,
          {
            step: "rename_tmp_to_file_with_rollback_failure",
            path: filePath,
            prev: prevPath,
            tmp: tmpPath,
            primary_errno: step3Err.code,
            rollback_errno: (rollbackErr as NodeJS.ErrnoException).code,
          },
        );
      }
    }
  };

  if (useLock) {
    await withFileLock(filePath, performRewrite);
  } else {
    await performRewrite();
  }
}
