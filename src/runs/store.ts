import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AGENT_NAMES_TUPLE } from "../config/ownership-matrix.js";
import { SquadError } from "../errors.js";
import { ensureRelativeInsideRoot } from "../util/path-safety.js";
import { withFileLock } from "../util/file-lock.js";
import { logger } from "../observability/logger.js";
import { SafeString } from "../tools/_shared/schemas.js";

/**
 * SQUAD RUNS STORE — telemetry journal for skill invocations. As of v0.10.0
 * the legitimate writers are the squad skill (`/squad:implement` and
 * `/squad:review`, invocations `implement | review | task`) and the debug
 * skill (`/squad:debug`, invocation `debug`). Each writer follows the same
 * two-phase contract: one row at start (`in_flight`) and one at end
 * (`completed | aborted`), paired by id. Mirrored line-for-line after
 * `src/learning/store.ts` — same lock + quarantine + mtime cache + atomic-
 * append-under-PIPE_BUF discipline.
 *
 * Plan v4 (cycle 2 advisory consensus) explicit decisions:
 *
 *  - NO multi-row partial fallback. If `JSON.stringify(record)` exceeds
 *    MAX_RECORD_BYTES the store rejects with `RECORD_TOO_LARGE` rather
 *    than splitting into continuation rows. Five advisors converged on
 *    "splitting erodes the one-row-per-record JSONL invariant and
 *    reopens parsing ambiguities"; rejection puts the burden on the
 *    caller to cap their `mode_warning.message` (already capped 512B)
 *    or shorten their inputs.
 *
 *  - File mode 0o600 (user-only), directory mode 0o700. The journal
 *    contains commit refs and prompt-length signals that can leak
 *    business context (branch names like `feat/acme-acquisition`); on
 *    shared workstations world-readable 0o644 would expose them to
 *    co-tenants.
 *
 *  - Single-writer contract: the squad skill (`skills/squad/SKILL.md`)
 *    AND the debug skill (`skills/debug/SKILL.md`) are the only legitimate
 *    callers of `appendRun`. `apply_consolidation_rules` and other server-
 *    side code MUST NOT emit terminal rows; doing so breaks the two-phase
 *    `(in_flight, completed)` pair-by-id invariant.
 */

/**
 * Hard cap per JSONL entry so a single line fits in POSIX PIPE_BUF
 * (4096 bytes) and `fs.appendFile` remains atomic w.r.t. concurrent
 * appenders. Length includes serialised JSON + trailing newline.
 *
 * Realistic finalization row with 9 agents + capped mode_warning.message
 * lands around 1.5-2 KB — well under the limit. Oversize is a hard error,
 * not a soft truncation (see RECORD_TOO_LARGE in errors.ts).
 */
export const MAX_RECORD_BYTES = 4_000;

/**
 * Default location for the JSONL file, relative to workspace_root.
 * Defaults are gitignored at the v0.9.0 release — the journal contains
 * local-only operational telemetry; users opting into team-wide sharing
 * remove `.squad/runs.jsonl` from their `.gitignore` deliberately.
 */
export const DEFAULT_RUNS_PATH = ".squad/runs.jsonl";

/**
 * Severity tally compacted into a single sortable number. The cycle-1
 * design carried `{ Blocker, Major, Minor, Suggestion }` per agent
 * (~30 bytes / agent of JSON overhead); cycle 2 architects + dev flagged
 * this as PIPE_BUF-budget waste on 9-agent runs. Collapsed to one number
 * with positional digits: B*1000 + M*100 + m*10 + s. Inverse decode in
 * aggregate.ts. Safe up to 9 of each severity per agent (more than that
 * is itself a signal something went sideways).
 */
function severityScore(counts: {
  Blocker: number;
  Major: number;
  Minor: number;
  Suggestion: number;
}): number {
  return counts.Blocker * 1000 + counts.Major * 100 + counts.Minor * 10 + counts.Suggestion;
}

