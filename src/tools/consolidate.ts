import { z } from 'zod';
import type { ToolDef } from './registry.js';

const severity = z.enum(['Blocker', 'Major', 'Minor', 'Suggestion']);

const reportSchema = z.object({
  agent: z.string(),
  findings: z.array(
    z.object({
      severity,
      title: z.string(),
      detail: z.string().optional(),
      forwarded_to: z.string().optional(),
      justified: z.boolean().optional().default(false),
    }),
  ),
  not_evaluated: z.boolean().optional().default(false),
});

const schema = z.object({
  reports: z.array(reportSchema),
});

type Input = z.infer<typeof schema>;

export type Verdict = 'APPROVED' | 'CHANGES_REQUIRED' | 'REJECTED';

export interface ConsolidationOutput {
  verdict: Verdict;
  blockers: { agent: string; title: string }[];
  majors_unjustified: { agent: string; title: string }[];
  forwarded: { from: string; to: string; title: string }[];
  not_evaluated: string[];
  summary: string;
}

export function applyConsolidationRules(input: Input): ConsolidationOutput {
  const blockers: { agent: string; title: string }[] = [];
  const majorsUnjustified: { agent: string; title: string }[] = [];
  const forwarded: { from: string; to: string; title: string }[] = [];
  const notEvaluated: string[] = [];

  for (const r of input.reports) {
    if (r.not_evaluated) {
      notEvaluated.push(r.agent);
      continue;
    }
    for (const f of r.findings) {
      if (f.severity === 'Blocker') blockers.push({ agent: r.agent, title: f.title });
      if (f.severity === 'Major' && !f.justified) majorsUnjustified.push({ agent: r.agent, title: f.title });
      if (f.forwarded_to) forwarded.push({ from: r.agent, to: f.forwarded_to, title: f.title });
    }
  }

  let verdict: Verdict;
  if (blockers.length) verdict = 'REJECTED';
  else if (majorsUnjustified.length) verdict = 'REJECTED';
  else if (input.reports.some((r) => r.findings.some((f) => f.severity === 'Major' || f.severity === 'Minor')))
    verdict = 'CHANGES_REQUIRED';
  else verdict = 'APPROVED';

  const summary =
    `Verdict: ${verdict}. ` +
    `${blockers.length} blocker(s), ${majorsUnjustified.length} unjustified major(s), ` +
    `${forwarded.length} forwarded item(s), ${notEvaluated.length} agent(s) not evaluated.`;

  return { verdict, blockers, majors_unjustified: majorsUnjustified, forwarded, not_evaluated: notEvaluated, summary };
}

export const applyConsolidationRulesTool: ToolDef<typeof schema> = {
  name: 'apply_consolidation_rules',
  description:
    'Aggregate advisory reports and emit a verdict per the rules in _Severity-and-Ownership.md. Blocker → REJECTED. Unjustified Major → REJECTED. Otherwise CHANGES_REQUIRED or APPROVED.',
  schema,
  handler: applyConsolidationRules,
};
