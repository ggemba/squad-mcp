import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  appendRun,
  readRuns,
  generateRunId,
  severityScore,
  decodeSeverityScore,
  DEFAULT_RUNS_PATH,
  MAX_RECORD_BYTES,
  __resetRunsStoreCacheForTests,
  type RunRecord,
} from "../src/runs/store.js";
import { isSquadError } from "../src/errors.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "squad-runs-test-"));
  __resetRunsStoreCacheForTests();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  __resetRunsStoreCacheForTests();
});

function baseInFlight(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schema_version: 2,
    id: overrides.id ?? generateRunId(),
    status: "in_flight",
    started_at: "2026-05-11T10:00:00.000Z",
    invocation: "implement",
    mode: "normal",
    mode_source: "auto",
    work_type: "Feature",
    git_ref: { kind: "head", value: "abcdef1" },
    files_count: 3,
    agents: [
      {
        name: "developer",
        model: "inherit",
        score: null,
        severity_score: null,
        batch_duration_ms: 0,
        prompt_chars: 0,
        response_chars: 0,
      },
    ],
    est_tokens_method: "chars-div-3.5",
    ...overrides,
  };
}

function baseCompleted(id: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schema_version: 2,
    id,
    status: "completed",
    started_at: "2026-05-11T10:00:00.000Z",
    completed_at: "2026-05-11T10:05:00.000Z",
    duration_ms: 5 * 60_000,
    invocation: "implement",
    mode: "normal",
    mode_source: "auto",
    work_type: "Feature",
    git_ref: { kind: "head", value: "abcdef1" },
    files_count: 3,
    agents: [
      {
        name: "developer",
        model: "sonnet",
        score: 82,
        severity_score: severityScore({ Blocker: 0, Major: 1, Minor: 2, Suggestion: 1 }),
        batch_duration_ms: 4_500,
        prompt_chars: 3_500,
        response_chars: 800,
      },
    ],
    verdict: "APPROVED",
    weighted_score: 82.4,
    est_tokens_method: "chars-div-3.5",
    ...overrides,
  };
}

describe("severityScore encoding", () => {
  it("round-trips through decodeSeverityScore", () => {
    const cases = [
      { Blocker: 0, Major: 0, Minor: 0, Suggestion: 0 },
      { Blocker: 1, Major: 2, Minor: 3, Suggestion: 4 },
      { Blocker: 9, Major: 9, Minor: 9, Suggestion: 9 },
      { Blocker: 0, Major: 0, Minor: 0, Suggestion: 7 },
    ];
    for (const c of cases) {
      expect(decodeSeverityScore(severityScore(c))).toEqual(c);
    }
  });
});

describe("generateRunId", () => {
  it("produces collision-resistant unique ids", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(generateRunId());
    expect(ids.size).toBe(100);
  });
});