/** Inverse of `severityScore`. Used by aggregate.ts. */
export function decodeSeverityScore(n: number): {
  Blocker: number;
  Major: number;
  Minor: number;
  Suggestion: number;
} {
  return {
    Blocker: Math.floor(n / 1000),
    Major: Math.floor((n % 1000) / 100),
    Minor: Math.floor((n % 100) / 10),
    Suggestion: n % 10,
  };
}

/** Public re-export so callers can build records without re-implementing the encoding. */
export { severityScore };

const InvocationEnum = z.enum(["implement", "review", "task", "question", "brainstorm", "debug"]);
const ModeEnum = z.enum(["quick", "normal", "deep"]);
const ModeSourceEnum = z.enum(["user", "auto"]);
const StatusEnum = z.enum(["in_flight", "completed", "aborted"]);
const WorkTypeEnum = z.enum([
  "Feature",
  "Bug Fix",
  "Refactor",
  "Performance",
  "Security",
  "Business Rule",
]);
const VerdictEnum = z.enum(["APPROVED", "CHANGES_REQUIRED", "REJECTED"]);

const ModelEnum = z.enum(["haiku", "sonnet", "opus", "inherit"]);

const GitRefSchema = z
  .object({
    kind: z.enum(["head", "diff_base", "pr_head"]),
    value: SafeString(200),
  })
  .nullable();

/**
 * Per-agent dispatch metrics captured by the squad skill orchestrator.
 *
 *  - `batch_duration_ms` (renamed from `duration_ms` in v0.9.0): wall-clock
 *    from this agent's Task() dispatch to its result. Note that advisors in
 *    a parallel batch overlap; this is "round-trip latency for this dispatch"
 *    not "exclusive time spent on this agent's work". Reflected in the
 *    /squad:stats output label.
 *
 *  - `prompt_chars` / `response_chars` (renamed from input/output_chars in
 *    v0.9.0): orchestrator-visible character counts of the dispatch prompt
 *    and the agent's returned string. EXCLUDES the agent's own internal
 *    tool_use roundtrips (file reads, sub-dispatches like code-explorer).
 *    For agents that read heavily, the recorded chars are a substantial
 *    underestimate — documented in `est_tokens_method` and rendered in the
 *    stats panel disclaimer.
 *
 *  - `severity_score`: encoded findings tally (see severityScore()).
 */
const AgentMetricsSchema = z.object({
  name: z.enum(AGENT_NAMES_TUPLE),
  model: ModelEnum,
  score: z.number().int().min(0).max(100).nullable(),
  severity_score: z.number().int().min(0).max(9999).nullable(),
  batch_duration_ms: z.number().int().nonnegative().finite(),
  prompt_chars: z.number().int().nonnegative().finite(),
  response_chars: z.number().int().nonnegative().finite(),
});

/**
 * RunRecord schema_version 1. PUBLIC STABLE CONTRACT from v0.9.0 — readers
 * (the `list_runs` MCP tool, the `/squad:stats` skill) key on
 * `schema_version` and quarantine unknown versions rather than failing.
 *
 * Discriminated by `status`:
 *  - `in_flight` rows carry only the Phase-1-known fields (skill knows what
 *    it's about to do; verdict/scores are still pending).
 *  - `completed | aborted` rows carry full metrics + verdict.
 *
 * For ergonomics under Zod we keep finalisation fields optional on the base
 * schema rather than splitting into two schemas; the writer validates the
 * appropriate subset at the call site (`appendRun` vs `finalizeRun`).
 */
