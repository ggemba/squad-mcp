import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { registerTools, dispatchTool } from "../src/tools/registry.js";
import {
  generateRunId,
  __resetRunsStoreCacheForTests,
  DEFAULT_RUNS_PATH,
  type RunRecord,
} from "../src/runs/store.js";

beforeAll(() => {
  registerTools();
});

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "squad-runs-e2e-"));
  __resetRunsStoreCacheForTests();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  __resetRunsStoreCacheForTests();
});

function inFlightRecord(id: string): RunRecord {
  return {
    schema_version: 1,
    id,
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
  };
}

function completedRecord(id: string): RunRecord {
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
        severity_score: 120,
        batch_duration_ms: 4_500,
        prompt_chars: 3_500,
        response_chars: 700,
      },
      {
        name: "senior-qa",
        model: "sonnet",
        score: 78,
        severity_score: 20,
        batch_duration_ms: 3_800,
        prompt_chars: 2_100,
        response_chars: 400,
      },
    ],
    verdict: "APPROVED",
    weighted_score: 80.4,
    est_tokens_method: "chars-div-3.5",
  };
}

async function dispatchOk(name: string, input: unknown): Promise<Record<string, unknown>> {
  const r = (await dispatchTool(name, input)) as {
    content: { text: string }[];
    isError?: boolean;
  };
  if (r.isError) {
    throw new Error(`${name} returned error: ${r.content[0]!.text}`);
  }
  return JSON.parse(r.content[0]!.text);
}

