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
    schema_version: 1,
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
        name: "senior-developer",
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
    schema_version: 1,
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
        name: "senior-developer",
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

  it("creates the file with mode 0o600 (user-only)", async () => {
    await appendRun(workspace, baseInFlight());
    const file = path.join(workspace, DEFAULT_RUNS_PATH);
    const st = await fs.stat(file);
    expect(st.mode & 0o777).toBe(0o600);
  });

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
      name: "senior-developer" as const,
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
    const bad = { ...baseInFlight(), schema_version: 2 } as unknown as RunRecord;
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
    const id1 = "first";
    await appendRun(workspace, baseInFlight({ id: id1 }));
    const first = await readRuns(workspace);
    expect(first.map((r) => r.id)).toEqual([id1]);

    // Force a different mtime via a small wait + second append.
    await new Promise((res) => setTimeout(res, 12));
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
