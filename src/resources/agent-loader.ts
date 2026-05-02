import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { AGENTS, type AgentName } from '../config/ownership-matrix.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const AGENT_FILE_MAP: Record<AgentName, string> = {
  po: 'PO.md',
  'tech-lead-planner': 'TechLead-Planner.md',
  'tech-lead-consolidator': 'TechLead-Consolidator.md',
  'senior-architect': 'Senior-Architect.md',
  'senior-dba': 'Senior-DBA.md',
  'senior-developer': 'Senior-Developer.md',
  'senior-dev-reviewer': 'Senior-Dev-Reviewer.md',
  'senior-dev-security': 'Senior-Dev-Security.md',
  'senior-qa': 'Senior-QA.md',
};

export const SHARED_FILES = ['_Severity-and-Ownership.md', 'Skill-Squad-Dev.md', 'Skill-Squad-Review.md'];

function defaultLocalDir(): string {
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appdata, 'squad-mcp', 'agents');
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(xdg, 'squad-mcp', 'agents');
}

export function getLocalDir(): string {
  return process.env.SQUAD_AGENTS_DIR ?? defaultLocalDir();
}

export function getEmbeddedDir(): string {
  return path.resolve(__dirname, '..', '..', 'agents');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function resolveAgentFile(name: AgentName): Promise<string> {
  const file = AGENT_FILE_MAP[name];
  const local = path.join(getLocalDir(), file);
  if (await exists(local)) return local;
  return path.join(getEmbeddedDir(), file);
}

export async function resolveSharedFile(file: string): Promise<string> {
  const local = path.join(getLocalDir(), file);
  if (await exists(local)) return local;
  return path.join(getEmbeddedDir(), file);
}

export async function readAgentDefinition(name: AgentName): Promise<string> {
  const filePath = await resolveAgentFile(name);
  return fs.readFile(filePath, 'utf8');
}

export async function listAvailableAgents() {
  const dir = getLocalDir();
  const localExists = await exists(dir);
  return Object.values(AGENTS).map((a) => ({
    name: a.name,
    role: a.role,
    owns: a.owns,
    conventions: a.conventions,
    file: AGENT_FILE_MAP[a.name],
    overridden: localExists,
  }));
}

export async function initLocalConfig(force = false): Promise<{ created: string[]; skipped: string[]; dir: string }> {
  const dir = getLocalDir();
  await fs.mkdir(dir, { recursive: true });
  const created: string[] = [];
  const skipped: string[] = [];
  const sources = [...Object.values(AGENT_FILE_MAP), ...SHARED_FILES];
  for (const file of sources) {
    const dst = path.join(dir, file);
    if ((await exists(dst)) && !force) {
      skipped.push(file);
      continue;
    }
    const src = path.join(getEmbeddedDir(), file);
    await fs.copyFile(src, dst);
    created.push(file);
  }
  return { created, skipped, dir };
}
