import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  getEstTokens,
  getEstTokensPerAgent,
  stripControlChars,
  foldById,
  applyFilters,
  aggregateOutcomes,
  aggregateHealth,
  trendByDay,
  renderBar,
  renderSparkline,
  formatDuration,
  formatTokens,
  IN_FLIGHT_TTL_MS,
  CHARS_PER_TOKEN_ESTIMATE,
} from "../src/runs/aggregate.js";
import { type RunRecord, type AgentMetrics } from "../src/runs/store.js";

function rec(over: Partial<RunRecord> = {}): RunRecord {
  return {
    schema_version: 1,
    id: over.id ?? "r1",
    status: "completed",
    started_at: "2026-05-11T10:00:00.000Z",
    completed_at: "2026-05-11T10:05:00.000Z",
    duration_ms: 5 * 60_000,
    invocation: "implement",
    mode: "normal",
    mode_source: "auto",
    work_type: "Feature",
    git_ref: { kind: "head", value: "abc" },
    files_count: 3,
    agents: over.agents ?? [
      agent("senior-developer", { prompt_chars: 3500, response_chars: 700, score: 82 }),
    ],
    verdict: "APPROVED",
    weighted_score: 82,
    est_tokens_method: "chars-div-3.5",
    ...over,
  };
}

function agent(name: AgentMetrics["name"], over: Partial<AgentMetrics> = {}): AgentMetrics {
  return {
    name,
    model: "inherit",
    score: null,
    severity_score: null,
    batch_duration_ms: 1_000,
    prompt_chars: 1_000,
    response_chars: 300,
    ...over,
  };
}

describe("estimateTokens", () => {
  it("returns 0 for zero / negative / non-finite input", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(-5)).toBe(0);
    expect(estimateTokens(NaN)).toBe(0);
    expect(estimateTokens(Infinity)).toBe(0);
  });

  it("floors chars / CHARS_PER_TOKEN_ESTIMATE", () => {
    expect(estimateTokens(7)).toBe(Math.floor(7 / CHARS_PER_TOKEN_ESTIMATE));
    expect(estimateTokens(3.5)).toBe(1);
  });

  it("is monotone non-decreasing", () => {
    for (let i = 0; i < 100; i++) {
      expect(estimateTokens(i + 1)).toBeGreaterThanOrEqual(estimateTokens(i));
    }
  });
});

describe("getEstTokens + getEstTokensPerAgent", () => {
  it("sums input and output independently", () => {
    const r = rec({
      agents: [
        agent("senior-developer", { prompt_chars: 700, response_chars: 0 }),
        agent("senior-qa", { prompt_chars: 0, response_chars: 350 }),
      ],
    });
    const t = getEstTokens(r);
    expect(t.input).toBe(estimateTokens(700));
    expect(t.output).toBe(estimateTokens(350));
    expect(t.total).toBe(t.input + t.output);
  });

  it("rolls up tokens per-agent across runs", () => {
    const r1 = rec({
      id: "x",
      agents: [agent("senior-developer", { prompt_chars: 700, response_chars: 350 })],
    });
    const r2 = rec({
      id: "y",
      agents: [agent("senior-developer", { prompt_chars: 1400, response_chars: 0 })],
    });
    const per = getEstTokensPerAgent([r1, r2]);
    const dev = per.get("senior-developer");
    expect(dev).toBeDefined();
    expect(dev!.input).toBe(estimateTokens(700) + estimateTokens(1400));
  });
});

describe("stripControlChars", () => {
  it("removes ESC, C0 (except \\t), C1, and DEL bytes while keeping printables", () => {
    // After ESC stripping, `[2J` printable chars remain (we strip the byte, not
    // the SGR sequence — that's expected: render-safe regex, not a CSI parser).
    const dirty = "hello\x1b\tworld\x07\x1f\x7fend";
    expect(stripControlChars(dirty)).toBe("hello\tworldend");
  });
});