describe("appendRun — happy path", () => {
  it("writes a single line of JSON terminated by newline", async () => {
    const rec = baseInFlight();
    const out = await appendRun(workspace, rec);
    expect(out.record.id).toBe(rec.id);
    const file = path.join(workspace, DEFAULT_RUNS_PATH);
    const raw = await fs.readFile(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n").filter((s) => s.length > 0)).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")(
    "creates the file with mode 0o600 (user-only)",
    async () => {
      // Skipped on Windows: NTFS does not honour POSIX file modes, and
      // `fs.stat` always returns 0o666 regardless of the mode passed to
      // `fs.open`. The mode contract is enforced on POSIX (Linux/macOS)
      // where the runs journal might leak under multi-user filesystems.
      await appendRun(workspace, baseInFlight());
      const file = path.join(workspace, DEFAULT_RUNS_PATH);
      const st = await fs.stat(file);
      expect(st.mode & 0o777).toBe(0o600);
    },
  );

  it("appends a second row in order", async () => {
    const a = baseInFlight({ id: "id-aaa" });
    const b = baseCompleted("id-aaa");
    await appendRun(workspace, a);
    await appendRun(workspace, b);
    const rows = await readRuns(workspace);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.status).toBe("in_flight");
    expect(rows[1]!.status).toBe("completed");
  });
});

describe("appendRun — validation + size cap", () => {
  it("throws RECORD_TOO_LARGE when JSON line exceeds MAX_RECORD_BYTES", async () => {
    // SafeString caps use string length (UTF-16 code units), not byte length.
    // Stuff the bytes with 4-byte UTF-8 characters (🚀 = 4 bytes, length 2)
    // so the serialized line trips the byte cap while staying schema-valid.
    const ROCKET = "\u{1F680}"; // length 2, 4 UTF-8 bytes
    const message512chars = ROCKET.repeat(256); // length 512, 1024 bytes
    const ref200chars = ROCKET.repeat(100); // length 200, 400 bytes
    const rec = baseInFlight({
      mode_warning: { code: "TOO_BIG", message: message512chars },
    });
    rec.git_ref = { kind: "head", value: ref200chars };
    rec.agents = Array.from({ length: 20 }).map(() => ({
      name: "developer" as const,
      model: "inherit" as const,
      score: null,
      severity_score: null,
      batch_duration_ms: 0,
      prompt_chars: 0,
      response_chars: 0,
    }));
    let err: unknown;
    try {
      await appendRun(workspace, rec);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(isSquadError(err)).toBe(true);
    if (isSquadError(err)) expect(err.code).toBe("RECORD_TOO_LARGE");
  });

  it("throws INVALID_INPUT when the record fails Zod validation", async () => {
    const bad = { ...baseInFlight(), schema_version: 3 } as unknown as RunRecord;
    let err: unknown;
    try {
      await appendRun(workspace, bad);
    } catch (e) {
      err = e;
    }
    expect(isSquadError(err)).toBe(true);
    if (isSquadError(err)) expect(err.code).toBe("INVALID_INPUT");
  });

  it("rejects configuredPath that escapes workspaceRoot (CWE-22)", async () => {
    await expect(
      appendRun(workspace, baseInFlight(), { configuredPath: "../escape.jsonl" }),
    ).rejects.toThrow(/PATH_TRAVERSAL_DENIED|escapes workspace_root/);
  });

  it("rejects absolute configuredPath (CWE-22)", async () => {
    await expect(
      appendRun(workspace, baseInFlight(), { configuredPath: "/etc/passwd" }),
    ).rejects.toThrow(/PATH_TRAVERSAL_DENIED|absolute/);
  });
});

describe("appendRun — RECORD_FAILED fallback shape (v0.10.1)", () => {
  it("accepts a fallback row with status:aborted + mode_warning code RECORD_FAILED", async () => {
    // SKILL-level fallback path (Phase C SquadError → second appendRun with
    // status:aborted + mode_warning) is contract-only. This test asserts the
    // store accepts the prescribed shape so the fallback can land on disk
    // when the SKILL invokes it.
    const id = "fallback-row";
    await appendRun(workspace, baseInFlight({ id }));
    await appendRun(workspace, {
      ...baseInFlight({ id }),
      status: "aborted",
      completed_at: "2026-05-11T10:05:00.000Z",
      duration_ms: 5 * 60_000,
      mode_warning: {
        code: "RECORD_FAILED",
        message: "downstream record write threw RECORD_TOO_LARGE on agent response",
      },
    });
    const rows = await readRuns(workspace);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.status).toBe("aborted");
    expect(rows[1]!.mode_warning?.code).toBe("RECORD_FAILED");
  });
});

describe("appendRun — mode_warning.message writer sanitization (v0.10.1)", () => {
  it("strips C0/C1/ESC bytes from mode_warning.message before write", async () => {
    // Defense in depth: aggregate.stripControlChars runs at render, but `cat`
    // bypasses the aggregator. Sanitize at writer too so on-disk bytes are
    // terminal-safe even for tools that read the journal directly.
    const dirty = "leak\x1b[2Jhere\x07\x7fend";
    const id = "dirty-mode-warning";
    await appendRun(workspace, {
      ...baseInFlight({ id }),
      mode_warning: { code: "DIRTY", message: dirty },
    });
    // Re-read raw bytes (bypass Zod / aggregator) to confirm sanitization.
    const file = path.join(workspace, DEFAULT_RUNS_PATH);
    const raw = await fs.readFile(file, "utf8");
    expect(raw).not.toContain("\x1b");
    expect(raw).not.toContain("\x07");
    expect(raw).not.toContain("\x7f");
    expect(raw).toContain("leak[2Jhereend"); // printables survive
  });
});

describe("phase_timings — --profile flag (v0.12)", () => {
  it("accepts a terminal row with phase_timings and round-trips through readRuns", async () => {
    const id = "profile-row";
    const rec = baseCompleted(id, {
      phase_timings: {
        phase_1_classify_ms: 420,
        phase_2_planner_ms: 18_500,
        phase_5_advisory_ms: 24_200,
        phase_10_consolidator_ms: 19_900,
      },
    });
    await appendRun(workspace, rec);
    const rows = await readRuns(workspace);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.phase_timings).toEqual({
      phase_1_classify_ms: 420,
      phase_2_planner_ms: 18_500,
      phase_5_advisory_ms: 24_200,
      phase_10_consolidator_ms: 19_900,
    });
  });

  it("absent phase_timings means --profile was not passed", async () => {
    const id = "no-profile";
    const rec = baseCompleted(id); // no phase_timings field
    await appendRun(workspace, rec);
    const rows = await readRuns(workspace);
    expect(rows[0]!.phase_timings).toBeUndefined();
  });

  it("rejects negative phase_timings values", async () => {
    const bad = baseCompleted("bad-negative", {
      phase_timings: { phase_1_classify_ms: -100 },
    });
    let err: unknown;
    try {
      await appendRun(workspace, bad);
    } catch (e) {
      err = e;
    }
    expect(isSquadError(err)).toBe(true);
    if (isSquadError(err)) expect(err.code).toBe("INVALID_INPUT");
  });

  it("rejects phase_timings values > 30 minutes (1.8M ms)", async () => {
    const bad = baseCompleted("bad-huge", {
      phase_timings: { phase_1_classify_ms: 2_000_000 }, // ~33 min, over 30-min cap
    });
    let err: unknown;
    try {
      await appendRun(workspace, bad);
    } catch (e) {
      err = e;
    }
    expect(isSquadError(err)).toBe(true);
    if (isSquadError(err)) expect(err.code).toBe("INVALID_INPUT");
  });

  it("phase_timings tolerates arbitrary phase key names (extensible)", async () => {
    // Future phase names should round-trip without schema bump.
    const id = "future-phase-key";
    const rec = baseCompleted(id, {
      phase_timings: {
        phase_99_hypothetical_ms: 5_000,
        phase_2_planner_ms: 10_000,
      },
    });
    await appendRun(workspace, rec);
    const rows = await readRuns(workspace);
    expect(rows[0]!.phase_timings).toMatchObject({
      phase_99_hypothetical_ms: 5_000,
      phase_2_planner_ms: 10_000,
    });
  });

  it("rejects phase_timings with > 30 keys (round-2 review fix — .refine enforced)", async () => {
    // The doc claimed a 30-key cap but the original schema only enforced
    // per-value bounds. .refine now closes the gap.
    const tooMany: Record<string, number> = {};
    for (let i = 0; i < 31; i++) tooMany[`phase_${i}_ms`] = 100;
    const bad = baseCompleted("too-many-keys", { phase_timings: tooMany });
    let err: unknown;
    try {
      await appendRun(workspace, bad);
    } catch (e) {
      err = e;
    }
    expect(isSquadError(err)).toBe(true);
    if (isSquadError(err)) expect(err.code).toBe("INVALID_INPUT");
  });

  it("accepts phase_timings with exactly 30 keys (boundary)", async () => {
    const exact: Record<string, number> = {};
    for (let i = 0; i < 30; i++) exact[`phase_${i}_ms`] = 100;
    await appendRun(workspace, baseCompleted("exact-30", { phase_timings: exact }));
    const rows = await readRuns(workspace);
    expect(Object.keys(rows[0]!.phase_timings!).length).toBe(30);
  });
});

