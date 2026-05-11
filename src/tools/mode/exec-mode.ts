import type { AgentName, WorkType } from "../../config/ownership-matrix.js";

/**
 * Execution depth resolution and squad shaping.
 *
 * `selectMode` picks one of `quick` / `normal` / `deep` from classify+risk
 * signals (or honours the user's flag). `shapeSquadForMode` adjusts the
 * agent list per the resolved mode.
 *
 * Lives in its own module so the pipeline orchestrator
 * (`compose-squad-workflow.ts`) stays focused on its single job (detect →
 * classify → score → select → shape). A future `.squad.yaml`-configurable
 * threshold lands here, not in the pipeline.
 */

/**
 * Auto-detect threshold for `mode: "quick"`. Surfaced as a named constant so
 * a future `.squad.yaml` override (Sprint 2 / v0.8.1) has a single hook.
 *
 * Note: an earlier draft also gated on a `loc_changed` heuristic, but the
 * heuristic was tautological with this file-count cap and could be foot-gunned
 * by single-file giant rewrites. Removed in favour of a real `git diff --numstat`
 * once we need finer granularity — track in the v0.8.1 follow-up.
 */
export const QUICK_AUTO_MAX_FILES = 5;

/**
 * Execution depth. PUBLIC STABLE CONTRACT from v0.8.0 — downstream
 * `.squad.yaml` consumers and CI integrations may key on this field.
 *
 *  - `quick`: cap squad to 2 agents (top-2 from the ranked `selectSquad`
 *    output, with `senior-developer` always force-included as a tiebreaker
 *    for code-touching work types). Skip tech-lead-planner and
 *    tech-lead-consolidator personas. `apply_consolidation_rules` still runs.
 *  - `normal`: zero behavioural change vs. pre-v0.8.0. The implicit default.
 *  - `deep`: force-include `senior-architect` + `senior-dev-security`.
 *    Reject-loop cap raised from 2 to 3 iterations. Codex round suggested
 *    (still gated on `--codex` consent).
 *
 * Auto-detection fires only when neither `--quick` nor `--deep` is passed.
 * User flag always wins. See `selectMode` for the rule.
 */
export type ExecMode = "quick" | "normal" | "deep";
export const EXEC_MODES = ["quick", "normal", "deep"] as const;

/**
 * Named constants for the agents the mode logic explicitly cares about.
 * Exported so tests can assert against them by name instead of by string
 * literal — if the role names ever change, the tests fail in the right
 * place rather than silently passing on the new literal.
 */
export const TIEBREAKER_AGENT: AgentName = "senior-developer";
export const FALLBACK_SECONDARY: AgentName = "senior-qa";
export const DEEP_REQUIRED: readonly AgentName[] = ["senior-architect", "senior-dev-security"];

/**
 * `mode_warning` codes. Stable from v0.8.0. CI integrations can differentiate
 * warning types without regex-parsing the human message.
 */
export type ModeWarningCode = "forced_quick_on_high_risk" | "force_agents_truncated";

export interface ModeWarning {
  code: ModeWarningCode;
  message: string;
}

interface RiskSignals {
  touches_auth: boolean;
  touches_money: boolean;
  touches_migration: boolean;
  files_count: number;
  new_module?: boolean;
  api_contract_change?: boolean;
}

/**
 * Decide execution depth from classify+risk signals. User-supplied `mode`
 * always wins (returned with `source: "user"`). Auto-detect rules:
 *
 *   deep  ← riskLevel == High || workType == Security || touches_migration
 *   quick ← riskLevel == Low
 *           && files_count <= QUICK_AUTO_MAX_FILES
 *           && !touches_auth && !touches_money && !touches_migration
 *           && workType != Security
 *   normal← everything else
 */
