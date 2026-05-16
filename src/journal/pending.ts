import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SquadError } from "../errors.js";
import { ensureRelativeInsideRoot } from "../util/path-safety.js";
import { logger } from "../observability/logger.js";

/**
 * PENDING JOURNAL STORE — staging buffer for auto-journaling breadcrumbs
 * (PR1 / Fase 1a). The opt-in PostToolUse hook (`hooks/post-tool-use.mjs`)
 * appends one JSONL breadcrumb per Edit/Write tool call; this module is the
 * TypeScript-side reader and drainer of that staging file.
 *
 * ── Why this module BYPASSES `JsonlStore<T>` ───────────────────────────────
 * Every other JSONL journal in this package (runs, learnings) goes through
 * the generic `JsonlStore<T>`, whose type constraint is `T extends { schema_
 * version: ... }` — every row carries a version literal so readers can
 * skip+log rows from an incompatible client. The pending store CANNOT
 * satisfy that constraint, and does so DELIBERATELY:
 *
 *  - The writer is `hooks/post-tool-use.mjs` — a zero-dependency standalone
 *    Node script copied into the user's `.squad/hooks/`. It is not part of
 *    the esbuild bundle and cannot `import { CURRENT_SCHEMA_VERSION }` from
 *    `src/`. Forcing a version field on it would mean hard-coding a magic
 *    number in the hook that silently drifts from the real constant.
 *  - Pending rows are SHORT-LIVED. They are a transient staging buffer, not
 *    a durable journal: a breadcrumb lives only from "hook appended it" to
 *    "drain consumed it". There is no long-tail cross-version read problem
 *    for `JsonlStore`'s version gate to solve.
 *
 * So `pendingEntrySchema` is intentionally VERSION-LESS, and this module
 * hand-rolls the read/quarantine/cache discipline (mirrored line-for-line
 * after `src/runs/store.ts`) rather than instantiating `JsonlStore`.
 *
 * ── Why drain uses an ATOMIC RENAME ────────────────────────────────────────
 * `drainPending` does NOT read-then-truncate. It `fs.rename`s the pending
 * file to a uniquely-named sibling, then reads + unlinks that sibling. Rename
 * is atomic on POSIX, so there is NO window where a concurrent hook append
 * could land in a file that drain is about to truncate: an append racing the
 * drain either lands in the old inode (and gets drained) or in a fresh file
 * the next `fs.open(..., "a")` creates (and gets drained next time). No lock
 * is needed on either side — which is exactly why the hook holds none.
 *
 * ── PR2 NOTE — prompt-rendering safety ─────────────────────────────────────
 * Pending rows carry a `path` and `tool` string sourced from tool input.
 * The hook already sanitises (NUL / over-long / traversal), and this schema
 * re-asserts the NUL refine. But any PR2 consumer that renders these strings
 * INTO AN LLM PROMPT (the distillation/retrieval step) MUST additionally
 * pass them through `sanitizeForPrompt` (`src/util/prompt-sanitize.ts`) —
 * lexical path safety is not the same guarantee as prompt-injection safety.
 */

/**
 * Zod schema for one pending breadcrumb. Version-less by design (see header).
 *
 *  - `ts`   — ISO 8601 timestamp. 1..40 chars, same bound as the runs store.
 *  - `tool` — the Claude Code tool name (`Edit`, `Write`, ...). 1..256.
 *  - `path` — the edited file path, or `null` when the hook could not safely
 *             capture one. Bounded at 4096 (`PATH_MAX`).
 *
 * The `.refine` rejecting NUL bytes on `tool` and `path` mirrors the
 * learnings store's NUL refine: even though the hook already drops NUL-bearing
 * input, the store schema rejects a hostile row independently in case a
 * future writer bypasses the hook.
 */
export const pendingEntrySchema = z.object({
  ts: z.string().min(1).max(40),
  tool: z
    .string()
    .min(1)
    .max(256)
    .refine((v) => v.indexOf("\0") === -1, "must not contain NUL byte"),
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine((v) => v.indexOf("\0") === -1, "must not contain NUL byte")
    .nullable(),
});

export type PendingEntry = z.infer<typeof pendingEntrySchema>;

/**
 * Default location for the staging file, relative to workspace_root. The hook
 * writes the same path. Gitignored — pending breadcrumbs are local-only
 * transient state, never committed.
 */
export const DEFAULT_PENDING_PATH = ".squad/pending-journal.jsonl";

interface PendingOptions {
  /** Override the staging file location. Validated workspace-relative. */
  configuredPath?: string;
}

/**
 * Per-process read cache, keyed by absolute workspace root. Invalidated on
 * mtime OR size change — same same-millisecond-write guard as `runs/store.ts`.
 */
interface CacheEntry {
  mtimeMs: number;
  size: number;
  filePath: string;
  entries: PendingEntry[];
}
const cache = new Map<string, CacheEntry>();

/** Test-only: clear the per-process cache. Production code MUST NOT call this. */
export function __resetCacheForTests(): void {
  cache.clear();
}

function resolvePendingFile(workspaceRoot: string, configuredPath: string | undefined): string {
  const rel = configuredPath ?? DEFAULT_PENDING_PATH;
  if (configuredPath !== undefined) {
    ensureRelativeInsideRoot(workspaceRoot, rel, "journaling.pending_path");
  }
  return path.resolve(workspaceRoot, rel);
}

/**
 * Parse the raw JSONL body into validated entries. Malformed lines (bad JSON
 * or schema violation) are SKIPPED and collected for quarantine; surrounding
 * valid lines survive — same discipline as `readRuns` in `src/runs/store.ts`.
 */
