import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readLearnings,
  appendLearning,
  tailRecent,
  DEFAULT_LEARNING_PATH,
  __resetLearningStoreCacheForTests,
  type LearningEntry,
} from "../src/learning/store.js";
import { LEARNINGS_SCHEMA_VERSION } from "../src/util/schema-version.js";
import { isSquadError } from "../src/errors.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "squad-learn-test-"));
  __resetLearningStoreCacheForTests();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  __resetLearningStoreCacheForTests();
});

describe("readLearnings — file presence", () => {
  it("returns [] when no file exists", async () => {
    const entries = await readLearnings(workspace);
    expect(entries).toEqual([]);
  });

  it("returns [] when the path resolves to a directory", async () => {
    await fs.mkdir(path.join(workspace, ".squad", "learnings.jsonl"), {
      recursive: true,
    });
    const entries = await readLearnings(workspace);
    expect(entries).toEqual([]);
  });

  it("reads append-order entries from the default path", async () => {
    const file = path.join(workspace, DEFAULT_LEARNING_PATH);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const a = {
      schema_version: 2,
      ts: "2026-01-01T00:00:00Z",
      agent: "security",
      finding: "csrf",
      decision: "reject",
    };
    const b = {
      schema_version: 2,
      ts: "2026-01-02T00:00:00Z",
      agent: "architect",
      finding: "coupling",
      decision: "accept",
    };
    await fs.writeFile(file, JSON.stringify(a) + "\n" + JSON.stringify(b) + "\n");
    const entries = await readLearnings(workspace);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.agent).toBe("security");
    expect(entries[1]!.agent).toBe("architect");
  });

  it("rejects configuredPath that escapes workspaceRoot via .. (CWE-22)", async () => {
    await expect(readLearnings(workspace, { configuredPath: "../escape.jsonl" })).rejects.toThrow(
      /PATH_TRAVERSAL_DENIED|escapes workspace_root/,
    );
  });

  it("rejects absolute configuredPath (CWE-22)", async () => {
    await expect(readLearnings(workspace, { configuredPath: "/etc/passwd" })).rejects.toThrow(
      /PATH_TRAVERSAL_DENIED|must be a workspace-relative/,
    );
  });

  it("honors a custom configuredPath", async () => {
    const rel = "custom/path/notes.jsonl";
    const file = path.join(workspace, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const e = {
      schema_version: 2,
      ts: "2026-01-01T00:00:00Z",
      agent: "dba",
      finding: "missing index",
      decision: "accept",
    };
    await fs.writeFile(file, JSON.stringify(e) + "\n");
    const entries = await readLearnings(workspace, { configuredPath: rel });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.finding).toBe("missing index");
  });

  it("skips blank lines (trailing newlines, blank separators)", async () => {
    const file = path.join(workspace, DEFAULT_LEARNING_PATH);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const e = {
      schema_version: 2,
      ts: "2026-01-01T00:00:00Z",
      agent: "qa",
      finding: "no test",
      decision: "reject",
    };
    await fs.writeFile(file, "\n\n" + JSON.stringify(e) + "\n\n");
    const entries = await readLearnings(workspace);
    expect(entries).toHaveLength(1);
  });
});

