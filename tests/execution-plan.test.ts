import { describe, it, expect } from "vitest";
import { buildExecutionPlan, selectMode, shapeSquadForMode } from "../src/tools/mode/exec-mode.js";
import { ExecutionStepSchema, type ExecutionStep } from "../src/tools/_shared/schemas.js";
import type { AgentName } from "../src/config/ownership-matrix.js";

/**
 * [O1] — typed, deterministic `execution_plan` emitted by
 * `compose_squad_workflow`. These tests pin the plan that `buildExecutionPlan`
 * derives from the resolved mode + shaped agents, including the two safety
 * overrides (forced --quick / --micro on a high-risk diff). The plan is a pure
 * projection — no IO, no LLM — so we drive it directly with the same
 * `selectMode` / `shapeSquadForMode` outputs the core pipeline feeds it.
 */

const baseSignals = {
  touches_auth: false,
  touches_money: false,
  touches_migration: false,
  files_count: 1,
  loc_changed: 10,
  new_module: false,
  api_contract_change: false,
};

/** Pull a single phase out of the plan for focused assertions. */
function phase(plan: ExecutionStep[], n: number): ExecutionStep {
  const step = plan.find((s) => s.phase === n);
  if (step === undefined) throw new Error(`no phase ${n} in plan`);
  return step;
}

describe("execution_plan — schema contract", () => {
  it("every step validates against ExecutionStepSchema", () => {
    for (const mode of ["micro", "quick", "normal", "deep"] as const) {
      const plan = buildExecutionPlan({ mode, agents: ["developer", "reviewer"] });
      for (const step of plan) {
        expect(() => ExecutionStepSchema.parse(step)).not.toThrow();
      }
    }
  });

  it("model_source is always 'frontmatter' (frontmatter pin wins in every mode)", () => {
    for (const mode of ["micro", "quick", "normal", "deep"] as const) {
      const plan = buildExecutionPlan({ mode, agents: ["developer"] });
      for (const step of plan) expect(step.model_source).toBe("frontmatter");
    }
  });

  it("covers the five mode-dependent phases (2, 4, 5, 8, 10)", () => {
    const plan = buildExecutionPlan({ mode: "normal", agents: ["developer"] });
    expect(plan.map((s) => s.phase).sort((a, b) => a - b)).toEqual([2, 4, 5, 8, 10]);
  });

  it("is deterministic — same inputs produce identical plans", () => {
    const a = buildExecutionPlan({ mode: "deep", agents: ["architect", "security"] });
    const b = buildExecutionPlan({ mode: "deep", agents: ["architect", "security"] });
    expect(a).toEqual(b);
  });
});

describe("execution_plan — normal mode (implement)", () => {
  const plan = buildExecutionPlan({ mode: "normal", agents: ["developer", "qa"] });

  it("runs the planner (Phase 2)", () => {
    expect(phase(plan, 2)).toEqual({
      phase: 2,
      run: true,
      model_source: "frontmatter",
      dispatch: "none",
      gate: null,
    });
  });

  it("runs Gate 1 (Phase 4) with a user gate", () => {
    expect(phase(plan, 4)).toMatchObject({ phase: 4, run: true, gate: "user", dispatch: "none" });
  });

  it("dispatches the advisory squad in parallel (Phase 5)", () => {
    expect(phase(plan, 5)).toEqual({
      phase: 5,
      run: true,
      agents: ["developer", "qa"],
      model_source: "frontmatter",
      dispatch: "parallel",
      gate: null,
    });
  });

  it("runs implementation (Phase 8) in implement mode", () => {
    expect(phase(plan, 8)).toEqual({
      phase: 8,
      run: true,
      model_source: "frontmatter",
      dispatch: "none",
      gate: null,
    });
  });

  it("runs the consolidator (Phase 10)", () => {
    expect(phase(plan, 10)).toMatchObject({ phase: 10, run: true, dispatch: "none" });
  });
});