function parseLines(raw: string): {
  entries: PendingEntry[];
  corruptLines: { line: number; raw: string; reason: string }[];
} {
  const lines = raw.split(/\r?\n/);
  const entries: PendingEntry[] = [];
  const corruptLines: { line: number; raw: string; reason: string }[] = [];
  let lineNo = 0;
  for (const line of lines) {
    lineNo++;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      corruptLines.push({
        line: lineNo,
        raw: trimmed,
        reason: `invalid JSON: ${(err as Error).message}`,
      });
      continue;
    }
    const validated = pendingEntrySchema.safeParse(parsed);
    if (!validated.success) {
      corruptLines.push({
        line: lineNo,
        raw: trimmed,
        reason: `schema violation: ${validated.error.message}`,
      });
      continue;
    }
    entries.push(validated.data);
  }
  return { entries, corruptLines };
}

/**
 * Quarantine corrupt lines to a timestamped sibling file (mode 0o600), and
 * log once. Best-effort — a failure to write the quarantine file is
 * diagnostic, not load-bearing, so it is swallowed.
 */
async function quarantine(
  filePath: string,
  corruptLines: { line: number; raw: string; reason: string }[],
): Promise<void> {
  if (corruptLines.length === 0) return;
  const quarantinePath = `${filePath}.corrupt-${Date.now()}.jsonl`;
  try {
    const body = corruptLines.map((c) => `# line ${c.line}: ${c.reason}\n${c.raw}\n`).join("");
    await fs.writeFile(quarantinePath, body, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Diagnostic, not load-bearing.
  }
  logger.warn("pending-journal: corrupt lines quarantined", {
    details: {
      file: filePath,
      quarantine: quarantinePath,
      count: corruptLines.length,
      lines: corruptLines.map((c) => c.line),
    },
  });
}

/**
 * Read all pending breadcrumbs. Returns `[]` if the staging file does not
 * exist (no journaling activity yet). Malformed lines are skipped, logged,
 * and quarantined to a `.corrupt-<ts>.jsonl` sibling; valid lines return in
 * append order. Results are cached per-process, invalidated by mtime+size.
 */
export async function readPending(
  workspaceRoot: string,
  opts: PendingOptions = {},
): Promise<PendingEntry[]> {
  const filePath = resolvePendingFile(workspaceRoot, opts.configuredPath);
  const absRoot = path.resolve(workspaceRoot);

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return [];
  }
  if (!stat.isFile()) return [];

  const cached = cache.get(absRoot);
  if (
    cached &&
    cached.filePath === filePath &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size
  ) {
    return cached.entries;
  }

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    throw new SquadError(
      "CONFIG_READ_FAILED",
      `failed to read pending journal ${filePath}: ${(err as Error).message}`,
      { source: filePath },
    );
  }

  const { entries, corruptLines } = parseLines(raw);
  await quarantine(filePath, corruptLines);

  cache.set(absRoot, { mtimeMs: stat.mtimeMs, size: stat.size, filePath, entries });
  return entries;
}

/**
 * Drain the pending journal: atomically claim every breadcrumb written so far
 * and return it, leaving an empty (absent) pending file behind.
 *
 * Mechanism — ATOMIC RENAME, no read-then-truncate:
 *  1. `fs.rename` the pending file to a unique `.draining-<ts>.jsonl` sibling.
 *     A concurrent hook append racing this either lands in the old inode
 *     (drained now) or in a fresh file the next append creates (drained next
 *     time) — there is no loss window, and no lock is needed.
 *  2. Read + parse the renamed sibling.
 *  3. `fs.unlink` the sibling.
 *
 * Returns `[]` when there is nothing to drain (ENOENT on the rename).
 *
 * Consumed by the `drain_journal` MCP tool (`src/tools/drain-journal.ts`),
 * which folds the drained paths into the terminal RunRecord's `touched_paths`.
 */
export async function drainPending(
  workspaceRoot: string,
  opts: PendingOptions = {},
): Promise<PendingEntry[]> {
  const filePath = resolvePendingFile(workspaceRoot, opts.configuredPath);
  const absRoot = path.resolve(workspaceRoot);
  const drainingPath = `${filePath}.draining-${Date.now()}.jsonl`;

  try {
    await fs.rename(filePath, drainingPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    // NOTE: `CONFIG_READ_FAILED` is reused here as the closest existing
    // generic "journal I/O failed" code — this is a rename failure, not a
    // config read, but `src/errors.ts` carries no drain-specific code and a
    // dedicated one is not worth the surface for a best-effort drain. The
    // squad skill treats any SquadError from `drain_journal` as non-blocking
    // telemetry loss.
    throw new SquadError(
      "CONFIG_READ_FAILED",
      `failed to rename pending journal for drain: ${(err as Error).message}`,
      { source: filePath },
    );
  }

  let raw: string;
  try {
    raw = await fs.readFile(drainingPath, "utf8");
  } catch (err) {
    throw new SquadError(
      "CONFIG_READ_FAILED",
      `failed to read draining file ${drainingPath}: ${(err as Error).message}`,
      { source: drainingPath },
    );
  }

  const { entries, corruptLines } = parseLines(raw);
  await quarantine(drainingPath, corruptLines);

  try {
    await fs.unlink(drainingPath);
  } catch {
    // Non-fatal: the breadcrumbs are already parsed and returned. A leftover
    // `.draining-*.jsonl` is gitignored and harmless; the next drain ignores it.
  }

  // Invalidate the read cache — the pending file is now gone.
  cache.delete(absRoot);
  return entries;
}
