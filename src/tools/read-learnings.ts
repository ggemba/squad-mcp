import { z } from "zod";
import type { ToolDef } from "./registry.js";
import { readLearnings, tailRecent, type LearningEntry } from "../learning/store.js";
import { formatLearningsForPrompt } from "../learning/format.js";
import { normalizeFindingTitle } from "../learning/normalize.js";
import { readSquadYaml, matchesGlob } from "../config/squad-yaml.js";
import { resolveSafePath, createSafePathContext } from "../util/path-safety.js";
import { AGENT_NAMES_TUPLE } from "../config/ownership-matrix.js";

/**
 * PR2 / Fase 1b — derived-recurrence threshold. An entry whose normalised
 * title (`normalizeFindingTitle(lesson ?? finding)`) recurs at least this
 * many times across the journal is treated as ALWAYS-INJECT — the same role
 * the persisted `promoted` flag plays. Recurrence is DERIVED here at read
 * time and never stored (no `count` field) — see learning/store.ts.
 *
 * 3 mirrors `prune_learnings`' default `min_recurrence` (1× anecdote, 2×
 * pattern, 3× team policy).
 */
const DERIVED_RECURRENCE_THRESHOLD = 3;

/**
 * Count how many entries share each normalised title. Used to derive
 * recurrence without persisting a counter. Title key is
 * `normalizeFindingTitle(lesson ?? finding)`; entries that normalise to an
 * empty key are not counted.
 */