describe("readLearnings — invalid input (quarantine)", () => {
  it("quarantines invalid JSON line and continues with valid entries", async () => {
    const file = path.join(workspace, DEFAULT_LEARNING_PATH);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const good = {
      schema_version: 2,
      ts: "2026-01-01T00:00:00Z",
      agent: "dba",
      finding: "survives quarantine",
      decision: "accept",
    };
    await fs.writeFile(file, "{not json\n" + JSON.stringify(good) + "\n");
    const entries = await readLearnings(workspace);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.finding).toBe("survives quarantine");
    // A quarantine file is created alongside the source.
    const siblings = await fs.readdir(path.dirname(file));
    expect(siblings.some((n) => n.startsWith("learnings.jsonl.corrupt-"))).toBe(true);
  });

  it("quarantines schema violations (unknown agent) and keeps reading", async () => {
    const file = path.join(workspace, DEFAULT_LEARNING_PATH);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const bad = {
      schema_version: 2,
      ts: "2026-01-01T00:00:00Z",
      agent: "not-a-real-agent",
      finding: "x",
      decision: "reject",
    };
    const good = {
      schema_version: 2,
      ts: "2026-01-01T00:00:01Z",
      agent: "qa",
      finding: "after bad",
      decision: "accept",
    };
    await fs.writeFile(file, JSON.stringify(bad) + "\n" + JSON.stringify(good) + "\n");
    const entries = await readLearnings(workspace);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.agent).toBe("qa");
  });

  it("quarantines entries missing required fields (no decision)", async () => {
    const file = path.join(workspace, DEFAULT_LEARNING_PATH);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const bad = {
      ts: "2026-01-01T00:00:00Z",
      agent: "dba",
      finding: "x",
    };
    await fs.writeFile(file, JSON.stringify(bad) + "\n");
    const entries = await readLearnings(workspace);
    expect(entries).toEqual([]);
    // isSquadError import kept for symmetry with original test file shape
    expect(isSquadError(null)).toBe(false);
  });
});

describe("readLearnings — caching", () => {
  it("returns cached entries on repeated reads with unchanged mtime", async () => {
    const file = path.join(workspace, DEFAULT_LEARNING_PATH);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const e = {
      schema_version: 2,
      ts: "2026-01-01T00:00:00Z",
      agent: "developer",
      finding: "x",
      decision: "accept",
    };
    await fs.writeFile(file, JSON.stringify(e) + "\n");
    const a = await readLearnings(workspace);
    const b = await readLearnings(workspace);
    expect(a).toBe(b);
  });

  it("invalidates cache when mtime changes", async () => {
    const file = path.join(workspace, DEFAULT_LEARNING_PATH);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const e1 = {
      schema_version: 2,
      ts: "2026-01-01T00:00:00Z",
      agent: "developer",
      finding: "first",
      decision: "accept",
    };
    await fs.writeFile(file, JSON.stringify(e1) + "\n");
    const a = await readLearnings(workspace);
    expect(a).toHaveLength(1);

    const e2 = {
      schema_version: 2,
      ts: "2026-01-02T00:00:00Z",
      agent: "developer",
      finding: "second",
      decision: "reject",
    };
    await fs.writeFile(file, JSON.stringify(e1) + "\n" + JSON.stringify(e2) + "\n");
    const future = new Date(Date.now() + 10_000);
    await fs.utimes(file, future, future);

    const b = await readLearnings(workspace);
    expect(b).toHaveLength(2);
    expect(b).not.toBe(a);
  });
});

describe("appendLearning — concurrency & sizing", () => {
  it("serialises concurrent appends and preserves every entry (no torn lines)", async () => {
    const writers = Array.from({ length: 30 }, (_, i) =>
      appendLearning(workspace, {
        agent: "dba",
        finding: `parallel-${i}`,
        decision: "accept",
      }),
    );
    await Promise.all(writers);
    const entries = await readLearnings(workspace);
    expect(entries).toHaveLength(30);
    const findings = new Set(entries.map((e) => e.finding));
    expect(findings.size).toBe(30);
  });

  it("truncates oversized entries to keep the JSONL line under the PIPE_BUF cap (~4KiB)", async () => {
    // Within the schema cap (4096) but above MAX_ENTRY_BYTES (4000); the
    // append-time truncator must shrink it further to keep the line atomic.
    const big = "x".repeat(4_096);
    const result = await appendLearning(workspace, {
      agent: "dba",
      finding: "header",
      decision: "accept",
      reason: big,
    });
    expect(result.entry.reason).toMatch(/\[truncated\]$/);
    const raw = await fs.readFile(path.join(workspace, DEFAULT_LEARNING_PATH), "utf8");
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(4_000);
    // The line still parses.
    const entries = await readLearnings(workspace);
    expect(entries).toHaveLength(1);
  });
});

