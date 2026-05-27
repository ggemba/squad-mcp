import { promises as fs } from "node:fs";
import { logger } from "../observability/logger.js";

/**
 * Read a file with a transient fallback to `<path>.prev`.
 *
 * Motivation — race vs `atomicRewriteJsonl`: the atomic rewriter renames the
 * current file to `<file>.prev` and then immediately renames the new tmp into
 * `<file>`. A concurrent READER that does not take the write lock (every
 * reader today, by design) can observe `ENOENT` in the brief window between
 * the two renames. Retrying against `<file>.prev` covers that window without
 * forcing readers onto the cross-process lock.
 *
 * Freshness gate: a `.prev` whose `mtimeMs` is older than `maxPrevAgeMs`
 * (default 5_000 ms) is ignored — it is almost certainly a stale snapshot
 * from a much earlier rewrite, not the active mid-swap snapshot. This caps
 * the worst-case "served stale data because no current file exists" window;
 * outside that window, the reader sees `null` and decides what to do.
 *
 * Helper is util-layer; callers (`runs/store`, `learning/store`,
 * `tasks/store`, `jsonl-store`) consume it. No reverse dependency on those
 * stores — the helper only knows about `fs` and the logger.
 */
export interface SafeReadOptions {
  /** Max age of the `.prev` sibling to accept on ENOENT fallback. Default 5_000 ms. */
  maxPrevAgeMs?: number;
}

export interface SafeReadResult {
  content: string;
  /**
   * `primary` when `filePath` itself was readable; `prev` when the primary was
   * missing and a fresh `<filePath>.prev` covered the gap. Callers SHOULD
   * skip cache population when `source === "prev"` so a transient mid-rename
   * snapshot does not poison the cache and survive past the rename window.
   */
  source: "primary" | "prev";
}

const DEFAULT_MAX_PREV_AGE_MS = 5_000;

/**
 * Try reading `filePath`. On `ENOENT`, fall back to `<filePath>.prev` if its
 * mtime is within `maxPrevAgeMs` of now. Returns `null` when both primary and
 * any acceptable `.prev` are missing. Re-throws any non-ENOENT error from
 * either read so genuine I/O failures surface to the caller.
 */
export async function readWithPrevFallback(
  filePath: string,
  opts: SafeReadOptions = {},
): Promise<SafeReadResult | null> {
  const maxPrevAgeMs = opts.maxPrevAgeMs ?? DEFAULT_MAX_PREV_AGE_MS;

  try {
    const content = await fs.readFile(filePath, "utf8");
    return { content, source: "primary" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const prevPath = `${filePath}.prev`;
  let prevStat;
  try {
    prevStat = await fs.stat(prevPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  if (!prevStat.isFile()) {
    return null;
  }
  const delta = Date.now() - prevStat.mtimeMs;
  if (delta > maxPrevAgeMs) {
    return null;
  }

  let content: string;
  try {
    content = await fs.readFile(prevPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // .prev vanished between stat and read — another rewrite cycle ran.
      // Treat as miss; the caller will retry on the next tick if needed.
      return null;
    }
    throw err;
  }

  logger.info("safe_read_fallback", {
    details: { path: filePath, mtime_delta_ms: delta },
  });

  return { content, source: "prev" };
}
