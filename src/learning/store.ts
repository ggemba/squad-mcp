import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  AGENT_NAMES_TUPLE,
  type AgentName,
} from "../config/ownership-matrix.js";
import { SquadError } from "../errors.js";
import { logger } from "../observability/logger.js";

/**
 * One row in `.squad/learnings.jsonl`. Append-only — entries are never
 * rewritten, just superseded by later ones with the same (agent, finding,
 * scope) tuple. Keep the schema small; rich query semantics are out of
 * scope for V1 (the consolidator does free-text recall, not vector search).
 */
const learningEntrySchema = z.object({
  /** ISO 8601 timestamp. Required for ordering. */
  ts: z.string().min(1).max(40),
  /** PR number when recorded from `/squad-review #N`; optional otherwise. */
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

function resolveLearningFile(
  workspaceRoot: string,
  configuredPath: string | undefined,
): string {
  const rel = configuredPath ?? DEFAULT_LEARNING_PATH;
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
  if (
    cached &&
    cached.filePath === filePath &&
    cached.mtimeMs === stat.mtimeMs
  ) {
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
  let lineNo = 0;
  for (const line of lines) {
    lineNo++;
    const trimmed = line.trim();
    if (trimmed === "") continue; // skip blank lines (trailing newline, spacing)
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new SquadError(
        "INVALID_INPUT",
        `${filePath}:${lineNo}: invalid JSON: ${(err as Error).message}`,
        { source: filePath, line: lineNo },
      );
    }
    const validated = learningEntrySchema.safeParse(parsed);
    if (!validated.success) {
      throw new SquadError(
        "INVALID_INPUT",
        `${filePath}:${lineNo}: schema violation: ${validated.error.message}`,
        {
          source: filePath,
          line: lineNo,
          issues: validated.error.issues.length,
        },
      );
    }
    entries.push(validated.data);
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

  // One JSON object per line, no pretty-print — keeps the file grep-friendly
  // and minimises diff churn when entries get re-ordered (which they don't,
  // but defensive).
  const line = JSON.stringify(validated.data) + "\n";
  await fs.appendFile(filePath, line, "utf8");

  // Invalidate cache so next readLearnings reflects the append.
  const absRoot = path.resolve(workspaceRoot);
  cache.delete(absRoot);

  logger.info("learning appended", {
    details: {
      file: filePath,
      agent: validated.data.agent,
      decision: validated.data.decision,
    },
  });

  return { filePath, entry: validated.data };
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
