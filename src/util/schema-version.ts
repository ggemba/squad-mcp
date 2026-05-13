/**
 * Single source of truth for the current JSONL `schema_version`.
 *
 * Bump in lockstep when the wire format of `.squad/runs.jsonl` and
 * `.squad/learnings.jsonl` rotates incompatibly (e.g. v1 → v2 in the
 * agent-rename release). Readers gate on `schema_version !== CURRENT_SCHEMA_VERSION`
 * to skip+log rows from older or newer producers (no quarantine of the
 * historical journal). Migration tooling that bumps the field on-disk
 * lives at `tools/migrate-jsonl-agents.mjs`.
 *
 * Why a constant: prior to v0.15 the literal `2` appeared at five sites
 * across `runs/store.ts`, `learning/store.ts`, `util/jsonl-store.ts`,
 * `tools/record-run.ts`, and the migration tool. The next bump now
 * touches this file plus the Zod literal sites (which need a literal
 * type, not a runtime reference). Reviewer dev-reviewer Minor:
 * "schema_version literal '2' scattered across 5 sites".
 */
export const CURRENT_SCHEMA_VERSION = 2 as const;
export type CurrentSchemaVersion = typeof CURRENT_SCHEMA_VERSION;