describe("appendLearning", () => {
  it("creates the directory and file on first append", async () => {
    const result = await appendLearning(workspace, {
      agent: "dba",
      finding: "missing index",
      decision: "accept",
    });
    expect(result.filePath).toContain(path.join(".squad", "learnings.jsonl"));
    expect(result.entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const raw = await fs.readFile(result.filePath, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.agent).toBe("dba");
    expect(parsed.decision).toBe("accept");
  });

  it("appends to existing entries without rewriting", async () => {
    await appendLearning(workspace, {
      agent: "dba",
      finding: "first",
      decision: "accept",
    });
    await appendLearning(workspace, {
      agent: "architect",
      finding: "second",
      decision: "reject",
      reason: "out of scope",
    });
    const entries = await readLearnings(workspace);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.finding).toBe("first");
    expect(entries[1]!.finding).toBe("second");
    expect(entries[1]!.reason).toBe("out of scope");
  });

  it("invalidates the read cache after append", async () => {
    await appendLearning(workspace, {
      agent: "dba",
      finding: "a",
      decision: "accept",
    });
    const first = await readLearnings(workspace);
    expect(first).toHaveLength(1);

    await appendLearning(workspace, {
      agent: "dba",
      finding: "b",
      decision: "accept",
    });
    const second = await readLearnings(workspace);
    expect(second).toHaveLength(2);
  });

  it("uses a configured path when provided", async () => {
    const rel = "logs/decisions.jsonl";
    const result = await appendLearning(
      workspace,
      {
        agent: "qa",
        finding: "no test",
        decision: "reject",
      },
      { configuredPath: rel },
    );
    expect(result.filePath).toContain(path.join("logs", "decisions.jsonl"));
    const exists = await fs
      .stat(path.join(workspace, rel))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it("rejects schema violations", async () => {
    let caught: unknown;
    try {
      await appendLearning(workspace, {
        // @ts-expect-error — intentional invalid agent
        agent: "bogus",
        finding: "x",
        decision: "accept",
      });
    } catch (e) {
      caught = e;
    }
    expect(isSquadError(caught)).toBe(true);
    if (isSquadError(caught)) {
      expect(caught.code).toBe("INVALID_INPUT");
    }
  });
});

describe("appendLearning — v0.11.0+ schema fields (cycle-2 QA M3)", () => {
  it("round-trips archived: true through append + read", async () => {
    // The schema additions for archived/promoted live at the STORE level
    // (not just the tool layer), so appending a row WITH those flags should
    // preserve them on read. This pins the round-trip contract and catches
    // a future refactor that narrows the schema (e.g. someone strict-modes
    // the object and silently strips the new fields).
    await appendLearning(workspace, {
      agent: "dba",
      finding: "old-archived",
      decision: "accept",
      archived: true,
    });
    const entries = await readLearnings(workspace);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.archived).toBe(true);
    expect(entries[0]!.promoted).toBeUndefined();
  });

  it("round-trips promoted: true through append + read", async () => {
    await appendLearning(workspace, {
      agent: "dba",
      finding: "policy-finding",
      decision: "accept",
      promoted: true,
    });
    const entries = await readLearnings(workspace);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.promoted).toBe(true);
  });

  it("round-trips BOTH archived and promoted on the same entry", async () => {
    // An entry can legitimately be both promoted (in run N) and then archived
    // (in run N+1 when it ages past max_age_days).
    await appendLearning(workspace, {
      agent: "dba",
      finding: "aged-policy",
      decision: "accept",
      archived: true,
      promoted: true,
    });
    // include_archived path needs to be exercised via the tool layer; here
    // we just confirm the store preserves the bytes.
    const entries = await readLearnings(workspace);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.archived).toBe(true);
    expect(entries[0]!.promoted).toBe(true);
  });
});

