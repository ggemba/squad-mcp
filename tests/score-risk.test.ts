import { describe, it, expect } from "vitest";
import { scoreRisk } from "../src/tools/score-risk.js";

describe("scoreRisk", () => {
  it("returns Low for empty signals", () => {
    const r = scoreRisk({
      touches_auth: false,
      touches_money: false,
      touches_migration: false,
      files_count: 0,
      new_module: false,
      api_contract_change: false,
    });
    expect(r.level).toBe("Low");
    expect(r.score).toBe(0);
  });

  it("returns Medium for 2 signals", () => {
    const r = scoreRisk({
      touches_auth: true,
      touches_money: true,
      touches_migration: false,
      files_count: 0,
      new_module: false,
      api_contract_change: false,
    });
    expect(r.level).toBe("Medium");
    expect(r.score).toBe(2);
  });

  it("returns High for 4+ signals", () => {
    const r = scoreRisk({
      touches_auth: true,
      touches_money: true,
      touches_migration: true,
      files_count: 12,
      new_module: false,
      api_contract_change: false,
    });
    expect(r.level).toBe("High");
    expect(r.score).toBe(4);
  });

  it("counts files_count_gt_8 as a single signal", () => {
    const r = scoreRisk({
      touches_auth: false,
      touches_money: false,
      touches_migration: false,
      files_count: 100,
      new_module: false,
      api_contract_change: false,
    });
    expect(r.score).toBe(1);
    expect(r.level).toBe("Low");
  });
});
