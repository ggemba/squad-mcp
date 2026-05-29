import { describe, it, expect } from "vitest";
import { applyConsolidationRules } from "../src/tools/consolidate.js";

/**
 * [O4] `arbitration_needed` — the deterministic persona-skip signal.
 *
 * The flag drives the Phase-10 fast-path in skills/squad/SKILL.md: when it is
 * FALSE the tech-lead-consolidator PERSONA dispatch is skipped (nothing to
 * arbitrate); the deterministic verdict + rubric + scorecard_text are produced
 * either way. The rule mirrors the three consolidation triggers in
 * shared/_Severity-and-Ownership.md:
 *
 *   TRUE iff ANY of: a Blocker, an unjustified Major, or a cross-agent
 *   forwarded finding (proxy for "conflicting recommendations").
 *   FALSE only when NONE hold.
 *
 * Conservative by design: when in doubt the rule errs toward TRUE so the
 * persona keeps running.
 */

function report(
  agent: Parameters<typeof applyConsolidationRules>[0]["reports"][number]["agent"],
  findings: {
    severity: "Blocker" | "Major" | "Minor" | "Suggestion";
    title: string;
    justified?: boolean;
    forwarded_to?: Parameters<typeof applyConsolidationRules>[0]["reports"][number]["agent"];
  }[] = [],
  score?: number,
) {
  return {
    agent,
    findings: findings.map((f) => ({
      severity: f.severity,
      title: f.title,
      justified: f.justified ?? false,
      ...(f.forwarded_to ? { forwarded_to: f.forwarded_to } : {}),
    })),
    not_evaluated: false,
    ...(typeof score === "number" ? { score } : {}),
  };
}

describe("applyConsolidationRules — arbitration_needed signal", () => {
  it("blocker present → true (and verdict REJECTED)", () => {
    const out = applyConsolidationRules({
      reports: [report("security", [{ severity: "Blocker", title: "SQLi in login" }])],
      threshold: 75,
    });
    expect(out.arbitration_needed).toBe(true);
    expect(out.verdict).toBe("REJECTED");
  });

  it("conflicting recommendations (cross-agent forwarded finding) → true", () => {
    const out = applyConsolidationRules({
      reports: [
        report("reviewer", [{ severity: "Minor", title: "naming nit", forwarded_to: "architect" }]),
      ],
      threshold: 75,
    });
    expect(out.arbitration_needed).toBe(true);
    // A lone forwarded Minor still keeps the verdict at CHANGES_REQUIRED, but
    // the persona must run to arbitrate the cross-agent item.
    expect(out.verdict).toBe("CHANGES_REQUIRED");
  });

  it("unjustified major → true (and verdict REJECTED)", () => {
    const out = applyConsolidationRules({
      reports: [report("dba", [{ severity: "Major", title: "missing index", justified: false }])],
      threshold: 75,
    });
    expect(out.arbitration_needed).toBe(true);
    expect(out.verdict).toBe("REJECTED");
  });

  it("clean APPROVED (no findings) → false", () => {
    const out = applyConsolidationRules({
      reports: [report("developer", []), report("qa", [])],
      threshold: 75,
    });
    expect(out.arbitration_needed).toBe(false);
    expect(out.verdict).toBe("APPROVED");
  });

  it("single minor (no blocker / no unjustified major / no forward) → false", () => {
    const out = applyConsolidationRules({
      reports: [report("reviewer", [{ severity: "Minor", title: "rename var" }])],
      threshold: 75,
    });
    expect(out.arbitration_needed).toBe(false);
    // Generalisation: verdict is CHANGES_REQUIRED yet the persona is still
    // skipped because there is nothing to arbitrate.
    expect(out.verdict).toBe("CHANGES_REQUIRED");
  });

  it("justified major (no other triggers) → false", () => {
    const out = applyConsolidationRules({
      reports: [report("dba", [{ severity: "Major", title: "slow query", justified: true }])],
      threshold: 75,
    });
    expect(out.arbitration_needed).toBe(false);
    expect(out.majors_unjustified).toHaveLength(0);
  });

  it("rubric + scorecard_text are produced regardless of arbitration_needed", () => {
    // Clean APPROVED with scores → persona skipped, but rubric must still exist.
    const skipped = applyConsolidationRules({
      reports: [report("developer", [], 90), report("qa", [], 88)],
      threshold: 75,
    });
    expect(skipped.arbitration_needed).toBe(false);
    expect(skipped.rubric).not.toBeNull();
    expect(skipped.rubric?.scorecard_text.length ?? 0).toBeGreaterThan(0);

    // Blocker present with scores → persona runs, rubric still produced.
    const ran = applyConsolidationRules({
      reports: [report("security", [{ severity: "Blocker", title: "RCE" }], 10)],
      threshold: 75,
    });
    expect(ran.arbitration_needed).toBe(true);
    expect(ran.rubric).not.toBeNull();
    expect(ran.rubric?.scorecard_text.length ?? 0).toBeGreaterThan(0);
  });
});
