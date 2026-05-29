import { z } from "zod";
import type { ToolDef } from "./registry.js";
import { AGENT_NAMES_TUPLE } from "../config/ownership-matrix.js";
import { SafeString as safeString } from "./_shared/schemas.js";
import { EXEC_MODES, buildExecutionPlan } from "./mode/exec-mode.js";
import type { ExecutionStep } from "./_shared/schemas.js";
import { composeWorkflowCore, type ComposeCoreInput } from "./_shared/compose-core.js";

// Re-export the public mode contract from its dedicated module so downstream
// callers (tests, CI integrations, .squad.yaml consumers) can keep importing
// from compose-squad-workflow while the implementation lives in src/tools/mode/.
export {
  EXEC_MODES,
  QUICK_AUTO_MAX_FILES,
  selectMode,
  shapeSquadForMode,
  TIEBREAKER_AGENT,
  FALLBACK_SECONDARY,
  DEEP_REQUIRED,
} from "./mode/exec-mode.js";
export type { ExecMode, ModeWarning, ModeWarningCode } from "./mode/exec-mode.js";

// Re-export the execution-plan step contract ([O1]) so downstream callers and
// tests can import the typed shape alongside the other mode-contract types.
export type { ExecutionStep } from "./_shared/schemas.js";
export { buildExecutionPlan } from "./mode/exec-mode.js";

// Re-export the shared workflow result type from its neutral home. Downstream
// callers (compose-advisory-bundle.ts, tests) have historically imported
// `ComposeWorkflowOutput` from this module; keep that import path stable while
// the type definition lives in `_shared/compose-core.ts`.
export type { ComposeWorkflowOutput } from "./_shared/compose-core.js";

const schema = z.object({
  workspace_root: safeString(4096),
  user_prompt: safeString(8192),
  base_ref: safeString(200).optional(),
  staged_only: z.boolean().optional().default(false),
  /**
   * Review dirty working tree (staged + unstaged vs HEAD). Mutually
   * exclusive with `base_ref` and `staged_only`; the upstream
   * `detect_changed_files` schema rejects invalid combos. Introduced v1.7.
   */
  working_tree: z.boolean().optional().default(false),
  read_content: z.boolean().optional().default(true),
  /**
   * Execution depth. Omit to let `selectMode` auto-detect from
   * classify+risk signals. Pass explicitly to override the auto-detect.
   */
  mode: z.enum(EXEC_MODES).optional(),
  /**
   * Run mode (invocation contract). `implement` (default) runs the full spine
   * — planner draft, Gate 1, implementation, advisory, consolidator. `review`
   * is advisory-only on an existing diff: there is no plan to draft, no Gate 1
   * to approve, and no implementation step, so the `execution_plan` marks those
   * phases `run: false` with skip_reason "review-mode". Omitted → implement, so
   * existing callers (which never sent this field) keep the prior behaviour.
   */
  run_mode: z.enum(["implement", "review"]).optional().default("implement"),
  force_work_type: z
    .enum(["Feature", "Bug Fix", "Refactor", "Performance", "Security", "Business Rule"])
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

/**
 * Thin wrapper over the shared compose pipeline. The detect -> classify ->
 * score -> select -> mode-resolution logic lives in `_shared/compose-core.ts`
 * so `compose_advisory_bundle` can reuse it without re-deriving it. This
 * handler forwards the parsed input — the `Input` type is structurally a
 * `ComposeCoreInput`, so no field-by-field marshalling is needed — and then
 * layers the typed, deterministic `execution_plan` on top ([O1]).
 *
 * The `execution_plan` is a PURE projection of the core's already-resolved
 * `mode` + shaped `squad.agents`; it adds no IO and changes no existing field.
 * Every existing output key is spread through unchanged — this is strictly
 * additive and behaviour-preserving.
 */
export async function composeSquadWorkflow(
  input: Input,
): Promise<Awaited<ReturnType<typeof composeWorkflowCore>> & { execution_plan: ExecutionStep[] }> {
  const core = await composeWorkflowCore(input satisfies ComposeCoreInput);
  const execution_plan = buildExecutionPlan({
    mode: core.mode,
    agents: core.squad.agents,
    // Thread the caller's run_mode (default "implement") so the plan's
    // run-mode-sensitive phases (planner draft, Gate 1, implementation) are
    // correct: in review mode they are marked run:false with skip_reason
    // "review-mode". Omitted by the caller → implement → unchanged behaviour.
    runMode: input.run_mode,
  });
  return { ...core, execution_plan };
}

export const composeSquadWorkflowTool: ToolDef<typeof schema> = {
  name: "compose_squad_workflow",
  description:
    "End-to-end deterministic pipeline: detect_changed_files -> read_squad_config -> classify_work_type -> " +
    "score_risk -> select_squad. Returns the union output, the resolved .squad.yaml config (defaults if absent), " +
    "and `skipped_paths` / `disabled_agents` when config.skip_paths or config.disable_agents narrowed things. " +
    "Caller can override work_type, force agents, or supply explicit risk signals (force_agents wins over " +
    "config.disable_agents — config is policy, not veto).",
  schema,
  handler: composeSquadWorkflow,
};
