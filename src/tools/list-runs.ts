import { z } from "zod";
import type { ToolDef } from "./registry.js";
import { SafeString } from "./_shared/schemas.js";
import { AGENT_NAMES_TUPLE, type AgentName } from "../config/ownership-matrix.js";
import { readRuns, type RunRecord } from "../runs/store.js";
import {
  foldById,
  applyFilters,
  aggregateOutcomes,
  aggregateHealth,
  trendByDay,
  getEstTokens,
  type FoldedRun,
} from "../runs/aggregate.js";

/**
 * Read tool: load runs from `.squad/runs.jsonl`, fold the two-phase
 * (in_flight, terminal) pair by id, apply filters, and either return the
 * folded raw list or a precomputed aggregate bundle.
 *
 * Plan v4 architect A-3: collapse the original `list_runs + aggregate_runs`
 * pair into one tool with an `aggregate: boolean` flag. The skill calls
 * the aggregate form for `/squad:stats`; humans (or other tools) call the
 * non-aggregate form to inspect raw rows.
 *
 * No writes here. The single-writer contract belongs to `record_run`.
 */

const InvocationEnum = z.enum(["implement", "review", "task", "question", "brainstorm", "debug"]);
const ModeEnum = z.enum(["quick", "normal", "deep"]);
const VerdictEnum = z.enum(["APPROVED", "CHANGES_REQUIRED", "REJECTED"]);
const WorkTypeEnum = z.enum([
  "Feature",
  "Bug Fix",
  "Refactor",
  "Performance",
  "Security",
  "Business Rule",
]);

const schema = z.object({
  workspace_root: SafeString(4096),
  /** ISO 8601 lower bound on `started_at`. */
  since: SafeString(40).optional(),
  /** Cap output to the most recent N folded runs. */
  limit: z.number().int().positive().max(5000).optional(),
  /** Restrict to runs that included this agent in any role. */
  agent: z.enum(AGENT_NAMES_TUPLE).optional(),
  /** Restrict to a single terminal verdict. */
  verdict: VerdictEnum.optional(),
  /** Restrict to a single dispatch mode. */
  mode: ModeEnum.optional(),
  /** Restrict to a single invocation kind. */
  invocation: InvocationEnum.optional(),
  /** Restrict to a single work type. */
  work_type: WorkTypeEnum.optional(),
  /**
   * If true, return aggregate views (outcomes + health + trend) instead of
   * the folded raw rows. The /squad:stats skill uses this; CLI inspections
   * default to the raw list.
   */
  aggregate: z.boolean().optional(),
  /** Days of trend sparkline data to compute when aggregate=true. Default 14. */
  trend_days: z.number().int().positive().max(90).optional(),
});

type Input = z.infer<typeof schema>;

interface ListRunsRawOutput {
  ok: true;
  file: string | null;
  total_in_store: number;
  total_folded: number;
  runs: SerializedFoldedRun[];
}

interface SerializedFoldedRun {
  id: string;
  status: "in_flight" | "completed" | "aborted";
  synthesized_aborted: boolean;
  record: RunRecord;
  est_tokens: { input: number; output: number; total: number };
}

interface ListRunsAggregateOutput {
  ok: true;
  file: string | null;
  total_in_store: number;
  total_folded: number;
  outcomes: {
    total_runs: number;
    verdict_counts: Record<"APPROVED" | "CHANGES_REQUIRED" | "REJECTED", number>;
    verdict_total: number;
    score_buckets: { range: string; count: number; min: number; max: number }[];
    invocation_counts: Record<
      "implement" | "review" | "task" | "question" | "brainstorm" | "debug",
      number
    >;
    est_tokens_total: { input: number; output: number; total: number };
    est_tokens_per_run_avg: number;
    est_tokens_per_agent: { agent: AgentName; input: number; output: number; total: number }[];
    is_empty: boolean;
  };
  health: {
    total_runs: number;
    in_flight: number;
    completed: number;
    aborted: number;
    synthesized_aborted: number;
    avg_batch_duration_ms_per_agent: { agent: AgentName; avg_ms: number }[];
    avg_total_duration_ms: number;
  };
  trend: { days: number; counts: number[] };
}