describe("foldById — pair-by-id + last-wins tiebreaker", () => {
  it("pairs an in_flight + completed under the same id", () => {
    const inflight: RunRecord = rec({ id: "shared", status: "in_flight" });
    const completed: RunRecord = rec({ id: "shared", status: "completed" });
    const folded = foldById([inflight, completed]);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.status).toBe("completed");
    expect(folded[0]!.synthesized_aborted).toBe(false);
  });

  it("differing-started_at: later started_at wins regardless of append position (v0.10.1)", () => {
    // Explicit coverage of the primary sort key. Previously only the same-
    // started_at tiebreaker was tested, leaving the started_at ASC ordering
    // documented but not regression-locked (v0.10.0 QA Suggestion C2).
    const earlier: RunRecord = rec({
      id: "swap",
      status: "completed",
      started_at: "2026-05-11T09:00:00.000Z",
      verdict: "APPROVED",
    });
    const later: RunRecord = rec({
      id: "swap",
      status: "completed",
      started_at: "2026-05-11T10:00:00.000Z",
      verdict: "REJECTED",
    });
    // Insertion order: later first, earlier second. Sort must still pick later.
    const folded = foldById([later, earlier]);
    expect(folded[0]!.record.verdict).toBe("REJECTED");
    expect(folded[0]!.record.started_at).toBe("2026-05-11T10:00:00.000Z");
  });

  it("breaks ties by (started_at ASC, append position ASC; last wins)", () => {
    const a: RunRecord = rec({
      id: "dup",
      status: "completed",
      started_at: "2026-05-11T10:00:00.000Z",
      verdict: "REJECTED",
    });
    const b: RunRecord = rec({
      id: "dup",
      status: "completed",
      started_at: "2026-05-11T10:00:00.000Z",
      verdict: "APPROVED",
    });
    const folded = foldById([a, b]);
    expect(folded[0]!.record.verdict).toBe("APPROVED");
  });

  it("synthesizes aborted view for in_flight older than IN_FLIGHT_TTL_MS", () => {
    const old = rec({
      id: "stale",
      status: "in_flight",
      started_at: new Date(Date.now() - IN_FLIGHT_TTL_MS - 60_000).toISOString(),
    });
    const folded = foldById([old]);
    expect(folded[0]!.status).toBe("aborted");
    expect(folded[0]!.synthesized_aborted).toBe(true);
  });

  it("keeps recent in_flight as in_flight", () => {
    const fresh = rec({
      id: "fresh",
      status: "in_flight",
      started_at: new Date().toISOString(),
    });
    const folded = foldById([fresh]);
    expect(folded[0]!.status).toBe("in_flight");
    expect(folded[0]!.synthesized_aborted).toBe(false);
  });
});

