/**
 * Shared compose pipeline core.
 *
 * `compose_squad_workflow` and `compose_advisory_bundle` both need the
 * deterministic detect -> read_squad_config -> classify -> score -> select ->
 * mode-resolution pipeline. Historically `compose_squad_workflow` owned this
 * logic and `compose_advisory_bundle` called it; the architect flagged the
 * coupling because the workflow result shape and the risk-inference helpers
 * were entangled with the `compose_squad_workflow` tool file rather than
 * living in a neutral, tool-agnostic place.
 *
 * This module is that neutral place. It exports:
 *   - `ComposeWorkflowOutput` — the union result both tools build on.
 *   - `ComposeCoreInput`       — the structurally-typed input the core needs
 *                                (NOT a Zod schema; each tool keeps its own
 *                                public schema unchanged).
 *   - `composeWorkflowCore`    — the pipeline function.
 *
 * The two tool handlers are thin wrappers: `compose_squad_workflow` just
 * forwards to `composeWorkflowCore`; `compose_advisory_bundle` calls the core
 * and then layers slices_by_agent / hunks_by_agent / plan_validation /
 * language supplements on top.
 *
 * Behaviour contract: this is a pure extraction. The logic below was moved
 * verbatim from `compose-squad-workflow.ts`; the observable output of both
 * tools is unchanged.
 */
import {
  detectChangedFiles,
  type ChangedFile,
  type DetectChangedFilesOutput,
} from "../detect-changed-files.js";
import { classifyWorkType, type ClassifyOutput } from "../classify-work-type.js";
import { scoreRisk, type RiskOutput } from "../score-risk.js";
import { selectSquad, type SelectSquadOutput } from "../select-squad.js";
import type { AgentName, WorkType } from "../../config/ownership-matrix.js";
import {
  readSquadYaml,
  applySkipPaths,
  applyDisableAgents,
  type ResolvedSquadConfig,
} from "../../config/squad-yaml.js";
import { sanitizeForPrompt } from "../../util/prompt-sanitize.js";
import {
  selectMode,
  shapeSquadForMode,
  type ExecMode,
  type ModeWarning,
} from "../mode/exec-mode.js";

/**
 * Optional caller-supplied risk-signal overrides. Each field, when present,
 * overrides the path-inferred value; `files_count` and `loc_changed` are
 * always inferred (callers cannot lie about diff shape).
 */
export interface ComposeRiskSignalsInput {
  touches_auth?: boolean;
  touches_money?: boolean;
  touches_migration?: boolean;
  new_module?: boolean;
  api_contract_change?: boolean;
}

/**
 * Structural input for the shared pipeline. This is intentionally a plain
 * interface, NOT a Zod schema — each tool keeps its own public Zod schema
 * (the MCP boundary contract) and maps the parsed result into this shape.
 */
export interface ComposeCoreInput {
  workspace_root: string;
  user_prompt: string;
  base_ref?: string;
  staged_only?: boolean;
  /**
   * Review the dirty working tree (staged + unstaged vs HEAD). Mutually
   * exclusive with `base_ref` and `staged_only` — the upstream
   * `detect_changed_files` schema rejects combinations. Introduced v1.7
   * for `/squad:review` against work-in-progress.
   */
  working_tree?: boolean;
  read_content?: boolean;
  mode?: ExecMode;
  force_work_type?: WorkType;
  force_agents?: AgentName[];
  risk_signals?: ComposeRiskSignalsInput;
}

export interface ComposeWorkflowOutput {
  /**
   * Sanitized user prompt as it was used for classification and as it will be
   * embedded in downstream agent prompts. Equals
   * `sanitizeForPrompt(input.user_prompt)` (idempotent — sanitizing already-
   * sanitized input is a no-op). Exposed so callers and tests can verify the
   * prompt-injection-codepoint strip happened before the value left this tool.
   */
  user_prompt: string;
  changed_files: DetectChangedFilesOutput;
  classification: ClassifyOutput;
  risk: RiskOutput;
  squad: SelectSquadOutput;
  work_type: WorkType;
  /**
   * Resolved execution depth. Either the user's `mode` input or the value
   * `selectMode` chose. Stable contract from v0.8.0.
   */
  mode: ExecMode;
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
    /**
     * Total lines added + removed across the diff. Present only when the
     * upstream `detect_changed_files` call ran with `with_stats: true`
     * (which `composeWorkflowCore` triggers automatically when the caller
     * did NOT pass an explicit `mode` — i.e. when auto-detect is in play).
     * Undefined otherwise; downstream `selectMode` treats undefined as
     * "micro auto-detect not eligible". Stable contract from v1.7.
     */
    loc_changed?: number;
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
  override: ComposeRiskSignalsInput | undefined,
  totalLocChanged: number | undefined,
): ComposeWorkflowOutput["inferred_risk_signals"] {
  const paths = files.map((f) => f.path);
  const auto: ComposeWorkflowOutput["inferred_risk_signals"] = {
    touches_auth: paths.some((p) => AUTH_PATTERN.test(p)),
    touches_money: paths.some((p) => MONEY_PATTERN.test(p)),
    touches_migration: paths.some((p) => MIGRATION_PATTERN.test(p)),
    files_count: paths.length,
    new_module: files.some((f) => f.status === "added"),
    api_contract_change: paths.some((p) => API_CONTRACT_PATTERN.test(p)),
  };
  if (totalLocChanged !== undefined) auto.loc_changed = totalLocChanged;
  if (!override) return auto;
  const merged: ComposeWorkflowOutput["inferred_risk_signals"] = {
    touches_auth: override.touches_auth ?? auto.touches_auth,
    touches_money: override.touches_money ?? auto.touches_money,
    touches_migration: override.touches_migration ?? auto.touches_migration,
    files_count: auto.files_count,
    new_module: override.new_module ?? auto.new_module,
    api_contract_change: override.api_contract_change ?? auto.api_contract_change,
  };
  if (totalLocChanged !== undefined) merged.loc_changed = totalLocChanged;
  return merged;
}

