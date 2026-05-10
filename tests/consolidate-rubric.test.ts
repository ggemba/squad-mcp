import { describe, it, expect } from "vitest";
import { applyConsolidationRules } from "../src/tools/consolidate.js";

describe("apply_consolidation_rules — backward compat (no scores)", () => {
  it("returns rubric=null when no report carries a score", () => {
    const out = applyConsolidationRules({
      reports: [
        {
          agent: "senior-architect",
          findings: [],
          not_evaluated: false,
        },
      ],
      threshold: 75,
    });
    expect(out.rubric).toBeNull();
    expect(out.downgraded_by_score).toBe(false);
    expect(out.verdict).toBe("APPROVED");
  });

  it("preserves legacy verdict logic exactly when no scores supplied", () => {
    const out = applyConsolidationRules({
      reports: [
        {
          agent: "senior-dev-security",
          findings: [{ severity: "Blocker", title: "auth bypass", justified: false }],
          not_evaluated: false,
        },
      ],
      threshold: 75,
    });
    expect(out.verdict).toBe("REJECTED");
    expect(out.rubric).toBeNull();
  });
});

describe("apply_consolidation_rules — with rubric scores", () => {
  it("emits a rubric when scores are supplied", () => {
    const out = applyConsolidationRules({
      reports: [
        {
          agent: "senior-architect",
          findings: [],
          not_evaluated: false,
          score: 85,
        },
        {
          agent: "senior-dev-security",
          findings: [],
          not_evaluated: false,
          score: 70,
        },
      ],
      threshold: 75,
    });
    expect(out.rubric).not.toBeNull();
    expect(out.rubric!.dimensions).toHaveLength(2);
    expect(out.rubric!.weighted_score).toBe(77.5); // (85+70)/2 — equal default weights
  });

  it("does NOT downgrade APPROVED when min_score is omitted", () => {
    const out = applyConsolidationRules({
      reports: [
        {
          agent: "senior-architect",
          findings: [],
          not_evaluated: false,
          score: 40, // very low
        },
      ],
      threshold: 75,
    });
    expect(out.verdict).toBe("APPROVED");
    expect(out.downgraded_by_score).toBe(false);
  });

  it("downgrades APPROVED to CHANGES_REQUIRED when score < min_score", () => {
    const out = applyConsolidationRules({
      reports: [
        {
          agent: "senior-architect",
          findings: [],
          not_evaluated: false,
          score: 40,
        },
      ],
      threshold: 75,
      min_score: 60,
    });
    expect(out.verdict).toBe("CHANGES_REQUIRED");
    expect(out.downgraded_by_score).toBe(true);
    expect(out.summary).toMatch(/Downgraded/);
  });

  it("does not downgrade if verdict is already non-APPROVED", () => {
    // Even though score is low, verdict is REJECTED for an unjustified Major.
    // downgraded_by_score must remain false (we never downgrade further).
    const out = applyConsolidationRules({
      reports: [
        {
          agent: "senior-architect",
          findings: [{ severity: "Major", title: "tight coupling", justified: false }],
          not_evaluated: false,
          score: 40,
        },
      ],
      threshold: 75,
      min_score: 80,
    });
    expect(out.verdict).toBe("REJECTED");
    expect(out.downgraded_by_score).toBe(false);
  });

  it("preserves verdict when score is at or above min_score", () => {
    const out = applyConsolidationRules({
      reports: [
        {
          agent: "senior-architect",
          findings: [],
          not_evaluated: false,
          score: 80,
        },
      ],
      threshold: 75,
      min_score: 75,
    });
    expect(out.verdict).toBe("APPROVED");
    expect(out.downgraded_by_score).toBe(false);
  });

  it("summary includes weighted score line when rubric present", () => {
    const out = applyConsolidationRules({
      reports: [
        {
          agent: "senior-architect",
          findings: [],
          not_evaluated: false,
          score: 88,
        },
      ],
      threshold: 75,
    });
    expect(out.summary).toMatch(/Weighted score: 88\.0\/100/);
  });

  it("skips reports flagged not_evaluated even if they carry a score", () => {
    const out = applyConsolidationRules({
      reports: [
        {
          agent: "senior-architect",
          findings: [],
          not_evaluated: true, // skip
          score: 30, // would tank the score if not skipped
        },
        {
          agent: "senior-dev-security",
          findings: [],
          not_evaluated: false,
          score: 90,
        },
      ],
      threshold: 75,
    });
    expect(out.rubric!.dimensions).toHaveLength(1);
    expect(out.rubric!.weighted_score).toBe(90);
  });
});
