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
 * History: shipped at 5 in v0.8.0, bumped to 8 in 2026-05 after telemetry
 * showed the median Low-risk PR sits around 6-7 files (small refactors,
 * docs+code combos, a feature with its single test file). At 5 the auto-detect
 * fell back to `normal` (4-7 agents, ~60-90s wall-clock) too often for diffs
 * that didn't actually need that breadth, training users to pass `--quick`
 * by hand. The risk gate (auth/money/migration/Security still force `deep`)
 * is the load-bearing safety; the file-count cap is just a budget heuristic.
 *
 * Earlier draft also gated on a `loc_changed` heuristic, but the heuristic
 * was tautological with this file-count cap and could be foot-gunned by
 * single-file giant rewrites. Removed; track the `git diff --numstat`
 * follow-up if needed.
 */
export const QUICK_AUTO_MAX_FILES = 8;

/**
 * Auto-detect thresholds for `mode: "micro"`. Introduced in v1.7. Surfaced as
 * named constants so a future `.squad.yaml` override has a single hook.
 *
 * Rationale: a 1-2 file change under 30 LOC at Low risk and outside
 * security/business-rule territory is a single-pass review job. The squad's
 * minimum (`quick` = 2 Sonnet dispatches + consolidation) is overkill at that
 * scale — the contextserver design proves a single LLM pass with diff +
 * scorecard template covers the same ground in ~10-30s instead of ~30-60s.
 */
export const MICRO_AUTO_MAX_FILES = 2;
export const MICRO_AUTO_MAX_LOC = 30;

/**
 * Execution depth. PUBLIC STABLE CONTRACT from v0.8.0 — downstream
 * `.squad.yaml` consumers and CI integrations may key on this field.
 *
 *  - `micro` (v1.7+): single-pass inline review. NO subagent dispatch at all
 *    — `compose_advisory_bundle` emits a ready-to-emit `micro_prompt` and the
 *    orchestrator responds inline in the same turn. Skip Phase 2 (planner),
 *    Phase 5 (advisory dispatch), Phase 10 (consolidator persona). Auto-trips
 *    when files_count<=2, loc_changed<30, risk=Low, no auth/money/migration,
 *    workType ∈ {Feature, Bug Fix, Refactor, Performance}. Review-mode only
 *    in V1; `/squad:implement --micro` degrades to `quick`.
 *  - `quick`: cap squad to 2 agents (top-2 from the ranked `selectSquad`
 *    output, with `developer` always force-included as a tiebreaker
 *    for code-touching work types). Skip tech-lead-planner and
 *    tech-lead-consolidator personas. `apply_consolidation_rules` still runs.
 *  - `normal`: zero behavioural change vs. pre-v0.8.0. The implicit default.
 *  - `deep`: force-include `architect` + `security`.
 *    Reject-loop cap raised from 2 to 3 iterations. Codex round suggested
 *    (still gated on `--codex` consent).
 *
 * Auto-detection fires only when no `--micro`/`--quick`/`--deep` flag is
 * passed. User flag always wins (subject to high-risk safety override). See
 * `selectMode` for the rule.
 */
export type ExecMode = "micro" | "quick" | "normal" | "deep";
export const EXEC_MODES = ["micro", "quick", "normal", "deep"] as const;

/**
 * Named constants for the agents the mode logic explicitly cares about.
 * Exported so tests can assert against them by name instead of by string
 * literal — if the role names ever change, the tests fail in the right
 * place rather than silently passing on the new literal.
 */
export const TIEBREAKER_AGENT: AgentName = "developer";
export const FALLBACK_SECONDARY: AgentName = "qa";
export const DEEP_REQUIRED: readonly AgentName[] = ["architect", "security"];

/**
 * `mode_warning` codes. Stable from v0.8.0. CI integrations can differentiate
 * warning types without regex-parsing the human message.
 */
export type ModeWarningCode =
  | "forced_quick_on_high_risk"
  | "forced_micro_on_high_risk"
  | "force_agents_truncated";

export interface ModeWarning {
  code: ModeWarningCode;
  message: string;
}

interface RiskSignals {
  touches_auth: boolean;
  touches_money: boolean;
  touches_migration: boolean;
  files_count: number;
  /**
   * Total lines added + removed across all changed files. Used exclusively by
   * the `micro` auto-detect cap (introduced v1.7). Default 0 when the caller
   * did not compute it — that just skips the `micro` cap and falls through to
   * the existing `quick`/`normal`/`deep` resolution unchanged.
   */
  loc_changed?: number;
  new_module?: boolean;
  api_contract_change?: boolean;
}

