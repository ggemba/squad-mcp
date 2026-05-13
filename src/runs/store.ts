import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AGENT_NAMES_TUPLE } from "../config/ownership-matrix.js";
import { SquadError } from "../errors.js";
import { ensureRelativeInsideRoot } from "../util/path-safety.js";
import { withFileLock } from "../util/file-lock.js";
import { logger } from "../observability/logger.js";
import { CURRENT_SCHEMA_VERSION } from "../util/schema-version.js";
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

/**
 * Strip C0 (`\x00`-`\x1F` except `\t`), C1 (`\x7F`-`\x9F`), and ESC (`\x1B`)
 * from a string before it lands on disk. This is the WRITER-side mirror of
 * the renderer's `aggregate.stripControlChars` (security #5).
 *
 * Defense in depth: render-time sanitisation protects users running
 * `/squad:stats`; writer-side sanitisation also protects users running
 * `cat .squad/runs.jsonl` or any other tool that bypasses the aggregator.
 * The regex is intentionally duplicated (3 lines, no runtime cost) rather
 * than importing from `aggregate.ts` because that would invert the natural
 * dep direction (store is foundational; aggregate consumes store).
 */
function stripWriterControlChars(s: string): string {
  return s.replace(/[\x00-\x08\x0A-\x1F\x7F-\x9F]/g, "");
}

/**
 * Canonical tuple of accepted journal invocations. Single source of truth.
 *
 * Why a tuple, not just a Zod enum: the same set is consumed by FIVE call
 * sites — this store's `InvocationEnum`, the tool boundary at
 * `src/tools/record-run.ts`, the filter schema at `src/tools/list-runs.ts`,
 * the Record literal in the aggregate output type, and the `invocation_counts`
 * initialiser in `src/runs/aggregate.ts`. Exporting one tuple makes "add a
 * new invocation" a single-line change instead of five-sites-must-stay-in-
 * sync. Pattern parallels `AGENT_NAMES_TUPLE` in `src/config/ownership-matrix.ts`.
 *
 * `as const` (readonly tuple) is what Zod's `z.enum` requires.
 */
export const INVOCATION_VALUES = [
  "implement",
  "review",
  "task",
  "question",
  "brainstorm",
  "debug",
  "grillme",
] as const;