describe("applyFilters", () => {
  it("filters by since (ISO lower bound)", () => {
    const old = rec({ id: "old", started_at: "2026-01-01T00:00:00.000Z" });
    const recent = rec({ id: "new", started_at: "2026-05-01T00:00:00.000Z" });
    const folded = foldById([old, recent]);
    const out = applyFilters(folded, { since: "2026-03-01T00:00:00.000Z" });
    expect(out.map((f) => f.id)).toEqual(["new"]);
  });

  it("filters by verdict + mode + invocation", () => {
    const a = rec({ id: "a", verdict: "APPROVED", mode: "deep", invocation: "implement" });
    const b = rec({ id: "b", verdict: "REJECTED", mode: "deep", invocation: "review" });
    const folded = foldById([a, b]);
    expect(applyFilters(folded, { verdict: "REJECTED" }).map((f) => f.id)).toEqual(["b"]);
    expect(applyFilters(folded, { invocation: "review" }).map((f) => f.id)).toEqual(["b"]);
    expect(
      applyFilters(folded, { mode: "deep" })
        .map((f) => f.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("limits to the N most recent then re-sorts ASC", () => {
    const recs = [1, 2, 3, 4, 5].map((i) =>
      rec({ id: `r${i}`, started_at: `2026-05-${10 + i}T00:00:00.000Z` }),
    );
    const folded = foldById(recs);
    const limited = applyFilters(folded, { limit: 3 });
    expect(limited.map((f) => f.id)).toEqual(["r3", "r4", "r5"]);
  });
});

describe("aggregateOutcomes", () => {
  it("returns is_empty=true on an empty journal", () => {
    expect(aggregateOutcomes([]).is_empty).toBe(true);
  });

  it("initialises every invocation_counts key to 0 on an empty journal (v0.10.1)", () => {
    // Per the data-driven init from INVOCATION_VALUES, every value in the
    // tuple must have a 0 bucket even when no runs exist. Regression-locks
    // the Object.fromEntries cast in aggregate.ts.
    const out = aggregateOutcomes([]);
    expect(out.invocation_counts.implement).toBe(0);
    expect(out.invocation_counts.review).toBe(0);
    expect(out.invocation_counts.task).toBe(0);
    expect(out.invocation_counts.question).toBe(0);
    expect(out.invocation_counts.brainstorm).toBe(0);
    expect(out.invocation_counts.debug).toBe(0);
  });

  it("counts verdicts and bucketizes scores from completed rows only", () => {
    const folded = foldById([
      rec({ id: "1", verdict: "APPROVED", weighted_score: 95 }),
      rec({ id: "2", verdict: "APPROVED", weighted_score: 82 }),
      rec({ id: "3", verdict: "CHANGES_REQUIRED", weighted_score: 73 }),
      rec({ id: "4", verdict: "REJECTED", weighted_score: 50 }),
    ]);
    const out = aggregateOutcomes(folded);
    expect(out.verdict_counts).toEqual({ APPROVED: 2, CHANGES_REQUIRED: 1, REJECTED: 1 });
    expect(out.score_buckets.find((b) => b.range === "90-100")!.count).toBe(1);
    expect(out.score_buckets.find((b) => b.range === "80-89")!.count).toBe(1);
    expect(out.score_buckets.find((b) => b.range === "70-79")!.count).toBe(1);
    expect(out.score_buckets.find((b) => b.range === "<70")!.count).toBe(1);
  });

  it("initialises invocation_counts.debug to 0 and counts debug runs (v0.10.0)", () => {
    const folded = foldById([
      rec({ id: "a", invocation: "debug", verdict: null }),
      rec({ id: "b", invocation: "debug", verdict: null }),
      rec({ id: "c", invocation: "implement", verdict: "APPROVED" }),
    ]);
    const out = aggregateOutcomes(folded);
    expect(out.invocation_counts.debug).toBe(2);
    expect(out.invocation_counts.implement).toBe(1);
    expect(out.invocation_counts.review).toBe(0);
  });

  it("skips verdict counts for null-verdict invocations (question / brainstorm)", () => {
    const folded = foldById([
      rec({ id: "q", verdict: null, invocation: "question" }),
      rec({ id: "b", verdict: null, invocation: "brainstorm" }),
    ]);
    const out = aggregateOutcomes(folded);
    expect(out.verdict_total).toBe(0);
    expect(out.invocation_counts.question).toBe(1);
    expect(out.invocation_counts.brainstorm).toBe(1);
  });
});

describe("aggregateHealth", () => {
  it("counts in_flight / completed / aborted + synthesized_aborted", () => {
    const folded = foldById([
      rec({ id: "1", status: "completed" }),
      rec({ id: "2", status: "completed" }),
      rec({ id: "stale", status: "in_flight", started_at: "2020-01-01T00:00:00.000Z" }),
    ]);
    const h = aggregateHealth(folded);
    expect(h.completed).toBe(2);
    expect(h.aborted).toBe(1);
    expect(h.synthesized_aborted).toBe(1);
  });
});

describe("trendByDay", () => {
  it("buckets runs into the requested number of trailing days", () => {
    const now = Date.parse("2026-05-11T12:00:00.000Z");
    const ONE_DAY = 24 * 60 * 60 * 1000;
    const folded = foldById([
      rec({ id: "a", started_at: new Date(now - 0.5 * ONE_DAY).toISOString() }),
      rec({ id: "b", started_at: new Date(now - 1.5 * ONE_DAY).toISOString() }),
      rec({ id: "c", started_at: new Date(now - 1.5 * ONE_DAY).toISOString() }),
    ]);
    const buckets = trendByDay(folded, 3, now);
    expect(buckets).toHaveLength(3);
    expect(buckets.reduce((a, b) => a + b, 0)).toBe(3);
  });
});

describe("renderBar", () => {
  it("returns padded spaces when max <= 0", () => {
    expect(renderBar(5, 0, 10)).toBe(" ".repeat(10));
  });

  it("renders full-width at value === max", () => {
    expect(renderBar(10, 10, 10)).toBe("█".repeat(10));
  });

  it("uses sub-cell glyphs at 1/8 granularity", () => {
    const bar = renderBar(1, 8, 1); // ratio 12.5% of width 1 = 1 eighth
    expect(bar.length).toBe(1);
    expect("█▉▊▋▌▍▎▏ ".includes(bar)).toBe(true);
  });
});

describe("renderSparkline", () => {
  it("returns empty string for empty input", () => {
    expect(renderSparkline([])).toBe("");
  });

  it("normalises against the max value", () => {
    const s = renderSparkline([1, 2, 4, 8]);
    expect(s.length).toBe(4);
    expect(s[s.length - 1]).toBe("█");
  });
});

describe("formatDuration", () => {
  it("renders ms / s / m fluently", () => {
    expect(formatDuration(750)).toBe("750ms");
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(83_000)).toBe("1m 23s");
  });

  it("returns em-dash sentinel on invalid input", () => {
    expect(formatDuration(NaN)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
  });
});

describe("formatTokens", () => {
  it("uses k / M shorthand at the right thresholds", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_500)).toBe("1.5k");
    expect(formatTokens(70_000)).toBe("70k");
    expect(formatTokens(1_600_000)).toBe("1.60M");
  });
});
