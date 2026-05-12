import { z } from "zod";
import { AGENT_NAMES_TUPLE, type AgentName } from "../config/ownership-matrix.js";
import { SquadError } from "../errors.js";
import { JsonlStore } from "../util/jsonl-store.js";

/**
 * Hard cap per JSONL entry so a single line fits in POSIX PIPE_BUF
 * (4096 bytes) and `fs.appendFile` remains atomic w.r.t. concurrent
 * appenders. Length includes serialised JSON + trailing newline.
 *
 * Identical to the cap inside `JsonlStore` (4000), exposed here for the
 * binary-search truncation that runs BEFORE the store-level write. We keep
 * truncation at this layer (not inside JsonlStore) because the soft-truncate
 * behaviour is learning-specific — runs/store rejects oversize records hard,
 * which is also the JsonlStore default.
 */
const MAX_ENTRY_BYTES = 4_000;

/**
 * One row in `.squad/learnings.jsonl`. Append-only — entries are never
 * rewritten, just superseded by later ones with the same (agent, finding,
 * scope) tuple. Keep the schema small; rich query semantics are out of
 * scope for V1 (the consolidator does free-text recall, not vector search).
 *
 * v0.14.x deep-review D1: `schema_version` added as the FIRST field with
 * `.default(1)`. Legacy rows that lack this field are coerced to v1 on read
 * via the Zod default. Future v2 rows are filtered at the JsonlStore
 * schema_version pre-check (skip+log, not quarantine).
 */
const learningEntrySchema = z.object({
  /** Schema version. Bump when breaking changes ship. Legacy rows default to 1. */
  schema_version: z.literal(1).default(1),
  /** ISO 8601 timestamp. Required for ordering. */
  ts: z.string().min(1).max(40),
  /** PR number when recorded from `/squad:review #N`; optional otherwise. */
  pr: z.number().int().positive().optional(),
  /**
   * Branch name when recorded from a local review (no PR ref). v0.11.0
   * cycle-2 (security Major M2): NUL-byte rejection mirrors the tool-edge
   * `SafeString` so the store schema rejects a hostile row even if a
   * future caller bypasses the tool.
   */
  branch: z
    .string()
    .min(1)
    .max(255)
    .refine((v) => v.indexOf("\0") === -1, "must not contain NUL byte")
    .optional(),
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
  scope: z
    .string()
    .min(1)
    .max(512)
    .refine((v) => v.indexOf("\0") === -1, "must not contain NUL byte")
    .optional(),
  /**
   * v0.11.0+ lifecycle fields. All optional and additive — a v0.10.x reader
   * encountering these fields silently strips them (Zod default), so the
   * journal can be read by older clients without crashing. A v0.11.0+ reader
   * uses them to suppress (archived) or surface (promoted) entries.
   *
   * - `archived: true` — entry is past `max_age_days` and is hidden from
   *   default `readLearnings` output. Set by `prune_learnings`. The entry
   *   stays on disk for forensics; not deleted.
   * - `promoted: true` — entry has been accepted ≥ `min_recurrence` times
   *   (across all agents, matched by `normalizeFindingTitle`) and is surfaced
   *   FIRST in the rendered learnings block regardless of scope match.
   *   Promoted entries represent crystallised team policy.
   *
   * Note: `recurrence_count` is NOT stored (planner cycle-1 Blocker B3 —
   * storing it creates a write-while-write race when parallel advisors
   * record). Promotion logic counts lazily inside `prune_learnings` and
   * `read_learnings` rendering instead.
   */
  archived: z.boolean().optional(),
  promoted: z.boolean().optional(),
});

export type LearningEntry = z.infer<typeof learningEntrySchema>;

/**
 * Default location for the JSONL file, relative to workspace_root. Repo-versioned
 * by convention; the team commits `.squad/learnings.jsonl` along with the code so
 * decisions are auditable in PR diffs.
 */
export const DEFAULT_LEARNING_PATH = ".squad/learnings.jsonl";

/**
 * Module-scope singleton. The JsonlStore class is generic and per-instance —
 * instantiating per public-function call would throw away the per-process
 * cache on every call. We instantiate ONCE at module load and have the
 * legacy `appendLearning` / `readLearnings` / `__resetLearningStoreCacheForTests`
 * wrappers delegate to it. The `maxRecordBytes` ceiling is left at the
 * JsonlStore default (4000); the consumer-side soft truncation in
 * `appendLearning` keeps lines well under that.
 */
const store = new JsonlStore<LearningEntry>({
  defaultPath: DEFAULT_LEARNING_PATH,
  schema: learningEntrySchema,
  maxRecordBytes: MAX_ENTRY_BYTES,
  settingName: "learnings.path",
  label: "learnings",
});

/** Test-only: clear the per-process cache. Production code MUST NOT call this. */
export function __resetLearningStoreCacheForTests(): void {
  store.__resetCacheForTests();
}

/**
 * Read all learnings from the JSONL file. Returns [] if the file does not exist
 * (a fresh repo with no decisions recorded is the common case). Corrupt rows
 * are quarantined to a timestamped sibling file; rows with unknown
 * `schema_version` are skipped and logged. The surviving entries return in
 * append order.
 */
export async function readLearnings(
  workspaceRoot: string,
  options: { configuredPath?: string } = {},
): Promise<LearningEntry[]> {
  return store.read(workspaceRoot, options);
}

/**
 * Append a new learning entry to the JSONL file. Creates the directory and
 * file if needed. Atomic at the append level (single write under file lock);
 * concurrent appenders serialise via the cross-process lock.
 *
 * Stamps the timestamp here if the caller did not supply one — gives a single
 * source of clock truth and prevents stale ts in CLI invocations.
 *
 * Soft-truncates `reason` then `finding` when the serialised line exceeds
 * MAX_ENTRY_BYTES, so realistic legitimate entries always land instead of
 * throwing RECORD_TOO_LARGE. Truncated fields gain a "…[truncated]" marker.
 */
export async function appendLearning(
  workspaceRoot: string,
  entry: Omit<LearningEntry, "ts" | "schema_version"> & {
    ts?: string;
    schema_version?: 1;
  },
  options: { configuredPath?: string } = {},
): Promise<{ filePath: string; entry: LearningEntry }> {
  const ts = entry.ts ?? new Date().toISOString();
  // Always set schema_version: 1 explicitly before delegating. The Zod
  // `.default(1)` would handle a missing field on READ, but on WRITE we want
  // the field present in the JSON line so older readers (and grep tooling)
  // see it directly without relying on schema defaults.
  const candidate: LearningEntry = {
    ...entry,
    schema_version: 1,
    ts,
  };

  const validated = learningEntrySchema.safeParse(candidate);
  if (!validated.success) {
    throw new SquadError(
      "INVALID_INPUT",
      `learning entry schema violation: ${validated.error.message}`,
      { issues: validated.error.issues.length },
    );
  }

  // Cap the serialised line at MAX_ENTRY_BYTES so the line stays atomic
  // w.r.t. concurrent appenders. When the entry exceeds the cap we truncate
  // `reason` first, then `finding`, until it fits. Same binary-search shrink
  // as the v0.14.0 implementation — keeps tests/learning-store.test.ts'
  // oversize case passing.
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

  // Delegate to the JsonlStore which owns the lock, mode-0o600 discipline,
  // and cache invalidation. We pass the already-truncated entry; JsonlStore
  // re-validates (cheap) and writes the canonical JSON.
  return store.append(workspaceRoot, toWrite, options);
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