/**
 * Work types eligible for `micro` auto-detect. Security needs multi-agent
 * scrutiny (security agent + reviewer). Business Rule needs the product-owner
 * agent to weigh the rule change. Anything else is fair game for a single
 * inline pass when the size/risk caps also hold.
 */
const MICRO_ELIGIBLE_WORK_TYPES: readonly WorkType[] = [
  "Feature",
  "Bug Fix",
  "Refactor",
  "Performance",
];

/**
 * Decide execution depth from classify+risk signals. User-supplied `mode`
 * always wins (returned with `source: "user"`), subject to the high-risk
 * safety override. Auto-detect rules (tried in order):
 *
 *   deep  ← riskLevel == High || workType == Security || touches_auth/money/migration
 *   micro ← riskLevel == Low (v1.7+)
 *           && files_count <= MICRO_AUTO_MAX_FILES (2)
 *           && (loc_changed ?? Infinity) < MICRO_AUTO_MAX_LOC (30)
 *           && !touches_auth/money/migration
 *           && workType ∈ MICRO_ELIGIBLE_WORK_TYPES
 *   quick ← riskLevel == Low
 *           && files_count <= QUICK_AUTO_MAX_FILES
 *           && !touches_auth/money/migration
 *           && workType != Security
 *   normal← everything else
 *
 * Safety overrides on a forced flag against a high-risk diff:
 *   --quick on high-risk → keeps quick, emits forced_quick_on_high_risk
 *   --micro on high-risk → degrades to quick, emits forced_micro_on_high_risk
 *     (micro skips advisor dispatch entirely; on a security-relevant change
 *     that is the wrong default — quick at least dispatches 2 agents with
 *     security force-included.)
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
            "user forced --quick on a high-risk diff; security force-included in the 2-agent cap as a safety override",
        },
      };
    }
    if (args.userMode === "micro" && isHighRiskShape) {
      return {
        mode: "quick",
        source: "user",
        warning: {
          code: "forced_micro_on_high_risk",
          message:
            "user forced --micro on a high-risk diff; degraded to quick (2 agents with security force-included) — micro skips advisor dispatch and is unsafe on auth/money/migration/Security changes",
        },
      };
    }
    return { mode: args.userMode, source: "user" };
  }

  if (isHighRiskShape) return { mode: "deep", source: "auto" };

  // `micro` is the tightest auto-cap and runs BEFORE `quick`. All four caps
  // must hold: file count, LOC budget, work type, and Low risk (the
  // !isHighRiskShape guard above already excludes auth/money/migration paths).
  const locWithinMicroCap =
    args.signals.loc_changed === undefined || args.signals.loc_changed < MICRO_AUTO_MAX_LOC;
  if (
    args.riskLevel === "Low" &&
    args.signals.files_count <= MICRO_AUTO_MAX_FILES &&
    args.signals.loc_changed !== undefined && // require caller-supplied stats
    locWithinMicroCap &&
    MICRO_ELIGIBLE_WORK_TYPES.includes(args.workType)
  ) {
    return { mode: "micro", source: "auto" };
  }

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
 *  - `micro` (v1.7+): return an EMPTY list. Micro mode has no subagent
 *    dispatch — the orchestrator emits the review inline from
 *    `compose_advisory_bundle.micro_prompt`. The empty list is the
 *    machine-readable signal the SKILL.md spine uses to skip Phase 5
 *    (and Phase 2 / Phase 10) entirely.
 *  - `quick`: take the top-2 agents from `selectedAgents` (which arrives
 *    rank-ordered from selectSquad: core matrix → signals → user
 *    force_agents). `developer` is force-included as a tiebreaker
 *    when the work_type is code-touching (anything other than
 *    `Business Rule`) — covers the Refactor/Performance path where
 *    `selectSquad` may not pick `developer` from the matrix but
 *    the user still wants code-review eyes.
 *    When the user forced `--quick` on a high-risk diff (signalled via
 *    `signals.touches_auth/money/migration`), `security` is
 *    force-included as one of the two regardless.
 *  - `normal`: pass through unchanged.
 *  - `deep`: force-include `DEEP_REQUIRED` (architect + security) even if
 *    `selectSquad` did not pick them.
 *
 * Precedence inside the 2-agent cap for `quick` (highest first):
 *   1. Safety override (`security` on forced-quick-on-high-risk).
 *   2. `userForcedAgents` (caller intent).
 *   3. Tiebreaker `developer` (code-touching work types).
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
  if (mode === "micro") return { agents: [] };

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
  if (highRiskShape) push("security");

  // (2) User-forced agents — preserve their intent within the cap.
  let droppedForced = 0;
  for (const a of ctx.userForcedAgents) {
    if (!push(a) && !seen.has(a)) droppedForced += 1;
  }

  // (3) Tiebreaker for code-touching work types: developer is the most
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