type ListRunsOutput = ListRunsRawOutput | ListRunsAggregateOutput;

function serializeFolded(f: FoldedRun): SerializedFoldedRun {
  return {
    id: f.id,
    status: f.status,
    synthesized_aborted: f.synthesized_aborted,
    record: f.record,
    est_tokens: getEstTokens(f.record),
  };
}

function workTypeFilter(folded: FoldedRun[], wt: string): FoldedRun[] {
  return folded.filter((f) => f.record.work_type === wt);
}

async function handler(input: Input): Promise<ListRunsOutput> {
  // Read raw records. readRuns swallows ENOENT and returns []; missing-journal
  // is a normal "no runs yet" state, not an error.
  const records = await readRuns(input.workspace_root);
  const totalInStore = records.length;

  const folded = foldById(records);
  // Apply work_type FIRST so it composes with limit semantically. If we applied
  // it after applyFilters, `limit: N` would truncate by started_at BEFORE the
  // work_type predicate, giving "bug fixes within the last N runs" instead of
  // "last N bug fixes" — silently wrong. (senior-developer cycle-2 Major.)
  let prefiltered = folded;
  if (input.work_type) {
    prefiltered = workTypeFilter(prefiltered, input.work_type);
  }
  const filtered = applyFilters(prefiltered, {
    ...(input.since !== undefined && { since: input.since }),
    ...(input.limit !== undefined && { limit: input.limit }),
    ...(input.agent !== undefined && { agent: input.agent }),
    ...(input.verdict !== undefined && { verdict: input.verdict }),
    ...(input.mode !== undefined && { mode: input.mode }),
    ...(input.invocation !== undefined && { invocation: input.invocation }),
  });

  // Filepath surfacing: we don't currently resolve the configured path here
  // (the store handles its own resolution); reporting null when no records is
  // honest about the "fresh repo" state.
  const filePath = totalInStore > 0 ? `${input.workspace_root}/.squad/runs.jsonl` : null;

  if (!input.aggregate) {
    return {
      ok: true,
      file: filePath,
      total_in_store: totalInStore,
      total_folded: filtered.length,
      runs: filtered.map(serializeFolded),
    };
  }

  const outcomes = aggregateOutcomes(filtered);
  const health = aggregateHealth(filtered);
  const trendBuckets = trendByDay(filtered, input.trend_days ?? 14);

  return {
    ok: true,
    file: filePath,
    total_in_store: totalInStore,
    total_folded: filtered.length,
    outcomes: {
      total_runs: outcomes.total_runs,
      verdict_counts: outcomes.verdict_counts,
      verdict_total: outcomes.verdict_total,
      score_buckets: outcomes.score_buckets,
      invocation_counts: outcomes.invocation_counts,
      est_tokens_total: outcomes.est_tokens_total,
      est_tokens_per_run_avg: outcomes.est_tokens_per_run_avg,
      est_tokens_per_agent: Array.from(outcomes.est_tokens_per_agent.entries()).map(
        ([agent, t]) => ({ agent, ...t }),
      ),
      is_empty: outcomes.is_empty,
    },
    health: {
      total_runs: health.total_runs,
      in_flight: health.in_flight,
      completed: health.completed,
      aborted: health.aborted,
      synthesized_aborted: health.synthesized_aborted,
      avg_batch_duration_ms_per_agent: Array.from(
        health.avg_batch_duration_ms_per_agent.entries(),
      ).map(([agent, avg_ms]) => ({ agent, avg_ms })),
      avg_total_duration_ms: health.avg_total_duration_ms,
    },
    trend: { days: input.trend_days ?? 14, counts: trendBuckets },
  };
}

export const listRunsToolDef: ToolDef<typeof schema> = {
  name: "list_runs",
  description:
    "Read tool for `.squad/runs.jsonl`. Folds the two-phase (in_flight, terminal) row pair by id, " +
    "applies filters (since / limit / agent / verdict / mode / invocation / work_type), and returns " +
    "either the folded list (aggregate=false, default) or a precomputed aggregate bundle " +
    "(outcomes + health + trend sparkline buckets) when aggregate=true. Missing-journal returns " +
    "an empty result, not an error. Read-only — never writes.",
  schema,
  handler,
};
