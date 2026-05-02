import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { AGENTS, type AgentName } from '../config/ownership-matrix.js';
import { SquadError } from '../errors.js';
import { logger } from '../observability/logger.js';
import {
  validateOverrideDir,
  validateOverrideFile,
  rejectionToError,
  getAllowlistSize,
  __resetOverrideAllowlistCache,
  type ValidationOk,
} from '../util/override-allowlist.js';

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

/**
 * Returns the configured override directory and whether it was set explicitly
 * via `SQUAD_AGENTS_DIR`. Empty string is treated as unset.
 */
export function getLocalDir(): { rawDir: string; explicit: boolean } {
  const env = process.env.SQUAD_AGENTS_DIR;
  if (env !== undefined && env !== '') {
    return { rawDir: env, explicit: true };
  }
  return { rawDir: defaultLocalDir(), explicit: false };
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

async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

let embeddedAsserted = false;
let overrideActiveAnnounced = false;
let overrideMissingWarnEmitted = false;
let permWarnEmitted = false;
const overrideValidationCache: Map<string, ValidationOk | null> = new Map();

/**
 * Test-only: reset all module-level caches and one-shot flags.
 * Production code MUST NOT call this.
 */
export function __resetAgentLoaderForTests(): void {
  embeddedAsserted = false;
  overrideActiveAnnounced = false;
  overrideMissingWarnEmitted = false;
  permWarnEmitted = false;
  overrideValidationCache.clear();
  __resetOverrideAllowlistCache();
}

/**
 * Create the override directory with user-only permissions.
 * On Unix, mkdir's mode is masked by umask, so an explicit chmod follows.
 * Chmod failures propagate — initLocalConfig must not silently succeed when the
 * security invariant (mode 0o700) cannot be met.
 * On Windows, fs.mkdir mode is ignored; APPDATA inherits user-only DACL by default.
 * Custom paths outside APPDATA on Windows fall back to whatever the parent grants.
 */
async function createSecureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await fs.chmod(dir, 0o700);
  }
}

/**
 * Copy a file with user-only read/write permissions on Unix.
 * fs.copyFile preserves the source mode (0o644 from the bundle), so an explicit
 * chmod is required for 0o600 semantics. Failure propagates so the operator
 * sees the security invariant breakage, rather than silent success.
 */
async function copyFileSecure(src: string, dst: string): Promise<void> {
  await fs.copyFile(src, dst);
  if (process.platform !== 'win32') {
    await fs.chmod(dst, 0o600);
  }
}

/**
 * Warn once per process if the override directory is world-writable. Group-write
 * is allowed (single-user box convention); only world-write triggers the warning.
 * Skipped on Windows: fs.stat does not surface DACL semantics.
 *
 * The "once" flag is claimed BEFORE the await so concurrent first-load calls do
 * not produce duplicate warnings.
 */
async function checkOverrideDirPerms(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  if (permWarnEmitted) return;
  permWarnEmitted = true;
  try {
    const s = await fs.stat(dir);
    if ((s.mode & 0o002) !== 0) {
      logger.warn('override directory is world-writable', {
        details: {
          configured_path: dir,
          mode: '0o' + (s.mode & 0o777).toString(8),
          recommendation: `chmod 700 ${dir}`,
        },
      });
    }
  } catch {
    // stat already validated upstream; ignore failure here
  }
}

async function ensureEmbeddedDir(): Promise<void> {
  if (embeddedAsserted) return;
  const dir = getEmbeddedDir();
  if (!(await exists(dir))) {
    throw new SquadError('AGENT_DIR_MISSING', `embedded agents directory missing at ${dir}`);
  }
  embeddedAsserted = true;
}

/**
 * Resolve and validate the active override directory.
 *
 * Returns:
 *   - validated `ValidationOk` (override active for this resolution).
 *   - `null` when there is no active override (use embedded). The "no active
 *     override" cases include: directory does not exist on disk; default
 *     platform dir failed validation (rare — these always live under an
 *     allowlisted root in practice).
 *
 * Throws `OVERRIDE_REJECTED` only when `SQUAD_AGENTS_DIR` was set explicitly
 * AND the directory exists but fails policy (outside allowlist, UNC, symlink
 * escape, etc.). A missing explicit-env directory still soft-fails with a
 * one-shot warn — this preserves the prior contract.
 */
