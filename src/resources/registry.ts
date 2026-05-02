import { promises as fs } from 'node:fs';
import { AGENTS, type AgentName } from '../config/ownership-matrix.js';
import { resolveAgentFile, resolveSharedFile, SHARED_FILES } from './agent-loader.js';

export async function listResources() {
  const agentResources = Object.values(AGENTS).map((a) => ({
    uri: `agent://${a.name}`,
    name: a.name,
    description: a.role,
    mimeType: 'text/markdown',
  }));
  const sharedResources = SHARED_FILES.map((f) => ({
    uri: `severity://${f.replace(/\.md$/, '').toLowerCase()}`,
    name: f,
    description: 'Shared squad reference document',
    mimeType: 'text/markdown',
  }));
  return [...agentResources, ...sharedResources];
}

export async function readResource(uri: string) {
  if (uri.startsWith('agent://')) {
    const name = uri.replace('agent://', '') as AgentName;
    if (!(name in AGENTS)) throw new Error(`Unknown agent: ${name}`);
    const filePath = await resolveAgentFile(name);
    const text = await fs.readFile(filePath, 'utf8');
    return { contents: [{ uri, mimeType: 'text/markdown', text }] };
  }
  if (uri.startsWith('severity://')) {
    const slug = uri.replace('severity://', '');
    const file = SHARED_FILES.find((f) => f.replace(/\.md$/, '').toLowerCase() === slug);
    if (!file) throw new Error(`Unknown shared resource: ${uri}`);
    const filePath = await resolveSharedFile(file);
    const text = await fs.readFile(filePath, 'utf8');
    return { contents: [{ uri, mimeType: 'text/markdown', text }] };
  }
  throw new Error(`Unsupported URI scheme: ${uri}`);
}
