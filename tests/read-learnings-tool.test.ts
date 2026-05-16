import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { readLearningsTool } from "../src/tools/read-learnings.js";
import {
  DEFAULT_LEARNING_PATH,
  __resetLearningStoreCacheForTests,
  type LearningEntry,
} from "../src/learning/store.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "squad-read-learn-test-"));
  __resetLearningStoreCacheForTests();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  __resetLearningStoreCacheForTests();
});

async function seed(rows: LearningEntry[]): Promise<void> {
  const file = path.join(workspace, DEFAULT_LEARNING_PATH);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body =
    rows.map((r) => JSON.stringify({ schema_version: 2, ...r })).join("\n") +
    (rows.length > 0 ? "\n" : "");
  await fs.writeFile(file, body, "utf8");
  const future = new Date(Date.now() + 10_000);
  await fs.utimes(file, future, future);
}

/**
 * Seed v3 distilled rows verbatim (caller controls `schema_version`). Used by
 * the PR2 retrieval tests so a row can carry `lesson` / `trigger` / no
 * `finding`.
 */
async function seedRaw(rows: Record<string, unknown>[]): Promise<void> {
  const file = path.join(workspace, DEFAULT_LEARNING_PATH);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");
  await fs.writeFile(file, body, "utf8");
  const future = new Date(Date.now() + 10_000);
  await fs.utimes(file, future, future);
}

/** Write a `.squad.yaml` enabling auto-journaling opt-in. */
async function enableJournaling(): Promise<void> {
  await fs.writeFile(path.join(workspace, ".squad.yaml"), "journaling: opt-in\n", "utf8");
}

describe("readLearningsTool — include_summary", () => {
  it("returns summary counts when include_summary=true", async () => {
    await seed([
      {
        ts: "2026-01-01T00:00:00Z",
        agent: "dba",
        finding: "active 1",
        decision: "accept",
      },
      {
        ts: "2026-01-02T00:00:00Z",
        agent: "dba",
        finding: "active 2",
        decision: "accept",
        promoted: true,
      },
      {
        ts: "2026-01-03T00:00:00Z",
        agent: "dba",
        finding: "archived 1",
        decision: "accept",
        archived: true,
      },
    ]);

    const r = await readLearningsTool({
      workspace_root: workspace,
      limit: 50,
      include_rendered: false,
      include_archived: false,
      include_summary: true,
    });

    expect(r.summary).toBeDefined();
    expect(r.summary!.total).toBe(3);
    expect(r.summary!.active).toBe(2);
    expect(r.summary!.archived).toBe(1);
    expect(r.summary!.promoted).toBe(1);
  });

  it("omits summary when include_summary=false", async () => {
    await seed([
      {
        ts: "2026-01-01T00:00:00Z",
        agent: "dba",
        finding: "x",
        decision: "accept",
      },
    ]);
    const r = await readLearningsTool({
      workspace_root: workspace,
      limit: 50,
      include_rendered: false,
      include_archived: false,
      include_summary: false,
    });
    expect(r.summary).toBeUndefined();
  });

  it("returns zero summary on empty workspace", async () => {
    const r = await readLearningsTool({
      workspace_root: workspace,
      limit: 50,
      include_rendered: false,
      include_archived: false,
      include_summary: true,
    });
    expect(r.summary).toEqual({ total: 0, active: 0, archived: 0, promoted: 0 });
  });
});

describe("readLearningsTool — limit:0 short-circuit", () => {
  it("returns no entries when limit=0", async () => {
    await seed([
      {
        ts: "2026-01-01T00:00:00Z",
        agent: "dba",
        finding: "x",
        decision: "accept",
      },
      {
        ts: "2026-01-02T00:00:00Z",
        agent: "dba",
        finding: "y",
        decision: "accept",
      },
    ]);

    const r = await readLearningsTool({
      workspace_root: workspace,
      limit: 0,
      include_rendered: true,
      include_archived: false,
      include_summary: false,
    });
    expect(r.entries).toEqual([]);
    expect(r.rendered).toBe("");
    // total_in_store still reflects the full file count.
    expect(r.total_in_store).toBe(2);
  });

  it("still returns summary when limit=0 + include_summary=true (stats panel mode)", async () => {
    await seed([
      {
        ts: "2026-01-01T00:00:00Z",
        agent: "dba",
        finding: "x",
        decision: "accept",
      },
    ]);

    const r = await readLearningsTool({
      workspace_root: workspace,
      limit: 0,
      include_rendered: false,
      include_archived: true,
      include_summary: true,
    });
    expect(r.entries).toEqual([]);
    expect(r.summary).toBeDefined();
    expect(r.summary!.total).toBe(1);
  });
});