describe("appendLearning — NUL-byte rejection on branch + scope (cycle-2 security M2)", () => {
  it("rejects a NUL byte in branch", async () => {
    let caught: unknown;
    try {
      await appendLearning(workspace, {
        agent: "dba",
        finding: "x",
        decision: "accept",
        branch: "feat/" + String.fromCharCode(0) + "evil",
      });
    } catch (e) {
      caught = e;
    }
    expect(isSquadError(caught)).toBe(true);
    if (isSquadError(caught)) {
      expect(caught.code).toBe("INVALID_INPUT");
      expect(caught.message).toContain("NUL byte");
    }
  });

  it("rejects a NUL byte in scope", async () => {
    let caught: unknown;
    try {
      await appendLearning(workspace, {
        agent: "dba",
        finding: "x",
        decision: "accept",
        scope: "src/" + String.fromCharCode(0) + "evil/**",
      });
    } catch (e) {
      caught = e;
    }
    expect(isSquadError(caught)).toBe(true);
    if (isSquadError(caught)) {
      expect(caught.code).toBe("INVALID_INPUT");
      expect(caught.message).toContain("NUL byte");
    }
  });
});

describe("appendLearning — v0.14.x D1 JsonlStore migration", () => {
  it.skipIf(process.platform === "win32")(
    "creates learnings.jsonl with mode 0o600 (user-only)",
    async () => {
      // The migrated path now goes through JsonlStore which enforces 0o600
      // both on create (fs.open mode arg) and defensively via fh.chmod even
      // on pre-existing files. Pin the create-time mode here.
      const r = await appendLearning(workspace, {
        agent: "dba",
        finding: "x",
        decision: "accept",
      });
      const st = await fs.stat(r.filePath);
      expect(st.mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")(
    "enforces 0o600 via fchmod on a pre-existing 0o644 learnings.jsonl (legacy upgrade)",
    async () => {
      // Simulate a file left at 0o644 by an older squad-mcp version. The
      // first append after upgrade must defensively re-stamp 0o600 so the
      // journal stops being world-readable.
      const file = path.join(workspace, DEFAULT_LEARNING_PATH);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const legacyRow = {
        schema_version: 2,
        ts: "2026-05-01T00:00:00Z",
        agent: "dba",
        finding: "legacy",
        decision: "accept",
      };
      await fs.writeFile(file, JSON.stringify(legacyRow) + "\n", { mode: 0o644 });
      let st = await fs.stat(file);
      expect(st.mode & 0o777).toBe(0o644);

      await appendLearning(workspace, {
        agent: "dba",
        finding: "after-upgrade",
        decision: "accept",
      });
      st = await fs.stat(file);
      expect(st.mode & 0o777).toBe(0o600);
    },
  );

  it("agent-rename migration: rows lacking schema_version are skip+logged (not coerced)", async () => {
    // Before the v1 → v2 bump (agent-rename release), rows without a
    // schema_version field were coerced to v1 via Zod default. The new
    // store rejects rows whose schema_version isn't 2 at the pre-Zod gate
    // — including the implicit-undefined case — because such rows almost
    // always carry pre-rename `senior-*` agent names that the v2 schema
    // would otherwise quarantine. Migration to v2 is via
    // `tools/migrate-jsonl-agents.mjs`. This test pins the new contract.
    const file = path.join(workspace, DEFAULT_LEARNING_PATH);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const legacyRow = {
      ts: "2026-04-01T00:00:00Z",
      agent: "dba",
      finding: "no-version-field",
      decision: "accept",
    };
    await fs.writeFile(file, JSON.stringify(legacyRow) + "\n");
    const entries = await readLearnings(workspace);
    // Skip+log, NOT quarantine — the row is filtered out silently.
    expect(entries).toHaveLength(0);
    const siblings = await fs.readdir(path.dirname(file));
    expect(siblings.some((n) => n.startsWith("learnings.jsonl.corrupt-"))).toBe(false);
  });

  it("skips (does not quarantine) rows with future schema_version", async () => {
    // A future writer's rows must be filtered out by the version pre-check,
    // NOT quarantined as corrupt. PR2: the learnings store now accepts BOTH
    // v2 and v3, so the "future/unknown" row is seeded as v4. A v3 row is
    // valid and is covered by the mixed-version round-trip test below.
    const file = path.join(workspace, DEFAULT_LEARNING_PATH);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const future = {
      schema_version: 4,
      ts: "2027-01-01T00:00:00Z",
      agent: "dba",
      finding: "from-the-future",
      decision: "accept",
    };
    const current = {
      schema_version: 2,
      ts: "2026-01-01T00:00:00Z",
      agent: "dba",
      finding: "current",
      decision: "accept",
    };
    await fs.writeFile(file, JSON.stringify(future) + "\n" + JSON.stringify(current) + "\n");
    const entries = await readLearnings(workspace);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.finding).toBe("current");
    const siblings = await fs.readdir(path.dirname(file));
    expect(siblings.some((n) => n.startsWith("learnings.jsonl.corrupt-"))).toBe(false);
  });

  it("reads a mixed v2 + v3 journal — both kept, neither quarantined (PR2)", async () => {
    const file = path.join(workspace, DEFAULT_LEARNING_PATH);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const v2row = {
      schema_version: 2,
      ts: "2026-01-01T00:00:00Z",
      agent: "dba",
      finding: "legacy v2 finding",
      decision: "accept",
    };
    const v3row = {
      schema_version: 3,
      ts: "2026-02-01T00:00:00Z",
      agent: "tech-lead-consolidator",
      lesson: "Validate CSRF tokens at the gateway, not per-route",
      trigger: "src/auth/**",
      evidence: "run:abc123",
      decision: "accept",
    };
    await fs.writeFile(file, JSON.stringify(v2row) + "\n" + JSON.stringify(v3row) + "\n");
    const entries = await readLearnings(workspace);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.finding).toBe("legacy v2 finding");
    expect(entries[0]!.schema_version).toBe(2);
    expect(entries[1]!.lesson).toBe("Validate CSRF tokens at the gateway, not per-route");
    expect(entries[1]!.trigger).toBe("src/auth/**");
    expect(entries[1]!.evidence).toBe("run:abc123");
    expect(entries[1]!.schema_version).toBe(3);
    const siblings = await fs.readdir(path.dirname(file));
    expect(siblings.some((n) => n.startsWith("learnings.jsonl.corrupt-"))).toBe(false);
  });

  it("reads a v2-only file unaffected by the v3 bump (PR2)", async () => {
    const file = path.join(workspace, DEFAULT_LEARNING_PATH);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const v2row = {
      schema_version: 2,
      ts: "2026-01-01T00:00:00Z",
      agent: "dba",
      finding: "v2 only",
      decision: "reject",
      scope: "src/db/**",
    };
    await fs.writeFile(file, JSON.stringify(v2row) + "\n");
    const entries = await readLearnings(workspace);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.finding).toBe("v2 only");
    expect(entries[0]!.scope).toBe("src/db/**");
  });

  it("appends a lesson-only v3 row (no finding) and round-trips it (PR2)", async () => {
    const r = await appendLearning(workspace, {
      agent: "tech-lead-consolidator",
      lesson: "Prefer composition over inheritance for advisory personas",
      decision: "accept",
      evidence: "run:xyz789",
    });
    expect(r.entry.lesson).toBe("Prefer composition over inheritance for advisory personas");
    expect(r.entry.finding).toBeUndefined();
    const entries = await readLearnings(workspace);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.lesson).toBe("Prefer composition over inheritance for advisory personas");
  });

  it("rejects a row with neither finding nor lesson (PR2 object refine)", async () => {
    let caught: unknown;
    try {
      await appendLearning(workspace, {
        // @ts-expect-error — intentional: neither finding nor lesson
        agent: "dba",
        decision: "accept",
      });
    } catch (e) {
      caught = e;
    }
    expect(isSquadError(caught)).toBe(true);
    if (isSquadError(caught)) {
      expect(caught.code).toBe("INVALID_INPUT");
    }
  });

  it("soft-truncates an oversized lesson so the line stays under the cap (PR2)", async () => {
    // A lesson within the 512-char schema cap is too short to overflow the
    // 4000-byte line cap on its own; pair it with a large reason so the loop
    // must shrink reason first, then still keep lesson intact. To exercise
    // the lesson branch specifically, use a lesson at max length and a
    // finding/reason combination that forces the line over the cap.
    const bigReason = "r".repeat(3_900);
    const maxLesson = "L".repeat(512);
    const result = await appendLearning(workspace, {
      agent: "tech-lead-consolidator",
      lesson: maxLesson,
      finding: "header",
      decision: "accept",
      reason: bigReason,
    });
    const raw = await fs.readFile(path.join(workspace, DEFAULT_LEARNING_PATH), "utf8");
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(4_000);
    // The row still parses and survives the round-trip.
    const entries = await readLearnings(workspace);
    expect(entries).toHaveLength(1);
    // reason was truncated; lesson kept (reason shrinks first in the loop).
    expect(result.entry.reason).toMatch(/\[truncated\]$/);
  });

  it("__resetLearningStoreCacheForTests still resets cache (legacy export name preserved)", async () => {
    // The migration MUST preserve this exact export name — tests at
    // prune-learnings.test.ts and read-learnings-tool.test.ts import it
    // by string. This test asserts the function actually clears the cache
    // (not just that it exists and is callable).
    await appendLearning(workspace, {
      agent: "dba",
      finding: "a",
      decision: "accept",
    });
    const a = await readLearnings(workspace);
    __resetLearningStoreCacheForTests();
    const b = await readLearnings(workspace);
    // After reset, the next read re-stats and produces a new array reference.
    expect(b).not.toBe(a);
    expect(b).toEqual(a);
  });

  it("appendLearning return shape preserved: { entry, filePath }", async () => {
    // Pin the public-API return shape so a future refactor inside the
    // JsonlStore wrapper can't break documented callers. PR2: the stamped
    // schema_version is the imported LEARNINGS_SCHEMA_VERSION (3), not a
    // hard literal — a future bump moves the constant and the assertion
    // tracks it.
    const r = await appendLearning(workspace, {
      agent: "dba",
      finding: "shape-check",
      decision: "accept",
    });
    expect(r.filePath).toMatch(/learnings\.jsonl$/);
    expect(r.entry.finding).toBe("shape-check");
    expect(r.entry.schema_version).toBe(LEARNINGS_SCHEMA_VERSION);
    expect(r.entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("tailRecent", () => {
  const entries: LearningEntry[] = [
    {
      ts: "2026-01-01T00:00:00Z",
      agent: "dba",
      finding: "a",
      decision: "accept",
    },
    {
      ts: "2026-01-02T00:00:00Z",
      agent: "architect",
      finding: "b",
      decision: "reject",
    },
    {
      ts: "2026-01-03T00:00:00Z",
      agent: "dba",
      finding: "c",
      decision: "reject",
    },
    {
      ts: "2026-01-04T00:00:00Z",
      agent: "developer",
      finding: "d",
      decision: "accept",
    },
  ];

  it("returns the tail without filter", () => {
    expect(tailRecent(entries, 2)).toEqual(entries.slice(-2));
  });

  it("filters by agent BEFORE slicing", () => {
    const r = tailRecent(entries, 50, { agent: "dba" });
    expect(r).toHaveLength(2);
    expect(r.map((e) => e.finding)).toEqual(["a", "c"]);
  });

  it("filters by decision", () => {
    const r = tailRecent(entries, 50, { decision: "reject" });
    expect(r).toHaveLength(2);
    expect(r.map((e) => e.finding)).toEqual(["b", "c"]);
  });

  it("combines agent + decision", () => {
    const r = tailRecent(entries, 50, {
      agent: "dba",
      decision: "reject",
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.finding).toBe("c");
  });

  it("respects the limit AFTER filtering", () => {
    const r = tailRecent(entries, 1, { decision: "accept" });
    expect(r).toHaveLength(1);
    expect(r[0]!.finding).toBe("d");
  });
});
