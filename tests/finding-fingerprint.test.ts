import { describe, it, expect } from "vitest";
import { fingerprintFinding, FINGERPRINT_HEX_LENGTH } from "../src/util/finding-fingerprint.js";

describe("fingerprintFinding", () => {
  it("returns a 16-char hex string", () => {
    const fp = fingerprintFinding({
      agent: "developer",
      severity: "Major",
      title: "Async error handling missing",
    });
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).toHaveLength(FINGERPRINT_HEX_LENGTH);
  });

  it("is idempotent", () => {
    const a = fingerprintFinding({
      agent: "architect",
      severity: "Blocker",
      title: "Module boundary violated",
    });
    const b = fingerprintFinding({
      agent: "architect",
      severity: "Blocker",
      title: "Module boundary violated",
    });
    expect(a).toBe(b);
  });

  it("normalises title — case + trailing punctuation + parenthetical equivalent", () => {
    const a = fingerprintFinding({
      agent: "developer",
      severity: "Major",
      title: "CSRF token missing.",
    });
    const b = fingerprintFinding({
      agent: "developer",
      severity: "Major",
      title: "csrf token MISSING (line 42)",
    });
    expect(a).toBe(b);
  });

  it("agent name is case-insensitive", () => {
    const a = fingerprintFinding({
      agent: "Developer",
      severity: "Major",
      title: "x",
    });
    const b = fingerprintFinding({
      agent: "developer",
      severity: "Major",
      title: "x",
    });
    expect(a).toBe(b);
  });

  it("different severity → different hash", () => {
    const a = fingerprintFinding({ agent: "x", severity: "Blocker", title: "t" });
    const b = fingerprintFinding({ agent: "x", severity: "Major", title: "t" });
    expect(a).not.toBe(b);
  });

  it("different agent → different hash", () => {
    const a = fingerprintFinding({ agent: "a", severity: "Major", title: "t" });
    const b = fingerprintFinding({ agent: "b", severity: "Major", title: "t" });
    expect(a).not.toBe(b);
  });

  it("different title → different hash", () => {
    const a = fingerprintFinding({ agent: "a", severity: "Major", title: "x" });
    const b = fingerprintFinding({ agent: "a", severity: "Major", title: "y" });
    expect(a).not.toBe(b);
  });

  it("file argument shifts the hash when supplied", () => {
    const without = fingerprintFinding({
      agent: "a",
      severity: "Major",
      title: "t",
    });
    const withFile = fingerprintFinding({
      agent: "a",
      severity: "Major",
      title: "t",
      file: "src/auth.ts",
    });
    expect(without).not.toBe(withFile);
  });

  it("does not collapse adjacency: agent='a|', severity='b' vs agent='a', severity='|b'", () => {
    // Defends the choice of using \x1F (US) as field separator instead of '|'.
    const a = fingerprintFinding({
      agent: "a|",
      severity: "Major" as never,
      title: "t",
    });
    const b = fingerprintFinding({
      agent: "a",
      severity: "|Major" as never,
      title: "t",
    });
    expect(a).not.toBe(b);
  });

  it("handles empty / weird inputs without throwing", () => {
    expect(() =>
      fingerprintFinding({
        agent: "",
        severity: "Suggestion",
        title: "",
      }),
    ).not.toThrow();
  });
});