/**
 * Shared deterministic pipeline: detect_changed_files -> read_squad_config ->
 * classify_work_type -> score_risk -> select_squad -> mode resolution.
 *
 * Called by both `compose_squad_workflow` (thin wrapper) and
 * `compose_advisory_bundle` (which layers extra steps on top). The logic here
 * is a verbatim extraction from the former `composeSquadWorkflow` body — see
 * the module header for the no-behaviour-change contract.
 */
export async function composeWorkflowCore(input: ComposeCoreInput): Promise<ComposeWorkflowOutput> {
  // Sanitize at the prompt boundary — strips invisibles, role tokens, normalises NFKC.
  // See src/util/prompt-sanitize.ts. Idempotent — if `compose_advisory_bundle` already
  // sanitized before delegating, this is a no-op (proven in D4 property tests).
  const safeUserPrompt = sanitizeForPrompt(input.user_prompt);

  // Caller did not pass an explicit `mode` → auto-detect is in play. Auto-
  // detect of `micro` needs `loc_changed`, which only `detect_changed_files`
  // can produce (via `--numstat`). Pay the extra git subprocess (~50-150ms
  // cold) only on the auto-detect path; explicit `--quick`/`--normal`/`--deep`
  // callers don't need the stat and keep the v1.6 cheap path.
  const wantsStats = input.mode === undefined;
  const detectInput: {
    workspace_root: string;
    base_ref?: string;
    staged_only: boolean;
    working_tree: boolean;
    with_stats: boolean;
  } = {
    workspace_root: input.workspace_root,
    staged_only: input.staged_only ?? false,
    working_tree: input.working_tree ?? false,
    with_stats: wantsStats,
  };
  if (input.base_ref !== undefined) detectInput.base_ref = input.base_ref;

  // Phase 0 parallelisation (v0.12+, B1): `detectChangedFiles` spawns a git
  // subprocess (~50-300ms cold) and `readSquadYaml` does a small `fs.stat` +
  // `fs.readFile` (~5-30ms). They are independent — read_squad_config does
  // not consume the changed-files list. Run them concurrently so the slower
  // of the two dominates wall-clock instead of their sum.
  //
  // Order of `Promise.all`: doesn't matter for correctness; both promises
  // start eagerly when the array is constructed. The runtime parallelism
  // budget here is bounded by Node's event loop + git process startup.
  //
  // Each call's error policy is preserved: detectChangedFiles throws on git
  // failure, readSquadYaml throws on invalid YAML. Promise.all surfaces the
  // first rejection — same behaviour the sequential `await` chain produced.
  const [changed, config] = await Promise.all([
    detectChangedFiles(detectInput),
    readSquadYaml(input.workspace_root),
  ]);

  const allPaths = changed.files.map((f) => f.path);
  const { kept: filePaths, skipped: skippedPaths } = applySkipPaths(allPaths, config.skip_paths);

  // Project the kept paths back into the ChangedFile shape so the downstream
  // `selectSquad` call can apply the v1.7.3+ weak-path-hint gate (status=D
  // skip, magnitude threshold). `applySkipPaths` works on strings to keep its
  // signature stable; we rebuild the typed list here.
  const keptSet = new Set(filePaths);
  const keptFiles = changed.files.filter((f) => keptSet.has(f.path));

  const classification = classifyWorkType({
    user_prompt: safeUserPrompt,
    files: filePaths,
  });
  const workType: WorkType = input.force_work_type ?? classification.work_type;

  // Risk signals use the FULL file list — disabling a file from advisory does
  // not make the change less risky (e.g. a migration in skip_paths still
  // touches schema).
  const riskSignals = inferRiskSignals(
    changed.files,
    input.risk_signals,
    changed.total_loc_changed,
  );
  // scoreRisk's zod schema declares `loc_changed` with `.default(0)`, which
  // makes the inferred TS type `number` (not `number | undefined`). The
  // inferred-signals shape carries it optionally because we want `selectMode`
  // to distinguish "stat unavailable" from "stat says 0". Bridge the gap by
  // passing 0 explicitly to scoreRisk — it doesn't read the field anyway
  // (passthrough only), so the substitution is safe.
  const risk = scoreRisk({ ...riskSignals, loc_changed: riskSignals.loc_changed ?? 0 });

  // v1.7.3: pass the rich ChangedFile shape (with status + per-file LOC) so
  // `selectSquad` can apply the weak-path-hint gate. Legacy callers that still
  // pass `string[]` are accepted via the schema's z.union; internal callers
  // now feed the structured form.
  const squad = await selectSquad({
    work_type: workType,
    files: keptFiles.map((f) => {
      const entry: {
        path: string;
        status: typeof f.status;
        loc_added?: number;
        loc_deleted?: number;
      } = { path: f.path, status: f.status };
      if (f.loc_added !== undefined) entry.loc_added = f.loc_added;
      if (f.loc_deleted !== undefined) entry.loc_deleted = f.loc_deleted;
      return entry;
    }),
    read_content: input.read_content ?? true,
    workspace_root: input.workspace_root,
    force_agents: input.force_agents ?? [],
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
    user_prompt: safeUserPrompt,
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