const InvocationEnum = z.enum(INVOCATION_VALUES);
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
 * RunRecord schema_version 2 (bumped from 1 in the agent-rename release).
 * PUBLIC STABLE CONTRACT — readers (the `list_runs` MCP tool, the
 * `/squad:stats` skill) key on `schema_version` and skip+log unknown
 * versions rather than failing.
 *
 * The v1 → v2 bump rotates the `agents[].name` enum (senior-* → bare names)
 * AND signals that any v1 row carries the old agent names. v1 rows are
 * skip+logged at read time so existing users with a populated journal can
 * either migrate (see `tools/migrate-jsonl-agents.mjs`) or simply continue
 * with a clean run history going forward.
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
  schema_version: z.literal(CURRENT_SCHEMA_VERSION),
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
  /**
   * Optional per-phase timing breakdown (v0.12+, E1). Populated only when the
   * user passed `--profile` (or `.squad.yaml.profile = true`). Keyed by a
   * stable phase name; values are wall-clock milliseconds since Phase 1
   * started. The orchestrator captures Date.now() at phase boundaries and
   * emits the diff here on the terminal `record_run` call.
   *
   * Why keyed map (not fixed shape): the phase list evolves (Phase 9 Codex
   * round, Phase 11 reject-loop) and we want add-without-schema-bump
   * extensibility. Cap of 30 keys is well above the realistic phase count
   * (8-12 phases typically); cap of 30 minutes per phase is generous.
   *
   * Cap chosen to keep the JSONL row well under MAX_RECORD_BYTES (4000):
   * 30 entries × ~50 bytes per `"phase_name": NNNNNN` pair ≈ 1500 bytes.
   * Combined with the other fields, fits comfortably.
   */
  phase_timings: z
    .record(SafeString(50), z.number().int().nonnegative().max(1_800_000))
    .refine((r) => Object.keys(r).length <= 30, {
      message: "phase_timings must not exceed 30 keys",
    })
    .optional(),
  /**
   * v0.13+ language-aware bundling telemetry. Optional — older records and
   * non-squad invocations (debug, question, brainstorm) omit it. The skill
   * orchestrator populates this on the terminal `record_run` call from the
   * `detected_languages` + `language_supplements_by_agent` fields of
   * `compose_advisory_bundle`'s output.
   *
   * Purpose: enable A/B measurement of whether per-language supplement
   * injection actually improves agent advisory quality (delta in score /
   * severity for runs WITH supplement vs WITHOUT). Without this signal we
   * are flying blind on whether to expand the `.langs/` catalog beyond the
   * initial 3 languages (TS / Python / C#).
   *
   * Byte budget: ~180 bytes worst case (4 agents + 13 detected langs).
   * Comfortably under MAX_RECORD_BYTES.
   */
  language_supplements: z
    .object({
      /**
       * `true` iff at least one agent in this run received at least one
       * supplement at dispatch time. `false` when detection succeeded but
       * (a) the user passed `include_language_supplements: false`, (b) no
       * detected language has an on-disk supplement (e.g. Go-only PR), or
       * (c) no LANGUAGE_AWARE_AGENT was in the squad selection.
       */
      injected: z.boolean(),
      /**
       * All language ids returned by `detectLanguages(...).all`. Stable
       * order per LANGUAGES tuple. Capped at 13 (current Language union
       * size); future expansion bumps the cap and the schema version.
       */
      detected: z.array(SafeString(20)).max(13),
      /** Detection confidence — useful for filtering low-signal A/B rows out. */
      confidence: z.enum(["high", "medium", "low", "none"]),
      /**
       * Agent names that received at least one supplement. Subset of
       * LANGUAGE_AWARE_AGENTS ∩ this run's squad. Empty when `injected` is
       * `false`. Capped at 8 to leave headroom; today the allowlist is 4.
       */
      agents_with_supplement: z.array(z.enum(AGENT_NAMES_TUPLE)).max(8),
    })
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
   * (developer cycle-2 Major). Two writes landing in the same ms keep
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
 * Rows with an unknown `schema_version` (legacy v1 produced before the
 * agent-rename bump, or future v3+ produced by a newer client) are
 * SKIPPED and LOGGED — NOT quarantined. The schema_version pre-Zod gate
 * fires first so the v2 Zod schema never sees a row carrying old agent
 * names that would otherwise fail enum validation. Migration to the
 * current version is via `tools/migrate-jsonl-agents.mjs`. The pinning
 * test for this contract is `tests/schema-version-skip-log.test.ts`.
 *
 * Rows that DO match `schema_version === CURRENT_SCHEMA_VERSION` but fail
 * Zod validation ARE quarantined to `.squad/runs.jsonl.corrupt-<ts>.jsonl`
 * alongside the source — those are real schema violations within the
 * current version's contract.
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
    // Schema_version gate: skip+log instead of throwing. v1 rows (carrying
    // pre-rename "senior-*" agent names) and rows lacking schema_version are
    // both skip+logged so a journal written by an older client (or by this
    // client before the rename release) is partially readable instead of
    // bricking the dashboard. Migration to v2 is via
    // `tools/migrate-jsonl-agents.mjs`.
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { schema_version: unknown }).schema_version !== CURRENT_SCHEMA_VERSION
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

  // Defense in depth: strip control chars from `mode_warning.message` at the
  // writer too. The aggregator's `stripControlChars` already runs at render
  // (security #5 in v0.9.0), but direct file inspection (`cat`, `less`) sees
  // raw bytes. Sanitising here keeps the recorded data terminal-safe for any
  // future viewer that bypasses the aggregator. We strip only this one field
  // because it's the documented free-form leak surface — other fields are
  // schema-bounded to safer shapes (enums, ISO strings, numbers, sha refs).
  const sanitized: RunRecord =
    validated.data.mode_warning != null
      ? {
          ...validated.data,
          mode_warning: {
            ...validated.data.mode_warning,
            message: stripWriterControlChars(validated.data.mode_warning.message),
          },
        }
      : validated.data;

  const line = JSON.stringify(sanitized) + "\n";
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
