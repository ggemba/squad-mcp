import { z } from "zod";
import type { ToolDef } from "./registry.js";
import { AGENT_NAMES_TUPLE } from "../config/ownership-matrix.js";

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
});

const schema = z.object({
  reports: z.array(reportSchema).max(50),
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

  let verdict: Verdict;
  if (blockers.length) verdict = "REJECTED";
  else if (majorsUnjustified.length) verdict = "REJECTED";
  else if (counts.Major + counts.Minor > 0) verdict = "CHANGES_REQUIRED";
  else verdict = "APPROVED";

  const summary =
    `Verdict: ${verdict}. ` +
    `${blockers.length} blocker(s), ${majorsUnjustified.length} unjustified major(s), ` +
    `${forwarded.length} forwarded item(s), ${notEvaluated.length} agent(s) not evaluated. ` +
    `Severity counts: ${counts.Blocker} blocker / ${counts.Major} major / ${counts.Minor} minor / ${counts.Suggestion} suggestion.`;

  return {
    verdict,
    blockers,
    majors_unjustified: majorsUnjustified,
    forwarded,
    not_evaluated: notEvaluated,
    severity_counts: counts,
    agents_involved: Array.from(agentsInvolved).sort(),
    summary,
  };
}

export const applyConsolidationRulesTool: ToolDef<typeof schema> = {
  name: "apply_consolidation_rules",
  description:
    "Aggregate advisory reports and emit a verdict per the rules in _shared/_Severity-and-Ownership.md. " +
    "Blocker -> REJECTED. Unjustified Major -> REJECTED. Otherwise CHANGES_REQUIRED or APPROVED. " +
    "Includes severity_counts and agents_involved for downstream summarization.",
  schema,
  handler: applyConsolidationRules,
};
