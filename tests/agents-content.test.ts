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

  // v0.10.1 reinforcement: also pin the cost contract (haiku model) and the
  // explicit forbidden-tool list. A future relaxation that bumps the model
  // to sonnet/opus or drops "no Edit/Write" from the Boundaries section will
  // trip these.

  it("senior-debugger frontmatter pins model: haiku (cost + read-only intent)", async () => {
    const file = path.join(AGENTS_DIR, "senior-debugger.md");
    const body = await fs.readFile(file, "utf8");
    expect(body).toMatch(/^model:\s*haiku\s*$/m);
  });

  it("code-explorer frontmatter pins model: haiku (cost + read-only intent)", async () => {
    const file = path.join(AGENTS_DIR, "code-explorer.md");
    const body = await fs.readFile(file, "utf8");
    expect(body).toMatch(/^model:\s*haiku\s*$/m);
  });

  it("senior-debugger Boundaries explicitly forbid Edit / Write / NotebookEdit", async () => {
    const file = path.join(AGENTS_DIR, "senior-debugger.md");
    const body = await fs.readFile(file, "utf8");
    expect(body).toContain("Edit");
    expect(body).toContain("Write");
    expect(body).toContain("NotebookEdit");
  });

  it("code-explorer Boundaries explicitly forbid Edit / Write / NotebookEdit", async () => {
    const file = path.join(AGENTS_DIR, "code-explorer.md");
    const body = await fs.readFile(file, "utf8");
    expect(body).toContain("Edit");
    expect(body).toContain("Write");
    expect(body).toContain("NotebookEdit");
  });
});