describe("readLearningsTool — include_archived", () => {
  it("filters out archived entries by default", async () => {
    await seed([
      {
        ts: "2026-01-01T00:00:00Z",
        agent: "dba",
        finding: "active",
        decision: "accept",
      },
      {
        ts: "2026-01-02T00:00:00Z",
        agent: "dba",
        finding: "archived",
        decision: "accept",
        archived: true,
      },
    ]);

    const r = await readLearningsTool({
      workspace_root: workspace,
      limit: 50,
      include_rendered: false,
      include_archived: false,
      include_summary: false,
    });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.finding).toBe("active");
  });

  it("includes archived entries when include_archived=true", async () => {
    await seed([
      {
        ts: "2026-01-01T00:00:00Z",
        agent: "dba",
        finding: "active",
        decision: "accept",
      },
      {
        ts: "2026-01-02T00:00:00Z",
        agent: "dba",
        finding: "archived",
        decision: "accept",
        archived: true,
      },
    ]);

    const r = await readLearningsTool({
      workspace_root: workspace,
      limit: 50,
      include_rendered: false,
      include_archived: true,
      include_summary: false,
    });
    expect(r.entries).toHaveLength(2);
  });
});

describe("readLearningsTool — promoted-first ordering", () => {
  it("promoted entries appear FIRST in the entries array", async () => {
    await seed([
      {
        ts: "2026-01-01T00:00:00Z",
        agent: "dba",
        finding: "regular 1",
        decision: "accept",
      },
      {
        ts: "2026-01-02T00:00:00Z",
        agent: "dba",
        finding: "promoted 1",
        decision: "accept",
        promoted: true,
      },
      {
        ts: "2026-01-03T00:00:00Z",
        agent: "dba",
        finding: "regular 2",
        decision: "accept",
      },
    ]);

    const r = await readLearningsTool({
      workspace_root: workspace,
      limit: 50,
      include_rendered: false,
      include_archived: false,
      include_summary: false,
    });
    expect(r.entries).toHaveLength(3);
    // The promoted entry comes first regardless of ts order.
    expect(r.entries[0]!.finding).toBe("promoted 1");
  });

  it("promoted entries appear FIRST in the rendered markdown block (cycle-2 B1 regression)", async () => {
    await seed([
      {
        ts: "2026-01-01T00:00:00Z",
        agent: "dba",
        finding: "regular-finding",
        decision: "accept",
      },
      {
        ts: "2026-01-02T00:00:00Z",
        agent: "dba",
        finding: "promoted-finding",
        decision: "accept",
        promoted: true,
      },
    ]);

    const r = await readLearningsTool({
      workspace_root: workspace,
      limit: 50,
      include_rendered: true,
      include_archived: false,
      include_summary: false,
    });

    // Cycle-2 B1 fix: promoted entries MUST appear BEFORE non-promoted in the
    // rendered output, not just somewhere in it. The earlier test asserted
    // only presence + tag emission, which silently masked the bug where
    // `formatLearningsForPrompt`'s internal reverse() pushed promoted to the
    // bottom.
    const idxPromoted = r.rendered.indexOf("promoted-finding");
    const idxRegular = r.rendered.indexOf("regular-finding");
    expect(idxPromoted).toBeGreaterThan(-1);
    expect(idxRegular).toBeGreaterThan(-1);
    expect(idxPromoted).toBeLessThan(idxRegular);
    expect(r.rendered).toContain("⭐ PROMOTED");
  });

  it("promoted entries survive when entries.length > limit (cycle-2 B1 regression)", async () => {
    // The original implementation built `[...promoted, ...rest]` and passed
    // it through `tailRecent.slice(-limit)`. When entries exceeded limit,
    // the slice took the tail and silently dropped the promoted prefix at
    // the head. This test seeds 60 entries with one promoted in the middle
    // and asserts limit=20 still surfaces the promoted entry at the top.
    const rows: LearningEntry[] = [];
    for (let i = 0; i < 60; i++) {
      rows.push({
        ts: `2026-01-${String((i % 30) + 1).padStart(2, "0")}T${String(Math.floor(i / 30)).padStart(2, "0")}:00:00Z`,
        agent: "dba",
        finding: `regular-${i}`,
        decision: "accept",
        ...(i === 25 ? { promoted: true, finding: "the-promoted-one" as string } : {}),
      });
    }
    await seed(rows);

    const r = await readLearningsTool({
      workspace_root: workspace,
      limit: 20,
      include_rendered: true,
      include_archived: false,
      include_summary: false,
    });

    // Promoted entry must survive the tail truncation.
    expect(r.entries[0]!.finding).toBe("the-promoted-one");
    expect(r.entries[0]!.promoted).toBe(true);
    expect(r.rendered).toContain("the-promoted-one");
    expect(r.rendered).toContain("⭐ PROMOTED");
    // And it must appear at the TOP of the rendered output, not buried in
    // the tail of regular entries.
    const idxPromoted = r.rendered.indexOf("the-promoted-one");
    const idxFirstRegular = r.rendered.search(/regular-\d+/);
    expect(idxPromoted).toBeLessThan(idxFirstRegular);
  });
});

