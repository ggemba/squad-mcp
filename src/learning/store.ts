import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AGENT_NAMES_TUPLE, type AgentName } from "../config/ownership-matrix.js";
import { SquadError } from "../errors.js";
import { ensureRelativeInsideRoot } from "../util/path-safety.js";
import { withFileLock } from "../util/file-lock.js";
import { logger } from "../observability/logger.js";

/**
 * Hard cap per JSONL entry so a single line fits in POSIX PIPE_BUF
 * (4096 bytes) and `fs.appendFile` remains atomic w.r.t. concurrent
 * appenders. Length includes serialised JSON + trailing newline.
 */
const MAX_ENTRY_BYTES = 4_000;

/**
 * One row in `.squad/learnings.jsonl`. Append-only — entries are never
 * rewritten, just superseded by later ones with the same (agent, finding,
 * scope) tuple. Keep the schema small; rich query semantics are out of
 * scope for V1 (the consolidator does free-text recall, not vector search).
 */
const learningEntrySchema = z.object({
  /** ISO 8601 timestamp. Required for ordering. */
  ts: z.string().min(1).max(40),
  /** PR number when recorded from `/squad:review #N`; optional otherwise. */
  pr: z.number().int().positive().optional(),
  /** Branch name when recorded from a local review (no PR ref). */
  branch: z.string().min(1).max(255).optional(),
  /** Which agent's finding this decision concerns. */
  agent: z.enum(AGENT_NAMES_TUPLE),
  /** Severity at the time of the decision (Blocker / Major / Minor / Suggestion). */
  severity: z.enum(["Blocker", "Major", "Minor", "Suggestion"]).optional(),
  /** Short title of the finding — same shape as Finding.title in consolidate. */
  finding: z.string().min(1).max(2048),
  /** Whether the team accepted or rejected this finding. */
  decision: z.enum(["accept", "reject"]),
  /** Free-form rationale. Surfaces in the consolidator prompt. */
  reason: z.string().max(4096).optional(),
  /**
   * Glob-ish path scope this decision applies to (e.g. "src/auth/**"). When
   * absent, the decision applies repo-wide. Used by the formatter to filter
   * learnings down to those relevant to the current diff.
   */
  scope: z.string().min(1).max(512).optional(),
});

export type LearningEntry = z.infer<typeof learningEntrySchema>;

/**
 * Default location for the JSONL file, relative to workspace_root. Repo-versioned
 * by convention; the team commits `.squad/learnings.jsonl` along with the code so
 * decisions are auditable in PR diffs.
 */
export const DEFAULT_LEARNING_PATH = ".squad/learnings.jsonl";

interface CacheEntry {
  mtimeMs: number;
  filePath: string;
  /** Parsed entries in file order (oldest first). Slice tail-N from end. */
  entries: LearningEntry[];
}
const cache = new Map<string, CacheEntry>();

/** Test-only: clear the per-process cache. Production code MUST NOT call this. */
export function __resetLearningStoreCacheForTests(): void {
  cache.clear();
}

function resolveLearningFile(workspaceRoot: string, configuredPath: string | undefined): string {
  const rel = configuredPath ?? DEFAULT_LEARNING_PATH;
  if (configuredPath !== undefined) {
    ensureRelativeInsideRoot(workspaceRoot, rel, "learnings.path");
  }
  return path.resolve(workspaceRoot, rel);
}

/**
 * Read all learnings from the JSONL file. Returns [] if the file does not exist
 * (a fresh repo with no decisions recorded is the common case). Throws on
 * parse failure of any individual line — callers may want to soft-fail, but
 * silent corruption is worse than loud rejection.
 */
export async function readLearnings(
  workspaceRoot: string,
  options: { configuredPath?: string } = {},
): Promise<LearningEntry[]> {
  const filePath = resolveLearningFile(workspaceRoot, options.configuredPath);
  const absRoot = path.resolve(workspaceRoot);

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    // No file — first run, no learnings yet.
    return [];
  }
  if (!stat.isFile()) {
    return [];
  }

  const cached = cache.get(absRoot);
  if (cached && cached.filePath === filePath && cached.mtimeMs === stat.mtimeMs) {
    return cached.entries;
  }

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    throw new SquadError(
      "CONFIG_READ_FAILED",
      `failed to read learnings file ${filePath}: ${(err as Error).message}`,
      { source: filePath },
    );
  }

  const lines = raw.split(/\r?\n/);
  const entries: LearningEntry[] = [];
  const corruptLines: { line: number; raw: string; reason: string }[] = [];
  let lineNo = 0;
  for (const line of lines) {
    lineNo++;
    const trimmed = line.trim();
    if (trimmed === "") continue; // skip blank lines (trailing newline, spacing)
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      // Quarantine bad line, keep reading. Earlier behaviour threw and bricked
      // the whole store for one bad line — a hand-edit or partial write would
      // make every read fail. Now we move the line aside and continue.
      corruptLines.push({
        line: lineNo,
        raw: trimmed,
        reason: `invalid JSON: ${(err as Error).message}`,
      });
      continue;
    }
    const validated = learningEntrySchema.safeParse(parsed);
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

  if (corruptLines.length > 0) {
    // Move corrupt lines to a timestamped quarantine file alongside the source.
    // Best-effort: if the write fails we still surface the warning so the
    // operator notices. The original file is left untouched.
    const quarantinePath = `${filePath}.corrupt-${Date.now()}.jsonl`;
    try {
      const body = corruptLines.map((c) => `# line ${c.line}: ${c.reason}\n${c.raw}\n`).join("");
      await fs.writeFile(quarantinePath, body, "utf8");
    } catch {
      // Swallow — quarantine write is diagnostic, not load-bearing.
    }
    logger.warn("learnings: corrupt lines quarantined", {
      details: {
        file: filePath,
        quarantine: quarantinePath,
        count: corruptLines.length,
        lines: corruptLines.map((c) => c.line),
      },
    });
  }

  cache.set(absRoot, { mtimeMs: stat.mtimeMs, filePath, entries });
  return entries;
}

