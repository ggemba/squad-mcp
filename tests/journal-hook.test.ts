import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { processEvent, serializeBreadcrumb } from "../hooks/journal-event.mjs";
import { pendingEntrySchema } from "../src/journal/pending.js";

/** Repo root, derived from this test file's location. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_PATH = path.join(REPO_ROOT, "hooks", "post-tool-use.mjs");

/** A NUL byte, built at runtime so the source file carries no raw NUL. */
const NUL = String.fromCharCode(0);

describe("processEvent (pure fn)", () => {
  it("happy path — produces a breadcrumb with ts, tool, path", () => {
    const crumb = processEvent({
      tool_name: "Edit",
      tool_input: { file_path: "src/foo.ts" },
    });
    expect(crumb).not.toBeNull();
    expect(crumb!.tool).toBe("Edit");
    expect(crumb!.path).toBe("src/foo.ts");
    expect(typeof crumb!.ts).toBe("string");
    expect(crumb!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("falls back to tool_input.path when file_path is absent", () => {
    const crumb = processEvent({
      tool_name: "Write",
      tool_input: { path: "src/bar.ts" },
    });
    expect(crumb!.path).toBe("src/bar.ts");
  });

  it("missing tool_name → null (event skipped)", () => {
    expect(processEvent({ tool_input: { file_path: "src/foo.ts" } })).toBeNull();
  });

  it("non-string tool_name → null", () => {
    expect(processEvent({ tool_name: 42, tool_input: {} })).toBeNull();
  });

  it("missing file_path and path → breadcrumb with path:null, does not throw", () => {
    const crumb = processEvent({ tool_name: "Edit", tool_input: {} });
    expect(crumb).not.toBeNull();
    expect(crumb!.path).toBeNull();
  });

  it("absent tool_input entirely → breadcrumb with path:null", () => {
    const crumb = processEvent({ tool_name: "Edit" });
    expect(crumb).not.toBeNull();
    expect(crumb!.path).toBeNull();
  });

  it("path with a NUL byte → path:null (event still recorded)", () => {
    const crumb = processEvent({
      tool_name: "Edit",
      tool_input: { file_path: `src/ba${NUL}d.ts` },
    });
    expect(crumb).not.toBeNull();
    expect(crumb!.path).toBeNull();
    expect(crumb!.tool).toBe("Edit");
  });

  it("over-long path → path:null (event still recorded)", () => {
    const crumb = processEvent({
      tool_name: "Edit",
      tool_input: { file_path: "x".repeat(5000) },
    });
    expect(crumb).not.toBeNull();
    expect(crumb!.path).toBeNull();
  });

  it("traversal path escaping cwd → path:null", () => {
    const crumb = processEvent({
      tool_name: "Edit",
      tool_input: { file_path: "../../etc/passwd" },
    });
    expect(crumb).not.toBeNull();
    expect(crumb!.path).toBeNull();
  });

  it("path inside .squad/ → null (self-trigger guard skips the whole event)", () => {
    expect(
      processEvent({
        tool_name: "Edit",
        tool_input: { file_path: ".squad/pending-journal.jsonl" },
      }),
    ).toBeNull();
  });

  it("non-object payload → null", () => {
    expect(processEvent(null)).toBeNull();
    expect(processEvent("not an object")).toBeNull();
    expect(processEvent(42)).toBeNull();
  });

  it("serializeBreadcrumb emits one newline-terminated JSON line", () => {
    const line = serializeBreadcrumb({ ts: "2026-05-15T10:00:00.000Z", tool: "Edit", path: "a" });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line.trim())).toEqual({
      ts: "2026-05-15T10:00:00.000Z",
      tool: "Edit",
      path: "a",
    });
  });
});

describe("post-tool-use.mjs (real subprocess)", () => {
  let tempCwd: string;

  beforeEach(async () => {
    tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "squad-hook-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempCwd, { recursive: true, force: true });
  });

  /** Run the real hook with `payload` on stdin, in `tempCwd`. */
  function runHook(payload: string) {
    return spawnSync("node", [HOOK_PATH], {
      cwd: tempCwd,
      input: payload,
      encoding: "utf8",
    });
  }

  it("a real Edit payload exits 0 and writes a line that parses through pendingEntrySchema", async () => {
    const result = runHook(
      JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "src/real.ts" } }),
    );
    expect(result.status).toBe(0);

    const pendingPath = path.join(tempCwd, ".squad", "pending-journal.jsonl");
    const raw = await fs.readFile(pendingPath, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(1);

    const parsed = pendingEntrySchema.safeParse(JSON.parse(lines[0]));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tool).toBe("Edit");
      expect(parsed.data.path).toBe("src/real.ts");
    }
  });

  it("empty stdin exits 0 and writes no pending file", async () => {
    const result = runHook("");
    expect(result.status).toBe(0);
    await expect(fs.stat(path.join(tempCwd, ".squad", "pending-journal.jsonl"))).rejects.toThrow();
  });

  it("malformed JSON exits 0 and writes no pending file", async () => {
    const result = runHook("{ not json");
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("squad-journal:");
    await expect(fs.stat(path.join(tempCwd, ".squad", "pending-journal.jsonl"))).rejects.toThrow();
  });

  it("a self-trigger payload (.squad/ path) exits 0 and writes nothing", async () => {
    const result = runHook(
      JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: ".squad/learnings.jsonl" },
      }),
    );
    expect(result.status).toBe(0);
    await expect(fs.stat(path.join(tempCwd, ".squad", "pending-journal.jsonl"))).rejects.toThrow();
  });

  it("creates .squad/ when it does not exist, then appends", async () => {
    // tempCwd has no .squad/ yet.
    const result = runHook(
      JSON.stringify({ tool_name: "Write", tool_input: { path: "src/new.ts" } }),
    );
    expect(result.status).toBe(0);
    const raw = await fs.readFile(path.join(tempCwd, ".squad", "pending-journal.jsonl"), "utf8");
    expect(raw.split(/\r?\n/).filter((l) => l.trim() !== "")).toHaveLength(1);
  });

  it("skips the append when the pending file is over the size cap", async () => {
    const squadDir = path.join(tempCwd, ".squad");
    await fs.mkdir(squadDir, { recursive: true });
    const pendingPath = path.join(squadDir, "pending-journal.jsonl");
    // Write a file larger than the 512 KB cap.
    await fs.writeFile(pendingPath, "x".repeat(512 * 1024 + 1), "utf8");
    const sizeBefore = (await fs.stat(pendingPath)).size;

    const result = runHook(
      JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "src/foo.ts" } }),
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("squad-journal:");
    // No append happened.
    expect((await fs.stat(pendingPath)).size).toBe(sizeBefore);
  });
});
