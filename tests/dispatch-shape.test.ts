import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  appendRun,
  readRuns,
  generateRunId,
  __resetRunsStoreCacheForTests,
  type RunRecord,
  type AgentMetrics,
} from "../src/runs/store.js";
import { inferDispatchShape, foldById, aggregateHealth } from "../src/runs/aggregate.js";

/**
 * [O3] Dispatch-shape detection. Records an OPTIONAL per-agent `started_at`
 * so /squad:stats can DETECT when advisory agents were linearized (run
 * sequentially) instead of dispatched in a single parallel batch.
 *
 * inferDispatchShape rule:
 *   - <2 agents OR any agent missing/unparseable started_at → "unknown"
 *   - at least one pair of [start, start+batch_duration_ms] windows overlaps
 *     (strict: a.start < b.end && b.start < a.end) → "parallel"
 *   - no pair overlaps → "sequential" (linearized; Inviolable Rule 9 violation)
 */

function agent(overrides: Partial<AgentMetrics> = {}): AgentMetrics {
  return {
    name: "developer",
    model: "sonnet",
    score: 80,
    severity_score: 0,
    batch_duration_ms: 1_000,
    prompt_chars: 100,
    response_chars: 100,
    ...overrides,
  };
}

describe("inferDispatchShape — overlap rule", () => {
  it('overlapping windows → "parallel"', () => {
    // Two agents dispatched ~same instant; both run ~10s → windows heavily overlap.
    const agents = [
      agent({
        name: "architect",
        started_at: "2026-05-11T10:00:00.000Z",
        batch_duration_ms: 10_000,
      }),
      agent({
        name: "security",
        started_at: "2026-05-11T10:00:02.000Z",
        batch_duration_ms: 10_000,
      }),
    ];
    expect(inferDispatchShape(agents)).toBe("parallel");
  });

  it('non-overlapping windows → "sequential" (linearized)', () => {
    // architect runs 10:00:00–10:00:05; security only dispatched at 10:00:06
    // (1s after architect finished) → disjoint windows = linearized.
    const agents = [
      agent({
        name: "architect",
        started_at: "2026-05-11T10:00:00.000Z",
        batch_duration_ms: 5_000,
      }),
      agent({ name: "security", started_at: "2026-05-11T10:00:06.000Z", batch_duration_ms: 5_000 }),
    ];
    expect(inferDispatchShape(agents)).toBe("sequential");
  });

  it("treats exactly touching edges (b.start === a.end) as sequential", () => {
    // architect ends at 10:00:05.000; security starts at exactly 10:00:05.000.
    // Strict overlap (<, not <=) reads a clean hand-off as sequential.
    const agents = [
      agent({
        name: "architect",
        started_at: "2026-05-11T10:00:00.000Z",
        batch_duration_ms: 5_000,
      }),
      agent({ name: "security", started_at: "2026-05-11T10:00:05.000Z", batch_duration_ms: 5_000 }),
    ];
    expect(inferDispatchShape(agents)).toBe("sequential");
  });

  it("classifies parallel if ANY pair overlaps among 3 agents", () => {
    // a & b overlap; c is far later and disjoint. One overlapping pair ⇒ parallel.
    const agents = [
      agent({
        name: "architect",
        started_at: "2026-05-11T10:00:00.000Z",
        batch_duration_ms: 8_000,
      }),
      agent({ name: "security", started_at: "2026-05-11T10:00:03.000Z", batch_duration_ms: 8_000 }),
      agent({ name: "qa", started_at: "2026-05-11T10:05:00.000Z", batch_duration_ms: 2_000 }),
    ];
    expect(inferDispatchShape(agents)).toBe("parallel");
  });

  it('missing started_at on any agent → "unknown"', () => {
    const agents = [
      agent({
        name: "architect",
        started_at: "2026-05-11T10:00:00.000Z",
        batch_duration_ms: 5_000,
      }),
      agent({ name: "security" }), // no started_at
    ];
    expect(inferDispatchShape(agents)).toBe("unknown");
  });

  it('unparseable started_at → "unknown"', () => {
    const agents = [
      agent({
        name: "architect",
        started_at: "2026-05-11T10:00:00.000Z",
        batch_duration_ms: 5_000,
      }),
      agent({ name: "security", started_at: "not-a-date", batch_duration_ms: 5_000 }),
    ];
    expect(inferDispatchShape(agents)).toBe("unknown");
  });

  it('single agent → "unknown" (overlap undefined for <2 windows)', () => {
    const agents = [
      agent({
        name: "developer",
        started_at: "2026-05-11T10:00:00.000Z",
        batch_duration_ms: 5_000,
      }),
    ];
    expect(inferDispatchShape(agents)).toBe("unknown");
  });

  it('zero agents → "unknown"', () => {
    expect(inferDispatchShape([])).toBe("unknown");
  });
});

