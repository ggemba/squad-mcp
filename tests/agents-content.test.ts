import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

const AGENTS_DIR = path.resolve(__dirname, "..", "agents");

/**
 * Cheap grep-based boundary check on agent markdown files. The check cannot
 * verify behaviour (you would need an LLM in the loop for that), but it can
 * verify that the inviolable boundary strings stay in the file. A future
 * editor accidentally relaxing the persona's boundary would trip this test.
 */
describe("agents content guard rails", () => {
  it("senior-debugger persona carries the read-only + no-writes boundary strings", async () => {
    const file = path.join(AGENTS_DIR, "senior-debugger.md");
    const body = await fs.readFile(file, "utf8");
    expect(body.toLowerCase()).toContain("read-only");
    expect(body.toLowerCase()).toContain("no writes");
  });

  it("senior-debugger persona carries the untrusted-input clause", async () => {
    const file = path.join(AGENTS_DIR, "senior-debugger.md");
    const body = await fs.readFile(file, "utf8");
    expect(body).toMatch(/untrusted input/i);
  });

  it("code-explorer persona carries the read-only + no-writes boundary strings", async () => {
    // Mirror test on the sibling utility agent so a future regression on
    // EITHER file gets caught — the boundary contract is shared.
    const file = path.join(AGENTS_DIR, "code-explorer.md");
    const body = await fs.readFile(file, "utf8");
    expect(body.toLowerCase()).toContain("read-only");
    expect(body.toLowerCase()).toContain("no writes");
  });
});