/**
 * Append a new learning entry to the JSONL file. Creates the directory and
 * file if needed. Atomic at the append level (single fs.appendFile call —
 * Node serialises this on POSIX); concurrent appenders may interleave entries
 * but never corrupt them line-wise.
 *
 * Stamps the timestamp here if the caller did not supply one — gives a single
 * source of clock truth and prevents stale ts in CLI invocations.
 */
export async function appendLearning(
  workspaceRoot: string,
  entry: Omit<LearningEntry, "ts"> & { ts?: string },
  options: { configuredPath?: string } = {},
): Promise<{ filePath: string; entry: LearningEntry }> {
  const ts = entry.ts ?? new Date().toISOString();
  const candidate: LearningEntry = { ...entry, ts };

  const validated = learningEntrySchema.safeParse(candidate);
  if (!validated.success) {
    throw new SquadError(
      "INVALID_INPUT",
      `learning entry schema violation: ${validated.error.message}`,
      { issues: validated.error.issues.length },
    );
  }

  const filePath = resolveLearningFile(workspaceRoot, options.configuredPath);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  // Cap the serialised line at MAX_ENTRY_BYTES so `fs.appendFile` stays atomic
  // w.r.t. concurrent appenders (POSIX guarantees atomicity for writes <=
  // PIPE_BUF, typically 4096B). When the entry exceeds the cap we truncate
  // `reason` first, then `finding`, until it fits.
  let toWrite = { ...validated.data };
  let line = JSON.stringify(toWrite) + "\n";
  for (const field of ["reason", "finding"] as const) {
    if (Buffer.byteLength(line, "utf8") <= MAX_ENTRY_BYTES) break;
    const v = toWrite[field];
    if (typeof v !== "string" || v.length === 0) continue;
    let lo = 0;
    let hi = v.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      const candidate = {
        ...toWrite,
        [field]: v.slice(0, mid) + "…[truncated]",
      };
      const candidateLine = JSON.stringify(candidate) + "\n";
      if (Buffer.byteLength(candidateLine, "utf8") <= MAX_ENTRY_BYTES) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    toWrite = { ...toWrite, [field]: v.slice(0, lo) + "…[truncated]" };
    line = JSON.stringify(toWrite) + "\n";
  }

  // Cross-process lock around the append. Even though appendFile is atomic
  // for writes <= PIPE_BUF, two processes hitting the same file simultaneously
  // can still produce interleaved bytes near the boundary on some filesystems.
  // The lock makes that race impossible at a cheap cost.
  await withFileLock(filePath, async () => {
    await fs.appendFile(filePath, line, "utf8");
  });

  // Invalidate cache so next readLearnings reflects the append.
  const absRoot = path.resolve(workspaceRoot);
  cache.delete(absRoot);

  logger.info("learning appended", {
    details: {
      file: filePath,
      agent: toWrite.agent,
      decision: toWrite.decision,
    },
  });

  return { filePath, entry: toWrite };
}

/**
 * Filter helper: pick the most recent N entries, optionally narrowed by
 * agent. Used by the formatter to inject a small, relevant slice into the
 * agent / consolidator prompt.
 *
 * Sort: input is in append order (oldest first). We slice the tail. The
 * filter happens BEFORE the slice — `recentForAgent('senior-dba', 50)`
 * returns the last 50 DBA decisions, not the last 50 decisions overall
 * filtered to DBA (which would often return zero on diverse repos).
 */
export function tailRecent(
  entries: LearningEntry[],
  limit: number,
  options: { agent?: AgentName; decision?: "accept" | "reject" } = {},
): LearningEntry[] {
  let filtered = entries;
  if (options.agent) {
    filtered = filtered.filter((e) => e.agent === options.agent);
  }
  if (options.decision) {
    filtered = filtered.filter((e) => e.decision === options.decision);
  }
  return filtered.slice(-limit);
}
