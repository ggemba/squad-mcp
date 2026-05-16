import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import fc from "fast-check";
import { JsonlStore } from "../src/util/jsonl-store.js";
import { isSquadError } from "../src/errors.js";

/**
 * Tests for the generic JsonlStore<T>. Uses a tiny in-test schema rather
 * than depending on the consumer schemas (learning, runs) so the contract
 * is exercised in isolation. The consumer-specific behaviour (truncation
 * for learning, control-char strip for runs) is tested in those stores'
 * own test files.
 */

const entrySchema = z.object({
  schema_version: z.literal(2).default(2),
  key: z.string().min(1).max(200),
  // `max(4000)` lets us craft a string-length-valid Zod input whose UTF-8
  // byte serialisation still trips the 4000-byte JsonlStore cap (a 4-byte
  // codepoint at length 2 contributes 4 bytes per "character").
  value: z.string().max(4000).optional(),
});
type Entry = z.infer<typeof entrySchema>;

function makeStore(): JsonlStore<2, Entry> {
  return new JsonlStore<2, Entry>({
    defaultPath: ".jsonl-test/data.jsonl",
    schema: entrySchema,
    writeVersion: 2,
    settingName: "test.path",
    label: "test",
  });
}

let workspace: string;
let store: JsonlStore<2, Entry>;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "squad-jsonl-store-test-"));
  store = makeStore();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  store.__resetCacheForTests();
});

