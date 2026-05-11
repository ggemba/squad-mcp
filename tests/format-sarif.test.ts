import { describe, it, expect } from "vitest";
import { formatSarif, SARIF_VERSION, SARIF_SCHEMA_URL } from "../src/format/sarif.js";
import type { ConsolidationOutput } from "../src/tools/consolidate.js";

function makeConsolidation(overrides: Partial<ConsolidationOutput> = {}): ConsolidationOutput {
  return {
    verdict: "APPROVED",
    blockers: [],
    majors_unjustified: [],
    forwarded: [],
    not_evaluated: [],
    severity_counts: { Blocker: 0, Major: 0, Minor: 0, Suggestion: 0 },
    agents_involved: [],
    summary: "test",
    rubric: null,
    downgraded_by_score: false,
    ...overrides,
  };
}

describe("formatSarif — schema shape", () => {
  it("emits a valid SARIF 2.1.0 envelope", () => {
    const log = formatSarif(makeConsolidation());
    expect(log.$schema).toBe(SARIF_SCHEMA_URL);
    expect(log.version).toBe(SARIF_VERSION);
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0].tool.driver.name).toBe("squad-mcp");
    expect(log.runs[0].tool.driver.informationUri).toMatch(/^https:\/\//);
    expect(Array.isArray(log.runs[0].results)).toBe(true);
  });

  it("clean run produces zero results and stable run.properties", () => {
    const log = formatSarif(
      makeConsolidation({
        verdict: "APPROVED",
        summary: "no issues",
        severity_counts: { Blocker: 0, Major: 0, Minor: 0, Suggestion: 0 },
      }),
    );
    expect(log.runs[0].results).toHaveLength(0);
    expect(log.runs[0].properties).toMatchObject({
      verdict: "APPROVED",
      weighted_score: null,
      passes_threshold: null,
      severity_counts: { Blocker: 0, Major: 0, Minor: 0, Suggestion: 0 },
      downgraded_by_score: false,
      summary: "no issues",
    });
  });
});

describe("formatSarif — finding mapping", () => {
  it("maps blockers to error level + carries fingerprint + agent property", () => {
    const log = formatSarif(
      makeConsolidation({
        verdict: "REJECTED",
        blockers: [{ agent: "senior-architect", title: "Module boundary violated" }],
        severity_counts: { Blocker: 1, Major: 0, Minor: 0, Suggestion: 0 },
      }),
    );
    expect(log.runs[0].results).toHaveLength(1);
    const r = log.runs[0].results[0];
    expect(r.level).toBe("error");
    expect(r.message.text).toBe("Module boundary violated");
    expect(r.ruleId).toBe("senior-architect:blocker");
    expect(r.partialFingerprints.canonicalHash).toMatch(/^[0-9a-f]{16}$/);
    expect(r.properties).toEqual({ severity: "Blocker", agent: "senior-architect" });
  });

  it("maps unjustified majors to error level", () => {
    const log = formatSarif(
      makeConsolidation({
        majors_unjustified: [{ agent: "senior-developer", title: "Async error handling missing" }],
        severity_counts: { Blocker: 0, Major: 1, Minor: 0, Suggestion: 0 },
      }),
    );
    expect(log.runs[0].results).toHaveLength(1);
    expect(log.runs[0].results[0].level).toBe("error");
    expect(log.runs[0].results[0].properties.severity).toBe("Major");
  });

  it("aggregates rules in driver.rules without duplicates", () => {
    const log = formatSarif(
      makeConsolidation({
        blockers: [
          { agent: "senior-developer", title: "X" },
          { agent: "senior-developer", title: "Y" },
        ],
        majors_unjustified: [{ agent: "senior-developer", title: "Z" }],
        severity_counts: { Blocker: 2, Major: 1, Minor: 0, Suggestion: 0 },
      }),
    );
    const rules = log.runs[0].tool.driver.rules.map((r) => r.id);
    expect(rules).toEqual(["senior-developer:blocker", "senior-developer:major"]);
  });

  it("identical findings produce the same fingerprint (idempotent dedup signal)", () => {
    const log = formatSarif(
      makeConsolidation({
        blockers: [
          { agent: "senior-architect", title: "Cycle in dependency graph" },
          { agent: "senior-architect", title: "Cycle in dependency graph" },
        ],
        severity_counts: { Blocker: 2, Major: 0, Minor: 0, Suggestion: 0 },
      }),
    );
    expect(log.runs[0].results).toHaveLength(2);
    expect(log.runs[0].results[0].partialFingerprints.canonicalHash).toBe(
      log.runs[0].results[1].partialFingerprints.canonicalHash,
    );
  });
});

describe("formatSarif — repoLabel + rubric", () => {
  it("repoLabel populates automationDetails.id", () => {
    const log = formatSarif(makeConsolidation(), { repoLabel: "ggemba/squad-mcp" });
    expect(log.runs[0].automationDetails).toEqual({ id: "ggemba/squad-mcp" });
  });

  it("absent repoLabel omits automationDetails", () => {
    const log = formatSarif(makeConsolidation());
    expect(log.runs[0].automationDetails).toBeUndefined();
  });

  it("carries rubric into properties when present", () => {
    const log = formatSarif(
      makeConsolidation({
        rubric: {
          weighted_score: 82.5,
          threshold: 75,
          passes_threshold: true,
          dimensions: [],
          ignored_agents: [],
          weights_source: "default",
          scorecard_text: "ignored by sarif",
        },
      }),
    );
    expect(log.runs[0].properties.weighted_score).toBe(82.5);
    expect(log.runs[0].properties.passes_threshold).toBe(true);
  });
});
