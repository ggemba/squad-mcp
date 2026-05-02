import { z } from 'zod';
import type { ToolDef } from './registry.js';

const schema = z.object({
  touches_auth: z.boolean().optional().default(false),
  touches_money: z.boolean().optional().default(false),
  touches_migration: z.boolean().optional().default(false),
  files_count: z.number().int().nonnegative().optional().default(0),
  new_module: z.boolean().optional().default(false),
  api_contract_change: z.boolean().optional().default(false),
});

type Input = z.infer<typeof schema>;

export type RiskLevel = 'Low' | 'Medium' | 'High';

export interface RiskOutput {
  level: RiskLevel;
  score: number;
  signals: { name: string; matched: boolean }[];
  recommendation: string;
}

export function scoreRisk(input: Input): RiskOutput {
  const checks = [
    { name: 'touches_auth', matched: input.touches_auth },
    { name: 'touches_money', matched: input.touches_money },
    { name: 'touches_migration', matched: input.touches_migration },
    { name: 'files_count_gt_8', matched: input.files_count > 8 },
    { name: 'new_module', matched: input.new_module },
    { name: 'api_contract_change', matched: input.api_contract_change },
  ];
  const score = checks.filter((c) => c.matched).length;
  const level: RiskLevel = score >= 4 ? 'High' : score >= 2 ? 'Medium' : 'Low';
  const recommendation =
    level === 'High'
      ? 'High risk: suggest Codex plan review (--codex). Halt implementation if any Blocker.'
      : level === 'Medium'
        ? 'Medium risk: standard advisory squad. Consider Codex if user requests.'
        : 'Low risk: minimal squad selection acceptable.';
  return { level, score, signals: checks, recommendation };
}

export const scoreRiskTool: ToolDef<typeof schema> = {
  name: 'score_risk',
  description:
    'Compute risk level (Low/Medium/High) from boolean signals. Pure function. 0-1=Low, 2-3=Medium, 4+=High.',
  schema,
  handler: scoreRisk,
};
