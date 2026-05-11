import { z } from "zod";
import type { ToolDef } from "./registry.js";
import { SafeString } from "./_shared/schemas.js";
import { AGENT_NAMES_TUPLE } from "../config/ownership-matrix.js";
import { appendRun, type RunRecord } from "../runs/store.js";

/**
 * SINGLE WRITER CONTRACT (plan v4, cycle 2 architect A-4; extended in v0.10.0).
 *
 * Legitimate callers of this tool are skills that own a two-phase lifecycle:
 *
 *  - `skills/squad/SKILL.md` (v0.9.0+) — Phase 1 `in_flight` + Phase 10
 *    terminal pair for `/squad:implement` and `/squad:review` runs.
 *  - `skills/debug/SKILL.md` (v0.10.0+) — Phase A `in_flight` + Phase C
 *    terminal pair for `/squad:debug` runs with `invocation: "debug"`.
 *
 * Any other caller is a bug. The Phase-1 / Phase-10 (or Phase-A / Phase-C
 * for debug) write pair is the transactional unit; emitting terminal rows
 * from any other path (notably `apply_consolidation_rules`) breaks the
 * two-phase `(in_flight, completed)` pair-by-id invariant that the
 * aggregator relies on for stranded-run detection.
 *
 * Two phases of the skill's lifecycle:
 *
 *  - **Phase 1 end** — skill writes `status: "in_flight"` with the static
 *    fields it knows (`id`, `started_at`, `mode`, `mode_source`, `work_type`,
 *    `git_ref`, `files_count`, `agents: [{name, model}]`). Scores, durations,
 *    verdict, and char counts are still pending.
 *
 *  - **Phase 10 end** — skill writes `status: "completed" | "aborted"`
 *    carrying the full agent metrics + verdict + weighted_score. Same `id`
 *    as the in_flight row; aggregator pairs them.
 *
 * If `record_run` throws on the Phase 10 finalisation, the skill writes a
 * second row with `status: "aborted"` and `mode_warning: { code:
 * "RECORD_FAILED", message: <reason> }` so the in_flight row never strands.
 * The skill's non-blocking try/catch covers I/O errors silently and surfaces
 * security-class SquadError codes to the user (Security #7).
 */

// Re-use the runs store's Zod tuple via the shared schema definitions.
// We can't import the runRecordSchema directly because it's a structured
// instance; instead we redefine the inputs here as the tool boundary. The
// store re-validates inside `appendRun`, so any drift between the two
// schemas trips at the store layer rather than silently passing.

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

const AgentMetricsSchema = z.object({
  name: z.enum(AGENT_NAMES_TUPLE),
  model: ModelEnum,
  score: z.number().int().min(0).max(100).nullable(),
  severity_score: z.number().int().min(0).max(9999).nullable(),
  batch_duration_ms: z.number().int().nonnegative().finite(),
  prompt_chars: z.number().int().nonnegative().finite(),
  response_chars: z.number().int().nonnegative().finite(),
});

const schema = z.object({
  workspace_root: SafeString(4096),
  record: z.object({
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
    git_ref: z
      .object({
        kind: z.enum(["head", "diff_base", "pr_head"]),
        value: SafeString(200),
      })
      .nullable(),
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
  }),
});

type Input = z.infer<typeof schema>;

interface RecordRunOutput {
  ok: true;
  file: string;
  id: string;
  status: "in_flight" | "completed" | "aborted";
}

async function handler(input: Input): Promise<RecordRunOutput> {
  const result = await appendRun(input.workspace_root, input.record as RunRecord);
  return {
    ok: true,
    file: result.filePath,
    id: result.record.id,
    status: result.record.status,
  };
}

export const recordRunToolDef: ToolDef<typeof schema> = {
  name: "record_run",
  description:
    "Append one RunRecord to .squad/runs.jsonl. Single-writer contract: only the squad skill " +
    "(Phase 1 in_flight + Phase 10 completed/aborted) and the debug skill (Phase A in_flight + " +
    "Phase C completed/aborted) should call this. Validates against the RunRecord schema_version:1 " +
    "and enforces MAX_RECORD_BYTES (4000) via RECORD_TOO_LARGE on overflow. Caller is responsible " +
    "for matching in_flight↔terminal rows by id. File mode is 0o600 (user-only) on first create.",
  schema,
  handler,
};
