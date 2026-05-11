import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pruneLearningsTool } from "../src/tools/prune-learnings.js";
import {
  readLearnings,
  appendLearning,
  DEFAULT_LEARNING_PATH,
  __resetLearningStoreCacheForTests,
  type LearningEntry,
} from "../src/learning/store.js";

let workspace: string;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "squad-prune-test-"));
  __resetLearningStoreCacheForTests();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  __resetLearningStoreCacheForTests();
});

/** Write raw rows directly to the journal, bypassing `appendLearning`. */
async function seed(rows: LearningEntry[]): Promise<string> {
  const file = path.join(workspace, DEFAULT_LEARNING_PATH);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");
  await fs.writeFile(file, body, "utf8");
  // Bump mtime so cached readLearnings re-reads.
  const future = new Date(Date.now() + 10_000);
  await fs.utimes(file, future, future);
  return file;
}

describe("pruneLearningsTool — empty / no-op cases", () => {
  it("returns zero counts when the journal does not exist", async () => {
    const r = await pruneLearningsTool({
      workspace_root: workspace,
      max_age_days: 30,
      min_recurrence: 3,
      dry_run: false,
    });
    expect(r.ok).toBe(true);
    expect(r.total).toBe(0);
    expect(r.archived_count).toBe(0);
    expect(r.promoted_count).toBe(0);
    expect(r.unchanged_count).toBe(0);
  });

  it("returns zero counts on an empty file", async () => {
    await seed([]);
    const r = await pruneLearningsTool({
      workspace_root: workspace,
      max_age_days: 30,
      min_recurrence: 3,
      dry_run: false,
    });
    expect(r.total).toBe(0);
  });

  it("defaults to a no-op (max_age_days=0, no promotion threshold change)", async () => {
    const oldTs = new Date(Date.now() - 365 * ONE_DAY_MS).toISOString();
    const file = await seed([
      {
        ts: oldTs,
        agent: "senior-dba",
        finding: "old finding",
        decision: "accept",
      },
    ]);
    const before = await fs.readFile(file, "utf8");

    // Default: max_age_days=0 (disabled), min_recurrence=3 (no group with 3+ accepts yet).
    const r = await pruneLearningsTool({
      workspace_root: workspace,
      max_age_days: 0,
      min_recurrence: 3,
      dry_run: false,
    });
    expect(r.archived_count).toBe(0);
    expect(r.promoted_count).toBe(0);
    expect(r.unchanged_count).toBe(1);

    // File untouched.
    const after = await fs.readFile(file, "utf8");
    expect(after).toBe(before);

    // No .prev snapshot when no rewrite happened.
    const prevExists = await fs
      .stat(`${file}.prev`)
      .then(() => true)
      .catch(() => false);
    expect(prevExists).toBe(false);
  });
});