describe("runs e2e — full lifecycle through MCP dispatch", () => {
  it("records in_flight + completed and folds them via list_runs", async () => {
    const id = generateRunId();

    // Phase 1 — in_flight
    const a = await dispatchOk("record_run", {
      workspace_root: workspace,
      record: inFlightRecord(id),
    });
    expect(a.ok).toBe(true);
    expect(a.status).toBe("in_flight");
    expect(a.id).toBe(id);

    // Phase 10 — completed
    const b = await dispatchOk("record_run", {
      workspace_root: workspace,
      record: completedRecord(id),
    });
    expect(b.status).toBe("completed");

    // Verify on-disk JSONL
    const raw = await fs.readFile(path.join(workspace, DEFAULT_RUNS_PATH), "utf8");
    expect(raw.split("\n").filter((l) => l.length > 0)).toHaveLength(2);

    // list_runs with aggregate=true folds them into one folded run
    const out = await dispatchOk("list_runs", {
      workspace_root: workspace,
      aggregate: true,
    });
    expect(out.total_in_store).toBe(2);
    expect(out.total_folded).toBe(1);
    const outcomes = out.outcomes as Record<string, unknown>;
    expect((outcomes.verdict_counts as Record<string, number>).APPROVED).toBe(1);
    expect(outcomes.is_empty).toBe(false);
    const tokens = outcomes.est_tokens_total as Record<string, number>;
    // 3500 + 700 + 2100 + 400 = 6700 chars in / out combined.
    expect(tokens.total).toBeGreaterThan(0);
  });

  it("returns empty result with file=null when journal does not exist", async () => {
    const out = await dispatchOk("list_runs", {
      workspace_root: workspace,
      aggregate: true,
    });
    expect(out.total_in_store).toBe(0);
    expect(out.total_folded).toBe(0);
    expect(out.file).toBeNull();
    expect((out.outcomes as Record<string, unknown>).is_empty).toBe(true);
  });

  it("RECORD_TOO_LARGE surfaces through dispatch as an error response", async () => {
    const id = generateRunId();
    // SafeString caps are length-based (UTF-16 code units); push byte length
    // past MAX_RECORD_BYTES with 4-byte UTF-8 chars while staying schema-valid.
    const ROCKET = "\u{1F680}";
    const huge: RunRecord = {
      ...inFlightRecord(id),
      mode_warning: { code: "TOO_BIG", message: ROCKET.repeat(256) },
      git_ref: { kind: "head", value: ROCKET.repeat(100) },
      agents: Array.from({ length: 20 }).map(() => ({
        name: "senior-developer" as const,
        model: "inherit" as const,
        score: null,
        severity_score: null,
        batch_duration_ms: 0,
        prompt_chars: 0,
        response_chars: 0,
      })),
    };
    const r = (await dispatchTool("record_run", {
      workspace_root: workspace,
      record: huge,
    })) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0]!.text);
    expect(body.error.code).toBe("RECORD_TOO_LARGE");
  });

  it("list_runs work_type filter composes with limit (work_type applied first)", async () => {
    // Regression test: previously work_type was applied AFTER limit, so
    // "last 2 Bug Fix runs" silently truncated to "Bug Fix runs within the
    // last 2 runs" — wrong data. The fix applies work_type before applyFilters.
    const ids = ["a", "b", "c", "d", "e"];
    for (let i = 0; i < ids.length; i++) {
      await dispatchOk("record_run", {
        workspace_root: workspace,
        record: {
          ...completedRecord(ids[i]!),
          started_at: `2026-05-${10 + i}T00:00:00.000Z`,
          work_type: i % 2 === 0 ? "Bug Fix" : "Feature",
        },
      });
    }
    const out = await dispatchOk("list_runs", {
      workspace_root: workspace,
      work_type: "Bug Fix",
      limit: 2,
    });
    // 3 Bug Fix runs exist (a, c, e); limit 2 of them by started_at desc → c, e.
    expect(out.total_folded).toBe(2);
  });

  it("v0.10.0 debug invocation: full lifecycle in_flight + completed + aggregate count", async () => {
    const id = generateRunId();
    // Phase A — in_flight (debug)
    await dispatchOk("record_run", {
      workspace_root: workspace,
      record: {
        ...inFlightRecord(id),
        invocation: "debug",
        agents: [
          {
            name: "code-explorer",
            model: "haiku",
            score: null,
            severity_score: null,
            batch_duration_ms: 0,
            prompt_chars: 0,
            response_chars: 0,
          },
          {
            name: "senior-debugger",
            model: "haiku",
            score: null,
            severity_score: null,
            batch_duration_ms: 0,
            prompt_chars: 0,
            response_chars: 0,
          },
        ],
      },
    });
    // Phase C — completed
    await dispatchOk("record_run", {
      workspace_root: workspace,
      record: {
        ...completedRecord(id),
        invocation: "debug",
        verdict: null,
        weighted_score: null,
        agents: [
          {
            name: "code-explorer",
            model: "haiku",
            score: null,
            severity_score: null,
            batch_duration_ms: 1200,
            prompt_chars: 800,
            response_chars: 1500,
          },
          {
            name: "senior-debugger",
            model: "haiku",
            score: null,
            severity_score: null,
            batch_duration_ms: 2400,
            prompt_chars: 2300,
            response_chars: 1800,
          },
        ],
      },
    });
    const out = await dispatchOk("list_runs", {
      workspace_root: workspace,
      aggregate: true,
    });
    expect(out.total_folded).toBe(1);
    const outcomes = out.outcomes as Record<string, unknown>;
    expect((outcomes.invocation_counts as Record<string, number>).debug).toBe(1);
  });

  it("list_runs filters by verdict + agent + invocation", async () => {
    const a = generateRunId();
    const b = generateRunId();
    await dispatchOk("record_run", {
      workspace_root: workspace,
      record: { ...completedRecord(a), verdict: "REJECTED", invocation: "review" },
    });
    await dispatchOk("record_run", {
      workspace_root: workspace,
      record: completedRecord(b),
    });

    const onlyApproved = await dispatchOk("list_runs", {
      workspace_root: workspace,
      verdict: "APPROVED",
    });
    expect(onlyApproved.total_folded).toBe(1);

    const onlyReview = await dispatchOk("list_runs", {
      workspace_root: workspace,
      invocation: "review",
    });
    expect(onlyReview.total_folded).toBe(1);

    const onlyQa = await dispatchOk("list_runs", {
      workspace_root: workspace,
      agent: "senior-qa",
    });
    expect(onlyQa.total_folded).toBe(2); // both records include senior-qa
  });
});
