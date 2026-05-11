import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { atomicRewriteJsonl } from "../src/util/atomic-rewrite-jsonl.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "squad-atomic-test-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("atomicRewriteJsonl — basic round-trip", () => {
  it("writes a new file when none exists", async () => {
    const file = path.join(workspace, ".squad", "out.jsonl");
    await atomicRewriteJsonl(file, [{ a: 1 }, { b: 2 }], { lock: false });
    const raw = await fs.readFile(file, "utf8");
    expect(raw).toBe('{"a":1}\n{"b":2}\n');
  });

  it("creates the parent directory recursively", async () => {
    const file = path.join(workspace, "nested", "deep", "out.jsonl");
    await atomicRewriteJsonl(file, [{ x: 1 }], { lock: false });
    const stat = await fs.stat(file);
    expect(stat.isFile()).toBe(true);
  });

  it("writes a trailing newline only when there are rows", async () => {
    const file = path.join(workspace, "empty.jsonl");
    await atomicRewriteJsonl(file, [], { lock: false });
    const raw = await fs.readFile(file, "utf8");
    expect(raw).toBe("");
  });

  it("overwrites an existing file", async () => {
    const file = path.join(workspace, "out.jsonl");
    await fs.writeFile(file, '{"old":true}\n');
    await atomicRewriteJsonl(file, [{ new: true }], { lock: false });
    const raw = await fs.readFile(file, "utf8");
    expect(raw).toBe('{"new":true}\n');
  });
});

describe("atomicRewriteJsonl — .prev snapshot semantics", () => {
  it("moves the previous file to <file>.prev as a rollback point", async () => {
    const file = path.join(workspace, "out.jsonl");
    await fs.writeFile(file, '{"old":true}\n');
    await atomicRewriteJsonl(file, [{ new: true }], { lock: false });

    const prev = await fs.readFile(`${file}.prev`, "utf8");
    expect(prev).toBe('{"old":true}\n');
    const current = await fs.readFile(file, "utf8");
    expect(current).toBe('{"new":true}\n');
  });

  it("does NOT create a .prev on the first-ever write (no source to snapshot)", async () => {
    const file = path.join(workspace, "out.jsonl");
    await atomicRewriteJsonl(file, [{ x: 1 }], { lock: false });

    const prevExists = await fs
      .stat(`${file}.prev`)
      .then(() => true)
      .catch(() => false);
    expect(prevExists).toBe(false);
  });

  it("overwrites a stale .prev on subsequent rewrites", async () => {
    const file = path.join(workspace, "out.jsonl");
    await fs.writeFile(file, '{"v":1}\n');
    await atomicRewriteJsonl(file, [{ v: 2 }], { lock: false });
    await atomicRewriteJsonl(file, [{ v: 3 }], { lock: false });

    // After two rewrites, .prev holds v=2 (the file state BEFORE the v=3 rewrite),
    // not v=1 — older snapshots are not retained.
    const prev = await fs.readFile(`${file}.prev`, "utf8");
    expect(prev).toBe('{"v":2}\n');
  });
});

describe("atomicRewriteJsonl — no stale tmp", () => {
  it("does not leave a .tmp behind on success", async () => {
    const file = path.join(workspace, "out.jsonl");
    await atomicRewriteJsonl(file, [{ ok: true }], { lock: false });

    const tmpExists = await fs
      .stat(`${file}.tmp`)
      .then(() => true)
      .catch(() => false);
    expect(tmpExists).toBe(false);
  });
});

describe("atomicRewriteJsonl — locking", () => {
  it("serialises concurrent rewrites when lock is enabled (default)", async () => {
    const file = path.join(workspace, "concurrent.jsonl");
    // Seed the file so .prev moves happen.
    await fs.writeFile(file, '{"seed":true}\n');

    // Fire 5 concurrent rewrites with distinct payloads. Without the lock,
    // the rename sequence could interleave and corrupt the result; with the
    // lock, every rewrite runs to completion before the next starts.
    const writers = Array.from({ length: 5 }, (_, i) => atomicRewriteJsonl(file, [{ run: i }]));
    await Promise.all(writers);

    // Whatever order they ran in, the FINAL file must be one of the 5 valid
    // single-row payloads — never a partial or torn write.
    const raw = await fs.readFile(file, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.run).toBeGreaterThanOrEqual(0);
    expect(parsed.run).toBeLessThanOrEqual(4);
  });
});

