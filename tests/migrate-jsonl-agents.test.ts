import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATOR = path.resolve(__dirname, "..", "tools", "migrate-jsonl-agents.mjs");

/**
 * Round-trip test for `tools/migrate-jsonl-agents.mjs`.
 *
 * The migration tool rewrites pre-rename `senior-*` agent identifiers to
 * the post-rename bare form in three files: `.squad/runs.jsonl`,
 * `.squad/learnings.jsonl`, and `.squad.yaml`. For the two JSONL files it
 * ALSO bumps `schema_version` from 1 → 2 so the migrated rows pass the
 * post-rename pre-Zod gate. This test builds a synthetic fixture in a temp
 * workspace, runs the tool, and asserts the contract.
 */
function runMigrator(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [MIGRATOR, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

describe("migrate-jsonl-agents", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "squad-migrate-test-"));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("rewrites all 8 senior-* agent names AND bumps schema_version in runs.jsonl", async () => {
    const file = path.join(workspace, ".squad", "runs.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const row1 = {
      schema_version: 1,
      id: "r1",
      status: "completed",
      started_at: "2026-04-01T00:00:00Z",
      completed_at: "2026-04-01T00:00:02Z",
      duration_ms: 2000,
      invocation: "implement",
      mode: "normal",
      mode_source: "auto",
      work_type: "Feature",
      git_ref: null,
      files_count: 2,
      agents: [
        {
          name: "senior-developer",
          model: "opus",
          score: 85,
          severity_score: 0,
          batch_duration_ms: 1000,
          prompt_chars: 100,
          response_chars: 50,
        },
        {
          name: "senior-dba",
          model: "sonnet",
          score: 75,
          severity_score: 100,
          batch_duration_ms: 800,
          prompt_chars: 90,
          response_chars: 40,
        },
      ],
      verdict: "APPROVED",
      weighted_score: 80,
      est_tokens_method: "chars-div-3.5",
    };
    await fs.writeFile(file, JSON.stringify(row1) + "\n");

    const result = await runMigrator(["--workspace-root", workspace, "--yes"]);
    expect(result.code).toBe(0);

    const after = await fs.readFile(file, "utf8");
    const lines = after.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.schema_version).toBe(2);
    expect(parsed.agents[0].name).toBe("developer");
    expect(parsed.agents[1].name).toBe("dba");
    // Ensure no senior-* string survived anywhere in the migrated row.
    expect(JSON.stringify(parsed)).not.toMatch(/senior-/);
  });

  it("rewrites senior-* in learnings.jsonl AND bumps schema_version", async () => {
    const file = path.join(workspace, ".squad", "learnings.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const row = {
      schema_version: 1,
      ts: "2026-04-01T00:00:00Z",
      agent: "senior-dev-security",
      finding: "IDOR on /api/orders/:id",
      decision: "reject",
      reason: "review confirmed authz enforced at controller",
    };
    await fs.writeFile(file, JSON.stringify(row) + "\n");

    const result = await runMigrator(["--workspace-root", workspace, "--yes"]);
    expect(result.code).toBe(0);

    const after = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(after.trim());
    expect(parsed.schema_version).toBe(2);
    expect(parsed.agent).toBe("security");
  });

  it("rewrites senior-* in .squad.yaml without disturbing comments", async () => {
    const yamlPath = path.join(workspace, ".squad.yaml");
    const yaml = [
      "# squad-mcp local configuration",
      "weights:",
      "  senior-architect: 20",
      "  senior-dba: 15",
      "  senior-developer: 25",
      "disable_agents:",
      "  - senior-debugger",
      "  - senior-qa",
      "",
    ].join("\n");
    await fs.writeFile(yamlPath, yaml);

    const result = await runMigrator(["--workspace-root", workspace, "--yes"]);
    expect(result.code).toBe(0);

    const after = await fs.readFile(yamlPath, "utf8");
    expect(after).not.toMatch(/senior-/);
    expect(after).toContain("architect: 20");
    expect(after).toContain("dba: 15");
    expect(after).toContain("developer: 25");
    expect(after).toContain("- debugger");
    expect(after).toContain("- qa");
    // Comment line preserved.
    expect(after).toContain("# squad-mcp local configuration");
  });

  it("--dry-run reports without writing", async () => {
    const file = path.join(workspace, ".squad", "runs.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const original = JSON.stringify({
      schema_version: 1,
      id: "r1",
      status: "in_flight",
      started_at: "2026-04-01T00:00:00Z",
      invocation: "implement",
      mode: "normal",
      mode_source: "auto",
      git_ref: null,
      files_count: 0,
      agents: [
        {
          name: "senior-qa",
          model: "sonnet",
          score: null,
          severity_score: null,
          batch_duration_ms: 0,
          prompt_chars: 0,
          response_chars: 0,
        },
      ],
      est_tokens_method: "chars-div-3.5",
    });
    await fs.writeFile(file, original + "\n");

    const result = await runMigrator(["--workspace-root", workspace, "--dry-run", "--yes"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("dry-run");

    const after = await fs.readFile(file, "utf8");
    expect(after.trim()).toBe(original);
  });

  it("missing targets are skipped without error", async () => {
    // Empty workspace — no .squad/ or .squad.yaml at all.
    const result = await runMigrator(["--workspace-root", workspace, "--yes"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/not present/);
  });

  it("idempotent: re-running on an already-migrated file is a no-op", async () => {
    // Senior-dev-reviewer Major (post-impl review): no fixture exercised the
    // already-migrated case. Without this pin, a future refactor that broke
    // the no-op path (e.g. by unconditionally bumping schema_version or by
    // re-stamping rows on every read) could silently corrupt user data on
    // second run.
    const runsFile = path.join(workspace, ".squad", "runs.jsonl");
    const learningsFile = path.join(workspace, ".squad", "learnings.jsonl");
    const yamlFile = path.join(workspace, ".squad.yaml");
    await fs.mkdir(path.dirname(runsFile), { recursive: true });

    // Pre-migrated v2 row with new bare-name agents.
    const v2Row = {
      schema_version: 2,
      id: "r-migrated",
      status: "completed",
      started_at: "2026-04-01T00:00:00Z",
      completed_at: "2026-04-01T00:00:01Z",
      duration_ms: 1000,
      invocation: "implement",
      mode: "quick",
      mode_source: "user",
      work_type: "Refactor",
      git_ref: null,
      files_count: 0,
      agents: [
        {
          name: "developer",
          model: "opus",
          score: 90,
          severity_score: 0,
          batch_duration_ms: 100,
          prompt_chars: 50,
          response_chars: 25,
        },
      ],
      verdict: "APPROVED",
      weighted_score: 90,
      est_tokens_method: "chars-div-3.5",
    };
    const v2Learning = {
      schema_version: 2,
      ts: "2026-04-01T00:00:00Z",
      agent: "developer",
      finding: "use Result<T> instead of throwing",
      decision: "accept",
    };
    const v2Yaml = ["weights:", "  developer: 25", "  qa: 15", ""].join("\n");

    await fs.writeFile(runsFile, JSON.stringify(v2Row) + "\n");
    await fs.writeFile(learningsFile, JSON.stringify(v2Learning) + "\n");
    await fs.writeFile(yamlFile, v2Yaml);

    const runsBefore = await fs.readFile(runsFile, "utf8");
    const learningsBefore = await fs.readFile(learningsFile, "utf8");
    const yamlBefore = await fs.readFile(yamlFile, "utf8");

    const result = await runMigrator(["--workspace-root", workspace, "--yes"]);
    expect(result.code).toBe(0);

    // Byte-for-byte identical: the no-op path skips the atomic-rewrite.
    expect(await fs.readFile(runsFile, "utf8")).toBe(runsBefore);
    expect(await fs.readFile(learningsFile, "utf8")).toBe(learningsBefore);
    expect(await fs.readFile(yamlFile, "utf8")).toBe(yamlBefore);

    // Summary should surface zero rewrites / replacements on each file.
    expect(result.stdout).toMatch(/0 rewritten/);
    expect(result.stdout).toMatch(/0 agent-name replacements/);
  });

  it("preserves unparseable JSON lines verbatim (between valid rows)", async () => {
    // Senior-qa Major (post-impl review): the migrateJsonl `catch` branch at
    // tools/migrate-jsonl-agents.mjs preserves rows that JSON.parse can't
    // decode so the store's quarantine path picks them up on next read.
    // No previous test exercised this. A future refactor dropping the
    // `outLines.push(line)` inside the catch would silently drop user data.
    const file = path.join(workspace, ".squad", "runs.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const validRow1 = {
      schema_version: 1,
      id: "r-valid-1",
      status: "in_flight",
      started_at: "2026-04-01T00:00:00Z",
      invocation: "implement",
      mode: "normal",
      mode_source: "auto",
      git_ref: null,
      files_count: 0,
      agents: [
        {
          name: "senior-architect",
          model: "opus",
          score: null,
          severity_score: null,
          batch_duration_ms: 0,
          prompt_chars: 0,
          response_chars: 0,
        },
      ],
      est_tokens_method: "chars-div-3.5",
    };
    const validRow2 = {
      schema_version: 1,
      id: "r-valid-2",
      status: "completed",
      started_at: "2026-04-01T00:00:01Z",
      completed_at: "2026-04-01T00:00:02Z",
      duration_ms: 1000,
      invocation: "implement",
      mode: "normal",
      mode_source: "auto",
      work_type: "Feature",
      git_ref: null,
      files_count: 0,
      agents: [
        {
          name: "senior-qa",
          model: "sonnet",
          score: 80,
          severity_score: 0,
          batch_duration_ms: 500,
          prompt_chars: 100,
          response_chars: 50,
        },
      ],
      verdict: "APPROVED",
      weighted_score: 80,
      est_tokens_method: "chars-div-3.5",
    };
    const malformed = `{"oh no this is not json,`;
    const body =
      [JSON.stringify(validRow1), malformed, JSON.stringify(validRow2)].join("\n") + "\n";
    await fs.writeFile(file, body);

    const result = await runMigrator(["--workspace-root", workspace, "--yes"]);
    expect(result.code).toBe(0);

    const after = (await fs.readFile(file, "utf8")).split("\n").filter((l) => l !== "");
    expect(after).toHaveLength(3);

    // Middle line preserved BYTE-FOR-BYTE; never re-serialised.
    expect(after[1]).toBe(malformed);

    // Valid rows migrated normally.
    const r1 = JSON.parse(after[0]!);
    const r2 = JSON.parse(after[2]!);
    expect(r1.schema_version).toBe(2);
    expect(r1.agents[0].name).toBe("architect");
    expect(r2.schema_version).toBe(2);
    expect(r2.agents[0].name).toBe("qa");

    // Summary surfaces the unparseable count for the user.
    expect(result.stdout).toMatch(/1 unparseable \(preserved\)/);
  });
});
