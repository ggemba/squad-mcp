import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { readRuns, __resetRunsStoreCacheForTests, DEFAULT_RUNS_PATH } from "../src/runs/store.js";
import {
  readLearnings,
  __resetLearningStoreCacheForTests,
  DEFAULT_LEARNING_PATH,
} from "../src/learning/store.js";

/**
 * Agent-rename release: schema_version was bumped from 1 → 2 in both the
 * runs.jsonl and learnings.jsonl journals. A pre-existing v1 row carries
 * the OLD agent names (`senior-developer`, `senior-dba`, …) which the v2
 * schema's `z.enum(AGENT_NAMES_TUPLE)` would otherwise reject as a Zod
 * violation — and quarantine. The schema_version pre-Zod gate must
 * intercept those rows FIRST so they end up in the "skip+log" branch
 * (not the quarantine branch). This test pins that path so a future
 * refactor that drops the pre-Zod gate won't silently bury a user's
 * historical journal in `.corrupt-<ts>.jsonl` siblings.
 *
 * Migration to v2 is via `tools/migrate-jsonl-agents.mjs` (see the
 * migrate-jsonl-agents test for the round-trip contract).
 *
 * PR2 / Fase 1b: the version constant is now PER-STORE. `runs.jsonl` stays
 * at v2 (`RUNS_SCHEMA_VERSION`); `learnings.jsonl` accepts BOTH v2 and v3
 * (`LEARNINGS_SCHEMA_VERSION` = 3). The runs gate's "future/unknown" row is
 * still v1 (it would now also reject v3+, but v1 is the canonical legacy
 * case). The learnings gate's "future/unknown" row is reseeded to v4 — v3
 * is a VALID learnings version post-PR2.
 */
describe("schema_version v1 → v2 skip+log contract", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "squad-schema-skip-test-"));
    __resetRunsStoreCacheForTests();
    __resetLearningStoreCacheForTests();
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    __resetRunsStoreCacheForTests();
    __resetLearningStoreCacheForTests();
  });

  it("runs.jsonl: v1 row with senior-* agent name is skip+logged (no quarantine)", async () => {
    const file = path.join(workspace, DEFAULT_RUNS_PATH);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // A v1 row from the pre-rename era. Note schema_version:1 and the legacy
    // agent name "senior-developer" in the agents[].name slot — exactly the
    // kind of row that would Zod-fail under v2 if not gated first.
    const legacyRunRow = {
      schema_version: 1,
      id: "abc123",
      status: "completed",
      started_at: "2026-04-01T00:00:00Z",
      completed_at: "2026-04-01T00:00:01Z",
      duration_ms: 1000,
      invocation: "implement",
      mode: "normal",
      mode_source: "auto",
      work_type: "Feature",
      git_ref: null,
      files_count: 1,
      agents: [
        {
          name: "senior-developer",
          model: "opus",
          score: 80,
          severity_score: 0,
          batch_duration_ms: 500,
          prompt_chars: 1000,
          response_chars: 500,
        },
      ],
      verdict: "APPROVED",
      weighted_score: 80,
      est_tokens_method: "chars-div-3.5",
    };
    await fs.writeFile(file, JSON.stringify(legacyRunRow) + "\n");

    const entries = await readRuns(workspace);
    expect(entries).toHaveLength(0);

    // Critical: NO quarantine sibling created. The gate intercepted at
    // pre-Zod; Zod never saw the bad agent name.
    const siblings = await fs.readdir(path.dirname(file));
    expect(siblings.some((n) => n.startsWith("runs.jsonl.corrupt-"))).toBe(false);
  });

  it("runs.jsonl: row LACKING schema_version field is also skip+logged (no quarantine)", async () => {
    // Senior-qa Minor (post-impl review): the dedicated pin only covered the
    // explicit schema_version: 1 case for runs.jsonl. The learning store had
    // an equivalent test for the missing-field path (see learning-store.test.ts
    // "rows lacking schema_version are skip+logged"); this mirrors that pin
    // here so a future refactor to the runs/store gate (`schema_version !== 2`)
    // doesn't silently regress the missing-field branch. The gate's
    // `parsed.schema_version !== 2` check catches `undefined !== 2`, so a row
    // with no version field follows the same skip+log path as an explicit v1.
    const file = path.join(workspace, DEFAULT_RUNS_PATH);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Row from an even older client (pre-v0.9.0 in_flight format perhaps) that
    // never wrote a schema_version field at all. Otherwise structurally valid.
    const rowWithoutVersion = {
      // schema_version intentionally omitted
      id: "no-version-row",
      status: "completed",
      started_at: "2026-04-01T00:00:00Z",
      completed_at: "2026-04-01T00:00:01Z",
      duration_ms: 1000,
      invocation: "implement",
      mode: "normal",
      mode_source: "auto",
      work_type: "Feature",
      git_ref: null,
      files_count: 1,
      agents: [
        {
          name: "developer",
          model: "opus",
          score: 80,
          severity_score: 0,
          batch_duration_ms: 500,
          prompt_chars: 1000,
          response_chars: 500,
        },
      ],
      verdict: "APPROVED",
      weighted_score: 80,
      est_tokens_method: "chars-div-3.5",
    };
    await fs.writeFile(file, JSON.stringify(rowWithoutVersion) + "\n");

    const entries = await readRuns(workspace);
    expect(entries).toHaveLength(0);

    // Same critical assertion as the v1 case: no quarantine sibling.
    const siblings = await fs.readdir(path.dirname(file));
    expect(siblings.some((n) => n.startsWith("runs.jsonl.corrupt-"))).toBe(false);
  });

  it("learnings.jsonl: v1 row with senior-* agent name is skip+logged (no quarantine)", async () => {
    const file = path.join(workspace, DEFAULT_LEARNING_PATH);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const legacyLearningRow = {
      schema_version: 1,
      ts: "2026-04-01T00:00:00Z",
      agent: "senior-dba",
      finding: "missing index on user_id",
      decision: "accept",
    };
    await fs.writeFile(file, JSON.stringify(legacyLearningRow) + "\n");

    const entries = await readLearnings(workspace);
    expect(entries).toHaveLength(0);

    const siblings = await fs.readdir(path.dirname(file));
    expect(siblings.some((n) => n.startsWith("learnings.jsonl.corrupt-"))).toBe(false);
  });

  it("learnings.jsonl: v4 row (future/unknown) is skip+logged; v3 is VALID (PR2 per-store gate)", async () => {
    // PR2: learnings accepts {2, 3}. A v3 row reads cleanly; only an
    // out-of-range version (v4 here) hits the skip+log branch. This pins the
    // post-PR2 per-store gate so a future refactor cannot regress either the
    // v3-is-valid contract or the v4-is-skipped contract.
    const file = path.join(workspace, DEFAULT_LEARNING_PATH);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const v3row = {
      schema_version: 3,
      ts: "2026-05-01T00:00:00Z",
      agent: "tech-lead-consolidator",
      lesson: "Gate CSRF at the edge",
      decision: "accept",
    };
    const v4row = {
      schema_version: 4,
      ts: "2027-01-01T00:00:00Z",
      agent: "dba",
      finding: "from a newer client",
      decision: "accept",
    };
    await fs.writeFile(file, JSON.stringify(v3row) + "\n" + JSON.stringify(v4row) + "\n");

    const entries = await readLearnings(workspace);
    // v3 kept, v4 skipped.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.lesson).toBe("Gate CSRF at the edge");

    const siblings = await fs.readdir(path.dirname(file));
    expect(siblings.some((n) => n.startsWith("learnings.jsonl.corrupt-"))).toBe(false);
  });
});
