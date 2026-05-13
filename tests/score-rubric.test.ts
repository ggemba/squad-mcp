import { describe, it, expect } from "vitest";
import { scoreRubric } from "../src/tools/score-rubric.js";
import { DEFAULT_RUBRIC_WEIGHTS } from "../src/config/ownership-matrix.js";

describe("score_rubric — defaults", () => {
  it("returns a rubric when at least one score is supplied", () => {
    const out = scoreRubric({
      scores: [{ agent: "architect", score: 80 }],
      threshold: 75,
    });
    expect(out.dimensions).toHaveLength(1);
    expect(out.dimensions[0].agent).toBe("architect");
    expect(out.weighted_score).toBe(80);
    expect(out.passes_threshold).toBe(true);
    expect(out.weights_source).toBe("default");
    expect(out.scorecard_text).toContain("Architecture");
  });

  it("renormalises weights across only the agents that scored", () => {
    // Architect (18) and Security (18) — equal default weights, so renormalised
    // to 50% each. Weighted score = (80 + 60) / 2 = 70.
    const out = scoreRubric({
      scores: [
        { agent: "architect", score: 80 },
        { agent: "security", score: 60 },
      ],
      threshold: 75,
    });
    expect(out.weighted_score).toBe(70);
    expect(out.dimensions).toHaveLength(2);
    // Each gets renormalised to 50%
    for (const d of out.dimensions) {
      expect(d.weight).toBeCloseTo(50, 0);
    }
  });

  it("flags dimensions below the threshold", () => {
    const out = scoreRubric({
      scores: [
        { agent: "architect", score: 90 },
        { agent: "security", score: 50 },
      ],
      threshold: 75,
    });
    const sec = out.dimensions.find((d) => d.agent === "security");
    const arch = out.dimensions.find((d) => d.agent === "architect");
    expect(sec?.below_threshold).toBe(true);
    expect(arch?.below_threshold).toBe(false);
  });

  it("lists agents without scores in ignored_agents", () => {
    const out = scoreRubric({
      scores: [{ agent: "architect", score: 80 }],
      threshold: 75,
    });
    expect(out.ignored_agents).toContain("dba");
    expect(out.ignored_agents).toContain("developer");
    expect(out.ignored_agents).toContain("product-owner");
    expect(out.ignored_agents).toContain("tech-lead-planner"); // meta-agent
    expect(out.ignored_agents).not.toContain("architect");
  });

  it("ignores meta-agents that somehow emit a score", () => {
    // tech-lead-consolidator has weight 0 — must not contribute to weighted score.
    const out = scoreRubric({
      scores: [
        { agent: "architect", score: 80 },
        { agent: "tech-lead-consolidator", score: 95 }, // would skew if included
      ],
      threshold: 75,
    });
    expect(out.weighted_score).toBe(80);
    expect(out.ignored_agents).toContain("tech-lead-consolidator");
    expect(out.dimensions.find((d) => d.agent === "tech-lead-consolidator")).toBeUndefined();
  });

  it("produces zero-score output when all supplied scores are meta-agents", () => {
    const out = scoreRubric({
      scores: [{ agent: "tech-lead-planner", score: 90 }],
      threshold: 75,
    });
    expect(out.weighted_score).toBe(0);
    expect(out.dimensions).toHaveLength(0);
    expect(out.passes_threshold).toBe(false);
  });

  it("passes the threshold flag honestly", () => {
    const lowScore = scoreRubric({
      scores: [{ agent: "architect", score: 70 }],
      threshold: 75,
    });
    expect(lowScore.passes_threshold).toBe(false);

    const exact = scoreRubric({
      scores: [{ agent: "architect", score: 75 }],
      threshold: 75,
    });
    expect(exact.passes_threshold).toBe(true);
  });
});

describe("score_rubric — weights override", () => {
  it("honours explicit weights that sum to 100", () => {
    // Force Security to 50%, Architecture to 50% — equal weight, scores 60 and 80.
    // Both ARE in the override and DO have scores, so renormalisation is a no-op.
    const out = scoreRubric({
      scores: [
        { agent: "architect", score: 80 },
        { agent: "security", score: 60 },
      ],
      weights: {
        architect: 50,
        security: 50,
        "product-owner": 0,
        "tech-lead-planner": 0,
        "tech-lead-consolidator": 0,
        dba: 0,
        developer: 0,
        reviewer: 0,
        qa: 0,
      },
      threshold: 75,
    });
    expect(out.weights_source).toBe("override");
    expect(out.weighted_score).toBe(70);
  });

  it("rejects override that does not sum to 100", () => {
    expect(() =>
      scoreRubric({
        scores: [{ agent: "architect", score: 80 }],
        weights: {
          architect: 50,
          security: 30,
          "product-owner": 0,
          "tech-lead-planner": 0,
          "tech-lead-consolidator": 0,
          dba: 0,
          developer: 0,
          reviewer: 0,
          qa: 0,
        },
        threshold: 75,
      }),
    ).toThrow(/sum to 100/);
  });
});

describe("score_rubric — defaults sanity", () => {
  it("default weights sum to 100 across advisory agents", () => {
    const sum = Object.values(DEFAULT_RUBRIC_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });

  it("meta-agents have weight 0", () => {
    expect(DEFAULT_RUBRIC_WEIGHTS["tech-lead-planner"]).toBe(0);
    expect(DEFAULT_RUBRIC_WEIGHTS["tech-lead-consolidator"]).toBe(0);
  });
});

describe("score_rubric — scorecard rendering", () => {
  it("includes header, threshold, and PASS/BELOW THRESHOLD verdict line", () => {
    const out = scoreRubric({
      scores: [{ agent: "architect", score: 80 }],
      threshold: 75,
    });
    expect(out.scorecard_text).toMatch(/SQUAD RUBRIC/);
    expect(out.scorecard_text).toMatch(/threshold 75/);
    expect(out.scorecard_text).toMatch(/PASS/);
  });

  it("flags below-threshold dimensions in the scorecard", () => {
    const out = scoreRubric({
      scores: [{ agent: "security", score: 50 }],
      threshold: 75,
    });
    expect(out.scorecard_text).toMatch(/⚠/);
    expect(out.scorecard_text).toMatch(/BELOW THRESHOLD/);
  });
});