describe("atomicRewriteJsonl — rollback on step-4 failure (cycle-2 Blocker B2)", () => {
  it("rolls .prev back to source when the tmp→source rename fails", async () => {
    const file = path.join(workspace, "rollback.jsonl");
    await fs.writeFile(file, '{"v":1}\n');

    // Mock fs.rename to fail ONLY on the second call (tmp → source). The
    // first call (source → .prev) succeeds, so we end up with .prev holding
    // the old content and tmp holding the new content — then the second
    // rename throws. The atomic-rewrite primitive should detect that,
    // attempt to put .prev back to source, and surface ATOMIC_REWRITE_FAILED.
    const realRename = fs.rename.bind(fs);
    let renameCalls = 0;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      renameCalls++;
      // Second call is tmp → file. Throw a synthetic EXDEV-like failure.
      if (renameCalls === 2) {
        const err = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException;
        err.code = "EXDEV";
        throw err;
      }
      return realRename(from, to);
    });

    try {
      await expect(atomicRewriteJsonl(file, [{ v: 2 }], { lock: false })).rejects.toMatchObject({
        code: "ATOMIC_REWRITE_FAILED",
        message: expect.stringContaining("Rollback applied"),
      });
    } finally {
      spy.mockRestore();
    }

    // After rollback, the original file is back in place. No data lost.
    const restored = await fs.readFile(file, "utf8");
    expect(restored).toBe('{"v":1}\n');

    // .prev should be gone (we renamed it back). tmp should be cleaned up.
    const prevExists = await fs
      .stat(`${file}.prev`)
      .then(() => true)
      .catch(() => false);
    const tmpExists = await fs
      .stat(`${file}.tmp`)
      .then(() => true)
      .catch(() => false);
    expect(prevExists).toBe(false);
    expect(tmpExists).toBe(false);
  });

  it("surfaces manual-recovery instructions when rollback ALSO fails", async () => {
    const file = path.join(workspace, "double-fail.jsonl");
    await fs.writeFile(file, '{"v":1}\n');

    // Mock fs.rename: succeed on first call (source → .prev), fail on
    // second (tmp → source), fail on third (.prev → source rollback).
    const realRename = fs.rename.bind(fs);
    let renameCalls = 0;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      renameCalls++;
      if (renameCalls === 2) {
        const err = new Error("EXDEV") as NodeJS.ErrnoException;
        err.code = "EXDEV";
        throw err;
      }
      if (renameCalls === 3) {
        const err = new Error("EACCES") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return realRename(from, to);
    });

    try {
      await expect(atomicRewriteJsonl(file, [{ v: 2 }], { lock: false })).rejects.toMatchObject({
        code: "ATOMIC_REWRITE_FAILED",
        // Manual recovery command must be embedded in the message.
        message: expect.stringMatching(/mv .*\.prev/),
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("atomicRewriteJsonl — round-trip with shaped data", () => {
  it("preserves field order and value types in a complex object", async () => {
    const file = path.join(workspace, "shaped.jsonl");
    const row = {
      ts: "2026-01-01T00:00:00Z",
      agent: "senior-dba",
      finding: "missing index",
      decision: "accept",
      archived: false,
      promoted: true,
    };
    await atomicRewriteJsonl(file, [row], { lock: false });
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw.trim());
    expect(parsed).toEqual(row);
  });

  it("preserves multiple rows in input order", async () => {
    const file = path.join(workspace, "multi.jsonl");
    const rows = [
      { ts: "2026-01-01T00:00:00Z", n: 1 },
      { ts: "2026-01-02T00:00:00Z", n: 2 },
      { ts: "2026-01-03T00:00:00Z", n: 3 },
    ];
    await atomicRewriteJsonl(file, rows, { lock: false });
    const raw = await fs.readFile(file, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l).n)).toEqual([1, 2, 3]);
  });
});
