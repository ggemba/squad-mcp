import { z } from "zod";
import type { ToolDef } from "./registry.js";
import { AGENT_NAMES_TUPLE } from "../config/ownership-matrix.js";
import { scoreRubric, type RubricOutput } from "./score-rubric.js";

const severity = z.enum(["Blocker", "Major", "Minor", "Suggestion"]);

const reportSchema = z.object({
  agent: z.enum(AGENT_NAMES_TUPLE),
  findings: z
    .array(
      z.object({
        severity,
        title: z.string().max(4096),
        detail: z.string().max(4096).optional(),
        forwarded_to: z.enum(AGENT_NAMES_TUPLE).optional(),
        justified: z.boolean().optional().default(false),
      }),
    )
    .max(500),
  not_evaluated: z.boolean().optional().default(false),
  /**
   * Optional dimension score 0-100 produced by the agent. When at least one
   * report carries a score, the consolidator emits a rubric scorecard and the
   * verdict can be downgraded if `min_score` is supplied. Backward compatible:
   * pre-rubric clients omit this field and behave exactly as before.
   */
  score: z.number().min(0).max(100).optional(),
  score_rationale: z.string().max(2048).optional(),
});

const schema = z.object({
  reports: z.array(reportSchema).max(50),
  /**
   * Optional weight overrides for the rubric (sum must be 100). Forwarded to
   * `score_rubric`. Ignored when no report carries a score.
   */
  weights: z
    .record(z.enum(AGENT_NAMES_TUPLE), z.number().min(0).max(100))
    .optional(),
  /**
   * Per-dimension threshold for flagging individual scores. Defaults to 75.
   */
  threshold: z.number().min(0).max(100).optional().default(75),
  /**
   * If supplied AND the weighted score is below this floor AND severity rules
   * would otherwise return APPROVED, downgrade to CHANGES_REQUIRED. Lets a
   * project enforce a "minimum quality bar" beyond just absence of Blockers.
   * Independent of `threshold` (which flags individual dimensions).
   */
  min_score: z.number().min(0).max(100).optional(),
});

type Input = z.infer<typeof schema>;

export type Verdict = "APPROVED" | "CHANGES_REQUIRED" | "REJECTED";

export type Severity = "Blocker" | "Major" | "Minor" | "Suggestion";

export interface ConsolidationOutput {
  verdict: Verdict;
  blockers: { agent: string; title: string }[];
  majors_unjustified: { agent: string; title: string }[];
  forwarded: { from: string; to: string; title: string }[];
  not_evaluated: string[];
  severity_counts: Record<Severity, number>;
  agents_involved: string[];
  summary: string;
  /**
   * Weighted-rubric scorecard if any report carried a score, else null.
   * Independent of verdict — verdict logic preserves the legacy severity rules,
   * extended only by the optional `min_score` floor.
   */
  rubric: RubricOutput | null;
  /**
   * True iff the verdict was downgraded from APPROVED to CHANGES_REQUIRED
   * because the weighted score fell below `min_score`. Helps callers explain
   * the downgrade in their output.
   */
  downgraded_by_score: boolean;
}

export function applyConsolidationRules(input: Input): ConsolidationOutput {
  const blockers: { agent: string; title: string }[] = [];
  const majorsUnjustified: { agent: string; title: string }[] = [];
  const forwarded: { from: string; to: string; title: string }[] = [];
  const notEvaluated: string[] = [];
  const agentsInvolved = new Set<string>();
  const counts: Record<Severity, number> = {
    Blocker: 0,
    Major: 0,
    Minor: 0,
    Suggestion: 0,
  };

  for (const r of input.reports) {
    agentsInvolved.add(r.agent);
    if (r.not_evaluated) {
      notEvaluated.push(r.agent);
      continue;
    }
    for (const f of r.findings) {
      counts[f.severity] += 1;
      if (f.severity === "Blocker")
        blockers.push({ agent: r.agent, title: f.title });
      if (f.severity === "Major" && !f.justified)
        majorsUnjustified.push({ agent: r.agent, title: f.title });
      if (f.forwarded_to)
        forwarded.push({ from: r.agent, to: f.forwarded_to, title: f.title });
    }
  }

  // Compute rubric only if at least one report carried a score. Avoids
  // disrupting legacy callers that never opted in.
  const scoredReports = input.reports.filter(
    (r) => typeof r.score === "number" && !r.not_evaluated,
  );
  let rubric: RubricOutput | null = null;
  if (scoredReports.length > 0) {
    rubric = scoreRubric({
      scores: scoredReports.map((r) => ({
        agent: r.agent,
        score: r.score as number,
        rationale: r.score_rationale,
      })),
      weights: input.weights,
      threshold: input.threshold,
    });
  }

  // Severity rules (legacy, unchanged)
  let verdict: Verdict;
  if (blockers.length) verdict = "REJECTED";
  else if (majorsUnjustified.length) verdict = "REJECTED";
  else if (counts.Major + counts.Minor > 0) verdict = "CHANGES_REQUIRED";
  else verdict = "APPROVED";

  // Optional score floor: APPROVED with weighted_score < min_score → CHANGES_REQUIRED.
  // Never PROMOTES a verdict (a low score doesn't override a Blocker rejection),
  // and never demotes below CHANGES_REQUIRED.
  let downgradedByScore = false;
  if (
    typeof input.min_score === "number" &&
    rubric !== null &&
    verdict === "APPROVED" &&
    rubric.weighted_score < input.min_score
  ) {
    verdict = "CHANGES_REQUIRED";
    downgradedByScore = true;
  }

  const scoreSummary = rubric
    ? ` Weighted score: ${rubric.weighted_score.toFixed(1)}/100${rubric.passes_threshold ? "" : " (below threshold)"}.`
    : "";
  const downgradeSummary = downgradedByScore
    ? ` Downgraded from APPROVED to CHANGES_REQUIRED because weighted score < min_score (${input.min_score}).`
    : "";
  const summary =
    `Verdict: ${verdict}. ` +
    `${blockers.length} blocker(s), ${majorsUnjustified.length} unjustified major(s), ` +
    `${forwarded.length} forwarded item(s), ${notEvaluated.length} agent(s) not evaluated. ` +
    `Severity counts: ${counts.Blocker} blocker / ${counts.Major} major / ${counts.Minor} minor / ${counts.Suggestion} suggestion.` +
    scoreSummary +
    downgradeSummary;

  return {
    verdict,
    blockers,
    majors_unjustified: majorsUnjustified,
    forwarded,
    not_evaluated: notEvaluated,
    severity_counts: counts,
    agents_involved: Array.from(agentsInvolved).sort(),
    summary,
    rubric,
    downgraded_by_score: downgradedByScore,
  };
}

export const applyConsolidationRulesTool: ToolDef<typeof schema> = {
  name: "apply_consolidation_rules",
  description:
    "Aggregate advisory reports and emit a verdict per the rules in _shared/_Severity-and-Ownership.md. " +
    "Blocker -> REJECTED. Unjustified Major -> REJECTED. Otherwise CHANGES_REQUIRED or APPROVED. " +
    "When reports carry per-dimension scores (0-100), also returns a weighted rubric scorecard " +
    "(see score_rubric). Optional `min_score` downgrades APPROVED to CHANGES_REQUIRED if the " +
    "weighted score is below the floor — useful for projects that want a quality bar beyond " +
    "absence of blockers. Includes severity_counts and agents_involved for downstream summarization.",
  schema,
  handler: applyConsolidationRules,
};
