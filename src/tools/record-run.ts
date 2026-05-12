import { z } from "zod";
import type { ToolDef } from "./registry.js";
import { SafeString } from "./_shared/schemas.js";
import { appendRun, runRecordSchema } from "../runs/store.js";

/**
 * SINGLE WRITER CONTRACT (plan v4, cycle 2 architect A-4; extended in v0.10.0,
 * v0.10.1).
 *
 * Legitimate callers of this tool are skills that own a two-phase lifecycle:
 *
 *  - `skills/squad/SKILL.md` (v0.9.0+) — Phase 1 `in_flight` + Phase 10
 *    terminal pair for `/squad:implement` and `/squad:review` runs
 *    (invocations: `implement`, `review`, `task`).
 *  - `skills/debug/SKILL.md` (v0.10.0+) — Phase A `in_flight` + Phase C
 *    terminal pair for `/squad:debug` runs (invocation: `debug`).
 *  - `skills/question/SKILL.md` (v0.10.1+) — Phase 1.5 `in_flight` + Phase
 *    3.5 terminal pair for `/squad:question` runs (invocation: `question`).
 *  - `skills/brainstorm/SKILL.md` (v0.10.1+) — Step 1.5 `in_flight` + Step
 *    5.5 terminal pair for `/brainstorm` runs (invocation: `brainstorm`).
 *
 * Any other caller is a bug. The two-phase write pair is the transactional
 * unit; emitting terminal rows from any other path (notably
 * `apply_consolidation_rules`) breaks the `(in_flight, completed)` pair-by-id
 * invariant that the aggregator relies on for stranded-run detection.
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

// Schema imported from src/runs/store.ts (single source of truth — D2 fix v0.14.x). The store re-validates in appendRun as defense-in-depth for non-tool callers.
const schema = z.object({
  workspace_root: SafeString(4096),
  record: runRecordSchema,
});

type Input = z.infer<typeof schema>;

interface RecordRunOutput {
  ok: true;
  file: string;
  id: string;
  status: "in_flight" | "completed" | "aborted";
}

async function handler(input: Input): Promise<RecordRunOutput> {
  const result = await appendRun(input.workspace_root, input.record);
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
    "Append one RunRecord to .squad/runs.jsonl. Single-writer contract: only the lifecycle-owning " +
    "skills should call this — squad (Phase 1 + Phase 10), debug (Phase A + Phase C), question " +
    "(Phase 1.5 + Phase 3.5), brainstorm (Step 1.5 + Step 5.5). Validates against the RunRecord " +
    "schema_version:1 and enforces MAX_RECORD_BYTES (4000) via RECORD_TOO_LARGE on overflow. " +
    "Caller is responsible for matching in_flight↔terminal rows by id. File mode is 0o600 " +
    "(user-only) on first create. mode_warning.message is stripped of control chars at write time.",
  schema,
  handler,
};