const runRecordSchema = z.object({
  schema_version: z.literal(1),
  id: SafeString(40),
  status: StatusEnum,
  started_at: SafeString(40),
  completed_at: SafeString(40).optional(),
  duration_ms: z.number().int().nonnegative().finite().optional(),
  invocation: InvocationEnum,
  mode: ModeEnum,
  mode_source: ModeSourceEnum,
  work_type: WorkTypeEnum.optional(),
  git_ref: GitRefSchema,
  files_count: z.number().int().nonnegative().finite(),
  agents: z.array(AgentMetricsSchema).max(20),
  verdict: VerdictEnum.nullable().optional(),
  weighted_score: z.number().min(0).max(100).nullable().optional(),
  est_tokens_method: z.literal("chars-div-3.5"),
  mode_warning: z
    .object({
      code: SafeString(64),
      message: SafeString(512),
    })
    .nullable()
    .optional(),
});

export type RunRecord = z.infer<typeof runRecordSchema>;
export type AgentMetrics = z.infer<typeof AgentMetricsSchema>;
export type GitRef = z.infer<typeof GitRefSchema>;
export type RunStatus = z.infer<typeof StatusEnum>;
export type RunInvocation = z.infer<typeof InvocationEnum>;
export type RunVerdict = z.infer<typeof VerdictEnum>;
export { runRecordSchema, WorkTypeEnum };

/**
 * Per-process cache. Same shape as learning-store.ts: keyed by absolute
 * workspace root, invalidated by mtime change. Multi-window editors with
 * two squad-mcp instances on the same repo invalidate cooperatively via
 * mtime — cross-process cache invalidation is over-engineering for 0.9.0
 * (architect A-7 finding).
 */
interface CacheEntry {
  mtimeMs: number;
  /**
   * File size at the time of caching. Used together with `mtimeMs` to guard
   * against same-millisecond writes that the (mtime-only) key would miss
   * (senior-developer cycle-2 Major). Two writes landing in the same ms keep
   * mtime identical; size always differs because each append-only line grows
   * the file. If both somehow match, the next mtime tick re-invalidates.
   */
  size: number;
  filePath: string;
  entries: RunRecord[];
}
const cache = new Map<string, CacheEntry>();

/** Test-only: clear the per-process cache. Production code MUST NOT call this. */
export function __resetRunsStoreCacheForTests(): void {
  cache.clear();
}

function resolveRunsFile(workspaceRoot: string, configuredPath: string | undefined): string {
  const rel = configuredPath ?? DEFAULT_RUNS_PATH;
  if (configuredPath !== undefined) {
    ensureRelativeInsideRoot(workspaceRoot, rel, "runs.path");
  }
  return path.resolve(workspaceRoot, rel);
}

/**
 * Generate a fresh run id. Date.now() base36 prefix + 6 chars from
 * [a-z0-9] (36^6 = 2.18B unique values per millisecond — collision
 * chance is effectively zero across realistic concurrent writers in
 * the same ms).
 */
export function generateRunId(): string {
  const ts = Date.now().toString(36);
  let suffix = "";
  const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 6; i++) {
    suffix += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `${ts}-${suffix}`;
}

/**
 * Read all run records from the JSONL file. Returns `[]` if the file does
 * not exist (fresh repo, first run). Corrupt lines are quarantined to a
 * timestamped sibling file and logged once; the surviving entries return
 * in append order.
 *
 * Unknown `schema_version` rows are quarantined too — readers must NEVER
 * silently include rows they don't understand. The quarantine file is
 * `.squad/runs.jsonl.corrupt-<ts>.jsonl` alongside the source.
 */