function countRecurrence(entries: LearningEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const title = e.lesson ?? e.finding;
    if (title === undefined) continue;
    const key = normalizeFindingTitle(title);
    if (key.length === 0) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * True when an entry should be treated as always-inject: either it carries
 * the persisted `promoted` flag, or its normalised title recurs ≥ threshold
 * across the journal (derived recurrence).
 */
function isAlwaysInject(e: LearningEntry, recurrence: Map<string, number>): boolean {
  if (e.promoted === true) return true;
  const title = e.lesson ?? e.finding;
  if (title === undefined) return false;
  const key = normalizeFindingTitle(title);
  if (key.length === 0) return false;
  return (recurrence.get(key) ?? 0) >= DERIVED_RECURRENCE_THRESHOLD;
}

const schema = z.object({
  workspace_root: z.string().min(1).max(4096),
  /**
   * Cap rendered/returned entries. Default 50. `0` is a valid sentinel
   * meaning "summary only, no entries" (used by `/squad:stats` to fetch
   * counts without paging the file). Range widened from `positive()` to
   * `nonnegative()` in v0.11.0 to accommodate that.
   */
  limit: z.number().int().nonnegative().max(200).optional().default(50),
  /** When set, restrict to learnings for this agent. */
  agent: z.enum(AGENT_NAMES_TUPLE).optional(),
  /** When set, restrict to accepts or rejects. Default both. */
  decision: z.enum(["accept", "reject"]).optional(),
  /**
   * When set, filter scope-tagged entries to those whose scope glob matches
   * at least one of these files. Entries without a scope always pass.
   */
  changed_files: z.array(z.string().min(1).max(4096)).max(5000).optional(),
  /**
   * When true (default), also return the rendered markdown block ready to
   * inject into an agent / consolidator prompt. When false, only the entries
   * array. Skip the render when the caller will format their own.
   */
  include_rendered: z.boolean().optional().default(true),
  /**
   * v0.11.0+ : when true, include entries with `archived: true` in the
   * result. Default false — archived entries are kept on disk for forensics
   * but suppressed from the active read path. Set true for debug / audit /
   * `/squad:stats` summary panels that need the total count.
   */
  include_archived: z.boolean().optional().default(false),
  /**
   * v0.11.0+ : when true, include a `summary` object on the response with
   * `{total, active, archived, promoted}` counts (computed over the full
   * file, ignoring agent / decision / scope filters but respecting
   * include_archived semantics). Used by `/squad:stats` to surface the
   * journal health line.
   */
  include_summary: z.boolean().optional().default(false),
});

type Input = z.infer<typeof schema>;

export interface LearningsSummary {
  /** Total rows in the journal, including archived. */
  total: number;
  /** Rows visible to the default read path (archived=false). */
  active: number;
  /** Rows with `archived: true`. */
  archived: number;
  /** Rows with `promoted: true`. */
  promoted: number;
}

export interface ReadLearningsOutput {
  entries: LearningEntry[];
  total_in_store: number;
  rendered: string;
  source: string | null;
  /** Present only when input.include_summary === true. */
  summary?: LearningsSummary;
}

/**
 * Read recent learnings from `.squad/learnings.jsonl` (path overridable via
 * `.squad.yaml`.learnings.path). Returns the filtered entries plus a
 * pre-rendered markdown block ready to inject into an agent / consolidator
 * prompt. Pure-ish — reads filesystem, no writes.
 */
export async function readLearningsTool(input: Input): Promise<ReadLearningsOutput> {
  const ctx = createSafePathContext();
  const safeRoot = await resolveSafePath(input.workspace_root, ".", ctx);
  const config = await readSquadYaml(safeRoot);
  // Honor the master switch — if learnings disabled, return empty without
  // touching the filesystem (the user explicitly turned it off).
  if (!config.learnings.enabled) {
    const baseOut: ReadLearningsOutput = {
      entries: [],
      total_in_store: 0,
      rendered: "",
      source: null,
    };
    return input.include_summary
      ? { ...baseOut, summary: { total: 0, active: 0, archived: 0, promoted: 0 } }
      : baseOut;
  }
  const configuredPath = config.learnings.path;

  const allEntriesRaw = await readLearnings(safeRoot, { configuredPath });

  // PR2 journaling guard. The v3 lesson-injection path is gated on the
  // `.squad.yaml` `journaling` switch: when journaling is NOT `opt-in`, any
  // distilled `lesson`-bearing row is dropped before injection so a team
  // that has not opted into auto-journaling never sees auto-distilled rules
  // surface in advisory prompts. Legacy `finding`-only rows (v2 and v3
  // without a `lesson`) are unaffected — the existing `/squad:review` flow
  // keeps working regardless of the journaling switch. The guard lives HERE
  // at the tool level, not inside the pure `formatLearningsForPrompt`, which
  // stays version-agnostic.
  const journalingOptIn = config.journaling === "opt-in";
  const allEntries = journalingOptIn
    ? allEntriesRaw
    : allEntriesRaw.filter((e) => e.lesson === undefined);

  // Compute summary over the journaling-visible entries (post journaling
  // guard, pre agent/decision/scope query filters). When journaling is not
  // opt-in, v3 lesson rows are already excluded from `allEntries`, so the
  // summary reflects what the tool exposes — not the raw file row count.
  const summary: LearningsSummary | undefined = input.include_summary
    ? {
        total: allEntries.length,
        active: allEntries.filter((e) => !e.archived).length,
        archived: allEntries.filter((e) => e.archived === true).length,
        promoted: allEntries.filter((e) => e.promoted === true).length,
      }
    : undefined;

  // v0.11.0: default read suppresses archived entries. include_archived: true
  // opts back in (debug / audit / stats panel surfacing).
  const visible = input.include_archived
    ? allEntries
    : allEntries.filter((e) => e.archived !== true);

  // v0.11.0 (cycle-2 Blocker B1 fix): always-inject entries surface FIRST in
  // BOTH the entries[] array (API view for direct callers) AND in the
  // rendered markdown block (LLM prompt view).
  //
  // The previous implementation built `[...promoted, ...rest]` and passed
  // it through `tailRecent.slice(-limit)`, which is a TAIL slice — so
  // promoted entries (sitting at the HEAD) were silently dropped the
  // moment `entries.length > limit`. Worse, `formatLearningsForPrompt`
  // reverses the array before rendering, so even in small fixtures the
  // promoted entries landed at the BOTTOM of the rendered output.
  //
  // PR2: the "always-inject" set is no longer just the persisted `promoted`
  // flag. It now also includes DERIVED-recurrence entries — an entry whose
  // normalised title recurs ≥ DERIVED_RECURRENCE_THRESHOLD across the
  // journal is treated identically to a promoted entry (always injected,
  // bypassing the trigger/scope glob filter). Recurrence is counted over
  // the journaling-filtered `allEntries` so an opted-out team's v3 lessons
  // never contribute to a count. Entries below the threshold inject only on
  // a `trigger` (or legacy `scope`) glob match — that filtering happens
  // inside `formatLearningsForPrompt` via `changedFiles`.
  //
  // Flow (otherwise unchanged from the cycle-2 B1 fix):
  //   1. Partition visible entries into always-inject vs. rest.
  //   2. Cap always-inject at MAX_PROMOTED_IN_PROMPT to bound prompt size.
  //   3. Apply the user's agent / decision filter ONLY to `rest`.
  //   4. Order BOTH lists newest-first.
  //   5. Build `entries` as `[...alwaysFirst, ...restNewestFirst]`.
  //   6. Reverse once before the formatter so its internal `.reverse()`
  //      restores the shape — always-inject stays at the top of the render.
  const MAX_PROMOTED_IN_PROMPT = 10;
  const recurrence = countRecurrence(allEntries);
  const promoted = visible.filter((e) => isAlwaysInject(e, recurrence));
  const rest = visible.filter((e) => !isAlwaysInject(e, recurrence));

  // promoted: sort ascending by ts so slice(-N) returns newest N (in oldest-
  // first order), then reverse to get newest-first.
  const promotedSorted = [...promoted].sort((a, b) => a.ts.localeCompare(b.ts));
  const promotedCappedNewestFirst = [...promotedSorted.slice(-MAX_PROMOTED_IN_PROMPT)].reverse();

  // rest: glob-filter by `changed_files` BEFORE the tail slice. An entry
  // without a trigger/scope tag is repo-wide and always passes; a tagged
  // entry passes only when a changed file matches its `trigger` (or legacy
  // `scope`) glob. This filtering happens HERE (not in the formatter) so the
  // always-inject set above bypasses it — a derived-recurrence entry is
  // injected regardless of whether its trigger matches the current diff,
  // exactly like a `promoted` entry. The formatter is then called WITHOUT
  // `changedFiles` so it does not re-filter the always-inject portion.
  const restScoped =
    input.changed_files && input.changed_files.length > 0
      ? rest.filter((e) => {
          const tag = e.trigger ?? e.scope;
          if (!tag) return true;
          return input.changed_files!.some((p) => matchesGlob(tag, p));
        })
      : rest;

  // rest: tailRecent returns tail-N in storage order (oldest-first within
  // the tail). Reverse for newest-first display.
  const restBudget = Math.max(0, input.limit - promotedCappedNewestFirst.length);
  const restTail =
    restBudget > 0
      ? tailRecent(restScoped, restBudget, {
          ...(input.agent !== undefined ? { agent: input.agent } : {}),
          ...(input.decision !== undefined ? { decision: input.decision } : {}),
        })
      : [];
  const restTailNewestFirst = [...restTail].reverse();

  // API-visible entries: promoted first, newest-within-each-group first.
  const filtered = input.limit === 0 ? [] : [...promotedCappedNewestFirst, ...restTailNewestFirst];

  // Format-input shape: chronological oldest-first. Since `filtered` is
  // already in newest-first display order, reverse it before handing to
  // the formatter (the formatter's internal `.reverse()` flips it back).
  // This is the load-bearing detail that keeps the existing
  // `learning-format.test.ts` contract intact while also putting promoted
  // entries at the top of the rendered output (cycle-2 Blocker B1 fix).
  //
  // `changedFiles` is deliberately NOT passed to the formatter: the `rest`
  // partition was already glob-filtered above, and the always-inject
  // partition must bypass glob filtering entirely. Passing `changedFiles`
  // here would re-filter and silently drop always-inject entries that carry
  // a non-matching `trigger`.
  const rendered =
    input.include_rendered && input.limit > 0
      ? formatLearningsForPrompt([...filtered].reverse(), {
          limit: input.limit,
        })
      : "";

  const baseOut: ReadLearningsOutput = {
    entries: filtered,
    total_in_store: allEntries.length,
    rendered,
    source:
      allEntries.length > 0 ? `${safeRoot}/${configuredPath ?? ".squad/learnings.jsonl"}` : null,
  };
  return summary ? { ...baseOut, summary } : baseOut;
}

export const readLearningsToolDef: ToolDef<typeof schema> = {
  name: "read_learnings",
  description:
    "Read recent team decisions from `.squad/learnings.jsonl` (path overridable via .squad.yaml.learnings.path). " +
    "Returns the filtered entries plus a pre-rendered markdown block ready to inject into agent / consolidator prompts. " +
    "Filters: agent, decision (accept|reject), changed_files (matches scoped entries against these paths). " +
    "Used by the /squad:review skill in Phase 5 (advisory) and Phase 10 (consolidation) to make the squad less repetitive over time.",
  schema,
  handler: readLearningsTool,
};
