import { z } from 'zod';
import type { ToolDef } from './registry.js';
import { composeSquadWorkflow, type ComposeWorkflowOutput } from './compose-squad-workflow.js';
import { sliceFilesForAgent, type SliceOutput } from './slice-files.js';
import { validatePlanText, type ValidatePlanOutput } from './validate-plan-text.js';
import { AGENT_NAMES_TUPLE } from '../config/ownership-matrix.js';

const safeString = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => s.indexOf(' ') === -1, 'must not contain NUL byte');

const schema = z.object({
  workspace_root: safeString(4096),
  user_prompt: safeString(8192),
  plan: z.string().max(65_536),
  base_ref: safeString(200).optional(),
  staged_only: z.boolean().optional().default(false),
  read_content: z.boolean().optional().default(true),
  force_work_type: z
    .enum(['Feature', 'Bug Fix', 'Refactor', 'Performance', 'Security', 'Business Rule'])
    .optional(),
  force_agents: z.array(z.enum(AGENT_NAMES_TUPLE)).optional().default([]),
  risk_signals: z
    .object({
      touches_auth: z.boolean().optional(),
      touches_money: z.boolean().optional(),
      touches_migration: z.boolean().optional(),
      new_module: z.boolean().optional(),
      api_contract_change: z.boolean().optional(),
    })
    .optional(),
});

type Input = z.infer<typeof schema>;

export interface AdvisoryBundleOutput {
  workflow: ComposeWorkflowOutput;
  slices_by_agent: Record<string, SliceOutput>;
  plan_validation: ValidatePlanOutput;
}

export async function composeAdvisoryBundle(input: Input): Promise<AdvisoryBundleOutput> {
  const workflowInput: Parameters<typeof composeSquadWorkflow>[0] = {
    workspace_root: input.workspace_root,
    user_prompt: input.user_prompt,
    staged_only: input.staged_only,
    read_content: input.read_content,
    force_agents: input.force_agents,
  };
  if (input.base_ref !== undefined) workflowInput.base_ref = input.base_ref;
  if (input.force_work_type !== undefined) workflowInput.force_work_type = input.force_work_type;
  if (input.risk_signals !== undefined) workflowInput.risk_signals = input.risk_signals;

  const workflow = await composeSquadWorkflow(workflowInput);
  const filePaths = workflow.changed_files.files.map((f) => f.path);

  const slices_by_agent: Record<string, SliceOutput> = {};
  for (const agent of workflow.squad.agents) {
    const slice = await sliceFilesForAgent({
      agent,
      files: filePaths,
      read_content: input.read_content,
      workspace_root: input.workspace_root,
    });
    slices_by_agent[agent] = slice;
  }

  const plan_validation = validatePlanText({ plan: input.plan });

  return { workflow, slices_by_agent, plan_validation };
}

export const composeAdvisoryBundleTool: ToolDef<typeof schema> = {
  name: 'compose_advisory_bundle',
  description:
    'End-to-end advisory dispatch bundle. Runs compose_squad_workflow, then slice_files_for_agent for each ' +
    'selected agent, then validate_plan_text on the supplied plan. Returns the union output ready for the ' +
    'host to dispatch parallel advisory reviews.',
  schema,
  handler: composeAdvisoryBundle,
};