async function resolveOverride(): Promise<ValidationOk | null> {
  const { rawDir, explicit } = getLocalDir();

  const cached = overrideValidationCache.get(rawDir);
  if (cached !== undefined) return cached;

  if (!(await isDirectory(rawDir))) {
    if (explicit && !overrideMissingWarnEmitted) {
      overrideMissingWarnEmitted = true;
      logger.warn('SQUAD_AGENTS_DIR set but directory not found; falling back to embedded defaults', {
        details: { configured_path: rawDir },
      });
    }
    overrideValidationCache.set(rawDir, null);
    return null;
  }

  const result = await validateOverrideDir(rawDir);

  if (!result.ok) {
    if (explicit) {
      const size = await getAllowlistSize();
      const err = rejectionToError(result, size);
      logger.warn('SQUAD_AGENTS_DIR rejected', {
        error_code: err.code,
        details: { reason: result.reason, configured_path: rawDir },
      });
      throw err;
    }
    // Platform-default rejection: log warn, fall back silently. Rare.
    logger.warn('platform default agent directory failed validation', {
      details: { reason: result.reason, configured_path: rawDir },
    });
    overrideValidationCache.set(rawDir, null);
    return null;
  }

  if (!overrideActiveAnnounced) {
    overrideActiveAnnounced = true;
    const fields = {
      resolved_path: result.resolvedPath,
      allowlist_match: result.allowlistMatch,
      has_unsafe_override: result.unsafeOverride,
      source: explicit ? 'env' : 'platform_default',
    };
    if (result.unsafeOverride) {
      logger.warn('agent override active (unsafe escape hatch)', { details: fields });
    } else {
      logger.info('agent override active', { details: fields });
    }
  }

  await checkOverrideDirPerms(result.resolvedPath);

  overrideValidationCache.set(rawDir, result);
  return result;
}

/**
 * Validate an agent name against the AGENT_FILE_MAP. Prevents agent-name
 * traversal (e.g. `../../../etc/passwd`) at the loader boundary.
 */
function assertKnownAgent(name: string): asserts name is AgentName {
  if (!Object.prototype.hasOwnProperty.call(AGENT_FILE_MAP, name)) {
    throw new SquadError('UNKNOWN_AGENT', `unknown agent: ${name}`, { name });
  }
}

export async function resolveAgentFile(name: AgentName): Promise<string> {
  await ensureEmbeddedDir();
  assertKnownAgent(name);
  const file = AGENT_FILE_MAP[name];
  const override = await resolveOverride();
  if (override) {
    const overrideFile = await validateOverrideFile(override.resolvedPath, file);
    if (overrideFile) return overrideFile;
    // File missing or per-file escape — silent fallback to embedded for this file.
  }
  return path.join(getEmbeddedDir(), file);
}

export async function resolveSharedFile(file: string): Promise<string> {
  await ensureEmbeddedDir();
  if (!SHARED_FILES.includes(file)) {
    throw new SquadError('INVALID_INPUT', `shared file not allowed: ${file}`, { file });
  }
  const override = await resolveOverride();
  if (override) {
    const overrideFile = await validateOverrideFile(override.resolvedPath, file);
    if (overrideFile) return overrideFile;
  }
  return path.join(getEmbeddedDir(), file);
}

export async function readAgentDefinition(name: AgentName): Promise<string> {
  const filePath = await resolveAgentFile(name);
  return fs.readFile(filePath, 'utf8');
}

export async function listAvailableAgents() {
  // Trigger validation so misconfigured overrides surface here too.
  let overridden = false;
  try {
    const result = await resolveOverride();
    overridden = result !== null;
  } catch {
    // OVERRIDE_REJECTED bubbles up to the caller via the resolve call below
    // when individual agent files are read. For listing, treat as no override.
    overridden = false;
  }
  return Object.values(AGENTS).map((a) => ({
    name: a.name,
    role: a.role,
    owns: a.owns,
    conventions: a.conventions,
    file: AGENT_FILE_MAP[a.name],
    overridden,
  }));
}

export async function initLocalConfig(force = false): Promise<{ created: string[]; skipped: string[]; dir: string }> {
  await ensureEmbeddedDir();
  const { rawDir } = getLocalDir();
  await createSecureDir(rawDir);
  const created: string[] = [];
  const skipped: string[] = [];
  // SECURITY: file names come from hardcoded constants only; never accept user-supplied names here.
  const sources = [...Object.values(AGENT_FILE_MAP), ...SHARED_FILES];
  for (const file of sources) {
    const dst = path.join(rawDir, file);
    if ((await exists(dst)) && !force) {
      skipped.push(file);
      continue;
    }
    const src = path.join(getEmbeddedDir(), file);
    await copyFileSecure(src, dst);
    created.push(file);
  }
  return { created, skipped, dir: rawDir };
}
