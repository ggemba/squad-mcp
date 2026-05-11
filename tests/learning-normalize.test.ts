import { describe, it, expect } from "vitest";
import { normalizeFindingTitle } from "../src/learning/normalize.js";

describe("normalizeFindingTitle", () => {
  it("lowercases for case-insensitive matching", () => {
    expect(normalizeFindingTitle("CSRF Token Missing")).toBe("csrf token missing");
    expect(normalizeFindingTitle("csrf token missing")).toBe("csrf token missing");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeFindingTitle("  csrf token  ")).toBe("csrf token");
  });

  it("collapses runs of internal whitespace to a single space", () => {
    expect(normalizeFindingTitle("csrf   token\t\tmissing")).toBe("csrf token missing");
  });

  it("strips a single trailing period", () => {
    expect(normalizeFindingTitle("csrf token missing.")).toBe("csrf token missing");
  });

  it("strips trailing commas and semicolons", () => {
    expect(normalizeFindingTitle("csrf token missing,")).toBe("csrf token missing");
    expect(normalizeFindingTitle("csrf token missing;")).toBe("csrf token missing");
  });

  it("strips multiple trailing punctuation marks", () => {
    expect(normalizeFindingTitle("csrf token missing...")).toBe("csrf token missing");
  });

  it("strips matching surrounding double quotes", () => {
    expect(normalizeFindingTitle('"csrf token missing"')).toBe("csrf token missing");
  });

  it("strips matching surrounding single quotes", () => {
    expect(normalizeFindingTitle("'csrf token missing'")).toBe("csrf token missing");
  });

  it("strips matching surrounding backticks", () => {
    expect(normalizeFindingTitle("`csrf token missing`")).toBe("csrf token missing");
  });

  it("strips only TRUE quote pairs (cycle-2 developer Major M6 fix)", () => {
    // v0.11.0 cycle-2 tightened the quote-strip to apply each quote class
    // independently — mismatched pairs like `"foo'` no longer collapse to
    // `foo`. The strip now only fires when BOTH sides are the SAME quote.
    expect(normalizeFindingTitle("\"csrf token'")).toBe("\"csrf token'");
    expect(normalizeFindingTitle('`csrf token"')).toBe('`csrf token"');
    // True pairs still strip:
    expect(normalizeFindingTitle('"csrf token"')).toBe("csrf token");
    expect(normalizeFindingTitle("'csrf token'")).toBe("csrf token");
    expect(normalizeFindingTitle("`csrf token`")).toBe("csrf token");
  });

  it("preserves inner punctuation like file paths and dotted names", () => {
    expect(normalizeFindingTitle("auth.middleware.ts is over-coupled")).toBe(
      "auth.middleware.ts is over-coupled",
    );
  });

  it("strips a trailing parenthetical line-number suffix", () => {
    expect(normalizeFindingTitle("csrf token missing (line 42)")).toBe("csrf token missing");
  });

  it("strips a trailing parenthetical PR-ref suffix", () => {
    expect(normalizeFindingTitle("csrf token missing (#1234)")).toBe("csrf token missing");
  });

  it("strips only the LAST trailing parenthetical, not inner ones", () => {
    // The regex `\s*\([^)]*\)\s*$` is anchored to end-of-string so an inner
    // parenthetical stays put.
    expect(normalizeFindingTitle("uses unsafe (eval) call (line 42)")).toBe(
      "uses unsafe (eval) call",
    );
  });

  it("collapses trailing whitespace exposed by parenthetical strip", () => {
    expect(normalizeFindingTitle("csrf token   (line 42)")).toBe("csrf token");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeFindingTitle("")).toBe("");
    expect(normalizeFindingTitle("   ")).toBe("");
  });

  it("returns empty string for non-string input (defensive)", () => {
    // @ts-expect-error — testing the runtime guard
    expect(normalizeFindingTitle(undefined)).toBe("");
    // @ts-expect-error — testing the runtime guard
    expect(normalizeFindingTitle(null)).toBe("");
    // @ts-expect-error — testing the runtime guard
    expect(normalizeFindingTitle(42)).toBe("");
  });

  it("is idempotent — normalising a normalised string yields the same string", () => {
    const cases = [
      "csrf token missing",
      "auth.middleware.ts is over-coupled",
      "uses unsafe (eval) call",
    ];
    for (const c of cases) {
      expect(normalizeFindingTitle(normalizeFindingTitle(c))).toBe(normalizeFindingTitle(c));
    }
  });

  it("treats common decoration variants of the same finding as equivalent", () => {
    // The key property of the helper: prune_learnings groups by output, so
    // these MUST normalise to the same key. Note the order of passes —
    // trailing-punctuation is stripped BEFORE surrounding-quotes, so a form
    // like `"csrf token missing."` keeps its inner period after quote-strip.
    // Don't combine quotes WITH inner punctuation in the same input; agents
    // record one or the other in practice.
    const a = normalizeFindingTitle("CSRF token missing");
    const b = normalizeFindingTitle('"csrf token missing"');
    const c = normalizeFindingTitle("csrf token missing (line 42)");
    const d = normalizeFindingTitle("  csrf   token   missing  ");
    const e = normalizeFindingTitle("csrf token missing.");
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).toBe(d);
    expect(a).toBe(e);
  });
});
