import type { AgentName } from "../config/ownership-matrix.js";
import {
  decodeSeverityScore,
  INVOCATION_VALUES,
  type RunRecord,
  type RunInvocation,
  type RunVerdict,
  type RunStatus,
} from "./store.js";

/**
 * SQUAD RUNS AGGREGATION + RENDERING. Pure functions only — no I/O, no
 * Date.now() side effects (clock is an injected parameter for testability).
 *
 * Per architect A-1 (cycle 1), this module folds in: token estimation
 * (CHARS_PER_TOKEN_ESTIMATE + estimateTokens), record folding (pair
 * `in_flight` with `completed | aborted` by id), aggregation views (outcomes
 * + health, kept as separate read shapes per A-2), Unicode renderers (bar,
 * sparkline — no ANSI; coloring happens in the skill layer).
 *
 * Per architect A-5, tokens are exposed only via `getEstTokens(record)` —
 * the aggregator never branches on `est_tokens_method`. The metadata stays
 * in the record for audit / future swap to host telemetry.
 */

/**
 * Rough English-prose-to-tokens conversion ratio. The actual Anthropic
 * tokenizer varies by content type (prose ≈ 4 chars/token, dense code
 * ≈ 2.5 chars/token), so 3.5 is a deliberately middle-of-the-road value
 * for mixed dev workloads. The stats skill labels every token figure as
 * "estimated (chars ÷ 3.5)" so users understand it's a rough indicator,
 * not an invoice. Sub-folded into one constant so future swaps to host
 * telemetry can simply rename the method tag.
 */
export const CHARS_PER_TOKEN_ESTIMATE = 3.5;

