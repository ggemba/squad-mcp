import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolDef } from './registry.js';
import {
  AGENTS,
  CONTENT_SIGNALS,
  PATH_HINTS,
  SQUAD_BY_TYPE,
  type AgentName,
  type WorkType,
} from '../config/ownership-matrix.js';

const schema = z.object({
  work_type: z.enum(['Feature', 'Bug Fix', 'Refactor', 'Performance', 'Security', 'Business Rule']),
  files: z.array(z.string()).default([]),
  read_content: z.boolean().optional().default(true),
  force_agents: z.array(z.string()).optional().default([]),
  workspace_root: z.string().optional(),
});

type Input = z.infer<typeof schema>;

export interface Evidence {
  file: string;
  agent: AgentName;
  signal: string;
  source: 'content' | 'path';
  confidence: 'high' | 'medium' | 'low';
}

export interface SelectSquadOutput {
  agents: AgentName[];
  rationale: { agent: AgentName; reason: string }[];
  evidence: Evidence[];
  low_confidence_files: { file: string; reason: string }[];
}

const MAX_BYTES = 16_384;

async function readSnippet(absPath: string): Promise<string | null> {
  try {
    const fh = await fs.open(absPath, 'r');
    try {
      const buf = Buffer.alloc(MAX_BYTES);
      const { bytesRead } = await fh.read(buf, 0, MAX_BYTES, 0);
      return buf.slice(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
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

  for (const file of input.files) {
    const matched: { agent: AgentName; signal: string; source: 'content' | 'path' }[] = [];

    for (const hint of PATH_HINTS) {
      if (hint.pattern.test(file)) {
        matched.push({ agent: hint.agent, signal: hint.description, source: 'path' });
      }
    }

    let contentMatched = false;
    if (input.read_content) {
      const abs = input.workspace_root ? path.resolve(input.workspace_root, file) : file;
      const content = await readSnippet(abs);
      if (content) {
        for (const sig of CONTENT_SIGNALS) {
          if (sig.pattern.test(content)) {
            matched.push({ agent: sig.agent, signal: sig.description, source: 'content' });
            contentMatched = true;
          }
        }
      } else {
        // file unreadable - degrade silently to path-only
      }
    }

    if (matched.length === 0) {
      lowConfidence.push({ file, reason: 'no path or content signal matched' });
      continue;
    }

    const seen = new Set<string>();
    for (const m of matched) {
      const key = `${m.agent}|${m.signal}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const confidence: Evidence['confidence'] =
        m.source === 'content' ? 'high' : contentMatched ? 'medium' : 'medium';
      evidence.push({ file, ...m, confidence });
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
    const name = forced as AgentName;
    if (!(name in AGENTS)) continue;
    if (!selected.has(name)) {
      selected.add(name);
      rationale.push({ agent: name, reason: 'forced by caller' });
    }
  }

  return {
    agents: Array.from(selected),
    rationale,
    evidence,
    low_confidence_files: lowConfidence,
  };
}

export const selectSquadTool: ToolDef<typeof schema> = {
  name: 'select_squad',
  description:
    'Select agents for a work type given changed files. Combines matrix (core agents per work type) with content sniff and path hints. Returns evidence per file.',
  schema,
  handler: selectSquad,
};
