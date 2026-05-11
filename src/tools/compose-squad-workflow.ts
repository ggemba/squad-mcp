import { z } from "zod";
import type { ToolDef } from "./registry.js";
import {
  detectChangedFiles,
  type ChangedFile,
  type DetectChangedFilesOutput,
} from "./detect-changed-files.js";
import { classifyWorkType, type ClassifyOutput } from "./classify-work-type.js";
import { scoreRisk, type RiskOutput } from "./score-risk.js";
import { selectSquad, type SelectSquadOutput } from "./select-squad.js";
import { AGENT_NAMES_TUPLE, type AgentName, type WorkType } from "../config/ownership-matrix.js";
import {
  readSquadYaml,
  applySkipPaths,
  applyDisableAgents,
  type ResolvedSquadConfig,
} from "../config/squad-yaml.js";
import { SafeString as safeString } from "./_shared/schemas.js";
import { EXEC_MODES, selectMode, shapeSquadForMode, type ModeWarning } from "./mode/exec-mode.js";

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

const schema = z.object({
  workspace_root: safeString(4096),
  user_prompt: safeString(8192),
  base_ref: safeString(200).optional(),
  staged_only: z.boolean().optional().default(false),
  read_content: z.boolean().optional().default(true),
  /**
   * Execution depth. Omit to let `selectMode` auto-detect from
   * classify+risk signals. Pass explicitly to override the auto-detect.
   */
  mode: z.enum(EXEC_MODES).optional(),
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

export interface ComposeWorkflowOutput {
  changed_files: DetectChangedFilesOutput;
  classification: ClassifyOutput;
  risk: RiskOutput;
  squad: SelectSquadOutput;
  work_type: WorkType;
  /**
   * Resolved execution depth. Either the user's `mode` input or the value
   * `selectMode` chose. Stable contract from v0.8.0.
   */
  mode: import("./mode/exec-mode.js").ExecMode;
  /**
   * "user" when caller passed `mode` explicitly, "auto" when `selectMode`
   * derived it from risk+files_count signals. Useful for surfacing to the
   * user why the run was sized the way it was.
   */
  mode_source: "user" | "auto";
  /**
   * Structured warning produced by mode resolution or squad shaping. Stable
   * contract from v0.8.0 — consumers can switch on `code` rather than
   * regex-parsing `message`. Absent on the common path.
   *
   *   forced_quick_on_high_risk — user passed --quick on auth/money/migration
   *   force_agents_truncated    — quick-mode cap dropped some force_agents
   */
  mode_warning?: ModeWarning;
  inferred_risk_signals: {
    touches_auth: boolean;
    touches_money: boolean;
    touches_migration: boolean;
    files_count: number;
    new_module: boolean;
    api_contract_change: boolean;
  };
  /**
   * Resolved `.squad.yaml` config (defaults filled in). `source` is null if no
   * config file existed in workspace_root. Downstream callers (compose_advisory_bundle,
   * apply_consolidation_rules) can lift weights/threshold/min_score from here.
   */
  config: ResolvedSquadConfig;
  /**
   * Files removed from advisory by `config.skip_paths`. Surfaced so callers can
   * see *why* the slice list got narrower.
   */
  skipped_paths: string[];
  /**
   * Agents removed from the selected squad by `config.disable_agents`. Empty
   * unless config disabled at least one of the agents the matrix would have
   * picked.
   */
  disabled_agents: AgentName[];
}

const AUTH_PATTERN = /(Auth|Identity|Jwt|csrf|xss|passport|bcrypt|jsonwebtoken|oauth)/i;
const MONEY_PATTERN =
  /(payment|invoice|billing|charge|subscription|checkout|stripe|paypal|wallet)/i;
const MIGRATION_PATTERN =
  /([\\/](Migrations?|migrations?|alembic|knex[\\/]migrations|prisma[\\/]migrations)[\\/])|\.sql$/i;
const API_CONTRACT_PATTERN =
  /(Controller\.cs$|[\\/](api|endpoints?|handlers|routes)[\\/]|openapi\.|swagger\.)/i;

function inferRiskSignals(
  files: ChangedFile[],
  override: Input["risk_signals"],
): ComposeWorkflowOutput["inferred_risk_signals"] {
  const paths = files.map((f) => f.path);
  const auto = {
    touches_auth: paths.some((p) => AUTH_PATTERN.test(p)),
    touches_money: paths.some((p) => MONEY_PATTERN.test(p)),
    touches_migration: paths.some((p) => MIGRATION_PATTERN.test(p)),
    files_count: paths.length,
    new_module: files.some((f) => f.status === "added"),
    api_contract_change: paths.some((p) => API_CONTRACT_PATTERN.test(p)),
  };
  if (!override) return auto;
  return {
    touches_auth: override.touches_auth ?? auto.touches_auth,
    touches_money: override.touches_money ?? auto.touches_money,
    touches_migration: override.touches_migration ?? auto.touches_migration,
    files_count: auto.files_count,
    new_module: override.new_module ?? auto.new_module,
    api_contract_change: override.api_contract_change ?? auto.api_contract_change,
  };
}

export async function composeSquadWorkflow(input: Input): Promise<ComposeWorkflowOutput> {
  const detectInput: {
    workspace_root: string;
    base_ref?: string;
    staged_only: boolean;
  } = {
    workspace_root: input.workspace_root,
    staged_only: input.staged_only,
  };
  if (input.base_ref !== undefined) detectInput.base_ref = input.base_ref;
  const changed = await detectChangedFiles(detectInput);

  // Read .squad.yaml early — applies before classification because skip_paths
  // can shrink the file list, which changes the heuristic in classify/select.
  const config = await readSquadYaml(input.workspace_root);

  const allPaths = changed.files.map((f) => f.path);
  const { kept: filePaths, skipped: skippedPaths } = applySkipPaths(allPaths, config.skip_paths);

  const classification = classifyWorkType({
    user_prompt: input.user_prompt,
    files: filePaths,
  });
  const workType: WorkType = input.force_work_type ?? classification.work_type;

  // Risk signals use the FULL file list — disabling a file from advisory does
  // not make the change less risky (e.g. a migration in skip_paths still
  // touches schema).
  const riskSignals = inferRiskSignals(changed.files, input.risk_signals);
  const risk = scoreRisk(riskSignals);

  const squad = await selectSquad({
    work_type: workType,
    files: filePaths,
    read_content: input.read_content,
    workspace_root: input.workspace_root,
    force_agents: input.force_agents,
  });

  // Apply config.disable_agents to the selected squad. force_agents in the
  // input still wins — config is a default policy, not a veto over explicit
  // caller intent. Same precedence as scoring weights.
  const filteredAgents = applyDisableAgents(squad.agents, config.disable_agents);
  const disabledAgents = squad.agents.filter((a) => !filteredAgents.includes(a));

  // Resolve execution depth (quick / normal / deep). Either honours the
  // user's flag or auto-detects from classify+risk.
  const modeResolution = selectMode({
    userMode: input.mode,
    riskLevel: risk.level,
    workType,
    signals: riskSignals,
  });

  // Reshape the squad per resolved mode. Cap-to-2 for quick, force-include
  // architect+security for deep. `force_agents` from the caller still wins
  // because shapeSquadForMode treats `userForcedAgents` with precedence inside
  // the cap and may emit `force_agents_truncated` when the cap dropped some.
  const shaping = shapeSquadForMode(filteredAgents, modeResolution.mode, {
    workType,
    signals: riskSignals,
    userForcedAgents: input.force_agents ?? [],
  });
  const shapedSquad: SelectSquadOutput = {
    ...squad,
    agents: shaping.agents,
  };

  // Precedence: mode-resolution warning wins (it explains a safety override
  // the user actively forced); shaping warnings (truncation) only surface
  // when there isn't already a louder reason to alert.
  const warning: ModeWarning | undefined = modeResolution.warning ?? shaping.warning;

  const output: ComposeWorkflowOutput = {
    changed_files: changed,
    classification,
    risk,
    squad: shapedSquad,
    work_type: workType,
    mode: modeResolution.mode,
    mode_source: modeResolution.source,
    inferred_risk_signals: riskSignals,
    config,
    skipped_paths: skippedPaths,
    disabled_agents: disabledAgents,
  };
  if (warning !== undefined) {
    output.mode_warning = warning;
  }
  return output;
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