describe("JsonlStore.read — happy path", () => {
  it("returns [] when no file exists", async () => {
    const out = await store.read(workspace);
    expect(out).toEqual([]);
  });

  it("returns [] when path resolves to a directory", async () => {
    await fs.mkdir(path.join(workspace, ".jsonl-test", "data.jsonl"), { recursive: true });
    const out = await store.read(workspace);
    expect(out).toEqual([]);
  });

  it("reads append-order entries from disk", async () => {
    const file = path.join(workspace, ".jsonl-test", "data.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const a = { schema_version: 2, key: "alpha" };
    const b = { schema_version: 2, key: "beta", value: "v" };
    await fs.writeFile(file, JSON.stringify(a) + "\n" + JSON.stringify(b) + "\n");
    const out = await store.read(workspace);
    expect(out).toHaveLength(2);
    expect(out[0]!.key).toBe("alpha");
    expect(out[1]!.value).toBe("v");
  });

  it("skips blank lines", async () => {
    const file = path.join(workspace, ".jsonl-test", "data.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const e = { schema_version: 2, key: "k" };
    await fs.writeFile(file, "\n\n" + JSON.stringify(e) + "\n\n");
    const out = await store.read(workspace);
    expect(out).toHaveLength(1);
  });
});

describe("JsonlStore.read — corruption + version handling", () => {
  it("quarantines invalid JSON and keeps reading the good rows", async () => {
    const file = path.join(workspace, ".jsonl-test", "data.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const good = { schema_version: 2, key: "survives" };
    await fs.writeFile(file, "{not json\n" + JSON.stringify(good) + "\n");
    const out = await store.read(workspace);
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe("survives");
    const siblings = await fs.readdir(path.dirname(file));
    expect(siblings.some((n) => n.startsWith("data.jsonl.corrupt-"))).toBe(true);
  });

  it("quarantines Zod-violating rows and keeps reading", async () => {
    const file = path.join(workspace, ".jsonl-test", "data.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Missing required `key` — Zod will reject.
    const bad = { schema_version: 2, value: "no-key" };
    const good = { schema_version: 2, key: "after-bad" };
    await fs.writeFile(file, JSON.stringify(bad) + "\n" + JSON.stringify(good) + "\n");
    const out = await store.read(workspace);
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe("after-bad");
  });

  it("skips (does not quarantine) rows with unknown schema_version", async () => {
    const file = path.join(workspace, ".jsonl-test", "data.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const future = { schema_version: 3, key: "from-the-future" };
    const current = { schema_version: 2, key: "current" };
    await fs.writeFile(file, JSON.stringify(future) + "\n" + JSON.stringify(current) + "\n");
    const out = await store.read(workspace);
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe("current");
    // CRITICAL: no quarantine file is created for version-skipped rows.
    const siblings = await fs.readdir(path.dirname(file));
    expect(siblings.some((n) => n.startsWith("data.jsonl.corrupt-"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "creates the quarantine file with mode 0o600",
    async () => {
      const file = path.join(workspace, ".jsonl-test", "data.jsonl");
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "{not json\n");
      await store.read(workspace);
      const siblings = await fs.readdir(path.dirname(file));
      const quarantine = siblings.find((n) => n.startsWith("data.jsonl.corrupt-"));
      expect(quarantine).toBeDefined();
      const st = await fs.stat(path.join(path.dirname(file), quarantine!));
      expect(st.mode & 0o777).toBe(0o600);
    },
  );
});

describe("JsonlStore.append — write discipline", () => {
  it("creates the file and the parent directory on first append", async () => {
    const result = await store.append(workspace, { schema_version: 2, key: "first" });
    expect(result.filePath).toContain(path.join(".jsonl-test", "data.jsonl"));
    const raw = await fs.readFile(result.filePath, "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(raw.trim());
    expect(parsed.key).toBe("first");
    expect(parsed.schema_version).toBe(2);
  });

  it.skipIf(process.platform === "win32")(
    "creates the new file with mode 0o600 (user-only)",
    async () => {
      await store.append(workspace, { schema_version: 2, key: "x" });
      const file = path.join(workspace, ".jsonl-test", "data.jsonl");
      const st = await fs.stat(file);
      expect(st.mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")(
    "enforces 0o600 via fchmod even on a pre-existing 0o644 file (legacy upgrade)",
    async () => {
      // Simulate an older-version file that landed at 0o644.
      const file = path.join(workspace, ".jsonl-test", "data.jsonl");
      await fs.mkdir(path.dirname(file), { recursive: true });
      const legacyRow = { schema_version: 2, key: "legacy" };
      await fs.writeFile(file, JSON.stringify(legacyRow) + "\n", { mode: 0o644 });
      let st = await fs.stat(file);
      expect(st.mode & 0o777).toBe(0o644);

      // The next append must re-stamp the mode to 0o600.
      await store.append(workspace, { schema_version: 2, key: "fresh" });
      st = await fs.stat(file);
      expect(st.mode & 0o777).toBe(0o600);
    },
  );

  it("rejects oversize entries with RECORD_TOO_LARGE", async () => {
    // Build an entry that exceeds the default 4000-byte cap.
    // 4-byte UTF-8 char (🚀 = length 2, 4 bytes) lets us stuff bytes without
    // tripping the schema's string-length checks. 1100 × 2 = 2200 chars
    // (under max 4000) but × 4 = 4400 UTF-8 bytes — comfortably over 4000.
    const big = "\u{1F680}".repeat(1100);
    let caught: unknown;
    try {
      await store.append(workspace, { schema_version: 2, key: "k", value: big });
    } catch (e) {
      caught = e;
    }
    expect(isSquadError(caught)).toBe(true);
    if (isSquadError(caught)) {
      expect(caught.code).toBe("RECORD_TOO_LARGE");
    }
  });

  it("rejects schema violations with INVALID_INPUT", async () => {
    let caught: unknown;
    try {
      await store.append(workspace, {
        schema_version: 2,
        // @ts-expect-error — intentional invalid: empty key
        key: "",
      });
    } catch (e) {
      caught = e;
    }
    expect(isSquadError(caught)).toBe(true);
    if (isSquadError(caught)) {
      expect(caught.code).toBe("INVALID_INPUT");
    }
  });

  it("serialises 30 concurrent appends without torn lines (every entry survives)", async () => {
    const writers = Array.from({ length: 30 }, (_, i) =>
      store.append(workspace, { schema_version: 2 as const, key: `parallel-${i}` }),
    );
    await Promise.all(writers);
    const out = await store.read(workspace);
    expect(out).toHaveLength(30);
    const keys = new Set(out.map((e) => e.key));
    expect(keys.size).toBe(30);
  });

  it("rejects configuredPath that escapes workspaceRoot via .. (CWE-22)", async () => {
    await expect(store.read(workspace, { configuredPath: "../escape.jsonl" })).rejects.toThrow(
      /PATH_TRAVERSAL_DENIED|escapes workspace_root/,
    );
  });

  it("rejects absolute configuredPath (CWE-22)", async () => {
    await expect(store.read(workspace, { configuredPath: "/etc/passwd" })).rejects.toThrow(
      /PATH_TRAVERSAL_DENIED|must be a workspace-relative/,
    );
  });
});

describe("JsonlStore caching", () => {
  it("reuses cached entries when mtime AND size match (returns same reference)", async () => {
    await store.append(workspace, { schema_version: 2, key: "x" });
    const a = await store.read(workspace);
    const b = await store.read(workspace);
    expect(a).toBe(b);
  });

  it("invalidates cache when size changes (same mtime, new line appended)", async () => {
    const file = path.join(workspace, ".jsonl-test", "data.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const e1 = { schema_version: 2, key: "first" };
    await fs.writeFile(file, JSON.stringify(e1) + "\n");
    const a = await store.read(workspace);
    expect(a).toHaveLength(1);

    // Append a second line WITHOUT bumping mtime: utime stays the same but
    // size grows. This exercises the size half of the cache key — mtime
    // alone would falsely return the cached single-entry result.
    const e2 = { schema_version: 2, key: "second" };
    const originalStat = await fs.stat(file);
    await fs.appendFile(file, JSON.stringify(e2) + "\n");
    // Pin mtime back to what it was — same-ms write simulation.
    await fs.utimes(file, originalStat.atime, originalStat.mtime);

    const b = await store.read(workspace);
    expect(b).toHaveLength(2);
    expect(b).not.toBe(a);
  });

  it("invalidates cache when mtime changes (size could match coincidentally)", async () => {
    const file = path.join(workspace, ".jsonl-test", "data.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const e1 = { schema_version: 2, key: "x" };
    await fs.writeFile(file, JSON.stringify(e1) + "\n");
    const a = await store.read(workspace);
    expect(a).toHaveLength(1);

    // Overwrite with same-length content but bump mtime to the future.
    const e2 = { schema_version: 2, key: "y" };
    await fs.writeFile(file, JSON.stringify(e2) + "\n");
    const future = new Date(Date.now() + 10_000);
    await fs.utimes(file, future, future);

    const b = await store.read(workspace);
    expect(b).toHaveLength(1);
    expect(b[0]!.key).toBe("y");
    expect(b).not.toBe(a);
  });

  it("__resetCacheForTests clears the cache (next read re-stats)", async () => {
    await store.append(workspace, { schema_version: 2, key: "x" });
    const a = await store.read(workspace);
    store.__resetCacheForTests();
    const b = await store.read(workspace);
    // Different cache slots → different array references.
    expect(b).not.toBe(a);
    expect(b).toEqual(a);
  });
});

describe("JsonlStore — isAcceptedVersion predicate (PR2)", () => {
  // A multi-version schema mirroring the learnings store's {2, 3} union.
  const multiSchema = z.object({
    schema_version: z.union([z.literal(2), z.literal(3)]).default(3),
    key: z.string().min(1).max(200),
  });
  type MultiEntry = z.infer<typeof multiSchema>;

  function makeMultiStore(): JsonlStore<2 | 3, MultiEntry> {
    return new JsonlStore<2 | 3, MultiEntry>({
      defaultPath: ".jsonl-test/multi.jsonl",
      schema: multiSchema,
      writeVersion: 3,
      isAcceptedVersion: (v) => v === 2 || v === 3,
      settingName: "test.path",
      label: "multi",
    });
  }

  it("accepts both v2 and v3 rows; skips v1 and v4 (no quarantine)", async () => {
    const s = makeMultiStore();
    const file = path.join(workspace, ".jsonl-test", "multi.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const rows = [
      { schema_version: 1, key: "v1-skipped" },
      { schema_version: 2, key: "v2-kept" },
      { schema_version: 3, key: "v3-kept" },
      { schema_version: 4, key: "v4-skipped" },
    ];
    await fs.writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const out = await s.read(workspace);
    expect(out.map((e) => e.key)).toEqual(["v2-kept", "v3-kept"]);
    // Version-skipped rows are NEVER quarantined.
    const siblings = await fs.readdir(path.dirname(file));
    expect(siblings.some((n) => n.startsWith("multi.jsonl.corrupt-"))).toBe(false);
    s.__resetCacheForTests();
  });

  it("default predicate (no isAcceptedVersion) accepts only the writeVersion literal", async () => {
    // The plain `store` (writeVersion 2, no predicate) must skip v3.
    const file = path.join(workspace, ".jsonl-test", "data.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const rows = [
      { schema_version: 2, key: "kept" },
      { schema_version: 3, key: "skipped" },
    ];
    await fs.writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const out = await store.read(workspace);
    expect(out.map((e) => e.key)).toEqual(["kept"]);
  });
});

describe("JsonlStore — property: append/read roundtrip", () => {
  it("roundtrips arbitrary entries (length-50 runs, fast-check)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            schema_version: fc.constant(2 as const),
            key: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
          }),
          { minLength: 0, maxLength: 8 },
        ),
        async (entries) => {
          // Fresh workspace per property iteration so cache state never leaks
          // across counter-examples.
          const ws = await fs.mkdtemp(path.join(os.tmpdir(), "squad-jsonl-prop-"));
          const s = makeStore();
          try {
            for (const e of entries) {
              await s.append(ws, e);
            }
            const out = await s.read(ws);
            expect(out.map((o) => o.key)).toEqual(entries.map((e) => e.key));
          } finally {
            await fs.rm(ws, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