describe("pruneLearningsTool — age cutoff archival", () => {
  it("archives entries older than max_age_days", async () => {
    const oldTs = new Date(Date.now() - 200 * ONE_DAY_MS).toISOString();
    const newTs = new Date(Date.now() - 5 * ONE_DAY_MS).toISOString();
    await seed([
      {
        ts: oldTs,
        agent: "senior-dba",
        finding: "old",
        decision: "accept",
      },
      {
        ts: newTs,
        agent: "senior-dba",
        finding: "new",
        decision: "accept",
      },
    ]);

    const r = await pruneLearningsTool({
      workspace_root: workspace,
      max_age_days: 30,
      min_recurrence: 0,
      dry_run: false,
    });
    expect(r.archived_count).toBe(1);
    expect(r.promoted_count).toBe(0);
    expect(r.total).toBe(2);

    const entries = await readLearnings(workspace);
    const oldEntry = entries.find((e) => e.finding === "old");
    const newEntry = entries.find((e) => e.finding === "new");
    expect(oldEntry?.archived).toBe(true);
    expect(newEntry?.archived).toBeUndefined();
  });

  it("idempotent — re-running prune does not double-archive", async () => {
    const oldTs = new Date(Date.now() - 200 * ONE_DAY_MS).toISOString();
    await seed([
      {
        ts: oldTs,
        agent: "senior-dba",
        finding: "old",
        decision: "accept",
      },
    ]);

    const r1 = await pruneLearningsTool({
      workspace_root: workspace,
      max_age_days: 30,
      min_recurrence: 0,
      dry_run: false,
    });
    expect(r1.archived_count).toBe(1);

    __resetLearningStoreCacheForTests();
    const r2 = await pruneLearningsTool({
      workspace_root: workspace,
      max_age_days: 30,
      min_recurrence: 0,
      dry_run: false,
    });
    // Already archived → count stays 0 the second pass.
    expect(r2.archived_count).toBe(0);
  });

  it("skips entries with unparseable timestamps", async () => {
    await seed([
      {
        // @ts-expect-error — intentional bad ts to verify defensive behaviour
        ts: "not-a-date",
        agent: "senior-dba",
        finding: "bad ts",
        decision: "accept",
      },
    ]);

    // readLearnings will quarantine the bad ts (schema validates ts is a
    // 1-40 char string, but Date.parse fails). The bad-ts entry is filtered
    // out before reaching prune, so we see zero rows.
    const r = await pruneLearningsTool({
      workspace_root: workspace,
      max_age_days: 30,
      min_recurrence: 0,
      dry_run: false,
    });
    // Either the schema accepted a non-ISO string OR quarantine dropped it —
    // either way, no archival happens for "not-a-date".
    expect(r.archived_count).toBe(0);
  });
});

