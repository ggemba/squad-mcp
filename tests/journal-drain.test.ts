import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { drainJournalTool } from "../src/tools/drain-journal.js";
import { __resetCacheForTests, DEFAULT_PENDING_PATH } from "../src/journal/pending.js";
import {
  appendRun,
  readRuns,
  generateRunId,
  __resetRunsStoreCacheForTests,
  type RunRecord,
} from "../src/runs/store.js";
import { parseDistilledLessonsBlock } from "../src/learning/format.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "squad-journal-drain-test-"));
  __resetCacheForTests();
  __resetRunsStoreCacheForTests();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  __resetCacheForTests();
  __resetRunsStoreCacheForTests();
});

/** Write a `.squad.yaml` enabling auto-journaling opt-in. */
async function enableJournaling(): Promise<void> {
  await fs.writeFile(path.join(workspace, ".squad.yaml"), "journaling: opt-in\n", "utf8");
}

/** Seed the pending-journal staging file with raw breadcrumb rows. */
async function seedPending(rows: Record<string, unknown>[]): Promise<void> {
  const file = path.join(workspace, DEFAULT_PENDING_PATH);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

describe("drain_journal tool", () => {
  it("returns empty + no-op when journaling is not opt-in", async () => {
    // No .squad.yaml → journaling defaults to `off`. Even with a populated
    // staging file the tool must NOT drain it.
    await seedPending([{ ts: "2026-05-01T00:00:00Z", tool: "Edit", path: "src/a.ts" }]);
    const r = await drainJournalTool({ workspace_root: workspace });
    expect(r.touched_paths).toEqual([]);
    expect(r.drained_count).toBe(0);
    // The staging file is untouched.
    const stillThere = await fs
      .stat(path.join(workspace, DEFAULT_PENDING_PATH))
      .then(() => true)
      .catch(() => false);
    expect(stillThere).toBe(true);
  });

  it("drains breadcrumbs and returns de-duplicated touched paths when opt-in", async () => {
    await enableJournaling();
    await seedPending([
      { ts: "2026-05-01T00:00:00Z", tool: "Edit", path: "src/a.ts" },
      { ts: "2026-05-01T00:00:01Z", tool: "Write", path: "src/b.ts" },
      { ts: "2026-05-01T00:00:02Z", tool: "Edit", path: "src/a.ts" },
    ]);
    const r = await drainJournalTool({ workspace_root: workspace });
    // 3 breadcrumbs drained, 2 unique paths.
    expect(r.drained_count).toBe(3);
    expect(r.touched_paths.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    // The staging file is consumed (atomic-rename drain).
    const gone = await fs
      .stat(path.join(workspace, DEFAULT_PENDING_PATH))
      .then(() => false)
      .catch(() => true);
    expect(gone).toBe(true);
  });

  it("drops null-path breadcrumbs from the touched_paths set", async () => {
    await enableJournaling();
    await seedPending([
      { ts: "2026-05-01T00:00:00Z", tool: "Edit", path: "src/a.ts" },
      { ts: "2026-05-01T00:00:01Z", tool: "Bash", path: null },
    ]);
    const r = await drainJournalTool({ workspace_root: workspace });
    expect(r.drained_count).toBe(2);
    expect(r.touched_paths).toEqual(["src/a.ts"]);
  });

  it("returns empty when the staging file does not exist (opt-in, nothing staged)", async () => {
    await enableJournaling();
    const r = await drainJournalTool({ workspace_root: workspace });
    expect(r.touched_paths).toEqual([]);
    expect(r.drained_count).toBe(0);
  });
});

describe("RunRecord touched_paths round-trip", () => {
  function baseRecord(id: string): RunRecord {
    return {
      schema_version: 2,
      id,
      status: "completed",
      started_at: "2026-05-01T00:00:00Z",
      completed_at: "2026-05-01T00:00:05Z",
      duration_ms: 5000,
      invocation: "implement",
      mode: "normal",
      mode_source: "auto",
      work_type: "Feature",
      git_ref: null,
      files_count: 2,
      agents: [],
      verdict: "APPROVED",
      weighted_score: 90,
      est_tokens_method: "chars-div-3.5",
    };
  }

  it("persists and reads back touched_paths on a terminal RunRecord", async () => {
    const id = generateRunId();
    const record: RunRecord = { ...baseRecord(id), touched_paths: ["src/a.ts", "src/b.ts"] };
    await appendRun(workspace, record);
    __resetRunsStoreCacheForTests();
    const runs = await readRuns(workspace);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.touched_paths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("accepts a RunRecord with no touched_paths (optional field, older shape)", async () => {
    const id = generateRunId();
    await appendRun(workspace, baseRecord(id));
    __resetRunsStoreCacheForTests();
    const runs = await readRuns(workspace);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.touched_paths).toBeUndefined();
  });
});

describe("parseDistilledLessonsBlock — C4 fenced-block parser (fail-silent)", () => {
  it("parses a well-formed block with one lesson", () => {
    const text = [
      "## TechLead-Consolidator Report",
      "",
      "```squad-distilled-lessons",
      '[{"lesson": "Gate CSRF at the edge", "trigger": "src/auth/**"}]',
      "```",
    ].join("\n");
    const out = parseDistilledLessonsBlock(text);
    expect(out).toEqual([{ lesson: "Gate CSRF at the edge", trigger: "src/auth/**" }]);
  });

  it("parses a lesson with no trigger", () => {
    const text = ["```squad-distilled-lessons", '[{"lesson": "Repo-wide rule"}]', "```"].join("\n");
    expect(parseDistilledLessonsBlock(text)).toEqual([{ lesson: "Repo-wide rule" }]);
  });

  it("returns [] when the fence is absent", () => {
    expect(parseDistilledLessonsBlock("just some report text, no fence")).toEqual([]);
  });

  it("returns [] on malformed JSON inside the fence", () => {
    const text = ["```squad-distilled-lessons", "[{not valid json", "```"].join("\n");
    expect(parseDistilledLessonsBlock(text)).toEqual([]);
  });

  it("returns [] on a partial / unclosed fence (no closing ```)", () => {
    const text = ["```squad-distilled-lessons", '[{"lesson": "never closed"}]'].join("\n");
    expect(parseDistilledLessonsBlock(text)).toEqual([]);
  });

  it("returns [] when the body is valid JSON but not an array", () => {
    const text = ["```squad-distilled-lessons", '{"lesson": "object not array"}', "```"].join("\n");
    expect(parseDistilledLessonsBlock(text)).toEqual([]);
  });

  it("returns [] for an empty array (nothing to distill)", () => {
    const text = ["```squad-distilled-lessons", "[]", "```"].join("\n");
    expect(parseDistilledLessonsBlock(text)).toEqual([]);
  });

  it("drops malformed elements but keeps valid siblings", () => {
    const text = [
      "```squad-distilled-lessons",
      JSON.stringify([
        { lesson: "valid one" },
        { lesson: "" }, // empty lesson — dropped
        { notlesson: "x" }, // wrong shape — dropped
        { lesson: "valid two", trigger: 42 }, // non-string trigger — dropped
        { lesson: "valid three", trigger: "src/**" },
      ]),
      "```",
    ].join("\n");
    expect(parseDistilledLessonsBlock(text)).toEqual([
      { lesson: "valid one" },
      { lesson: "valid three", trigger: "src/**" },
    ]);
  });

  it("does NOT match a near-miss info-string", () => {
    const text = ["```squad-distilled", '[{"lesson": "wrong fence id"}]', "```"].join("\n");
    expect(parseDistilledLessonsBlock(text)).toEqual([]);
  });
});
