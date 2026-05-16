import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readPending,
  drainPending,
  pendingEntrySchema,
  DEFAULT_PENDING_PATH,
  __resetCacheForTests,
  type PendingEntry,
} from "../src/journal/pending.js";

let workspace: string;

/** A NUL byte, written via escape so the source file carries no raw NUL. */
const NUL = String.fromCharCode(0);

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "squad-journal-test-"));
  __resetCacheForTests();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  __resetCacheForTests();
});

/** Resolve the pending file path inside the temp workspace. */
function pendingFile(): string {
  return path.join(workspace, DEFAULT_PENDING_PATH);
}

/** Append raw JSONL text (creating `.squad/`) to the pending file. */
async function writePending(body: string): Promise<void> {
  await fs.mkdir(path.join(workspace, ".squad"), { recursive: true });
  await fs.appendFile(pendingFile(), body, "utf8");
}

function crumb(overrides: Partial<PendingEntry> = {}): PendingEntry {
  return {
    ts: "2026-05-15T10:00:00.000Z",
    tool: "Edit",
    path: "src/foo.ts",
    ...overrides,
  };
}

describe("readPending", () => {
  it("returns [] when the pending file is absent", async () => {
    const entries = await readPending(workspace);
    expect(entries).toEqual([]);
  });

  it("round-trips appended breadcrumbs", async () => {
    await writePending(
      JSON.stringify(crumb({ path: "src/a.ts" })) +
        "\n" +
        JSON.stringify(crumb({ path: null, tool: "Write" })) +
        "\n",
    );
    const entries = await readPending(workspace);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ tool: "Edit", path: "src/a.ts" });
    expect(entries[1]).toMatchObject({ tool: "Write", path: null });
  });

  it("skips a malformed line and quarantines it, surrounding valid lines survive", async () => {
    await writePending(
      JSON.stringify(crumb({ path: "src/before.ts" })) +
        "\n" +
        "{ this is not valid json\n" +
        JSON.stringify(crumb({ path: "src/after.ts" })) +
        "\n",
    );
    const entries = await readPending(workspace);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.path)).toEqual(["src/before.ts", "src/after.ts"]);

    // The corrupt line is quarantined to a sibling file.
    const squadDir = path.join(workspace, ".squad");
    const files = await fs.readdir(squadDir);
    const quarantine = files.find((f) => f.includes(".corrupt-"));
    expect(quarantine).toBeDefined();
  });

  it("rejects a row carrying a NUL byte (quarantined, not returned)", async () => {
    await writePending(
      JSON.stringify(crumb({ path: "src/clean.ts" })) +
        "\n" +
        JSON.stringify({
          ts: "2026-05-15T10:00:00.000Z",
          tool: "Edit",
          path: `src/ba${NUL}d.ts`,
        }) +
        "\n",
    );
    const entries = await readPending(workspace);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("src/clean.ts");
  });

  it("__resetCacheForTests forces a re-read after the file changes", async () => {
    await writePending(JSON.stringify(crumb({ path: "src/one.ts" })) + "\n");
    expect(await readPending(workspace)).toHaveLength(1);

    await writePending(JSON.stringify(crumb({ path: "src/two.ts" })) + "\n");
    __resetCacheForTests();
    expect(await readPending(workspace)).toHaveLength(2);
  });
});

describe("drainPending", () => {
  it("returns [] when there is nothing to drain", async () => {
    expect(await drainPending(workspace)).toEqual([]);
  });

  it("renames, reads, unlinks — leaves no pending file behind", async () => {
    await writePending(
      JSON.stringify(crumb({ path: "src/x.ts" })) +
        "\n" +
        JSON.stringify(crumb({ path: "src/y.ts" })) +
        "\n",
    );
    const drained = await drainPending(workspace);
    expect(drained.map((e) => e.path)).toEqual(["src/x.ts", "src/y.ts"]);

    // The pending file is gone.
    await expect(fs.stat(pendingFile())).rejects.toThrow();
    // No .draining-* sidecar leaks.
    const squadDir = path.join(workspace, ".squad");
    const files = await fs.readdir(squadDir);
    expect(files.some((f) => f.includes(".draining-"))).toBe(false);
  });

  it("a second drain after a successful drain returns []", async () => {
    await writePending(JSON.stringify(crumb()) + "\n");
    expect(await drainPending(workspace)).toHaveLength(1);
    expect(await drainPending(workspace)).toEqual([]);
  });

  it("a line appended AFTER the drain's rename survives into the next drain", async () => {
    // First batch.
    await writePending(JSON.stringify(crumb({ path: "src/batch1.ts" })) + "\n");
    const first = await drainPending(workspace);
    expect(first.map((e) => e.path)).toEqual(["src/batch1.ts"]);

    // The rename consumed the old inode; a hook appending now lands in a
    // fresh file via fs.open(..., "a"). Simulate that append.
    await writePending(JSON.stringify(crumb({ path: "src/batch2.ts" })) + "\n");

    const second = await drainPending(workspace);
    expect(second.map((e) => e.path)).toEqual(["src/batch2.ts"]);
  });
});

describe("pendingEntrySchema", () => {
  it("accepts a well-formed breadcrumb with a string path", () => {
    expect(pendingEntrySchema.safeParse(crumb()).success).toBe(true);
  });

  it("accepts a breadcrumb with a null path", () => {
    expect(pendingEntrySchema.safeParse(crumb({ path: null })).success).toBe(true);
  });

  it("rejects a NUL byte in tool or path", () => {
    expect(pendingEntrySchema.safeParse(crumb({ tool: `Ed${NUL}it` })).success).toBe(false);
    expect(pendingEntrySchema.safeParse(crumb({ path: `src/${NUL}.ts` })).success).toBe(false);
  });

  it("rejects an over-long path (> 4096)", () => {
    expect(pendingEntrySchema.safeParse(crumb({ path: "x".repeat(4097) })).success).toBe(false);
  });
});