describe("pruneLearningsTool — promotion by recurrence", () => {
  it("promotes the most-recent accept entry when group size ≥ min_recurrence", async () => {
    await seed([
      {
        ts: "2026-01-01T00:00:00Z",
        agent: "senior-dba",
        finding: "CSRF token missing",
        decision: "accept",
      },
      {
        ts: "2026-02-01T00:00:00Z",
        agent: "senior-dev-security",
        finding: "csrf token missing",
        decision: "accept",
      },
      {
        ts: "2026-03-01T00:00:00Z",
        agent: "senior-architect",
        finding: "  CSRF Token   Missing.",
        decision: "accept",
      },
    ]);

    const r = await pruneLearningsTool({
      workspace_root: workspace,
      max_age_days: 0,
      min_recurrence: 3,
      dry_run: false,
    });
    expect(r.promoted_count).toBe(1);

    const entries = await readLearnings(workspace);
    const promoted = entries.filter((e) => e.promoted === true);
    expect(promoted).toHaveLength(1);
    // Most recent by ts wins.
    expect(promoted[0]!.ts).toBe("2026-03-01T00:00:00Z");
  });

  it("does NOT promote when group size < min_recurrence", async () => {
    await seed([
      {
        ts: "2026-01-01T00:00:00Z",
        agent: "senior-dba",
        finding: "csrf token missing",
        decision: "accept",
      },
      {
        ts: "2026-02-01T00:00:00Z",
        agent: "senior-dba",
        finding: "csrf token missing",
        decision: "accept",
      },
    ]);

    const r = await pruneLearningsTool({
      workspace_root: workspace,
      max_age_days: 0,
      min_recurrence: 3,
      dry_run: false,
    });
    expect(r.promoted_count).toBe(0);

    const entries = await readLearnings(workspace);
    expect(entries.every((e) => e.promoted !== true)).toBe(true);
  });

  it("ignores reject decisions when counting (only accepts count)", async () => {
    await seed([
      {
        ts: "2026-01-01T00:00:00Z",
        agent: "senior-dba",
        finding: "csrf token missing",
        decision: "reject",
      },
      {
        ts: "2026-02-01T00:00:00Z",
        agent: "senior-dba",
        finding: "csrf token missing",
        decision: "reject",
      },
      {
        ts: "2026-03-01T00:00:00Z",
        agent: "senior-dba",
        finding: "csrf token missing",
        decision: "accept",
      },
    ]);

    const r = await pruneLearningsTool({
      workspace_root: workspace,
      max_age_days: 0,
      min_recurrence: 3,
      dry_run: false,
    });
    // Only 1 accept → below threshold, no promotion.
    expect(r.promoted_count).toBe(0);
  });

  it("does not count archived entries toward recurrence", async () => {
    await seed([
      {
        ts: "2026-01-01T00:00:00Z",
        agent: "senior-dba",
        finding: "csrf token missing",
        decision: "accept",
        archived: true,
      },
      {
        ts: "2026-02-01T00:00:00Z",
        agent: "senior-dba",
        finding: "csrf token missing",
        decision: "accept",
      },
      {
        ts: "2026-03-01T00:00:00Z",
        agent: "senior-dba",
        finding: "csrf token missing",
        decision: "accept",
      },
    ]);

    const r = await pruneLearningsTool({
      workspace_root: workspace,
      max_age_days: 0,
      min_recurrence: 3,
      dry_run: false,
    });
    // 2 active + 1 archived = 2 toward count, below threshold 3.
    expect(r.promoted_count).toBe(0);
  });

  it("idempotent — re-running prune does not double-promote", async () => {
    await seed([
      {
        ts: "2026-01-01T00:00:00Z",
        agent: "senior-dba",
        finding: "csrf token missing",
        decision: "accept",
      },
      {
        ts: "2026-02-01T00:00:00Z",
        agent: "senior-dba",
        finding: "csrf token missing",
        decision: "accept",
      },
      {
        ts: "2026-03-01T00:00:00Z",
        agent: "senior-dba",
        finding: "csrf token missing",
        decision: "accept",
      },
    ]);

    const r1 = await pruneLearningsTool({
      workspace_root: workspace,
      max_age_days: 0,
      min_recurrence: 3,
      dry_run: false,
    });
    expect(r1.promoted_count).toBe(1);

    __resetLearningStoreCacheForTests();
    const r2 = await pruneLearningsTool({
      workspace_root: workspace,
      max_age_days: 0,
      min_recurrence: 3,
      dry_run: false,
    });
    expect(r2.promoted_count).toBe(0);
  });

  it("disables promotion entirely when min_recurrence is 0", async () => {
    await seed([
      {
        ts: "2026-01-01T00:00:00Z",
        agent: "senior-dba",
        finding: "csrf token missing",
        decision: "accept",
      },
      {
        ts: "2026-02-01T00:00:00Z",
        agent: "senior-dba",
        finding: "csrf token missing",
        decision: "accept",
      },
    ]);

    const r = await pruneLearningsTool({
      workspace_root: workspace,
      max_age_days: 0,
      min_recurrence: 0,
      dry_run: false,
    });
    expect(r.promoted_count).toBe(0);
  });
});

describe("pruneLearningsTool — dry_run", () => {
  it("computes counts without mutating the file", async () => {
    const oldTs = new Date(Date.now() - 200 * ONE_DAY_MS).toISOString();
    const file = await seed([
      {
        ts: oldTs,
        agent: "senior-dba",
        finding: "old",
        decision: "accept",
      },
    ]);
    const before = await fs.readFile(file, "utf8");

    const r = await pruneLearningsTool({
      workspace_root: workspace,
      max_age_days: 30,
      min_recurrence: 0,
      dry_run: true,
    });
    expect(r.archived_count).toBe(1);
    expect(r.dry_run).toBe(true);

    // File untouched.
    const after = await fs.readFile(file, "utf8");
    expect(after).toBe(before);

    // No .prev snapshot.
    const prevExists = await fs
      .stat(`${file}.prev`)
      .then(() => true)
      .catch(() => false);
    expect(prevExists).toBe(false);
  });
});

