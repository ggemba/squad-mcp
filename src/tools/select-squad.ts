import { z } from "zod";
import type { ToolDef } from "./registry.js";
import {
  AGENTS,
  AGENT_NAMES_TUPLE,
  CONTENT_SIGNALS,
  PATH_HINTS,
  signalApplies,
  SQUAD_BY_TYPE,
  type AgentName,
  type WorkType,
} from "../config/ownership-matrix.js";
import {
  createSafePathContext,
  MAX_BYTES,
  readSnippet,
  resolveSafePath,
} from "../util/path-safety.js";
import { isSquadError } from "../errors.js";
import { SafeString as safeString } from "./_shared/schemas.js";

const schema = z.object({
  work_type: z.enum(["Feature", "Bug Fix", "Refactor", "Performance", "Security", "Business Rule"]),
  files: z.array(safeString(4096)).max(10_000).default([]),
  read_content: z.boolean().optional().default(true),
  force_agents: z.array(z.enum(AGENT_NAMES_TUPLE)).optional().default([]),
  workspace_root: safeString(4096).optional(),
});

type Input = z.infer<typeof schema>;

export interface Evidence {
  file: string;
  agent: AgentName;
  signal: string;
  source: "content" | "path";
  confidence: "high" | "medium" | "low";
  truncated?: boolean;
}

export interface SelectSquadOutput {
  agents: AgentName[];
  rationale: { agent: AgentName; reason: string }[];
  evidence: Evidence[];
  low_confidence_files: { file: string; reason: string }[];
}

export async function selectSquad(input: Input): Promise<SelectSquadOutput> {
  const matrixEntry = SQUAD_BY_TYPE[input.work_type as WorkType];
  const selected = new Set<AgentName>(matrixEntry.core);
  const rationale: { agent: AgentName; reason: string }[] = matrixEntry.core.map((a) => ({
    agent: a,
    reason: `core agent for ${input.work_type}`,
  }));

  const evidence: Evidence[] = [];
  const lowConfidence: { file: string; reason: string }[] = [];

  const ctx = createSafePathContext();
  const canReadContent = input.read_content && input.workspace_root !== undefined;

  for (const file of input.files) {
    const matched: {
      agent: AgentName;
      signal: string;
      source: "content" | "path";
      truncated?: boolean;
    }[] = [];

    for (const hint of PATH_HINTS) {
      if (hint.pattern.test(file)) {
        matched.push({
          agent: hint.agent,
          signal: hint.description,
          source: "path",
        });
      }
    }

    let contentMatched = false;
    let snippetTruncated = false;
    if (canReadContent) {
      try {
        const abs = await resolveSafePath(input.workspace_root, file, ctx);
        const snippet = await readSnippet(abs);
        if (snippet) {
          snippetTruncated = snippet.truncated;
          for (const sig of CONTENT_SIGNALS) {
            if (!signalApplies(sig, file)) continue;
            if (sig.pattern.test(snippet.content)) {
              matched.push({
                agent: sig.agent,
                signal: sig.description,
                source: "content",
                truncated: snippet.truncated,
              });
              contentMatched = true;
            }
          }
        }
      } catch (err) {
        if (isSquadError(err)) {
          lowConfidence.push({ file, reason: `path rejected: ${err.code}` });
          continue;
        }
        throw err;
      }
    }

    if (matched.length === 0) {
      lowConfidence.push({ file, reason: "no path or content signal matched" });
      continue;
    }

    const seen = new Set<string>();
    for (const m of matched) {
      const key = `${m.agent}|${m.signal}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const confidence: Evidence["confidence"] =
        m.source === "content" ? "high" : contentMatched ? "medium" : "medium";
      const ev: Evidence = {
        file,
        agent: m.agent,
        signal: m.signal,
        source: m.source,
        confidence,
      };
      if (m.truncated || (m.source === "content" && snippetTruncated)) ev.truncated = true;
      evidence.push(ev);
      if (!selected.has(m.agent)) {
        selected.add(m.agent);
        rationale.push({
          agent: m.agent,
          reason: `${m.source} signal in ${file}: ${m.signal}`,
        });
      }
    }
  }

  for (const forced of input.force_agents) {
    if (!selected.has(forced)) {
      selected.add(forced);
      rationale.push({ agent: forced, reason: "forced by caller" });
    }
  }

  // Preserve insertion order: core agents from the matrix come first, then
  // content/path signals, then user force_agents last. This is the "ranked"
  // order downstream consumers (notably `shapeSquadForMode` in
  // compose-squad-workflow.ts when mode === "quick") rely on. Prior versions
  // sorted alphabetically and silently shipped a top-2 that didn't match
  // the docstring contract.
  const rankedAgents = Array.from(selected);
  return {
    agents: rankedAgents,
    rationale,
    evidence,
    low_confidence_files: lowConfidence,
  };
}

export const selectSquadTool: ToolDef<typeof schema> = {
  name: "select_squad",
  description:
    `Select agents for a work type given changed files. Combines core matrix with content sniff and path hints. ` +
    `Reads up to ${MAX_BYTES} bytes per file when workspace_root is set; signals can be ext-gated to avoid cross-stack false positives.`,
  schema,
  handler: selectSquad,
};

void AGENTS;
