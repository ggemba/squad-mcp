import { promises as fs } from 'node:fs';
import { AGENTS, type AgentName } from '../config/ownership-matrix.js';
import { resolveAgentFile, resolveSharedFile, SHARED_FILES } from './agent-loader.js';
import { SquadError } from '../errors.js';
import { logger, newRequestId } from '../observability/logger.js';

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
  const requestId = newRequestId();
  const started = Date.now();
  try {
    if (uri.startsWith('agent://')) {
      const name = uri.replace('agent://', '') as AgentName;
      if (!(name in AGENTS)) {
        throw new SquadError('UNKNOWN_AGENT', `unknown agent: ${name}`, { uri });
      }
      const filePath = await resolveAgentFile(name);
      const text = await fs.readFile(filePath, 'utf8');
      logger.debug('resource ok', {
        request_id: requestId,
        outcome: 'success',
        duration_ms: Date.now() - started,
        details: { scheme: 'agent', name },
      });
      return { contents: [{ uri, mimeType: 'text/markdown', text }] };
    }
    if (uri.startsWith('severity://')) {
      const slug = uri.replace('severity://', '');
      const file = SHARED_FILES.find((f) => f.replace(/\.md$/, '').toLowerCase() === slug);
      if (!file) {
        throw new SquadError('UNKNOWN_AGENT', `unknown shared resource: ${uri}`, { uri });
      }
      const filePath = await resolveSharedFile(file);
      const text = await fs.readFile(filePath, 'utf8');
      logger.debug('resource ok', {
        request_id: requestId,
        outcome: 'success',
        duration_ms: Date.now() - started,
        details: { scheme: 'severity', slug },
      });
      return { contents: [{ uri, mimeType: 'text/markdown', text }] };
    }
    throw new SquadError('UNKNOWN_AGENT', `unsupported URI scheme: ${uri}`, { uri });
  } catch (err) {
    logger.warn('resource error', {
      request_id: requestId,
      duration_ms: Date.now() - started,
      details: { uri, message: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}