export async function readRuns(
  workspaceRoot: string,
  options: { configuredPath?: string } = {},
): Promise<RunRecord[]> {
  const filePath = resolveRunsFile(workspaceRoot, options.configuredPath);
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
      `failed to read runs file ${filePath}: ${(err as Error).message}`,
      { source: filePath },
    );
  }

  const lines = raw.split(/\r?\n/);
  const entries: RunRecord[] = [];
  const corruptLines: { line: number; raw: string; reason: string }[] = [];
  let skippedUnknownVersion = 0;
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
    // Schema_version gate: skip+log instead of throwing. A future v2 writer
    // would otherwise brick v1 readers; this lets a heterogeneous-version
    // journal be partially read by older clients (architect A-6 + dev #11).
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "schema_version" in parsed &&
      (parsed as { schema_version: unknown }).schema_version !== 1
    ) {
      skippedUnknownVersion++;
      continue;
    }
    const validated = runRecordSchema.safeParse(parsed);
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

  if (skippedUnknownVersion > 0) {
    logger.warn("runs: skipped rows with unknown schema_version", {
      details: { file: filePath, count: skippedUnknownVersion },
    });
  }

  if (corruptLines.length > 0) {
    const quarantinePath = `${filePath}.corrupt-${Date.now()}.jsonl`;
    try {
      const body = corruptLines.map((c) => `# line ${c.line}: ${c.reason}\n${c.raw}\n`).join("");
      // Write quarantine with same restricted mode as the source.
      await fs.writeFile(quarantinePath, body, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Diagnostic, not load-bearing.
    }
    logger.warn("runs: corrupt lines quarantined", {
      details: {
        file: filePath,
        quarantine: quarantinePath,
        count: corruptLines.length,
        lines: corruptLines.map((c) => c.line),
      },
    });
  }

  cache.set(absRoot, { mtimeMs: stat.mtimeMs, size: stat.size, filePath, entries });
  return entries;
}

/**
 * Append one RunRecord. Validates against Zod, then enforces
 * MAX_RECORD_BYTES (post-serialisation) before acquiring the file lock.
 * Oversize records throw `RECORD_TOO_LARGE` — no silent split, no soft
 * truncation. The caller (the squad skill) is responsible for keeping
 * `mode_warning.message` capped and the agent list short enough that
 * realistic records stay well under the cap.
 */
export async function appendRun(
  workspaceRoot: string,
  record: RunRecord,
  options: { configuredPath?: string } = {},
): Promise<{ filePath: string; record: RunRecord }> {
  const validated = runRecordSchema.safeParse(record);
  if (!validated.success) {
    throw new SquadError(
      "INVALID_INPUT",
      `run record schema violation: ${validated.error.message}`,
      { issues: validated.error.issues.length },
    );
  }

  const line = JSON.stringify(validated.data) + "\n";
  const byteLen = Buffer.byteLength(line, "utf8");
  if (byteLen > MAX_RECORD_BYTES) {
    throw new SquadError(
      "RECORD_TOO_LARGE",
      `run record exceeds MAX_RECORD_BYTES (${byteLen} > ${MAX_RECORD_BYTES}); ` +
        `cap mode_warning.message or shorten inputs`,
      { byteLen, max: MAX_RECORD_BYTES, id: validated.data.id },
    );
  }

  const filePath = resolveRunsFile(workspaceRoot, options.configuredPath);
  const dir = path.dirname(filePath);
  // Directory mode 0o700 — user-only. Subsequent runs inherit the existing
  // mode if the dir already exists (mkdir recursive is idempotent on mode).
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  // Cross-process lock around the append. The lock file lives in the same
  // directory; file-lock.ts cleans it up in a finally.
  await withFileLock(filePath, async () => {
    // Create the journal with explicit mode 0o600 on first write. fs.open
    // honours mode only when O_CREAT applies (i.e. the file is being
    // created); subsequent appends ride the existing mode.
    const fh = await fs.open(filePath, "a", 0o600);
    try {
      await fh.writeFile(line, "utf8");
    } finally {
      await fh.close();
    }
  });

  // Invalidate cache so the next readRuns picks up the append.
  const absRoot = path.resolve(workspaceRoot);
  cache.delete(absRoot);

  logger.info("run recorded", {
    details: {
      file: filePath,
      id: validated.data.id,
      status: validated.data.status,
      invocation: validated.data.invocation,
    },
  });

  return { filePath, record: validated.data };
}
