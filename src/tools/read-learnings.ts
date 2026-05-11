import { z } from "zod";
import type { ToolDef } from "./registry.js";
import { readLearnings, tailRecent, type LearningEntry } from "../learning/store.js";
import { formatLearningsForPrompt } from "../learning/format.js";
import { readSquadYaml } from "../config/squad-yaml.js";
import { resolveSafePath, createSafePathContext } from "../util/path-safety.js";
import { AGENT_NAMES_TUPLE } from "../config/ownership-matrix.js";

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

  const allEntries = await readLearnings(safeRoot, { configuredPath });

  // v0.11.0: compute summary over the FULL file before any filter is applied.
  // Counts respect file-level state, not query-level filters.
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

  // v0.11.0 (cycle-2 Blocker B1 fix): promoted entries surface FIRST in
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
  // New flow:
  //   1. Partition visible entries into promoted vs. rest.
  //   2. Cap promoted at MAX_PROMOTED_IN_PROMPT to bound prompt size as
  //      the journal accumulates promoted entries over a project lifetime
  //      (architect cycle-2 Major M2). Pick the most-recent N by ts.
  //   3. Apply the user's agent / decision filter ONLY to `rest` — promoted
  //      entries are team policy and bypass per-agent narrowing by design.
  //   4. Order BOTH lists newest-first.
  //   5. Build the API-visible `entries` array as
  //      `[...promotedNewestFirst, ...restNewestFirst]` so direct API
  //      consumers see promoted at the top.
  //   6. For the render input, REVERSE `entries` once so the formatter's
  //      internal `.reverse()` flips it back to the same shape — promoted
  //      stays at the top of the rendered output. This keeps the formatter
  //      contract (input is chronological-oldest-first) intact for the
  //      existing test suite.
  const MAX_PROMOTED_IN_PROMPT = 10;
  const promoted = visible.filter((e) => e.promoted === true);
  const rest = visible.filter((e) => e.promoted !== true);

  // promoted: sort ascending by ts so slice(-N) returns newest N (in oldest-
  // first order), then reverse to get newest-first.
  const promotedSorted = [...promoted].sort((a, b) => a.ts.localeCompare(b.ts));
  const promotedCappedNewestFirst = [...promotedSorted.slice(-MAX_PROMOTED_IN_PROMPT)].reverse();

  // rest: tailRecent returns tail-N in storage order (oldest-first within
  // the tail). Reverse for newest-first display.
  const restBudget = Math.max(0, input.limit - promotedCappedNewestFirst.length);
  const restTail =
    restBudget > 0
      ? tailRecent(rest, restBudget, {
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
  const rendered =
    input.include_rendered && input.limit > 0
      ? formatLearningsForPrompt([...filtered].reverse(), {
          ...(input.changed_files ? { changedFiles: input.changed_files } : {}),
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
