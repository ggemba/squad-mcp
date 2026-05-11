import { z } from "zod";
import path from "node:path";
import type { ToolDef } from "./registry.js";
import { readLearnings, DEFAULT_LEARNING_PATH, type LearningEntry } from "../learning/store.js";
import { normalizeFindingTitle } from "../learning/normalize.js";
import { atomicRewriteJsonl } from "../util/atomic-rewrite-jsonl.js";
import { readSquadYaml } from "../config/squad-yaml.js";
import { resolveSafePath, createSafePathContext } from "../util/path-safety.js";
import { SquadError } from "../errors.js";
import { ensureRelativeInsideRoot } from "../util/path-safety.js";
import { logger } from "../observability/logger.js";

/**
 * Lifecycle maintenance for `.squad/learnings.jsonl` (v0.11.0+).
 *
 * Two passes, both running inside the same atomic-rewrite (lock + rename-
 * rename) under `withFileLock`:
 *
 *   1. **Age cutoff** — when `max_age_days > 0`, entries whose `ts` is older
 *      than `now - max_age_days` are marked `archived: true`. Archived
 *      entries stay on disk for forensics; they are suppressed from the
 *      default `read_learnings` read path (use `include_archived: true` to
 *      surface them).
 *
 *   2. **Promotion** — entries are grouped by `normalizeFindingTitle(finding)`.
 *      For each group, the number of `decision: "accept"` entries that are
 *      NOT already archived is counted. When the count is ≥ `min_recurrence`,
 *      the most-recent accepted entry in the group is marked `promoted: true`
 *      (the rest stay un-promoted to avoid noisy duplicates in the rendered
 *      block). Promoted entries surface FIRST in `read_learnings` output
 *      regardless of scope match — they represent crystallised team policy.
 *
 * **Never auto-runs.** The default `max_age_days` is `0` (= disabled) so
 * invoking the tool with no input is a safe no-op. Users who want regular
 * housekeeping run it themselves (or wire a cron / git pre-commit hook).
 *
 * **Auditability**: pruning produces a diff on the on-disk journal. Repos
 * that commit `.squad/learnings.jsonl` should expect a non-trivial diff
 * after a non-no-op run. The `.prev` snapshot from the atomic rewrite is
 * the rollback point.
 *
 * **Race safety**: the entire read-modify-write happens under the file
 * lock used by `appendLearning`. Concurrent appenders block until the
 * prune finishes; concurrent readers (no lock by design) see either the
 * pre-prune or post-prune file in full because rename-into-place is
 * atomic on POSIX same-filesystem renames.
 */

const schema = z.object({
  workspace_root: z.string().min(1).max(4096),
  /**
   * Age cutoff in days. Entries older than `now - max_age_days` are marked
   * archived. Default `0` (= disabled — explicit user opt-in required).
   * The plan v2 default departs from the plan v1 default of 180 to avoid
   * surprising diff churn on repos that commit the journal.
   */
  max_age_days: z.number().int().nonnegative().max(36500).optional().default(0),
  /**
   * Promotion threshold. A finding-title group with ≥ this many accept
   * decisions (across all agents, after archival) earns a `promoted: true`
   * flag on its most-recent entry. Default 3 (1× = anecdote; 2× = pattern;
   * 3× = team policy). Set 0 to disable promotion entirely. `1` is rejected
   * because it would mark every singleton accept as promoted — defeating the
   * "this is team policy" signal (developer cycle-2 Major M5).
   */
  min_recurrence: z
    .number()
    .int()
    .nonnegative()
    .max(1000)
    .optional()
    .default(3)
    .refine(
      (n) => n !== 1,
      "min_recurrence must be 0 (disable promotion) or >= 2 (a singleton accept is not recurrence)",
    ),
  /**
   * When true, compute counts without writing. Useful for "what would this
   * do?" inspection before running the destructive pass.
   */
  dry_run: z.boolean().optional().default(false),
});