describe("execution_plan — quick mode skips planner, keeps the rest", () => {
  const plan = buildExecutionPlan({ mode: "quick", agents: ["developer", "reviewer"] });

  it("skips Phase 2 with skip_reason 'quick'", () => {
    expect(phase(plan, 2)).toMatchObject({ phase: 2, run: false, skip_reason: "quick" });
  });

  it("still runs Gate 1 (Phase 4) in implement mode", () => {
    expect(phase(plan, 4)).toMatchObject({ run: true, gate: "user" });
  });

  it("dispatches the 2-agent advisory squad in parallel (Phase 5)", () => {
    expect(phase(plan, 5)).toMatchObject({
      run: true,
      dispatch: "parallel",
      agents: ["developer", "reviewer"],
    });
  });

  it("still runs Phase 10 (apply_consolidation_rules runs in quick)", () => {
    expect(phase(plan, 10)).toMatchObject({ run: true });
    expect(phase(plan, 10).skip_reason).toBeUndefined();
  });
});

describe("execution_plan — micro mode: inline review, skip planner + consolidator + gate", () => {
  const plan = buildExecutionPlan({ mode: "micro", agents: [] });

  it("skips Phase 2 with skip_reason 'micro'", () => {
    expect(phase(plan, 2)).toMatchObject({ phase: 2, run: false, skip_reason: "micro" });
  });

  it("skips Gate 1 (micro is review-only in V1)", () => {
    expect(phase(plan, 4)).toMatchObject({ run: false, skip_reason: "micro", gate: null });
  });

  it("replaces Phase 5 with an inline single-pass review (no dispatch, no agents)", () => {
    expect(phase(plan, 5)).toEqual({
      phase: 5,
      run: true,
      agents: [],
      model_source: "frontmatter",
      dispatch: "inline",
      gate: null,
    });
  });

  it("skips implementation (Phase 8) — micro is review-only in V1", () => {
    expect(phase(plan, 8)).toMatchObject({ phase: 8, run: false, skip_reason: "micro" });
  });

  it("skips the whole consolidator phase (Phase 10) with skip_reason 'micro'", () => {
    expect(phase(plan, 10)).toMatchObject({ phase: 10, run: false, skip_reason: "micro" });
  });
});

describe("execution_plan — deep mode forces architect + security in Phase 5", () => {
  const shaped = shapeSquadForMode(["developer"], "deep", {
    workType: "Feature",
    signals: baseSignals,
    userForcedAgents: [],
  });
  const plan = buildExecutionPlan({ mode: "deep", agents: shaped.agents });

  it("runs planner, Gate 1, advisory, consolidator", () => {
    expect(phase(plan, 2).run).toBe(true);
    expect(phase(plan, 4)).toMatchObject({ run: true, gate: "user" });
    expect(phase(plan, 5).run).toBe(true);
    expect(phase(plan, 10).run).toBe(true);
  });

  it("Phase 5 carries the deep-required agents (architect + security)", () => {
    const p5 = phase(plan, 5);
    expect(p5.dispatch).toBe("parallel");
    expect(p5.agents).toContain("architect");
    expect(p5.agents).toContain("security");
  });
});