describe("readLearningsTool — backward compat with v0.10.x rows", () => {
  it("reads rows without archived/promoted fields without error", async () => {
    // v0.10.x shape — no archived/promoted fields. Post v0.14.x D1 the
    // schema_version pre-gate requires `schema_version: 2`; migrated rows
    // carry it but legacy v0.10.x fields beyond that are absent.
    const file = path.join(workspace, DEFAULT_LEARNING_PATH);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const row = {
      schema_version: 2,
      ts: "2026-01-01T00:00:00Z",
      agent: "dba",
      finding: "legacy",
      decision: "accept",
    };
    await fs.writeFile(file, JSON.stringify(row) + "\n");

    const r = await readLearningsTool({
      workspace_root: workspace,
      limit: 50,
      include_rendered: false,
      include_archived: false,
      include_summary: true,
    });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.finding).toBe("legacy");
    // Legacy row has no archived flag → counts as active.
    expect(r.summary!.active).toBe(1);
    expect(r.summary!.archived).toBe(0);
    expect(r.summary!.promoted).toBe(0);
  });
});

describe("readLearningsTool — PR2 distilled-lesson retrieval", () => {
  it("injects a v3 lesson row when its trigger glob matches a changed file", async () => {
    await enableJournaling();
    await seedRaw([
      {
        schema_version: 3,
        ts: "2026-02-01T00:00:00Z",
        agent: "tech-lead-consolidator",
        lesson: "Gate CSRF at the edge",
        trigger: "src/auth/**",
        decision: "accept",
      },
    ]);

    // changed file under src/auth/** → the trigger glob matches → lesson injected.
    const matched = await readLearningsTool({
      workspace_root: workspace,
      limit: 50,
      include_rendered: true,
      include_archived: false,
      include_summary: false,
      changed_files: ["src/auth/login.ts"],
    });
    expect(matched.rendered).toContain("Gate CSRF at the edge");

    // changed file elsewhere → trigger does NOT match → lesson filtered out.
    __resetLearningStoreCacheForTests();
    const unmatched = await readLearningsTool({
      workspace_root: workspace,
      limit: 50,
      include_rendered: true,
      include_archived: false,
      include_summary: false,
      changed_files: ["src/db/index.ts"],
    });
    expect(unmatched.rendered).not.toContain("Gate CSRF at the edge");
  });

  it("always-injects an entry whose normalised title recurs >= 3 times (derived recurrence)", async () => {
    await enableJournaling();
    // Three rows sharing a normalised title, each scoped to src/auth/** so a
    // changed file OUTSIDE that scope would normally exclude them. Derived
    // recurrence >= 3 promotes them to always-inject, bypassing the glob.
    const rows = [1, 2, 3].map((i) => ({
      schema_version: 3,
      ts: `2026-0${i}-01T00:00:00Z`,
      agent: "tech-lead-consolidator",
      lesson: "Recurring policy lesson",
      trigger: "src/auth/**",
      decision: "accept",
    }));
    await seedRaw(rows);

    const r = await readLearningsTool({
      workspace_root: workspace,
      limit: 50,
      include_rendered: true,
      include_archived: false,
      include_summary: false,
      // changed file is OUTSIDE src/auth/** — only the recurrence override
      // can surface the lesson.
      changed_files: ["src/db/index.ts"],
    });
    expect(r.rendered).toContain("Recurring policy lesson");
  });

  it("does NOT always-inject an entry recurring only twice (below threshold)", async () => {
    await enableJournaling();
    const rows = [1, 2].map((i) => ({
      schema_version: 3,
      ts: `2026-0${i}-01T00:00:00Z`,
      agent: "tech-lead-consolidator",
      lesson: "Twice-only lesson",
      trigger: "src/auth/**",
      decision: "accept",
    }));
    await seedRaw(rows);

    const r = await readLearningsTool({
      workspace_root: workspace,
      limit: 50,
      include_rendered: true,
      include_archived: false,
      include_summary: false,
      changed_files: ["src/db/index.ts"],
    });
    // Recurrence is 2 (< 3) and the trigger glob does not match → excluded.
    expect(r.rendered).not.toContain("Twice-only lesson");
  });

  it("no-ops the v3 lesson-injection path when journaling is not opt-in", async () => {
    // No .squad.yaml → journaling defaults to `off`. A v3 lesson row must NOT
    // surface; a legacy finding-only row is unaffected.
    await seedRaw([
      {
        schema_version: 3,
        ts: "2026-02-01T00:00:00Z",
        agent: "tech-lead-consolidator",
        lesson: "Should-not-appear lesson",
        decision: "accept",
      },
      {
        schema_version: 2,
        ts: "2026-01-01T00:00:00Z",
        agent: "dba",
        finding: "legacy finding still visible",
        decision: "accept",
      },
    ]);

    const r = await readLearningsTool({
      workspace_root: workspace,
      limit: 50,
      include_rendered: true,
      include_archived: false,
      include_summary: false,
    });
    expect(r.rendered).not.toContain("Should-not-appear lesson");
    expect(r.rendered).toContain("legacy finding still visible");
    // The lesson row is filtered out of entries too.
    expect(r.entries.some((e) => e.lesson === "Should-not-appear lesson")).toBe(false);
  });
});
