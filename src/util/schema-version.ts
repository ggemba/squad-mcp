/**
 * Single source of truth for the JSONL `schema_version` constants.
 *
 * Bump the relevant constant when the wire format of a journal rotates
 * incompatibly. Readers gate on `schema_version` to skip+log rows from
 * incompatible producers (no quarantine of the historical journal).
 * Migration tooling that bumps the field on-disk lives at
 * `tools/migrate-jsonl-agents.mjs`.
 *
 * ── Why TWO constants (PR2 / Fase 1b — C0) ─────────────────────────────────
 * Prior to PR2 a single `CURRENT_SCHEMA_VERSION = 2` was shared by BOTH the
 * runs journal (`.squad/runs.jsonl`) and the learnings journal
 * (`.squad/learnings.jsonl`). PR2 bumps ONLY the learnings format to v3
 * (additive `lesson` / `trigger` / `evidence` fields) — the runs format is
 * untouched. A shared constant would force a learnings bump to also touch
 * the runs read gate, which is wrong: a learnings-only schema change must
 * never silently widen what `readRuns` accepts.
 *
 * So the constant is split per-store:
 *   - `RUNS_SCHEMA_VERSION` — `.squad/runs.jsonl`. Stays 2.
 *   - `LEARNINGS_SCHEMA_VERSION` — `.squad/learnings.jsonl`. Bumped to 3 in PR2.
 *
 * The two version values are independent; do not assume they move together.
 *
 * Why constants at all: the literal previously appeared at five sites across
 * `runs/store.ts`, `learning/store.ts`, `util/jsonl-store.ts`,
 * `tools/record-run.ts`, and the migration tool. A bump now touches this
 * file plus the Zod literal sites (which need a literal type, not a runtime
 * reference).
 */

/** Schema version of `.squad/runs.jsonl`. Bumped 1 → 2 in the agent-rename release. */
export const RUNS_SCHEMA_VERSION = 2 as const;
export type RunsSchemaVersion = typeof RUNS_SCHEMA_VERSION;

/**
 * Schema version of `.squad/learnings.jsonl`. Bumped 2 → 3 in PR2 (Fase 1b)
 * for the additive `lesson` / `trigger` / `evidence` distillation fields.
 * v2 rows remain readable — the learnings store accepts both {2, 3}.
 */
export const LEARNINGS_SCHEMA_VERSION = 3 as const;
export type LearningsSchemaVersion = typeof LEARNINGS_SCHEMA_VERSION;
