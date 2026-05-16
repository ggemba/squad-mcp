import { z } from "zod";
import type { ToolDef } from "./registry.js";
import { drainPending } from "../journal/pending.js";
import { readSquadYaml } from "../config/squad-yaml.js";
import { resolveSafePath, createSafePathContext } from "../util/path-safety.js";

/**
 * `drain_journal` — PR2 / Fase 1b auto-journaling drain.
 *
 * Claims every breadcrumb the opt-in PostToolUse hook staged into
 * `.squad/pending-journal.jsonl` since the last drain and returns the
 * de-duplicated set of touched file paths. The squad skill folds the result
 * into the terminal `record_run` RunRecord (`touched_paths`) so the run
 * telemetry reflects the actual work trail.
 *
 * No-op when `.squad.yaml` `journaling !== "opt-in"`: a team that has not
 * opted into auto-journaling never has its pending file drained by the
 * squad. (A staging file could still exist if the hook was wired manually;
 * leaving it untouched is the conservative choice — drain only on opt-in.)
 *
 * Side-effecting: `drainPending` atomically renames + consumes the staging
 * file. Safe to call once per run from the lifecycle-owning skill.
 */

/** Hard cap on returned paths — mirrors `runRecordSchema.touched_paths.max(100)`. */
const MAX_TOUCHED_PATHS = 100;
/** Per-path length cap — mirrors `SafeString(512)` on the RunRecord field. */
const MAX_PATH_LEN = 512;

const schema = z.object({
  workspace_root: z.string().min(1).max(4096),
});

type Input = z.infer<typeof schema>;

export interface DrainJournalOutput {
  /**
   * De-duplicated file paths touched during the run, capped at 100. Each path
   * is NUL-free and ≤512 chars (defensive — the pending store schema already
   * rejects NUL, this re-asserts the bound the RunRecord field requires).
   */
  touched_paths: string[];
  /** Count of breadcrumbs drained from the staging file (pre-dedup). */
  drained_count: number;
}

/**
 * Drain the pending-journal staging buffer and return the de-duplicated set
 * of touched paths plus the raw breadcrumb count.
 */
export async function drainJournalTool(input: Input): Promise<DrainJournalOutput> {
  const ctx = createSafePathContext();
  const safeRoot = await resolveSafePath(input.workspace_root, ".", ctx);
  const config = await readSquadYaml(safeRoot);

  // Journaling guard: only drain when the team has opted in. Returns an empty
  // result otherwise — the caller folds an empty `touched_paths` and the run
  // record is unaffected.
  if (config.journaling !== "opt-in") {
    return { touched_paths: [], drained_count: 0 };
  }

  const entries = await drainPending(safeRoot);

  // De-duplicate, drop null/over-long paths, and cap at MAX_TOUCHED_PATHS.
  // `drainPending`'s schema already rejects NUL bytes; the length filter here
  // is the belt-and-braces guard for the RunRecord `SafeString(512)` bound.
  const seen = new Set<string>();
  const touched_paths: string[] = [];
  for (const e of entries) {
    if (touched_paths.length >= MAX_TOUCHED_PATHS) break;
    const p = e.path;
    if (p === null) continue;
    if (p.length === 0 || p.length > MAX_PATH_LEN) continue;
    if (p.indexOf("\0") !== -1) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    touched_paths.push(p);
  }

  return { touched_paths, drained_count: entries.length };
}

export const drainJournalToolDef: ToolDef<typeof schema> = {
  name: "drain_journal",
  description:
    "Drain the auto-journaling staging buffer (`.squad/pending-journal.jsonl`) and return the " +
    "de-duplicated set of file paths touched during the run, plus the raw breadcrumb count. " +
    "No-op (returns empty) when `.squad.yaml` `journaling` is not `opt-in`. Side-effecting — " +
    "atomically claims and clears the staging file. The squad skill calls this once in Phase 10 " +
    "before the terminal `record_run`, folding `touched_paths` into the RunRecord.",
  schema,
  handler: drainJournalTool,
};
