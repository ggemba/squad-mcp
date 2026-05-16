import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const SKILL = path.join(ROOT, "skills", "pipeline", "SKILL.md");
const COMMAND = path.join(ROOT, "commands", "pipeline.md");
const PLUGIN_JSON = path.join(ROOT, ".claude-plugin", "plugin.json");

/**
 * The pipeline skill ships as a thin command trigger + a fat SKILL.md, and the
 * command must be wired into plugin.json or Claude Code never surfaces it.
 * Skills are auto-discovered via the "skills" glob, but commands are an
 * explicit array — a missing entry is the classic "skill works locally but is
 * undiscoverable" bug the qa advisory flagged. These tests pin both.
 */
describe("pipeline skill registration", () => {
  it("ships skills/pipeline/SKILL.md and commands/pipeline.md", async () => {
    await expect(fs.access(SKILL)).resolves.toBeUndefined();
    await expect(fs.access(COMMAND)).resolves.toBeUndefined();
  });

  it("registers ./commands/pipeline.md in plugin.json commands array", async () => {
    const plugin = JSON.parse(await fs.readFile(PLUGIN_JSON, "utf8"));
    expect(plugin.commands).toContain("./commands/pipeline.md");
  });

  it("SKILL.md frontmatter declares name: pipeline", async () => {
    const body = await fs.readFile(SKILL, "utf8");
    expect(body).toMatch(/^name:\s*pipeline\s*$/m);
  });
});

/**
 * Cheap grep-based boundary check, mirroring tests/agents-content.test.ts.
 * It cannot verify behaviour, but it pins the inviolable boundary strings so a
 * future editor accidentally relaxing one trips the test. The pipeline's whole
 * safety story is: it never auto-runs, never records telemetry, never persists.
 */
describe("pipeline skill content guard rails", () => {
  it("SKILL.md carries the no-auto-execution boundary", async () => {
    const body = await fs.readFile(SKILL, "utf8");
    expect(body.toLowerCase()).toContain("no auto-execution");
    expect(body.toLowerCase()).toContain("only ever");
    expect(body.toLowerCase()).toContain("recommends");
  });

  it("SKILL.md carries the no-telemetry boundary", async () => {
    const body = await fs.readFile(SKILL, "utf8");
    expect(body.toLowerCase()).toContain("no telemetry of its own");
    expect(body).toContain("record_run");
  });

  it("SKILL.md carries the no-persistence boundary", async () => {
    const body = await fs.readFile(SKILL, "utf8");
    expect(body.toLowerCase()).toContain("no persistence");
  });

  it("SKILL.md carries the no-source-edit boundary", async () => {
    const body = await fs.readFile(SKILL, "utf8");
    expect(body.toLowerCase()).toContain("never edits source code");
  });

  it("SKILL.md pins --from to a closed, validated phase set", async () => {
    const body = await fs.readFile(SKILL, "utf8");
    for (const phase of ["brainstorm", "grillme", "tasks", "next", "implement", "review"]) {
      expect(body).toContain(phase);
    }
    // The unknown-value rejection contract must stay in the file.
    expect(body).toContain("error: unknown phase");
  });

  it("command trigger carries the untrusted-input clause", async () => {
    const body = await fs.readFile(COMMAND, "utf8");
    expect(body).toMatch(/untrusted input/i);
  });

  it("neither file carries AI attribution", async () => {
    for (const file of [SKILL, COMMAND]) {
      const body = await fs.readFile(file, "utf8");
      expect(body).not.toMatch(/co-authored-by:\s*claude/i);
      expect(body).not.toMatch(/generated with \[?claude/i);
    }
  });
});
