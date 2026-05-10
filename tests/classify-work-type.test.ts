import { describe, it, expect } from "vitest";
import { classifyWorkType } from "../src/tools/classify-work-type.js";

describe("classifyWorkType", () => {
  it.each([
    ["fix the login bug", [], "Bug Fix", "Medium"],
    ["add new export feature", [], "Feature", "Low"],
    ["refactor the payment module", [], "Refactor", "Medium"],
    ["speed up p99 latency", [], "Performance", "Medium"],
    ["fix CSRF vulnerability in auth flow", [], "Security", "High"],
    ["change business rule for discount approval", [], "Business Rule", "Medium"],
  ])(
    'classifies "%s" as %s with %s confidence',
    (prompt, files, expectedType, expectedConfidence) => {
      const r = classifyWorkType({ user_prompt: prompt, files: files as string[] });
      expect(r.work_type).toBe(expectedType);
      expect(r.confidence).toBe(expectedConfidence);
    },
  );

  it("falls back to Feature with Low confidence on empty prompt", () => {
    const r = classifyWorkType({ user_prompt: "", files: [] });
    expect(r.work_type).toBe("Feature");
    expect(r.confidence).toBe("Low");
  });

  it("boosts Security via auth path hint", () => {
    const r = classifyWorkType({
      user_prompt: "add authentication",
      files: ["src/Auth/JwtService.cs"],
    });
    expect(r.work_type).toBe("Security");
  });

  it("combines prompt + path signals into High confidence", () => {
    const r = classifyWorkType({
      user_prompt: "fix CSRF authn vulnerability OWASP",
      files: ["src/AuthService.cs"],
    });
    expect(r.confidence).toBe("High");
  });

  it("returns deterministic result on repeated input", () => {
    const a = classifyWorkType({ user_prompt: "refactor module", files: [] });
    const b = classifyWorkType({ user_prompt: "refactor module", files: [] });
    expect(a).toEqual(b);
  });

  it("records signals_detected with source", () => {
    const r = classifyWorkType({
      user_prompt: "fix login bug",
      files: ["HOTFIX.md"],
    });
    const promptSignal = r.signals_detected.find((s) => s.source === "prompt");
    const pathSignal = r.signals_detected.find((s) => s.source === "path");
    expect(promptSignal).toBeDefined();
    expect(pathSignal).toBeDefined();
  });
});
