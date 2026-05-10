import { z } from "zod";
import type { ToolDef } from "./registry.js";
import { readLearnings, tailRecent, type LearningEntry } from "../learning/store.js";
import { formatLearningsForPrompt } from "../learning/format.js";
import { readSquadYaml } from "../config/squad-yaml.js";
import { resolveSafePath, createSafePathContext } from "../util/path-safety.js";
import { AGENT_NAMES_TUPLE } from "../config/ownership-matrix.js";

const schema = z.object({
  workspace_root: z.string().min(1).max(4096),
  /** Cap rendered/returned entries. Default 50. */
  limit: z.number().int().positive().max(200).optional().default(50),
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
});

type Input = z.infer<typeof schema>;

export interface ReadLearningsOutput {
  entries: LearningEntry[];
  total_in_store: number;
  rendered: string;
  source: string | null;
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
    return { entries: [], total_in_store: 0, rendered: "", source: null };
  }
  const configuredPath = config.learnings.path;

  const allEntries = await readLearnings(safeRoot, { configuredPath });
  const filtered = tailRecent(allEntries, input.limit, {
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.decision !== undefined ? { decision: input.decision } : {}),
  });

  const rendered = input.include_rendered
    ? formatLearningsForPrompt(filtered, {
        ...(input.changed_files ? { changedFiles: input.changed_files } : {}),
        limit: input.limit,
      })
    : "";

  return {
    entries: filtered,
    total_in_store: allEntries.length,
    rendered,
    source:
      allEntries.length > 0 ? `${safeRoot}/${configuredPath ?? ".squad/learnings.jsonl"}` : null,
  };
}

export const readLearningsToolDef: ToolDef<typeof schema> = {
  name: "read_learnings",
  description:
    "Read recent team decisions from `.squad/learnings.jsonl` (path overridable via .squad.yaml.learnings.path). " +
    "Returns the filtered entries plus a pre-rendered markdown block ready to inject into agent / consolidator prompts. " +
    "Filters: agent, decision (accept|reject), changed_files (matches scoped entries against these paths). " +
    "Used by the /squad-review skill in Phase 5 (advisory) and Phase 10 (consolidation) to make the squad less repetitive over time.",
  schema,
  handler: readLearningsTool,
};
