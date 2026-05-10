import { z } from "zod";
import type { ToolDef } from "./registry.js";
import {
  AGENT_NAMES_TUPLE,
  AGENTS,
  DEFAULT_RUBRIC_WEIGHTS,
  type AgentName,
} from "../config/ownership-matrix.js";

/**
 * Per-agent dimension score from an advisory pass. Scores are 0-100 (higher is
 * better). Reports without a score (e.g. legacy clients, unsupported agents,
 * `not_evaluated: true`) are simply omitted from the rubric.
 */
const dimensionScoreSchema = z.object({
  agent: z.enum(AGENT_NAMES_TUPLE),
  score: z.number().min(0).max(100),
  rationale: z.string().max(2048).optional(),
});

/**
 * Repo override of weights. Keys are agent names; values 0-100. The set of
 * supplied keys must sum to 100 (validated). Agents absent from this object
 * fall back to DEFAULT_RUBRIC_WEIGHTS for that name. Useful when a project
 * wants to ignore a dimension entirely (set its weight to 0 and redistribute).
 */
const weightOverridesSchema = z
  .record(z.enum(AGENT_NAMES_TUPLE), z.number().min(0).max(100))
  .optional();

const schema = z.object({
  scores: z.array(dimensionScoreSchema).max(50),
  weights: weightOverridesSchema,
  threshold: z.number().min(0).max(100).optional().default(75),
});

type Input = z.infer<typeof schema>;

export interface DimensionEntry {
  agent: AgentName;
  dimension: string;
  score: number;
  weight: number;
  contribution: number;
  rationale?: string;
  below_threshold: boolean;
}

export interface RubricOutput {
  weighted_score: number;
  threshold: number;
  passes_threshold: boolean;
  dimensions: DimensionEntry[];
  ignored_agents: string[];
  weights_source: "default" | "override";
  scorecard_text: string;
}

const BAR_WIDTH = 20;

function renderBar(score: number): string {
  const filled = Math.round((score / 100) * BAR_WIDTH);
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

function formatScorecard(out: Omit<RubricOutput, "scorecard_text">): string {
  const header = `SQUAD RUBRIC — weighted ${out.weighted_score.toFixed(1)} / 100 (threshold ${out.threshold})`;
  const verdictLine = out.passes_threshold ? "PASS" : "BELOW THRESHOLD";
  const lines = out.dimensions.map((d) => {
    const flag = d.below_threshold ? " ⚠" : "  ";
    const dim = d.dimension.padEnd(20);
    const bar = renderBar(d.score);
    const score = String(d.score).padStart(3);
    const weight = `×${d.weight.toString().padStart(2)}%`;
    return `${dim} ${bar}  ${score}  ${weight}  ${d.agent}${flag}`;
  });
  return [header, "─".repeat(70), ...lines, "─".repeat(70), verdictLine].join("\n");
}

/**
 * Compute the weighted-rubric scorecard from per-agent dimension scores.
 *
 * Math:
 *   - Reduce supplied scores to the subset of agents present.
 *   - Resolve weights: override (if provided AND keys sum to 100) > default.
 *   - For each scored agent, contribution = score * weight / 100.
 *   - weighted_score = sum of contributions normalised so weights sum to 100
 *     across the agents that ACTUALLY scored. (If only 6 of 9 agents scored,
 *     the rubric renormalises across those 6 instead of leaving 3 dimensions
 *     contributing 0 to the weighted average.)
 *   - Dimensions below `threshold` are flagged.
 *
 * Returns a RubricOutput; meta-agents (weight 0) and unscored agents are listed
 * in `ignored_agents`.
 */
export function scoreRubric(input: Input): RubricOutput {
  const overrides = input.weights;
  let weights: Record<AgentName, number>;
  let weightsSource: "default" | "override";

  if (overrides && Object.keys(overrides).length > 0) {
    const overrideSum = Object.values(overrides).reduce((acc, v) => acc + v, 0);
    if (Math.abs(overrideSum - 100) > 0.01) {
      throw new Error(
        `weights override must sum to 100, got ${overrideSum}. Supplied: ${JSON.stringify(overrides)}`,
      );
    }
    weights = { ...DEFAULT_RUBRIC_WEIGHTS, ...overrides } as Record<AgentName, number>;
    weightsSource = "override";
  } else {
    weights = { ...DEFAULT_RUBRIC_WEIGHTS };
    weightsSource = "default";
  }

  // Build the dimension list from scores actually supplied.
  const scoredAgents = new Set(input.scores.map((s) => s.agent));
  const ignored: string[] = [];
  for (const agentName of AGENT_NAMES_TUPLE) {
    if (!scoredAgents.has(agentName)) {
      // Either unscored OR weight 0 (meta-agent). Both go to ignored, distinguished by weight.
      ignored.push(agentName);
    }
  }

  // Effective weight base: sum of weights across agents that actually scored AND have weight > 0.
  // We renormalise to this base so the weighted score reflects only the dimensions evaluated.
  let weightBase = 0;
  for (const s of input.scores) {
    weightBase += weights[s.agent] ?? 0;
  }

  const dimensions: DimensionEntry[] = [];
  let weightedScore = 0;

  if (weightBase > 0) {
    for (const s of input.scores) {
      const w = weights[s.agent] ?? 0;
      if (w === 0) {
        // Meta-agent that somehow emitted a score — ignore from rubric, surface in ignored.
        if (!ignored.includes(s.agent)) ignored.push(s.agent);
        continue;
      }
      const normalisedWeight = (w / weightBase) * 100;
      const contribution = (s.score * normalisedWeight) / 100;
      dimensions.push({
        agent: s.agent,
        dimension: AGENTS[s.agent].dimension,
        score: s.score,
        weight: Math.round(normalisedWeight * 10) / 10,
        contribution: Math.round(contribution * 10) / 10,
        rationale: s.rationale,
        below_threshold: s.score < input.threshold,
      });
      weightedScore += contribution;
    }
  }

  weightedScore = Math.round(weightedScore * 10) / 10;

  // Sort dimensions by descending weight so the most important come first.
  dimensions.sort((a, b) => b.weight - a.weight);

  const partial: Omit<RubricOutput, "scorecard_text"> = {
    weighted_score: weightedScore,
    threshold: input.threshold,
    passes_threshold: weightedScore >= input.threshold,
    dimensions,
    ignored_agents: ignored,
    weights_source: weightsSource,
  };

  return { ...partial, scorecard_text: formatScorecard(partial) };
}

export const scoreRubricTool: ToolDef<typeof schema> = {
  name: "score_rubric",
  description:
    "Compute a weighted multi-dimensional rubric scorecard from per-agent advisory scores (0-100). " +
    "Each agent represents one dimension (Architecture, Security, Testing, etc.) with a default weight; " +
    "weights can be overridden per-repo via .squad.yaml. Returns weighted_score, per-dimension breakdown, " +
    "pass/fail vs threshold (default 75), and a pre-formatted ASCII scorecard. " +
    "Renormalises across agents that actually scored, so a partial advisory pass produces a meaningful score.",
  schema,
  handler: scoreRubric,
};
