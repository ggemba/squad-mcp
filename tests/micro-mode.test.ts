import { describe, it, expect } from "vitest";
import {
  selectMode,
  shapeSquadForMode,
  EXEC_MODES,
  MICRO_AUTO_MAX_FILES,
  MICRO_AUTO_MAX_LOC,
  type ExecMode,
} from "../src/tools/mode/exec-mode.js";

const baseSignals = {
  touches_auth: false,
  touches_money: false,
  touches_migration: false,
  files_count: 1,
  loc_changed: 10,
  new_module: false,
  api_contract_change: false,
};

describe("EXEC_MODES contract", () => {
  it("includes micro alongside quick/normal/deep", () => {
    expect(EXEC_MODES).toEqual(["micro", "quick", "normal", "deep"]);
  });
});

describe("selectMode — micro auto-detect", () => {
  it("trips on small Low-risk Feature with loc_changed defined", () => {
    const r = selectMode({
      userMode: undefined,
      riskLevel: "Low",
      workType: "Feature",
      signals: { ...baseSignals, files_count: 2, loc_changed: 25 },
    });
    expect(r).toEqual({ mode: "micro", source: "auto" });
  });

  it("trips on Bug Fix / Refactor / Performance", () => {
    for (const wt of ["Bug Fix", "Refactor", "Performance"] as const) {
      const r = selectMode({
        userMode: undefined,
        riskLevel: "Low",
        workType: wt,
        signals: baseSignals,
      });
      expect(r.mode).toBe("micro");
    }
  });

  it("does NOT trip when loc_changed is missing — falls through to quick", () => {
    const sig: Record<string, unknown> = { ...baseSignals };
    delete sig.loc_changed;
    const r = selectMode({
      userMode: undefined,
      riskLevel: "Low",
      workType: "Feature",
      signals: sig as typeof baseSignals,
    });
    expect(r).toEqual({ mode: "quick", source: "auto" });
  });

  it("does NOT trip when files_count exceeds cap", () => {
    const r = selectMode({
      userMode: undefined,
      riskLevel: "Low",
      workType: "Feature",
      signals: { ...baseSignals, files_count: MICRO_AUTO_MAX_FILES + 1, loc_changed: 5 },
    });
    expect(r.mode).toBe("quick");
  });

  it("does NOT trip when loc_changed reaches the cap", () => {
    const r = selectMode({
      userMode: undefined,
      riskLevel: "Low",
      workType: "Feature",
      signals: { ...baseSignals, loc_changed: MICRO_AUTO_MAX_LOC },
    });
    expect(r.mode).toBe("quick");
  });

  it("does NOT trip on Security workType — always escalates", () => {
    const r = selectMode({
      userMode: undefined,
      riskLevel: "Low",
      workType: "Security",
      signals: baseSignals,
    });
    expect(r.mode).toBe("deep");
  });

  it("does NOT trip on Business Rule — needs product-owner", () => {
    const r = selectMode({
      userMode: undefined,
      riskLevel: "Low",
      workType: "Business Rule",
      signals: baseSignals,
    });
    // Business Rule isn't in MICRO_ELIGIBLE_WORK_TYPES and Security gate above
    // doesn't catch it, so it falls through to quick (files_count <= 8) rather
    // than micro.
    expect(r.mode).toBe("quick");
  });

  it("does NOT trip when touches_auth / money / migration", () => {
    for (const flag of ["touches_auth", "touches_money", "touches_migration"] as const) {
      const r = selectMode({
        userMode: undefined,
        riskLevel: "Low",
        workType: "Feature",
        signals: { ...baseSignals, [flag]: true },
      });
      expect(r.mode).toBe("deep");
    }
  });
});

describe("selectMode — micro forced by user", () => {
  it("honours --micro on a safe Low-risk diff", () => {
    const r = selectMode({
      userMode: "micro",
      riskLevel: "Low",
      workType: "Feature",
      signals: baseSignals,
    });
    expect(r).toEqual({ mode: "micro", source: "user" });
  });

  it("degrades --micro to quick on auth diff with forced_micro_on_high_risk", () => {
    const r = selectMode({
      userMode: "micro",
      riskLevel: "Low",
      workType: "Feature",
      signals: { ...baseSignals, touches_auth: true },
    });
    expect(r.mode).toBe("quick");
    expect(r.source).toBe("user");
    expect(r.warning?.code).toBe("forced_micro_on_high_risk");
  });

  it("degrades --micro on Security workType", () => {
    const r = selectMode({
      userMode: "micro",
      riskLevel: "Low",
      workType: "Security",
      signals: baseSignals,
    });
    expect(r.mode).toBe("quick");
    expect(r.warning?.code).toBe("forced_micro_on_high_risk");
  });

  it("degrades --micro on touches_migration", () => {
    const r = selectMode({
      userMode: "micro",
      riskLevel: "Low",
      workType: "Feature",
      signals: { ...baseSignals, touches_migration: true },
    });
    expect(r.mode).toBe("quick");
    expect(r.warning?.code).toBe("forced_micro_on_high_risk");
  });

  it("forced --quick still warns with forced_quick_on_high_risk on high risk", () => {
    const r = selectMode({
      userMode: "quick",
      riskLevel: "Low",
      workType: "Feature",
      signals: { ...baseSignals, touches_money: true },
    });
    expect(r.warning?.code).toBe("forced_quick_on_high_risk");
  });
});

describe("shapeSquadForMode — micro returns empty squad", () => {
  it("returns agents:[] for mode=micro regardless of selected list", () => {
    const out = shapeSquadForMode(["developer", "reviewer"], "micro" as ExecMode, {
      workType: "Feature",
      signals: baseSignals,
      userForcedAgents: [],
    });
    expect(out.agents).toEqual([]);
    expect(out.warning).toBeUndefined();
  });

  it("preserves existing shaping for quick/normal/deep", () => {
    const quick = shapeSquadForMode(
      ["developer", "reviewer", "qa", "architect"],
      "quick" as ExecMode,
      {
        workType: "Feature",
        signals: baseSignals,
        userForcedAgents: [],
      },
    );
    expect(quick.agents.length).toBe(2);

    const normal = shapeSquadForMode(["developer", "qa"], "normal" as ExecMode, {
      workType: "Feature",
      signals: baseSignals,
      userForcedAgents: [],
    });
    expect(normal.agents).toEqual(["developer", "qa"]);

    const deep = shapeSquadForMode(["developer"], "deep" as ExecMode, {
      workType: "Feature",
      signals: baseSignals,
      userForcedAgents: [],
    });
    expect(deep.agents).toContain("architect");
    expect(deep.agents).toContain("security");
  });
});
