import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { readWithPrevFallback } from "../src/util/safe-read.js";
import { logger } from "../src/observability/logger.js";

/**
 * Coverage for `readWithPrevFallback` — the mid-rewrite ENOENT fallback that
 * lets readers survive the brief window where `atomicRewriteJsonl` has renamed
 * the current file to `.prev` and not yet renamed the new tmp into place.
 *
 * Five cases:
 *   1. primary present → returns content + source: "primary"
 *   2. primary ENOENT + fresh .prev (within window) → returns content + source: "prev"
 *                                                  + emits info "safe_read_fallback"
 *   3. primary ENOENT + stale .prev (outside window) → returns null
 *   4. primary ENOENT + .prev ENOENT → returns null
 *   5. non-ENOENT error on primary (e.g. EISDIR) → rethrows
 *
 * Tmp dirs are per-test (uuid suffix) to keep tests isolated without locks.
 */

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), `squad-safe-read-${randomUUID()}-`));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("readWithPrevFallback — case 1: primary present", () => {
  it("returns the primary content with source: 'primary'", async () => {
    const file = path.join(workspace, "out.jsonl");
    await fs.writeFile(file, '{"hello":"world"}\n');

    const result = await readWithPrevFallback(file);

    expect(result).not.toBeNull();
    expect(result!.content).toBe('{"hello":"world"}\n');
    expect(result!.source).toBe("primary");
  });

  it("does NOT emit a fallback log when the primary read succeeds", async () => {
    const file = path.join(workspace, "out.jsonl");
    await fs.writeFile(file, "primary-ok\n");
    const spy = vi.spyOn(logger, "info");

    await readWithPrevFallback(file);

    const fallbackCalls = spy.mock.calls.filter((c) => c[0] === "safe_read_fallback");
    expect(fallbackCalls).toHaveLength(0);
  });
});

describe("readWithPrevFallback — case 2: primary ENOENT + fresh .prev", () => {
  it("returns the .prev content with source: 'prev' when within the freshness window", async () => {
    const file = path.join(workspace, "out.jsonl");
    const prev = `${file}.prev`;
    await fs.writeFile(prev, "snapshot-mid-rename\n");

    // Freeze time so the .prev mtime (just written) is "now" — well within
    // the 5_000 ms default window.
    vi.useFakeTimers();
    vi.setSystemTime(new Date());

    const result = await readWithPrevFallback(file);

    expect(result).not.toBeNull();
    expect(result!.content).toBe("snapshot-mid-rename\n");
    expect(result!.source).toBe("prev");
  });

  it("emits the 'safe_read_fallback' info log with the mtime delta", async () => {
    const file = path.join(workspace, "out.jsonl");
    const prev = `${file}.prev`;
    await fs.writeFile(prev, "snapshot\n");
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    const spy = vi.spyOn(logger, "info");

    await readWithPrevFallback(file);

    const fallbackCalls = spy.mock.calls.filter((c) => c[0] === "safe_read_fallback");
    expect(fallbackCalls).toHaveLength(1);
    // Second argument is the fields object: { details: { path, mtime_delta_ms } }
    const fields = fallbackCalls[0][1] as { details?: { path?: string; mtime_delta_ms?: number } };
    expect(fields.details?.path).toBe(file);
    expect(typeof fields.details?.mtime_delta_ms).toBe("number");
    // mtime_delta_ms is now() - prevStat.mtimeMs; should be small (well under
    // the freshness window). Cannot assert >= 0: fs.stat returns ns-precision
    // mtimeMs while Date.now() truncates to ms, so the delta can be negative
    // by sub-ms on Linux high-resolution timestamps. Observed ~20% flake rate
    // in isolated runs of this file before this tolerance was applied.
    expect(Math.abs(fields.details!.mtime_delta_ms!)).toBeLessThan(1000);
  });

  it("respects a custom maxPrevAgeMs window", async () => {
    const file = path.join(workspace, "out.jsonl");
    const prev = `${file}.prev`;
    await fs.writeFile(prev, "snapshot-tight-window\n");

    // Set .prev mtime to a known instant in the recent past.
    const prevWriteMs = Date.now();
    await fs.utimes(prev, prevWriteMs / 1000, prevWriteMs / 1000);

    // Advance "now" so the delta is 500 ms past the .prev mtime.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(prevWriteMs + 500));

    // With a tight 100 ms window, 500 ms is stale → null.
    const tight = await readWithPrevFallback(file, { maxPrevAgeMs: 100 });
    expect(tight).toBeNull();

    // With a 1_000 ms window, 500 ms is fresh → returns prev content.
    const loose = await readWithPrevFallback(file, { maxPrevAgeMs: 1_000 });
    expect(loose).not.toBeNull();
    expect(loose!.source).toBe("prev");
  });
});

describe("readWithPrevFallback — case 3: primary ENOENT + stale .prev", () => {
  it("returns null when the .prev mtime is older than the default 5s window", async () => {
    const file = path.join(workspace, "out.jsonl");
    const prev = `${file}.prev`;
    await fs.writeFile(prev, "stale-snapshot\n");

    // Force .prev mtime to 10 seconds in the past via utimes.
    const tenSecondsAgo = (Date.now() - 10_000) / 1000;
    await fs.utimes(prev, tenSecondsAgo, tenSecondsAgo);

    const result = await readWithPrevFallback(file);
    expect(result).toBeNull();
  });

  it("does NOT emit the fallback log when .prev is stale (no fallback served)", async () => {
    const file = path.join(workspace, "out.jsonl");
    const prev = `${file}.prev`;
    await fs.writeFile(prev, "stale\n");
    const tenSecondsAgo = (Date.now() - 10_000) / 1000;
    await fs.utimes(prev, tenSecondsAgo, tenSecondsAgo);
    const spy = vi.spyOn(logger, "info");

    await readWithPrevFallback(file);

    const fallbackCalls = spy.mock.calls.filter((c) => c[0] === "safe_read_fallback");
    expect(fallbackCalls).toHaveLength(0);
  });
});

describe("readWithPrevFallback — case 4: primary ENOENT + .prev ENOENT", () => {
  it("returns null when neither primary nor .prev exists", async () => {
    const file = path.join(workspace, "never-existed.jsonl");

    const result = await readWithPrevFallback(file);

    expect(result).toBeNull();
  });
});

describe("readWithPrevFallback — case 5: non-ENOENT error on primary", () => {
  it("rethrows when the primary path is a directory (EISDIR)", async () => {
    // Pointing the "file" at the workspace dir itself triggers EISDIR on
    // fs.readFile — a real non-ENOENT error class the helper must NOT swallow.
    await expect(readWithPrevFallback(workspace)).rejects.toThrow();
  });

  it("rethrows when fs.readFile yields a non-ENOENT error (e.g. EACCES)", async () => {
    const file = path.join(workspace, "out.jsonl");
    // Simulate EACCES on the primary read. The helper must rethrow, not
    // fall back to .prev — non-ENOENT errors are real I/O failures.
    const eacces: NodeJS.ErrnoException = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    const spy = vi.spyOn(fs, "readFile").mockRejectedValueOnce(eacces);

    await expect(readWithPrevFallback(file)).rejects.toThrow("permission denied");
    expect(spy).toHaveBeenCalled();
  });
});
