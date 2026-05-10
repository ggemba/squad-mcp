import { describe, it, expect } from "vitest";
import { formatLearningsForPrompt } from "../src/learning/format.js";
import type { LearningEntry } from "../src/learning/store.js";

const e = (overrides: Partial<LearningEntry>): LearningEntry => ({
  ts: "2026-01-01T00:00:00Z",
  agent: "senior-dev-security",
  finding: "f",
  decision: "reject",
  ...overrides,
});

describe("formatLearningsForPrompt — empty cases", () => {
  it("returns empty string for empty entries", () => {
    expect(formatLearningsForPrompt([])).toBe("");
  });

  it("returns empty string when all entries filtered out by changedFiles scope", () => {
    const entries = [e({ scope: "src/auth/**" })];
    const out = formatLearningsForPrompt(entries, {
      changedFiles: ["src/billing/foo.ts"],
    });
    expect(out).toBe("");
  });
});

describe("formatLearningsForPrompt — content", () => {
  it("renders the default heading and a one-of-N preamble", () => {
    const out = formatLearningsForPrompt([e({})]);
    expect(out).toContain("## Past team decisions");
    expect(out).toContain("1 of 1 total");
  });

  it("honors a custom heading", () => {
    const out = formatLearningsForPrompt([e({})], {
      heading: "### Prior judgments",
    });
    expect(out).toContain("### Prior judgments");
    expect(out).not.toContain("## Past team decisions");
  });

  it("renders REJECTED / ACCEPTED tags", () => {
    const entries = [
      e({ decision: "reject", finding: "csrf" }),
      e({ decision: "accept", finding: "coupling" }),
    ];
    const out = formatLearningsForPrompt(entries);
    expect(out).toContain("**REJECTED**");
    expect(out).toContain("**ACCEPTED**");
  });

  it("renders PR ref when available, falls back to branch, then ts date", () => {
    const out = formatLearningsForPrompt([
      e({ pr: 42, finding: "p" }),
      e({ branch: "feat/x", finding: "b" }),
      e({ ts: "2026-03-04T12:00:00Z", finding: "d" }),
    ]);
    expect(out).toContain("PR #42");
    expect(out).toContain("branch feat/x");
    expect(out).toContain("2026-03-04");
  });

  it("renders severity tag when present", () => {
    const out = formatLearningsForPrompt([
      e({ severity: "Major", finding: "x" }),
    ]);
    expect(out).toContain("[Major]");
  });

  it("renders scope inline when present", () => {
    const out = formatLearningsForPrompt([
      e({ scope: "src/auth/**", finding: "x" }),
    ]);
    expect(out).toContain("(scope: `src/auth/**`)");
  });

  it("renders the reason on its own indented line when present", () => {
    const out = formatLearningsForPrompt([
      e({ reason: "CSRF terminated at gateway" }),
    ]);
    expect(out).toContain("Reason: CSRF terminated at gateway");
  });

  it("renders most-recent-first", () => {
    const entries = [
      e({ ts: "2026-01-01T00:00:00Z", finding: "alpha-finding" }),
      e({ ts: "2026-01-02T00:00:00Z", finding: "bravo-finding" }),
      e({ ts: "2026-01-03T00:00:00Z", finding: "charlie-finding" }),
    ];
    const out = formatLearningsForPrompt(entries);
    const idxAlpha = out.indexOf("alpha-finding");
    const idxBravo = out.indexOf("bravo-finding");
    const idxCharlie = out.indexOf("charlie-finding");
    expect(idxCharlie).toBeLessThan(idxBravo);
    expect(idxBravo).toBeLessThan(idxAlpha);
  });
});

describe("formatLearningsForPrompt — limit", () => {
  it("caps to default limit (50) when many entries", () => {
    const many: LearningEntry[] = Array.from({ length: 80 }, (_, i) =>
      e({
        ts: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
        finding: `f${i}`,
      }),
    );
    const out = formatLearningsForPrompt(many);
    // count numbered list lines
    const matches = out.match(/^\d+\.\s/gm) ?? [];
    expect(matches.length).toBe(50);
  });

  it("honors custom limit", () => {
    const many: LearningEntry[] = Array.from({ length: 10 }, (_, i) =>
      e({
        ts: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
        finding: `f${i}`,
      }),
    );
    const out = formatLearningsForPrompt(many, { limit: 3 });
    const matches = out.match(/^\d+\.\s/gm) ?? [];
    expect(matches.length).toBe(3);
  });

  it("clamps limit to hard cap of 200", () => {
    const many: LearningEntry[] = Array.from({ length: 250 }, (_, i) =>
      e({
        ts: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
        finding: `f${i}`,
      }),
    );
    const out = formatLearningsForPrompt(many, { limit: 500 });
    const matches = out.match(/^\d+\.\s/gm) ?? [];
    expect(matches.length).toBe(200);
  });
});

describe("formatLearningsForPrompt — scope filter via changedFiles", () => {
  it("includes entries with no scope (repo-wide)", () => {
    const out = formatLearningsForPrompt([e({ finding: "global" })], {
      changedFiles: ["src/billing/foo.ts"],
    });
    expect(out).toContain("global");
  });

  it("includes scoped entries when at least one changed file matches", () => {
    const out = formatLearningsForPrompt(
      [e({ scope: "src/auth/**", finding: "auth-scoped" })],
      { changedFiles: ["src/auth/login.ts", "src/billing/index.ts"] },
    );
    expect(out).toContain("auth-scoped");
  });

  it("excludes scoped entries when no changed file matches", () => {
    const out = formatLearningsForPrompt(
      [e({ scope: "src/auth/**", finding: "auth-scoped" })],
      { changedFiles: ["src/billing/index.ts"] },
    );
    expect(out).toBe("");
  });

  it("mixes scoped and repo-wide entries correctly", () => {
    const out = formatLearningsForPrompt(
      [
        e({ finding: "global" }),
        e({ scope: "src/auth/**", finding: "auth-only" }),
        e({ scope: "src/billing/**", finding: "billing-only" }),
      ],
      { changedFiles: ["src/auth/login.ts"] },
    );
    expect(out).toContain("global");
    expect(out).toContain("auth-only");
    expect(out).not.toContain("billing-only");
  });

  it("treats empty changedFiles as no filter", () => {
    const out = formatLearningsForPrompt(
      [e({ scope: "src/auth/**", finding: "auth-scoped" })],
      { changedFiles: [] },
    );
    expect(out).toContain("auth-scoped");
  });
});
