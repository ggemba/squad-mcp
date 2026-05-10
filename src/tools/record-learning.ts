import { z } from "zod";
import type { ToolDef } from "./registry.js";
import { appendLearning } from "../learning/store.js";
import { readSquadYaml } from "../config/squad-yaml.js";
import { resolveSafePath, createSafePathContext } from "../util/path-safety.js";
import { AGENT_NAMES_TUPLE } from "../config/ownership-matrix.js";

const schema = z.object({
  workspace_root: z.string().min(1).max(4096),
  /** Which agent's finding this decision concerns. */
  agent: z.enum(AGENT_NAMES_TUPLE),
  /** Short title of the finding (matches finding.title from consolidate). */
  finding: z.string().min(1).max(2048),
  /** Whether the team accepted or rejected this finding. */
  decision: z.enum(["accept", "reject"]),
  /** Severity at the time of the decision. */
  severity: z.enum(["Blocker", "Major", "Minor", "Suggestion"]).optional(),
  /** Free-form rationale. Surfaces in the consolidator prompt. */
  reason: z.string().max(4096).optional(),
  /** PR number when recorded from `/squad-review #N`. */
  pr: z.number().int().positive().optional(),
  /** Branch name when recorded from a local review. */
  branch: z.string().min(1).max(255).optional(),
  /** Glob-ish path scope (e.g. "src/auth/**"). When absent, repo-wide. */
  scope: z.string().min(1).max(512).optional(),
});

type Input = z.infer<typeof schema>;

/**
 * Append a new entry to `.squad/learnings.jsonl`. Atomic per-line. Skill calls
 * this in Phase 14 (post-PR record). The CLI helper `tools/record-learning.mjs`
 * is the equivalent for non-MCP clients.
 *
 * Side-effecting (writes to disk). The skill or CLI is responsible for
 * confirming with the user before invoking — this tool itself never asks
 * (MCP tools don't have user prompts).
 */
export async function recordLearningTool(input: Input): Promise<{
  recorded: true;
  file: string;
  entry: { ts: string; agent: string; decision: string };
}> {
  const ctx = createSafePathContext();
  const safeRoot = await resolveSafePath(input.workspace_root, ".", ctx);
  const config = await readSquadYaml(safeRoot);
  // Recording IS allowed even when reads are disabled — turning off injection
  // (e.g. for a quiet release window) shouldn't throw away the journal. The
  // skill is responsible for not calling record_learning when the user did
  // not authorise the decision.
  const configuredPath = config.learnings.path;

  const entry: Parameters<typeof appendLearning>[1] = {
    agent: input.agent,
    finding: input.finding,
    decision: input.decision,
  };
  if (input.severity !== undefined) entry.severity = input.severity;
  if (input.reason !== undefined) entry.reason = input.reason;
  if (input.pr !== undefined) entry.pr = input.pr;
  if (input.branch !== undefined) entry.branch = input.branch;
  if (input.scope !== undefined) entry.scope = input.scope;

  const result = await appendLearning(safeRoot, entry, {
    ...(configuredPath !== undefined ? { configuredPath } : {}),
  });

  return {
    recorded: true,
    file: result.filePath,
    entry: {
      ts: result.entry.ts,
      agent: result.entry.agent,
      decision: result.entry.decision,
    },
  };
}

export const recordLearningToolDef: ToolDef<typeof schema> = {
  name: "record_learning",
  description:
    "Append a team decision (accept | reject) on a finding to `.squad/learnings.jsonl`. " +
    "Future runs of the squad will inject the most recent entries into agent / consolidator prompts so " +
    "the squad stops re-suggesting things the team has already declined (with reason). " +
    "Side-effecting — writes to disk. Caller (skill or CLI) is responsible for user confirmation.",
  schema,
  handler: recordLearningTool,
};