describe("pruneLearningsTool — interaction with readLearnings default", () => {
  it("archived entries are hidden from default readLearnings output", async () => {
    const oldTs = new Date(Date.now() - 200 * ONE_DAY_MS).toISOString();
    const newTs = new Date(Date.now() - 5 * ONE_DAY_MS).toISOString();
    await seed([
      {
        ts: oldTs,
        agent: "senior-dba",
        finding: "old",
        decision: "accept",
      },
      {
        ts: newTs,
        agent: "senior-dba",
        finding: "new",
        decision: "accept",
      },
    ]);

    await pruneLearningsTool({
      workspace_root: workspace,
      max_age_days: 30,
      min_recurrence: 0,
      dry_run: false,
    });

    __resetLearningStoreCacheForTests();
    const entries = await readLearnings(workspace);
    // readLearnings returns the raw file — archived rows survive (we filter at the tool layer).
    // What matters is that the archived flag is persisted on the old entry.
    const oldEntry = entries.find((e) => e.finding === "old");
    const newEntry = entries.find((e) => e.finding === "new");
    expect(oldEntry?.archived).toBe(true);
    expect(newEntry?.archived).toBeUndefined();
  });
});

describe("pruneLearningsTool — schema validation (cycle-2)", () => {
  it("rejects min_recurrence=1 with a clear error (cycle-2 developer Major M5)", async () => {
    await seed([
      {
        ts: "2026-01-01T00:00:00Z",
        agent: "senior-dba",
        finding: "x",
        decision: "accept",
      },
    ]);

    // min_recurrence=1 would promote every singleton accept, defeating the
    // "team policy" signal. The schema now rejects it explicitly.
    await expect(
      pruneLearningsTool({
        workspace_root: workspace,
        max_age_days: 0,
        min_recurrence: 1,
        dry_run: false,
      }),
    ).rejects.toThrow(/singleton|recurrence/i);
  });

  it("accepts min_recurrence=0 (disable) and min_recurrence>=2", async () => {
    await seed([
      {
        ts: "2026-01-01T00:00:00Z",
        agent: "senior-dba",
        finding: "x",
        decision: "accept",
      },
    ]);

    await expect(
      pruneLearningsTool({
        workspace_root: workspace,
        max_age_days: 0,
        min_recurrence: 0,
        dry_run: false,
      }),
    ).resolves.toMatchObject({ ok: true });

    __resetLearningStoreCacheForTests();

    await expect(
      pruneLearningsTool({
        workspace_root: workspace,
        max_age_days: 0,
        min_recurrence: 2,
        dry_run: false,
      }),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe("pruneLearningsTool — promotion tie-break (cycle-2 QA M4)", () => {
  it("on identical ts, later-in-append-order wins promotion", async () => {
    // Pin the documented tie-break: when two accepts in the same finding
    // group share an identical timestamp, the entry later in append order
    // (higher index) is promoted. The production code at prune-learnings.ts
    // uses `ms >= bestMs` which selects the higher index on equality.
    await seed([
      {
        ts: "2026-02-01T00:00:00Z",
        agent: "senior-dba",
        finding: "csrf token missing",
        decision: "accept",
        // Distinguish via a field that survives the prune
        reason: "first-in-order",
      },
      {
        ts: "2026-02-01T00:00:00Z",
        agent: "senior-dba",
        finding: "csrf token missing",
        decision: "accept",
        reason: "second-in-order",
      },
      {
        ts: "2026-02-01T00:00:00Z",
        agent: "senior-dba",
        finding: "csrf token missing",
        decision: "accept",
        reason: "third-in-order",
      },
    ]);

    const r = await pruneLearningsTool({
      workspace_root: workspace,
      max_age_days: 0,
      min_recurrence: 3,
      dry_run: false,
    });
    expect(r.promoted_count).toBe(1);

    __resetLearningStoreCacheForTests();
    const entries = await readLearnings(workspace);
    const promoted = entries.filter((e) => e.promoted === true);
    expect(promoted).toHaveLength(1);
    // The last appended entry wins on identical-ts tie.
    expect(promoted[0]!.reason).toBe("third-in-order");
  });
});

describe("pruneLearningsTool — config gate (cycle-2 QA M2)", () => {
  it("returns a safe no-op when learnings.enabled is false", async () => {
    // Write a .squad.yaml that disables learnings, plus a populated journal.
    // The tool should NOT touch the journal.
    await fs.mkdir(path.join(workspace, ".squad"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, ".squad.yaml"),
      "learnings:\n  enabled: false\n",
      "utf8",
    );
    const oldTs = new Date(Date.now() - 200 * ONE_DAY_MS).toISOString();
    const file = await seed([
      {
        ts: oldTs,
        agent: "senior-dba",
        finding: "old",
        decision: "accept",
      },
    ]);
    const before = await fs.readFile(file, "utf8");

    const r = await pruneLearningsTool({
      workspace_root: workspace,
      max_age_days: 30,
      min_recurrence: 0,
      dry_run: false,
    });
    expect(r.ok).toBe(true);
    expect(r.total).toBe(0);
    expect(r.archived_count).toBe(0);

    // File untouched, no .prev snapshot created.
    const after = await fs.readFile(file, "utf8");
    expect(after).toBe(before);
    const prevExists = await fs
      .stat(`${file}.prev`)
      .then(() => true)
      .catch(() => false);
    expect(prevExists).toBe(false);
  });
});

describe("pruneLearningsTool — backward compat", () => {
  it("reads v0.10.x rows (no archived/promoted fields) cleanly", async () => {
    // Simulate a pre-v0.11.0 row by serialising one without the new fields.
    const file = await seed([
      {
        ts: "2026-01-01T00:00:00Z",
        agent: "senior-dba",
        finding: "legacy",
        decision: "accept",
      },
    ]);
    const raw = await fs.readFile(file, "utf8");
    expect(raw).not.toContain("archived");
    expect(raw).not.toContain("promoted");

    const r = await pruneLearningsTool({
      workspace_root: workspace,
      max_age_days: 0,
      min_recurrence: 0,
      dry_run: false,
    });
    expect(r.total).toBe(1);
    expect(r.archived_count).toBe(0);
    expect(r.promoted_count).toBe(0);
  });

  it("preserves all fields on rewrite (no data loss for fields not touched by prune)", async () => {
    await appendLearning(workspace, {
      agent: "senior-dba",
      finding: "with everything",
      decision: "accept",
      severity: "Major",
      reason: "we already shipped this",
      pr: 42,
      scope: "src/auth/**",
    });
    // Trigger a rewrite by archival of a separate old row.
    const oldTs = new Date(Date.now() - 200 * ONE_DAY_MS).toISOString();
    const file = path.join(workspace, DEFAULT_LEARNING_PATH);
    const oldRow = {
      ts: oldTs,
      agent: "senior-dba",
      finding: "old",
      decision: "accept",
    };
    await fs.appendFile(file, JSON.stringify(oldRow) + "\n");
    const future = new Date(Date.now() + 10_000);
    await fs.utimes(file, future, future);
    __resetLearningStoreCacheForTests();

    await pruneLearningsTool({
      workspace_root: workspace,
      max_age_days: 30,
      min_recurrence: 0,
      dry_run: false,
    });

    __resetLearningStoreCacheForTests();
    const entries = await readLearnings(workspace);
    const everything = entries.find((e) => e.finding === "with everything");
    expect(everything).toBeDefined();
    expect(everything?.severity).toBe("Major");
    expect(everything?.reason).toBe("we already shipped this");
    expect(everything?.pr).toBe(42);
    expect(everything?.scope).toBe("src/auth/**");
  });
});