export function selectMode(args: {
  userMode: ExecMode | undefined;
  riskLevel: "Low" | "Medium" | "High";
  workType: WorkType;
  signals: RiskSignals;
}): { mode: ExecMode; source: "user" | "auto"; warning?: ModeWarning } {
  const isHighRiskShape =
    args.riskLevel === "High" ||
    args.workType === "Security" ||
    args.signals.touches_auth ||
    args.signals.touches_money ||
    args.signals.touches_migration;

  if (args.userMode !== undefined) {
    if (args.userMode === "quick" && isHighRiskShape) {
      return {
        mode: "quick",
        source: "user",
        warning: {
          code: "forced_quick_on_high_risk",
          message:
            "user forced --quick on a high-risk diff; senior-dev-security force-included in the 2-agent cap as a safety override",
        },
      };
    }
    return { mode: args.userMode, source: "user" };
  }

  if (isHighRiskShape) return { mode: "deep", source: "auto" };

  if (
    args.riskLevel === "Low" &&
    args.signals.files_count <= QUICK_AUTO_MAX_FILES &&
    args.workType !== "Security"
  ) {
    return { mode: "quick", source: "auto" };
  }

  return { mode: "normal", source: "auto" };
}

/**
 * Cap or expand the agent list according to execution depth.
 *
 *  - `quick`: take the top-2 agents from `selectedAgents` (which arrives
 *    rank-ordered from selectSquad: core matrix → signals → user
 *    force_agents). `senior-developer` is force-included as a tiebreaker
 *    when the work_type is code-touching (anything other than
 *    `Business Rule`) — covers the Refactor/Performance path where
 *    `selectSquad` may not pick `senior-developer` from the matrix but
 *    the user still wants code-review eyes.
 *    When the user forced `--quick` on a high-risk diff (signalled via
 *    `signals.touches_auth/money/migration`), `senior-dev-security` is
 *    force-included as one of the two regardless.
 *  - `normal`: pass through unchanged.
 *  - `deep`: force-include `DEEP_REQUIRED` (architect + security) even if
 *    `selectSquad` did not pick them.
 *
 * Precedence inside the 2-agent cap for `quick` (highest first):
 *   1. Safety override (`senior-dev-security` on forced-quick-on-high-risk).
 *   2. `userForcedAgents` (caller intent).
 *   3. Tiebreaker `senior-developer` (code-touching work types).
 *   4. Top of `selectedAgents` ranked order.
 *   5. `FALLBACK_SECONDARY` last resort to guarantee 2 agents.
 *
 * Returns the (potentially) reshaped list and a `truncationWarning` when
 * the user's `force_agents` exceeded the cap-to-2 and slots were dropped.
 */
export function shapeSquadForMode(
  selectedAgents: AgentName[],
  mode: ExecMode,
  ctx: {
    workType: WorkType;
    signals: RiskSignals;
    userForcedAgents: readonly AgentName[];
  },
): { agents: AgentName[]; warning?: ModeWarning } {
  if (mode === "normal") return { agents: selectedAgents };

  if (mode === "deep") {
    const out = [...selectedAgents];
    for (const required of DEEP_REQUIRED) {
      if (!out.includes(required)) out.push(required);
    }
    return { agents: out };
  }

  // mode === "quick"
  const highRiskShape =
    ctx.signals.touches_auth || ctx.signals.touches_money || ctx.signals.touches_migration;

  const seen = new Set<AgentName>();
  const picked: AgentName[] = [];
  const push = (a: AgentName): boolean => {
    if (picked.length >= 2) return false;
    if (seen.has(a)) return false;
    seen.add(a);
    picked.push(a);
    return true;
  };

  // (1) Safety override.
  if (highRiskShape) push("senior-dev-security");

  // (2) User-forced agents — preserve their intent within the cap.
  let droppedForced = 0;
  for (const a of ctx.userForcedAgents) {
    if (!push(a) && !seen.has(a)) droppedForced += 1;
  }

  // (3) Tiebreaker for code-touching work types: senior-developer is the most
  // general reviewer; force-include even if the matrix did not pick it.
  // Skip only for Business Rule (PO-owned, not code-centric).
  if (ctx.workType !== "Business Rule") push(TIEBREAKER_AGENT);

  // (4) Fill remaining slot(s) from the ranked list.
  for (const a of selectedAgents) push(a);

  // (5) Last-resort fallback to guarantee 2 agents even with pathological
  // upstream (e.g. selectSquad returned an empty list).
  if (picked.length < 2) push(FALLBACK_SECONDARY);

  const result: { agents: AgentName[]; warning?: ModeWarning } = { agents: picked };
  if (droppedForced > 0) {
    result.warning = {
      code: "force_agents_truncated",
      message: `quick mode caps the squad at 2 agents; ${droppedForced} of the user's force_agents were dropped`,
    };
  }
  return result;
}