type Input = z.infer<typeof schema>;

export interface PruneLearningsOutput {
  ok: true;
  file: string;
  total: number;
  archived_count: number;
  promoted_count: number;
  unchanged_count: number;
  dry_run: boolean;
}

function resolveLearningPath(safeRoot: string, configuredPath: string | undefined): string {
  if (configuredPath !== undefined) {
    ensureRelativeInsideRoot(safeRoot, configuredPath, "learnings.path");
    return path.resolve(safeRoot, configuredPath);
  }
  return path.resolve(safeRoot, DEFAULT_LEARNING_PATH);
}

export async function pruneLearningsTool(input: Input): Promise<PruneLearningsOutput> {
  // v0.11.0 cycle-2 (developer Major M5): defense-in-depth guard against
  // `min_recurrence: 1`. The schema's `.refine` only fires when the call
  // goes through the dispatch registry; direct programmatic callers (and
  // the test suite) bypass it. A runtime check inside the handler closes
  // that gap so the contract holds regardless of entry point.
  if (input.min_recurrence === 1) {
    throw new SquadError(
      "INVALID_INPUT",
      "min_recurrence must be 0 (disable promotion) or >= 2 (a singleton accept is not recurrence — `1` would promote every one-off finding)",
      { received: 1 },
    );
  }

  const ctx = createSafePathContext();
  const safeRoot = await resolveSafePath(input.workspace_root, ".", ctx);
  const config = await readSquadYaml(safeRoot);

  // If learnings is disabled at config level, treat as no-op rather than
  // implicitly enabling it via the prune tool.
  if (!config.learnings.enabled) {
    const filePath = resolveLearningPath(safeRoot, config.learnings.path);
    return {
      ok: true,
      file: filePath,
      total: 0,
      archived_count: 0,
      promoted_count: 0,
      unchanged_count: 0,
      dry_run: input.dry_run,
    };
  }

  const configuredPath = config.learnings.path;
  const filePath = resolveLearningPath(safeRoot, configuredPath);

  const entries = await readLearnings(safeRoot, {
    ...(configuredPath !== undefined ? { configuredPath } : {}),
  });

  if (entries.length === 0) {
    return {
      ok: true,
      file: filePath,
      total: 0,
      archived_count: 0,
      promoted_count: 0,
      unchanged_count: 0,
      dry_run: input.dry_run,
    };
  }

  // ---------------------------------------------------------------------------
  // Pass 1: age cutoff
  // ---------------------------------------------------------------------------
  // v0.11.0 cycle-2 (developer Major M4): track changed indices in a Set
  // instead of computing `unchangedCount = total - (archived + promoted)`
  // arithmetically. The arithmetic was structurally fragile — it relied on
  // three invariants holding simultaneously (Pass 2 skips archived; Pass 2
  // skips already-promoted; Pass 1 doesn't read promoted). A future drift
  // in any of those would silently break the count. The Set approach is
  // robust under refactoring: an index in the Set means "this row mutated
  // this pass", regardless of how many fields changed.
  const changedIndices = new Set<number>();

  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const cutoffMs = input.max_age_days > 0 ? nowMs - input.max_age_days * ONE_DAY_MS : -Infinity;

  let archivedCount = 0;
  const stage1: LearningEntry[] = entries.map((e, idx) => {
    if (e.archived === true) return e;
    const tsMs = Date.parse(e.ts);
    if (!Number.isFinite(tsMs)) return e;
    if (tsMs < cutoffMs) {
      archivedCount++;
      changedIndices.add(idx);
      return { ...e, archived: true };
    }
    return e;
  });

  // ---------------------------------------------------------------------------
  // Pass 2: promotion by normalised-title recurrence
  // ---------------------------------------------------------------------------
  let promotedCount = 0;
  let stage2: LearningEntry[] = stage1;

  if (input.min_recurrence > 0) {
    // Group indices by normalised title. We carry indices (not entries) so
    // we can mutate the most-recent member of each qualifying group.
    const groups = new Map<string, number[]>();
    stage1.forEach((e, idx) => {
      if (e.archived === true) return;
      if (e.decision !== "accept") return;
      const key = normalizeFindingTitle(e.finding);
      if (key.length === 0) return;
      const acc = groups.get(key) ?? [];
      acc.push(idx);
      groups.set(key, acc);
    });

    const promotedFlags = new Set<number>();
    for (const [, indices] of groups) {
      if (indices.length < input.min_recurrence) continue;
      // Most-recent member by ts (fall back to last in append-order if ts
      // doesn't parse). We compare ms; on equality the later index wins.
      let bestIdx = indices[0]!;
      let bestMs = Date.parse(stage1[bestIdx]!.ts);
      for (let i = 1; i < indices.length; i++) {
        const idx = indices[i]!;
        const ms = Date.parse(stage1[idx]!.ts);
        if (!Number.isFinite(ms)) continue;
        if (!Number.isFinite(bestMs) || ms >= bestMs) {
          bestIdx = idx;
          bestMs = ms;
        }
      }
      // Only count a promotion if the chosen entry wasn't already promoted.
      // Idempotent: re-running prune doesn't keep incrementing promoted_count
      // for the same entries.
      if (stage1[bestIdx]!.promoted !== true) {
        promotedFlags.add(bestIdx);
      }
    }

    if (promotedFlags.size > 0) {
      stage2 = stage1.map((e, idx) => (promotedFlags.has(idx) ? { ...e, promoted: true } : e));
      promotedCount = promotedFlags.size;
      // Add promoted indices to the changed-indices Set. An entry both
      // archived (Pass 1) and promoted (Pass 2) would only count ONCE in
      // the Set, which is the correct invariant — it's still one row that
      // changed this pass.
      for (const idx of promotedFlags) changedIndices.add(idx);
    }
  }

  // ---------------------------------------------------------------------------
  // Write (or skip in dry-run)
  // ---------------------------------------------------------------------------
  // unchangedCount is derived from the Set of touched indices (cycle-2 M4
  // robustness fix). archivedCount and promotedCount are kept as separate
  // observability counters in the return shape; they double-count when an
  // entry is both archived AND promoted in the same run, which can happen
  // across multiple prune cycles (today's Pass 2 skips archived entries
  // from THIS pass, but a previously-promoted entry can age out and get
  // archived later — those rows will appear in BOTH counters historically).
  const changed = changedIndices.size;
  const unchangedCount = entries.length - changed;

  if (!input.dry_run && changed > 0) {
    await atomicRewriteJsonl(filePath, stage2);
    logger.info("prune_learnings: rewritten", {
      details: {
        file: filePath,
        total: entries.length,
        archived_count: archivedCount,
        promoted_count: promotedCount,
      },
    });
  }

  return {
    ok: true,
    file: filePath,
    total: entries.length,
    archived_count: archivedCount,
    promoted_count: promotedCount,
    unchanged_count: unchangedCount,
    dry_run: input.dry_run,
  };
}

export const pruneLearningsToolDef: ToolDef<typeof schema> = {
  name: "prune_learnings",
  description:
    "Lifecycle maintenance for `.squad/learnings.jsonl` (v0.11.0+). Two passes: (1) entries older than " +
    "`max_age_days` are marked `archived: true` and hidden from default `read_learnings`; (2) entries " +
    "with ≥ `min_recurrence` accept decisions on the same normalised finding title get `promoted: true` " +
    "on the most-recent matching entry — promoted entries surface first in advisory prompts regardless " +
    "of scope match. Atomic rewrite under file lock. Never auto-runs (`max_age_days` defaults to 0). " +
    "Use `dry_run: true` to inspect counts without mutating.",
  schema,
  handler: pruneLearningsTool,
};