describe("InvocationEnum — debug widening (v0.10.0)", () => {
  it('accepts invocation: "debug" through appendRun + readRuns roundtrip', async () => {
    const id = "debug-run";
    const rec = baseInFlight({ id, invocation: "debug" });
    await appendRun(workspace, rec);
    const rows = await readRuns(workspace);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.invocation).toBe("debug");
  });

  it("rejects an invocation outside the enum at the store layer", async () => {
    const bad = { ...baseInFlight(), invocation: "bogus" } as unknown as RunRecord;
    let err: unknown;
    try {
      await appendRun(workspace, bad);
    } catch (e) {
      err = e;
    }
    expect(isSquadError(err)).toBe(true);
    if (isSquadError(err)) expect(err.code).toBe("INVALID_INPUT");
  });
});

describe("readRuns — file presence + cache", () => {
  it("returns [] when the file does not exist", async () => {
    expect(await readRuns(workspace)).toEqual([]);
  });

  it("returns [] when the path resolves to a directory", async () => {
    await fs.mkdir(path.join(workspace, ".squad", "runs.jsonl"), { recursive: true });
    expect(await readRuns(workspace)).toEqual([]);
  });

  it("invalidates cache when the file changes", async () => {
    // Cache key is (mtimeMs, size) since v0.9.0 (senior-dev cycle-2 Major).
    // Two reasons this test is now reliable on coarse-mtime filesystems:
    //   1. appendRun calls cache.delete(absRoot) unconditionally — primary
    //      in-process invalidator.
    //   2. The size field in the cache key differs after the second append
    //      (each appendRun grows the file) — secondary cross-process guard.
    // The pre-v0.9.0 12ms sleep was guarding against an mtime-only key on
    // ext4 with 1s mtime granularity. No longer needed.
    const id1 = "first";
    await appendRun(workspace, baseInFlight({ id: id1 }));
    const first = await readRuns(workspace);
    expect(first.map((r) => r.id)).toEqual([id1]);

    const id2 = "second";
    await appendRun(workspace, baseInFlight({ id: id2 }));
    const second = await readRuns(workspace);
    expect(second.map((r) => r.id)).toEqual([id1, id2]);
  });
});

describe("readRuns — quarantine of corrupt + unknown-version rows", () => {
  it("quarantines a malformed-JSON line and keeps the rest", async () => {
    const file = path.join(workspace, DEFAULT_RUNS_PATH);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const valid = JSON.stringify(baseInFlight({ id: "good" }));
    await fs.writeFile(file, valid + "\n{not-json\n" + valid.replace("good", "good2") + "\n");
    const rows = await readRuns(workspace);
    expect(rows.map((r) => r.id)).toEqual(["good", "good2"]);
    // The quarantine file should exist alongside.
    const dirContents = await fs.readdir(path.join(workspace, ".squad"));
    expect(dirContents.some((n) => n.startsWith("runs.jsonl.corrupt-"))).toBe(true);
  });

  it("skips unknown schema_version rows (not corrupt — forward-compat gate)", async () => {
    const file = path.join(workspace, DEFAULT_RUNS_PATH);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const future = JSON.stringify({ schema_version: 99, id: "x" });
    const valid = JSON.stringify(baseInFlight({ id: "ok" }));
    await fs.writeFile(file, future + "\n" + valid + "\n");
    const rows = await readRuns(workspace);
    expect(rows.map((r) => r.id)).toEqual(["ok"]);
  });
});
