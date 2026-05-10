import { z } from "zod";
import type { ToolDef } from "./registry.js";
import {
  readSquadYaml,
  type ResolvedSquadConfig,
} from "../config/squad-yaml.js";
import { resolveSafePath, createSafePathContext } from "../util/path-safety.js";

const schema = z.object({
  workspace_root: z.string().min(1).max(4096),
});

type Input = z.infer<typeof schema>;

/**
 * MCP tool wrapper around the YAML reader. Lets non-Claude-Code clients (or
 * non-composer callers) inspect the resolved config explicitly. Pure tools
 * (apply_consolidation_rules, score_rubric, select_squad) do NOT call this —
 * the composers (compose_squad_workflow, compose_advisory_bundle) read
 * .squad.yaml automatically when they receive workspace_root, then pass the
 * concrete values down. This tool is for direct introspection and for clients
 * that want to construct a tailored bundle themselves.
 */
export async function readSquadConfig(
  input: Input,
): Promise<ResolvedSquadConfig> {
  // Containment check — canonicalise the workspace root via the same machinery
  // every other path-receiving tool uses. resolveSafePath returns the realpath
  // of `<root>/.` which is the root itself.
  const ctx = createSafePathContext();
  const safe = await resolveSafePath(input.workspace_root, ".", ctx);
  return await readSquadYaml(safe);
}

export const readSquadConfigTool: ToolDef<typeof schema> = {
  name: "read_squad_config",
  description:
    "Read and resolve `.squad.yaml` (or `.squad.yml`) at the given workspace_root. " +
    "Returns effective weights (defaults merged), threshold, min_score, skip_paths, disable_agents, " +
    "and the source path (or null if no file present). Composers (compose_squad_workflow, " +
    "compose_advisory_bundle) read this automatically when they receive workspace_root; this tool " +
    "is for explicit introspection and for clients that build their own bundle.",
  schema,
  handler: readSquadConfig,
};
