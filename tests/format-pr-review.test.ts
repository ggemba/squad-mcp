import { describe, it, expect } from "vitest";
import { formatPrReview, chooseGhAction } from "../src/format/pr-review.js";
import type { ConsolidationOutput } from "../src/tools/consolidate.js";
import type { RubricOutput } from "../src/tools/score-rubric.js";

function makeRubric(weighted: number, threshold = 75): RubricOutput {
  return {
    weighted_score: weighted,
    threshold,
    passes_threshold: weighted >= threshold,
    dimensions: [],
    ignored_agents: [],
    weights_source: "default",
    scorecard_text: `SQUAD RUBRIC — weighted ${weighted.toFixed(1)} / 100 (threshold ${threshold})\n${weighted >= threshold ? "PASS" : "BELOW THRESHOLD"}`,
  };
}

function makeConsolidation(
  overrides: Partial<ConsolidationOutput> = {},
): ConsolidationOutput {
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

describe("chooseGhAction", () => {
  it("REJECTED → request-changes", () => {
    expect(chooseGhAction(makeConsolidation({ verdict: "REJECTED" }), {})).toBe(
      "request-changes",
    );
  });

  it("CHANGES_REQUIRED → comment", () => {
    expect(
      chooseGhAction(makeConsolidation({ verdict: "CHANGES_REQUIRED" }), {}),
    ).toBe("comment");
  });

  it("APPROVED clean → approve", () => {
    expect(chooseGhAction(makeConsolidation({ verdict: "APPROVED" }), {})).toBe(
      "approve",
    );
  });

  it("APPROVED downgraded by score → comment", () => {
    expect(
      chooseGhAction(
        makeConsolidation({ verdict: "APPROVED", downgraded_by_score: true }),
        {},
      ),
    ).toBe("comment");
  });

  it("APPROVED but score < requestChangesBelowScore → request-changes", () => {
    const c = makeConsolidation({
      verdict: "APPROVED",
      rubric: makeRubric(40),
    });
    expect(chooseGhAction(c, { requestChangesBelowScore: 60 })).toBe(
      "request-changes",
    );
  });

  it("APPROVED with score above requestChangesBelowScore → approve", () => {
    const c = makeConsolidation({
      verdict: "APPROVED",
      rubric: makeRubric(70),
    });
    expect(chooseGhAction(c, { requestChangesBelowScore: 60 })).toBe("approve");
  });

  it("APPROVED with no rubric and floor set → approve (no score to compare)", () => {
    const c = makeConsolidation({ verdict: "APPROVED", rubric: null });
    expect(chooseGhAction(c, { requestChangesBelowScore: 60 })).toBe("approve");
  });
});

describe("formatPrReview — header", () => {
  it("clean APPROVED above threshold", () => {
    const c = makeConsolidation({
      verdict: "APPROVED",
      rubric: makeRubric(85),
    });
    const out = formatPrReview(c);
    expect(out.body).toContain("## Squad Advisory: APPROVED (85.0 / 100)");
    expect(out.action).toBe("approve");
  });

  it("APPROVED downgraded → APPROVED with attention", () => {
    const c = makeConsolidation({
      verdict: "APPROVED",
      rubric: makeRubric(60),
      downgraded_by_score: true,
    });
    const out = formatPrReview(c);
    expect(out.body).toContain("APPROVED with attention (60.0 / 100)");
    expect(out.action).toBe("comment");
  });

  it("CHANGES_REQUIRED with rubric", () => {
    const c = makeConsolidation({
      verdict: "CHANGES_REQUIRED",
      rubric: makeRubric(70),
      severity_counts: { Blocker: 0, Major: 1, Minor: 0, Suggestion: 0 },
      majors_unjustified: [
        { agent: "senior-dev-security", title: "missing CSRF" },
      ],
    });
    const out = formatPrReview(c);
    expect(out.body).toContain("Squad Advisory: CHANGES_REQUIRED (70.0 / 100)");
    expect(out.action).toBe("comment");
  });

  it("REJECTED → request-changes header", () => {
    const c = makeConsolidation({
      verdict: "REJECTED",
      blockers: [{ agent: "senior-dev-security", title: "auth bypass" }],
      severity_counts: { Blocker: 1, Major: 0, Minor: 0, Suggestion: 0 },
    });
    const out = formatPrReview(c);
    expect(out.body).toContain("Squad Advisory: REJECTED");
    expect(out.action).toBe("request-changes");
  });

  it("no rubric → header omits score", () => {
    const c = makeConsolidation({ verdict: "APPROVED", rubric: null });
    const out = formatPrReview(c);
    expect(out.body).toContain("## Squad Advisory: APPROVED");
    expect(out.body).not.toMatch(/\d\.\d \/ 100/);
  });
});

describe("formatPrReview — rubric block", () => {
  it("wraps scorecard_text in a fenced code block", () => {
    const c = makeConsolidation({
      verdict: "APPROVED",
      rubric: makeRubric(85),
    });
    const out = formatPrReview(c);
    // Should contain the scorecard verbatim inside ```...``` fences
    expect(out.body).toMatch(/```[\s\S]*SQUAD RUBRIC[\s\S]*```/);
  });

  it("omits rubric block entirely when rubric is null", () => {
    const c = makeConsolidation({ verdict: "APPROVED", rubric: null });
    const out = formatPrReview(c);
    expect(out.body).not.toContain("SQUAD RUBRIC");
  });
});

describe("formatPrReview — findings section", () => {
  it("omits findings section entirely on a clean review", () => {
    const c = makeConsolidation({
      verdict: "APPROVED",
      rubric: makeRubric(95),
    });
    const out = formatPrReview(c);
    expect(out.body).not.toContain("### Findings");
  });

  it("shows totals only when no Blocker/Major present but Minor/Suggestion exist", () => {
    const c = makeConsolidation({
      verdict: "APPROVED",
      rubric: makeRubric(85),
      severity_counts: { Blocker: 0, Major: 0, Minor: 2, Suggestion: 3 },
    });
    const out = formatPrReview(c);
    expect(out.body).toContain("### Findings");
    expect(out.body).toContain("0 blocker / 0 major / 2 minor / 3 suggestion");
    // No #### per-agent sub-headers
    expect(out.body).not.toMatch(/^####\s/m);
  });

  it("expands Blocker and Major findings per agent, sorted alphabetically", () => {
    const c = makeConsolidation({
      verdict: "REJECTED",
      blockers: [
        { agent: "senior-dev-security", title: "auth bypass" },
        { agent: "senior-dba", title: "lost update on race" },
      ],
      majors_unjustified: [
        { agent: "senior-architect", title: "cross-module coupling" },
      ],
      severity_counts: { Blocker: 2, Major: 1, Minor: 0, Suggestion: 0 },
    });
    const out = formatPrReview(c);
    // Three #### headers, sorted alphabetically
    const headerOrder = out.body.match(/^####\s\S+/gm) ?? [];
    expect(headerOrder).toEqual([
      "#### senior-architect",
      "#### senior-dba",
      "#### senior-dev-security",
    ]);
    // Each finding rendered with severity prefix
    expect(out.body).toContain("**Blocker** — auth bypass");
    expect(out.body).toContain("**Blocker** — lost update on race");
    expect(out.body).toContain("**Major** — cross-module coupling");
  });
});

describe("formatPrReview — footer + summary", () => {
  it("includes attribution footer by default", () => {
    const c = makeConsolidation({
      verdict: "APPROVED",
      rubric: makeRubric(85),
    });
    const out = formatPrReview(c);
    expect(out.body).toContain("Generated by [@gempack/squad-mcp]");
  });

  it("repoLabel appears in the footer when supplied", () => {
    const c = makeConsolidation({
      verdict: "APPROVED",
      rubric: makeRubric(85),
    });
    const out = formatPrReview(c, { repoLabel: "ggemba/squad-mcp" });
    expect(out.body).toContain("`ggemba/squad-mcp`");
  });

  it("summary line includes severity counts and score", () => {
    const c = makeConsolidation({
      verdict: "CHANGES_REQUIRED",
      rubric: makeRubric(72),
      severity_counts: { Blocker: 0, Major: 1, Minor: 2, Suggestion: 3 },
    });
    const out = formatPrReview(c);
    expect(out.summary).toBe(
      "Squad: CHANGES_REQUIRED | score 72.0/100 | 0B/1M/2m/3s",
    );
  });

  it("summary works without rubric", () => {
    const c = makeConsolidation({
      verdict: "APPROVED",
      rubric: null,
      severity_counts: { Blocker: 0, Major: 0, Minor: 0, Suggestion: 0 },
    });
    const out = formatPrReview(c);
    expect(out.summary).toBe("Squad: APPROVED | 0B/0M/0m/0s");
  });

  it("downgrade footer note appears when downgraded_by_score", () => {
    const c = makeConsolidation({
      verdict: "APPROVED",
      rubric: makeRubric(60),
      downgraded_by_score: true,
    });
    const out = formatPrReview(c);
    expect(out.body).toContain("Verdict downgraded from APPROVED");
  });

  it("request-changes-floor footer note appears when applied", () => {
    const c = makeConsolidation({
      verdict: "APPROVED",
      rubric: makeRubric(40),
    });
    const out = formatPrReview(c, { requestChangesBelowScore: 60 });
    expect(out.action).toBe("request-changes");
    expect(out.body).toContain("Posting as request-changes");
    expect(out.body).toContain("60");
  });
});