/** Convert character count to estimated token count. Floor for stability. */
export function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.floor(chars / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * Per-record token rollup. Architect A-5 enforcement point: ALL token
 * arithmetic flows through this getter. The aggregator must never read
 * `record.agents[i].prompt_chars` directly without going through here,
 * so a future host-telemetry record (`est_tokens_method:
 * "host-telemetry-v1"` with `tokens` fields populated and `chars` zero)
 * silently substitutes without breaking aggregation math.
 */
export function getEstTokens(record: RunRecord): { input: number; output: number; total: number } {
  let input = 0;
  let output = 0;
  for (const a of record.agents) {
    input += estimateTokens(a.prompt_chars);
    output += estimateTokens(a.response_chars);
  }
  return { input, output, total: input + output };
}

/** Per-agent token rollup across a run set. */
export function getEstTokensPerAgent(
  records: RunRecord[],
): Map<AgentName, { input: number; output: number; total: number }> {
  const out = new Map<AgentName, { input: number; output: number; total: number }>();
  for (const r of records) {
    for (const a of r.agents) {
      const acc = out.get(a.name) ?? { input: 0, output: 0, total: 0 };
      acc.input += estimateTokens(a.prompt_chars);
      acc.output += estimateTokens(a.response_chars);
      acc.total = acc.input + acc.output;
      out.set(a.name, acc);
    }
  }
  return out;
}

/**
 * Strip C0 (`\x00`-`\x1F` except `\t`), C1 (`\x7F`-`\x9F`), and ESC (`\x1B`)
 * from a string before rendering it into a colored output panel.
 *
 * Security #5 mitigation: recorded fields like `mode_warning.message` are
 * partially user-influenceable. An attacker who can stuff `\x1B[2J\x1B[H`
 * (clear screen) or `\x1B]0;evil\x07` (set window title) into the journal
 * would otherwise see it rendered into the user's terminal. We sanitize
 * at the rendering boundary — the recorded data stays intact for forensics.
 */
export function stripControlChars(s: string): string {
  // Tab (\x09) is preserved; everything else in C0/C1 ranges + ESC is dropped.
  // U+007F (DEL) sits in the C1 range we strip; spaces (U+0020+) are kept.
  return s.replace(/[\x00-\x08\x0A-\x1F\x7F-\x9F]/g, "");
}

/* -------------------------------------------------------------------------- */
/* Fold: pair in_flight + completed/aborted rows by id                        */
/* -------------------------------------------------------------------------- */

/**
 * Time-to-live for an unpaired `in_flight` row before the aggregator treats
 * it as `aborted`. Cycle 2 lowered from 24h → 1h because users were seeing
 * crashed runs stuck as "still running" indefinitely in stats (developer
 * Major #3).
 */
export const IN_FLIGHT_TTL_MS = 60 * 60 * 1000;

export interface FoldedRun {
  id: string;
  /**
   * Effective status after folding. `completed | aborted` if a finalization
   * row exists; `in_flight` if only the Phase-1 row is present and recent;
   * `aborted` (synthesized) if Phase-1 row is older than IN_FLIGHT_TTL_MS
   * with no finalization.
   */
  status: RunStatus;
  /** The chosen record after pair-resolution (finalization row when present). */
  record: RunRecord;
  /** True if this run was synthesized from a stranded in_flight row. */
  synthesized_aborted: boolean;
}

/**
 * Pair rows by id. Tiebreaker per QA cycle-2 finding: when two completed
 * rows share an id (Phase-10 retry, host crash + resume), pick the one
 * with the LATEST `started_at`; if those tie, the one that appears LATER
 * in the input array (which corresponds to later file position because
 * `readRuns` preserves append order). The chosen rule is documented so
 * a future contributor doesn't silently swap to a different sort key.
 */
export function foldById(records: RunRecord[], now: number = Date.now()): FoldedRun[] {
  // Carry the append position on each row at collection time so the tiebreaker
  // sort is O(g log g) per group instead of O(g² · n) — the previous shape
  // re-scanned `indexed` with findIndex inside the sort comparator (developer
  // cycle-2 Major #2).
  interface Indexed {
    rec: RunRecord;
    pos: number;
  }
  const byId = new Map<string, Indexed[]>();
  let idx = 0;
  for (const rec of records) {
    const wrapped: Indexed = { rec, pos: idx++ };
    const acc = byId.get(rec.id) ?? [];
    acc.push(wrapped);
    byId.set(rec.id, acc);
  }

  const folded: FoldedRun[] = [];
  for (const [id, group] of byId) {
    // Prefer the last completed/aborted row (terminal wins over in_flight).
    const terminals = group.filter(
      (w) => w.rec.status === "completed" || w.rec.status === "aborted",
    );
    if (terminals.length > 0) {
      // Sort by (started_at ASC, append-position ASC). Last wins. Comparator is
      // O(1) because `pos` is precomputed.
      terminals.sort((a, b) => {
        if (a.rec.started_at !== b.rec.started_at)
          return a.rec.started_at.localeCompare(b.rec.started_at);
        return a.pos - b.pos;
      });
      const winner = terminals[terminals.length - 1]!.rec;
      folded.push({ id, status: winner.status, record: winner, synthesized_aborted: false });
      continue;
    }
    // No terminal row. The in_flight is either still running or stranded.
    // We compare against the latest started_at (group is small; usually 1 row).
    const inflight = group.find((w) => w.rec.status === "in_flight")?.rec;
    if (!inflight) {
      // Pathological: rows exist but none is in_flight or terminal. Shouldn't
      // happen under our writer contract; skip silently rather than throw.
      continue;
    }
    const startedMs = Date.parse(inflight.started_at);
    const ageMs = Number.isFinite(startedMs) ? now - startedMs : 0;
    if (ageMs > IN_FLIGHT_TTL_MS) {
      // Synthesize an aborted view. The on-disk row is unchanged (no rewrite);
      // the aggregator just reports it as aborted for stats purposes.
      folded.push({
        id,
        status: "aborted",
        record: { ...inflight, status: "aborted" },
        synthesized_aborted: true,
      });
    } else {
      folded.push({ id, status: "in_flight", record: inflight, synthesized_aborted: false });
    }
  }
  return folded;
}

/* -------------------------------------------------------------------------- */
/* Filters                                                                    */
/* -------------------------------------------------------------------------- */

export interface RunFilter {
  /** ISO 8601 start of inclusive range. */
  since?: string;
  /** Cap output to the most recent N runs. */
  limit?: number;
  /** Restrict to runs that included this agent (any role). */
  agent?: AgentName;
  /** Restrict to a single verdict. */
  verdict?: RunVerdict;
  /** Restrict to a single mode. */
  mode?: "quick" | "normal" | "deep";
  /** Restrict to a single invocation. */
  invocation?: RunInvocation;
}

export function applyFilters(folded: FoldedRun[], filter: RunFilter): FoldedRun[] {
  let out = folded;
  if (filter.since) {
    const sinceMs = Date.parse(filter.since);
    if (Number.isFinite(sinceMs)) {
      out = out.filter((f) => {
        const t = Date.parse(f.record.started_at);
        return Number.isFinite(t) ? t >= sinceMs : false;
      });
    }
  }
  if (filter.invocation) out = out.filter((f) => f.record.invocation === filter.invocation);
  if (filter.mode) out = out.filter((f) => f.record.mode === filter.mode);
  if (filter.verdict) {
    out = out.filter((f) => f.record.verdict === filter.verdict);
  }
  if (filter.agent) {
    out = out.filter((f) => f.record.agents.some((a) => a.name === filter.agent));
  }
  if (typeof filter.limit === "number" && filter.limit > 0) {
    // "Most recent N" — sort by started_at desc, take N, then re-sort asc
    // so downstream consumers see chronological order.
    const sorted = [...out].sort((a, b) => b.record.started_at.localeCompare(a.record.started_at));
    out = sorted.slice(0, filter.limit).reverse();
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Aggregation: outcomes (rubric) + health (operational)                       */
/* -------------------------------------------------------------------------- */

export interface OutcomeAggregate {
  total_runs: number;
  verdict_counts: Record<RunVerdict, number>;
  verdict_total: number;
  score_buckets: { range: string; count: number; min: number; max: number }[];
  invocation_counts: Record<RunInvocation, number>;
  est_tokens_total: { input: number; output: number; total: number };
  est_tokens_per_run_avg: number;
  est_tokens_per_agent: Map<AgentName, { input: number; output: number; total: number }>;
  /**
   * True when the underlying journal has zero runs. The skill renders a
   * dedicated "no runs yet" empty-state when this is set rather than a
   * panel full of zero bars.
   */
  is_empty: boolean;
}

export interface HealthAggregate {
  total_runs: number;
  in_flight: number;
  completed: number;
  aborted: number;
  synthesized_aborted: number;
  /** Average batch_duration_ms across all agents in all folded runs. */
  avg_batch_duration_ms_per_agent: Map<AgentName, number>;
  /** Sum of batch_duration_ms per run, averaged across runs. */
  avg_total_duration_ms: number;
}

/** Verdict histogram + score distribution. Excludes null-verdict (question/brainstorm). */
export function aggregateOutcomes(folded: FoldedRun[]): OutcomeAggregate {
  const verdict_counts: Record<RunVerdict, number> = {
    APPROVED: 0,
    CHANGES_REQUIRED: 0,
    REJECTED: 0,
  };
  let verdict_total = 0;
  const score_buckets = [
    { range: "90-100", count: 0, min: 90, max: 100 },
    { range: "80-89", count: 0, min: 80, max: 89 },
    { range: "70-79", count: 0, min: 70, max: 79 },
    { range: "<70", count: 0, min: 0, max: 69 },
  ];
  // Initialise every invocation key to 0 from the canonical tuple. Keeps this
  // initialiser auto-extending when `INVOCATION_VALUES` grows; the `Record<
  // RunInvocation, number>` cast is type-safe because the tuple is the type's
  // single source of truth.
  const invocation_counts = Object.fromEntries(INVOCATION_VALUES.map((v) => [v, 0])) as Record<
    RunInvocation,
    number
  >;
  let inputTotal = 0;
  let outputTotal = 0;
  const perAgent = new Map<AgentName, { input: number; output: number; total: number }>();
  let agentBearingRuns = 0;

  for (const f of folded) {
    invocation_counts[f.record.invocation] = (invocation_counts[f.record.invocation] ?? 0) + 1;
    const tokens = getEstTokens(f.record);
    inputTotal += tokens.input;
    outputTotal += tokens.output;
    if (f.record.agents.length > 0) agentBearingRuns++;

    for (const a of f.record.agents) {
      const acc = perAgent.get(a.name) ?? { input: 0, output: 0, total: 0 };
      acc.input += estimateTokens(a.prompt_chars);
      acc.output += estimateTokens(a.response_chars);
      acc.total = acc.input + acc.output;
      perAgent.set(a.name, acc);
    }

    // Verdict histogram + score buckets ONLY for terminal rubric-bearing runs.
    // question/brainstorm have verdict===null and are skipped from rubric
    // panels but already counted in token totals above (QA M1).
    if (f.status !== "completed") continue;
    if (f.record.verdict !== null && f.record.verdict !== undefined) {
      verdict_counts[f.record.verdict]++;
      verdict_total++;
    }
    const score = f.record.weighted_score;
    if (typeof score === "number" && Number.isFinite(score)) {
      const bucket = score_buckets.find((b) => score >= b.min && score <= b.max);
      if (bucket) bucket.count++;
    }
  }

  const totalTokens = inputTotal + outputTotal;
  return {
    total_runs: folded.length,
    verdict_counts,
    verdict_total,
    score_buckets,
    invocation_counts,
    est_tokens_total: { input: inputTotal, output: outputTotal, total: totalTokens },
    est_tokens_per_run_avg: agentBearingRuns > 0 ? Math.floor(totalTokens / agentBearingRuns) : 0,
    est_tokens_per_agent: perAgent,
    is_empty: folded.length === 0,
  };
}

/** Operational telemetry: in_flight/aborted/completed counts + batch times. */
export function aggregateHealth(folded: FoldedRun[]): HealthAggregate {
  let in_flight = 0;
  let completed = 0;
  let aborted = 0;
  let synthesized_aborted = 0;
  const agentDurations = new Map<AgentName, { sum: number; n: number }>();
  let totalDurationSum = 0;
  let totalDurationN = 0;

  for (const f of folded) {
    if (f.status === "in_flight") in_flight++;
    else if (f.status === "completed") completed++;
    else aborted++;
    if (f.synthesized_aborted) synthesized_aborted++;

    let runTotal = 0;
    for (const a of f.record.agents) {
      const acc = agentDurations.get(a.name) ?? { sum: 0, n: 0 };
      acc.sum += a.batch_duration_ms;
      acc.n++;
      agentDurations.set(a.name, acc);
      runTotal += a.batch_duration_ms;
    }
    if (f.record.agents.length > 0) {
      totalDurationSum += runTotal;
      totalDurationN++;
    }
  }

  const avg_batch_duration_ms_per_agent = new Map<AgentName, number>();
  for (const [name, { sum, n }] of agentDurations) {
    avg_batch_duration_ms_per_agent.set(name, n > 0 ? Math.floor(sum / n) : 0);
  }

  return {
    total_runs: folded.length,
    in_flight,
    completed,
    aborted,
    synthesized_aborted,
    avg_batch_duration_ms_per_agent,
    avg_total_duration_ms: totalDurationN > 0 ? Math.floor(totalDurationSum / totalDurationN) : 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Trend: runs/day sparkline buckets                                          */
/* -------------------------------------------------------------------------- */

/**
 * Bucket runs into `days` daily counts, ending at `now`. Returns an array
 * of length `days` (oldest first). Used by the skill to render a sparkline.
 */
export function trendByDay(folded: FoldedRun[], days: number, now: number = Date.now()): number[] {
  const buckets = new Array<number>(days).fill(0);
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const oldest = now - days * ONE_DAY_MS;
  for (const f of folded) {
    const t = Date.parse(f.record.started_at);
    if (!Number.isFinite(t)) continue;
    if (t < oldest || t > now) continue;
    const idx = Math.min(days - 1, Math.floor((t - oldest) / ONE_DAY_MS));
    if (idx >= 0 && idx < days) buckets[idx]!++;
  }
  return buckets;
}

/* -------------------------------------------------------------------------- */
/* Plain Unicode renderers — no ANSI inside the MCP server (architect)       */
/* -------------------------------------------------------------------------- */

const FULL_BLOCKS = "█▉▊▋▌▍▎▏";

/**
 * Render a horizontal bar. `value/max` determines fill ratio; `width` is
 * the total cell count. Uses Unicode block characters at 1/8 granularity
 * for sub-cell precision so a value of "26% of width 10" renders as
 * `██▌       ` rather than rounding to `██        `.
 */
export function renderBar(value: number, max: number, width: number): string {
  if (max <= 0 || !Number.isFinite(value) || value < 0) return " ".repeat(width);
  const clamped = Math.min(value, max);
  const ratio = clamped / max;
  const totalEighths = Math.round(ratio * width * 8);
  const fullBlocks = Math.floor(totalEighths / 8);
  const remainderEighths = totalEighths % 8;
  let out = "█".repeat(fullBlocks);
  if (remainderEighths > 0 && fullBlocks < width) {
    out += FULL_BLOCKS[8 - remainderEighths];
  }
  return out.padEnd(width, " ");
}

const SPARK_GLYPHS = "▁▂▃▄▅▆▇█";

/** Render a series of values as a Unicode sparkline. */
export function renderSparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values, 1);
  let out = "";
  for (const v of values) {
    if (!Number.isFinite(v) || v <= 0) {
      out += SPARK_GLYPHS[0];
      continue;
    }
    const idx = Math.min(SPARK_GLYPHS.length - 1, Math.floor((v / max) * SPARK_GLYPHS.length));
    out += SPARK_GLYPHS[idx];
  }
  return out;
}

/** Convert ms to a short human-readable form: "750ms", "12s", "1m 23s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** Format a token count in the conventional "1.6M", "70k" shorthand. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

/* -------------------------------------------------------------------------- */
/* Language-aware supplements A/B impact (v0.13+).                            */
/* -------------------------------------------------------------------------- */

/**
 * Per-agent A/B contrast for the v0.13 language-supplement feature.
 *
 * For each LANGUAGE_AWARE_AGENT we bucket their `(run, agent_metrics)` pairs
 * into:
 *  - `with_supplement`: the agent appears in `record.language_supplements
 *    .agents_with_supplement` for that run. The supplement was injected into
 *    the agent's prompt at dispatch time.
 *  - `without_supplement`: the run has `language_supplements.injected: false`
 *    OR the agent was not in the supplemented set even though the run was
 *    eligible for supplementation (detection succeeded). This is the natural
 *    counterfactual.
 *
 * `delta_score` is `with.avg_score - without.avg_score`. A positive number
 * means agents scored higher with the supplement on. NULL when either side
 * has fewer than `min_n` rows (default 10) — guards against the noise floor
 * of a tiny journal.
 *
 * Records WITHOUT the `language_supplements` field (older or unrelated
 * invocations like debug/brainstorm) are excluded from both buckets — they
 * carry no signal about the v0.13 path.
 *
 * Pure: no I/O, no clock. Same shape contract as the rest of aggregate.ts.
 */
export interface SupplementImpactPerAgent {
  agent: AgentName;
  with_supplement: SupplementBucketStats;
  without_supplement: SupplementBucketStats;
  /** `with.avg_score − without.avg_score`, or `null` if either side under min_n. */
  delta_score: number | null;
  /** `with.avg_severity_score − without.avg_severity_score`, or `null`. Lower is better. */
  delta_severity_score: number | null;
}

export interface SupplementBucketStats {
  /** Number of (run, agent) pairs in this bucket. */
  n: number;
  /** Mean of non-null `score` values in this bucket. `null` when n=0 or all scores are null. */
  avg_score: number | null;
  /** Mean of non-null `severity_score` values. `null` when n=0 or all are null. */
  avg_severity_score: number | null;
}

/**
 * Walk the run journal and return per-agent A/B comparisons of supplemented
 * vs un-supplemented dispatch outcomes.
 *
 *  - `min_n` (default 10) gates `delta_*` to `null` when sample size is small.
 *    Tune down for unit tests, never below 1 in production usage.
 *  - Only terminal records (`completed | aborted`) contribute — `in_flight`
 *    rows have null scores and would skew the means.
 *  - Records lacking `language_supplements` are skipped entirely (not
 *    counted as "without"); the contrast is only meaningful between runs
 *    where the v0.13 path actually ran.
 */
export function aggregateLanguageSupplementImpact(
  records: readonly RunRecord[],
  options: { min_n?: number } = {},
): SupplementImpactPerAgent[] {
  const minN = options.min_n ?? 10;
  // Build a map: agent -> { with: { n, scores[], sevs[] }, without: { n, scores[], sevs[] } }
  // `n` counts dispatches (one per (agent, run) pair) regardless of whether
  // the agent emitted a score on that run. Means are computed only from the
  // non-null subset, so a non-rubric dispatch contributes to n but not to
  // avg_score / avg_severity_score.
  type Bucket = { n: number; scores: number[]; sevs: number[] };
  const buckets = new Map<AgentName, { with: Bucket; without: Bucket }>();

  for (const r of records) {
    if (r.status === "in_flight") continue;
    if (!r.language_supplements) continue;
    const supplemented = new Set<AgentName>(r.language_supplements.agents_with_supplement);
    for (const a of r.agents) {
      // Only LANGUAGE_AWARE_AGENTS matter for this contrast — but instead of
      // hard-coding the allowlist here (would create a second SoT), we infer:
      // an agent is language-aware iff it appears in some supplemented set
      // OR its run had `injected: true` and that agent's name is omitted —
      // the second form catches "implementer was eligible but the squad
      // didn't dispatch it this round" only weakly. Simplest robust rule:
      // accept any agent that appears in `agents_with_supplement` across the
      // FULL set. We learn the agent membership from data, not config.
      // (The `LANGUAGE_AWARE_AGENTS` const is the SoT for runtime; this
      // aggregate stays decoupled so adding a 5th language-aware agent
      // doesn't require touching aggregate.ts.)
      const inWith = supplemented.has(a.name);
      const inWithout =
        !inWith &&
        (r.language_supplements.injected || r.language_supplements.confidence !== "none");
      if (!inWith && !inWithout) continue;
      const slot = buckets.get(a.name) ?? {
        with: { n: 0, scores: [], sevs: [] },
        without: { n: 0, scores: [], sevs: [] },
      };
      const target = inWith ? slot.with : slot.without;
      target.n += 1;
      if (a.score !== null) target.scores.push(a.score);
      if (a.severity_score !== null) target.sevs.push(a.severity_score);
      buckets.set(a.name, slot);
    }
  }

  const out: SupplementImpactPerAgent[] = [];
  for (const [agent, b] of buckets) {
    const w = bucketStats(b.with);
    const wo = bucketStats(b.without);
    const deltaScore =
      w.n >= minN && wo.n >= minN && w.avg_score !== null && wo.avg_score !== null
        ? round2(w.avg_score - wo.avg_score)
        : null;
    const deltaSev =
      w.n >= minN && wo.n >= minN && w.avg_severity_score !== null && wo.avg_severity_score !== null
        ? round2(w.avg_severity_score - wo.avg_severity_score)
        : null;
    out.push({
      agent,
      with_supplement: w,
      without_supplement: wo,
      delta_score: deltaScore,
      delta_severity_score: deltaSev,
    });
  }
  // Stable order — by agent name — so a renderer can rely on it for diffs.
  out.sort((x, y) => x.agent.localeCompare(y.agent));
  return out;
}

function bucketStats(b: { n: number; scores: number[]; sevs: number[] }): SupplementBucketStats {
  return {
    n: b.n,
    avg_score: b.scores.length
      ? round2(b.scores.reduce((s, n) => s + n, 0) / b.scores.length)
      : null,
    avg_severity_score: b.sevs.length
      ? round2(b.sevs.reduce((s, n) => s + n, 0) / b.sevs.length)
      : null,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/* Suggestion: re-emit decoded severity counts when needed (not for stats     */
/* main panels — kept for future drill-down view).                            */
/* -------------------------------------------------------------------------- */
export { decodeSeverityScore };
