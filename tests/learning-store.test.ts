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
      ts: "2026-01-01T00:00:00Z",
      agent: "senior-dev-security",
      finding: "csrf",
      decision: "reject",
    };
    const b = {
      ts: "2026-01-02T00:00:00Z",
      agent: "senior-architect",
      finding: "coupling",
      decision: "accept",
    };
    await fs.writeFile(file, JSON.stringify(a) + "\n" + JSON.stringify(b) + "\n");
    const entries = await readLearnings(workspace);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.agent).toBe("senior-dev-security");
    expect(entries[1]!.agent).toBe("senior-architect");
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
      ts: "2026-01-01T00:00:00Z",
      agent: "senior-dba",
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
      ts: "2026-01-01T00:00:00Z",
      agent: "senior-qa",
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
      ts: "2026-01-01T00:00:00Z",
      agent: "senior-dba",
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
      ts: "2026-01-01T00:00:00Z",
      agent: "not-a-real-agent",
      finding: "x",
      decision: "reject",
    };
    const good = {
      ts: "2026-01-01T00:00:01Z",
      agent: "senior-qa",
      finding: "after bad",
      decision: "accept",
    };
    await fs.writeFile(file, JSON.stringify(bad) + "\n" + JSON.stringify(good) + "\n");
    const entries = await readLearnings(workspace);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.agent).toBe("senior-qa");
  });

  it("quarantines entries missing required fields (no decision)", async () => {
    const file = path.join(workspace, DEFAULT_LEARNING_PATH);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const bad = {
      ts: "2026-01-01T00:00:00Z",
      agent: "senior-dba",
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
      ts: "2026-01-01T00:00:00Z",
      agent: "senior-developer",
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
      ts: "2026-01-01T00:00:00Z",
      agent: "senior-developer",
      finding: "first",
      decision: "accept",
    };
    await fs.writeFile(file, JSON.stringify(e1) + "\n");
    const a = await readLearnings(workspace);
    expect(a).toHaveLength(1);

    const e2 = {
      ts: "2026-01-02T00:00:00Z",
      agent: "senior-developer",
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
        agent: "senior-dba",
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
      agent: "senior-dba",
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
      agent: "senior-dba",
      finding: "missing index",
      decision: "accept",
    });
    expect(result.filePath).toContain(path.join(".squad", "learnings.jsonl"));
    expect(result.entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const raw = await fs.readFile(result.filePath, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.agent).toBe("senior-dba");
    expect(parsed.decision).toBe("accept");
  });

  it("appends to existing entries without rewriting", async () => {
    await appendLearning(workspace, {
      agent: "senior-dba",
      finding: "first",
      decision: "accept",
    });
    await appendLearning(workspace, {
      agent: "senior-architect",
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
      agent: "senior-dba",
      finding: "a",
      decision: "accept",
    });
    const first = await readLearnings(workspace);
    expect(first).toHaveLength(1);

    await appendLearning(workspace, {
      agent: "senior-dba",
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
        agent: "senior-qa",
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

describe("tailRecent", () => {
  const entries: LearningEntry[] = [
    {
      ts: "2026-01-01T00:00:00Z",
      agent: "senior-dba",
      finding: "a",
      decision: "accept",
    },
    {
      ts: "2026-01-02T00:00:00Z",
      agent: "senior-architect",
      finding: "b",
      decision: "reject",
    },
    {
      ts: "2026-01-03T00:00:00Z",
      agent: "senior-dba",
      finding: "c",
      decision: "reject",
    },
    {
      ts: "2026-01-04T00:00:00Z",
      agent: "senior-developer",
      finding: "d",
      decision: "accept",
    },
  ];

  it("returns the tail without filter", () => {
    expect(tailRecent(entries, 2)).toEqual(entries.slice(-2));
  });

  it("filters by agent BEFORE slicing", () => {
    const r = tailRecent(entries, 50, { agent: "senior-dba" });
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
      agent: "senior-dba",
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