describe("execution_plan — review mode skips planner draft + Gate 1", () => {
  const plan = buildExecutionPlan({
    mode: "normal",
    agents: ["developer", "qa"],
    runMode: "review",
  });

  it("skips Phase 2 with skip_reason 'review-mode'", () => {
    expect(phase(plan, 2)).toMatchObject({ run: false, skip_reason: "review-mode" });
  });

  it("skips Gate 1 with skip_reason 'review-mode'", () => {
    expect(phase(plan, 4)).toMatchObject({ run: false, skip_reason: "review-mode", gate: null });
  });

  it("skips implementation (Phase 8) with skip_reason 'review-mode'", () => {
    expect(phase(plan, 8)).toMatchObject({ run: false, skip_reason: "review-mode", gate: null });
  });

  it("still dispatches the advisory squad (review is advisory-only)", () => {
    expect(phase(plan, 5)).toMatchObject({ run: true, dispatch: "parallel" });
  });

  it("still runs the consolidator (Phase 10) — review emits the verdict", () => {
    expect(phase(plan, 10)).toMatchObject({ run: true });
    expect(phase(plan, 10).skip_reason).toBeUndefined();
  });

  it("defaults to implement when runMode is omitted (backward compatible)", () => {
    const implicit = buildExecutionPlan({ mode: "normal", agents: ["developer", "qa"] });
    const explicit = buildExecutionPlan({
      mode: "normal",
      agents: ["developer", "qa"],
      runMode: "implement",
    });
    expect(implicit).toEqual(explicit);
    expect(phase(implicit, 2).run).toBe(true);
    expect(phase(implicit, 4)).toMatchObject({ run: true, gate: "user" });
    expect(phase(implicit, 8).run).toBe(true);
  });
});

/**
 * Safety overrides — end-to-end through selectMode + shapeSquadForMode into the
 * plan, mirroring how composeWorkflowCore feeds buildExecutionPlan.
 */
describe("execution_plan — safety override: forced --quick on high-risk diff", () => {
  const ranked: AgentName[] = ["developer", "reviewer", "architect"];
  const signals = { ...baseSignals, touches_auth: true };

  const resolution = selectMode({
    userMode: "quick",
    riskLevel: "Low",
    workType: "Feature",
    signals,
  });
  const shaped = shapeSquadForMode(ranked, resolution.mode, {
    workType: "Feature",
    signals,
    userForcedAgents: [],
  });
  const plan = buildExecutionPlan({ mode: resolution.mode, agents: shaped.agents });

  it("stays in quick mode and emits forced_quick_on_high_risk", () => {
    expect(resolution.mode).toBe("quick");
    expect(resolution.warning?.code).toBe("forced_quick_on_high_risk");
  });

  it("force-includes security and keeps the 2-agent cap in Phase 5", () => {
    const p5 = phase(plan, 5);
    expect(p5.dispatch).toBe("parallel");
    expect(p5.agents).toContain("security");
    expect(p5.agents).toHaveLength(2);
  });

  it("still skips the planner (quick) but runs Gate 1 + consolidator", () => {
    expect(phase(plan, 2)).toMatchObject({ run: false, skip_reason: "quick" });
    expect(phase(plan, 4)).toMatchObject({ run: true, gate: "user" });
    expect(phase(plan, 10)).toMatchObject({ run: true });
  });
});

describe("execution_plan — safety override: forced --micro on high-risk diff degrades to quick", () => {
  const ranked: AgentName[] = ["developer", "reviewer"];
  const signals = { ...baseSignals, touches_migration: true };

  const resolution = selectMode({
    userMode: "micro",
    riskLevel: "Low",
    workType: "Feature",
    signals,
  });
  const shaped = shapeSquadForMode(ranked, resolution.mode, {
    workType: "Feature",
    signals,
    userForcedAgents: [],
  });
  const plan = buildExecutionPlan({ mode: resolution.mode, agents: shaped.agents });

  it("degrades to quick and emits forced_micro_on_high_risk", () => {
    expect(resolution.mode).toBe("quick");
    expect(resolution.warning?.code).toBe("forced_micro_on_high_risk");
  });

  it("produces a QUICK plan, not a micro one — Phase 5 dispatches in parallel", () => {
    const p5 = phase(plan, 5);
    expect(p5.dispatch).toBe("parallel");
    expect(p5.agents).toContain("security");
  });

  it("Phase 10 runs (not skipped as it would be in real micro)", () => {
    expect(phase(plan, 10)).toMatchObject({ run: true });
    expect(phase(plan, 10).skip_reason).toBeUndefined();
  });

  it("Phase 2 is skipped with skip_reason 'quick' (degraded), not 'micro'", () => {
    expect(phase(plan, 2)).toMatchObject({ run: false, skip_reason: "quick" });
  });
});