describe("aggregateHealth — dispatch_shape signal counts", () => {
  function completed(id: string, agents: AgentMetrics[]): RunRecord {
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
      agents,
      verdict: "APPROVED",
      weighted_score: 82,
      est_tokens_method: "chars-div-3.5",
    };
  }

  it("counts parallel / sequential / unknown across runs", () => {
    const parallelRun = completed("run-parallel", [
      agent({
        name: "architect",
        started_at: "2026-05-11T10:00:00.000Z",
        batch_duration_ms: 10_000,
      }),
      agent({
        name: "security",
        started_at: "2026-05-11T10:00:02.000Z",
        batch_duration_ms: 10_000,
      }),
    ]);
    const sequentialRun = completed("run-sequential", [
      agent({
        name: "architect",
        started_at: "2026-05-11T11:00:00.000Z",
        batch_duration_ms: 5_000,
      }),
      agent({ name: "security", started_at: "2026-05-11T11:00:06.000Z", batch_duration_ms: 5_000 }),
    ]);
    // unknown: started_at missing on one agent
    const unknownRun = completed("run-unknown", [
      agent({
        name: "architect",
        started_at: "2026-05-11T12:00:00.000Z",
        batch_duration_ms: 5_000,
      }),
      agent({ name: "security" }),
    ]);
    // unknown: single agent
    const singleAgentRun = completed("run-single", [
      agent({
        name: "developer",
        started_at: "2026-05-11T13:00:00.000Z",
        batch_duration_ms: 5_000,
      }),
    ]);

    const folded = foldById([parallelRun, sequentialRun, unknownRun, singleAgentRun]);
    const health = aggregateHealth(folded);

    expect(health.dispatch_shape).toEqual({
      parallel: 1,
      sequential: 1,
      unknown: 2,
    });
  });

  it("reports zero counts on an empty journal", () => {
    const health = aggregateHealth(foldById([]));
    expect(health.dispatch_shape).toEqual({ parallel: 0, sequential: 0, unknown: 0 });
  });
});

describe("backward compatibility — records with no per-agent started_at", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "squad-dispatch-shape-"));
    __resetRunsStoreCacheForTests();
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    __resetRunsStoreCacheForTests();
  });

  function legacy(id: string): RunRecord {
    // A record exactly as written before [O3]: agents carry NO started_at.
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
        agent({ name: "architect" }), // no started_at
        agent({ name: "security" }), // no started_at
      ],
      verdict: "APPROVED",
      weighted_score: 82,
      est_tokens_method: "chars-div-3.5",
    };
  }

  it("a record with no started_at still parses through appendRun + readRuns", async () => {
    const id = generateRunId();
    await appendRun(workspace, legacy(id));
    const rows = await readRuns(workspace);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    // The optional field is genuinely absent, not coerced to null.
    expect(rows[0]!.agents[0]!.started_at).toBeUndefined();
  });

  it("a record with no started_at aggregates as dispatch-shape unknown (never throws)", async () => {
    await appendRun(workspace, legacy(generateRunId()));
    const rows = await readRuns(workspace);
    const health = aggregateHealth(foldById(rows));
    expect(health.dispatch_shape).toEqual({ parallel: 0, sequential: 0, unknown: 1 });
  });

  it("a record WITH started_at round-trips through the store and classifies", async () => {
    const id = generateRunId();
    const rec: RunRecord = {
      ...legacy(id),
      agents: [
        agent({
          name: "architect",
          started_at: "2026-05-11T10:00:00.000Z",
          batch_duration_ms: 10_000,
        }),
        agent({
          name: "security",
          started_at: "2026-05-11T10:00:02.000Z",
          batch_duration_ms: 10_000,
        }),
      ],
    };
    await appendRun(workspace, rec);
    const rows = await readRuns(workspace);
    expect(rows[0]!.agents[0]!.started_at).toBe("2026-05-11T10:00:00.000Z");
    expect(inferDispatchShape(rows[0]!.agents)).toBe("parallel");
  });
});
