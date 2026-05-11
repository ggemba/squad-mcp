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

  // (Removed) senior-debugger pin to haiku — moved to sonnet under the v0.13
  // tiered-by-task-class policy (Reason class, multi-step hypothesis reasoning).
  // The new pin lives in the policy block below.

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

  // 2026-05 model-tier policy (revised): adopted "tiered-by-task-class".
  // Reason class (advisory judgement) → Sonnet pinned. Reviewer + QA were
  // briefly Haiku-pinned earlier in this session; reverted after both agents
  // self-flagged Haiku as a ceiling for cross-file reasoning (reviewer) and
  // edge-case generation (QA). False-negatives are the #1 risk in code
  // review per industry data; cost delta from Haiku → Sonnet is acceptable.
  // See CHANGELOG "Model tier policy" for the full task-class table.
  it("senior-dev-reviewer frontmatter pins model: sonnet (Reason class)", async () => {
    const file = path.join(AGENTS_DIR, "senior-dev-reviewer.md");
    const body = await fs.readFile(file, "utf8");
    expect(body).toMatch(/^model:\s*sonnet\s*$/m);
  });

  it("senior-qa frontmatter pins model: sonnet (Reason class)", async () => {
    const file = path.join(AGENTS_DIR, "senior-qa.md");
    const body = await fs.readFile(file, "utf8");
    expect(body).toMatch(/^model:\s*sonnet\s*$/m);
  });

  it("senior-debugger frontmatter pins model: sonnet (Reason class — multi-step hypothesis)", async () => {
    const file = path.join(AGENTS_DIR, "senior-debugger.md");
    const body = await fs.readFile(file, "utf8");
    expect(body).toMatch(/^model:\s*sonnet\s*$/m);
  });

  // The five previously-`inherit` agents: pinned to Sonnet for reproducibility.
  // `inherit` silently couples the agent's behaviour to whatever model the user
  // is running in their session — same review yields different verdicts on
  // Opus vs Sonnet sessions. Pinning eliminates that non-determinism.
  it("senior-architect frontmatter pins model: sonnet (Reason class)", async () => {
    const file = path.join(AGENTS_DIR, "senior-architect.md");
    const body = await fs.readFile(file, "utf8");
    expect(body).toMatch(/^model:\s*sonnet\s*$/m);
  });

  it("senior-dba frontmatter pins model: sonnet (Reason class)", async () => {
    const file = path.join(AGENTS_DIR, "senior-dba.md");
    const body = await fs.readFile(file, "utf8");
    expect(body).toMatch(/^model:\s*sonnet\s*$/m);
  });

  it("senior-dev-security frontmatter pins model: sonnet (Reason class)", async () => {
    const file = path.join(AGENTS_DIR, "senior-dev-security.md");
    const body = await fs.readFile(file, "utf8");
    expect(body).toMatch(/^model:\s*sonnet\s*$/m);
  });

  it("tech-lead-planner frontmatter pins model: sonnet (Reason class)", async () => {
    const file = path.join(AGENTS_DIR, "tech-lead-planner.md");
    const body = await fs.readFile(file, "utf8");
    expect(body).toMatch(/^model:\s*sonnet\s*$/m);
  });

  it("tech-lead-consolidator frontmatter pins model: sonnet (Reason class)", async () => {
    const file = path.join(AGENTS_DIR, "tech-lead-consolidator.md");
    const body = await fs.readFile(file, "utf8");
    expect(body).toMatch(/^model:\s*sonnet\s*$/m);
  });

  // 2026-05 capability reinforcement: senior-developer pinned to Opus.
  // Rationale: this is the "code-touching agent" in the squad — its role is
  // robustness, API contracts, runtime behaviour. The user explicitly wants
  // this dimension to run at the highest model tier regardless of their
  // session default (which may be Sonnet for cost reasons elsewhere). The
  // pin guarantees Opus on /squad:review and /squad:implement quick/normal
  // modes; --deep already overrides everyone to Opus per SKILL.md anyway.
  it("senior-developer frontmatter pins model: opus (capability contract)", async () => {
    const file = path.join(AGENTS_DIR, "senior-developer.md");
    const body = await fs.readFile(file, "utf8");
    expect(body).toMatch(/^model:\s*opus\s*$/m);
  });

  // 2026-05 senior-implementer (v0.13): dedicated Phase 8 executor.
  // Pinned to Opus — same rationale as senior-developer (highest-stakes
  // step of the squad). The "no commit/push" + "no AI attribution" + "no
  // scope creep" boundaries are core to the role; pin them by grep.
  it("senior-implementer frontmatter pins model: opus (capability contract)", async () => {
    const file = path.join(AGENTS_DIR, "senior-implementer.md");
    const body = await fs.readFile(file, "utf8");
    expect(body).toMatch(/^model:\s*opus\s*$/m);
  });

  it("senior-implementer Boundaries explicitly forbid git commit / push and AI attribution", async () => {
    const file = path.join(AGENTS_DIR, "senior-implementer.md");
    const body = await fs.readFile(file, "utf8");
    expect(body).toContain("git commit");
    expect(body).toContain("git push");
    expect(body.toLowerCase()).toMatch(/co-authored-by|ai attribution/);
  });

  it("senior-implementer carries the untrusted-input clause", async () => {
    const file = path.join(AGENTS_DIR, "senior-implementer.md");
    const body = await fs.readFile(file, "utf8");
    expect(body).toMatch(/untrusted input/i);
  });
});
