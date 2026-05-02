import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolDef } from './registry.js';
import { CONTENT_SIGNALS, PATH_HINTS, type AgentName } from '../config/ownership-matrix.js';

const schema = z.object({
  agent: z.string(),
  files: z.array(z.string()),
  read_content: z.boolean().optional().default(true),
  workspace_root: z.string().optional(),
});

type Input = z.infer<typeof schema>;

export interface SliceOutput {
  agent: string;
  matched: { file: string; reasons: string[] }[];
  unmatched: string[];
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

export async function sliceFilesForAgent(input: Input): Promise<SliceOutput> {
  const target = input.agent as AgentName;
  const matched: { file: string; reasons: string[] }[] = [];
  const unmatched: string[] = [];

  for (const file of input.files) {
    const reasons: string[] = [];

    for (const hint of PATH_HINTS) {
      if (hint.agent === target && hint.pattern.test(file)) {
        reasons.push(`path: ${hint.description}`);
      }
    }

    if (input.read_content) {
      const abs = input.workspace_root ? path.resolve(input.workspace_root, file) : file;
      const content = await readSnippet(abs);
      if (content) {
        for (const sig of CONTENT_SIGNALS) {
          if (sig.agent === target && sig.pattern.test(content)) {
            reasons.push(`content: ${sig.description}`);
          }
        }
      }
    }

    if (reasons.length) {
      matched.push({ file, reasons });
    } else {
      unmatched.push(file);
    }
  }

  return { agent: input.agent, matched, unmatched };
}

export const sliceFilesForAgentTool: ToolDef<typeof schema> = {
  name: 'slice_files_for_agent',
  description:
    'Filter a file list to those owned by a specific agent. Uses path hints + content sniff. Used to build sliced advisory prompts.',
  schema,
  handler: sliceFilesForAgent,
};
