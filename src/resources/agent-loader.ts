import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { AGENTS, type AgentName } from "../config/ownership-matrix.js";
import { SquadError } from "../errors.js";
import { logger } from "../observability/logger.js";
import {
  validateOverrideDir,
  validateOverrideFile,
  rejectionToError,
  getAllowlistSize,
  __resetOverrideAllowlistCache,
  type ValidationOk,
} from "../util/override-allowlist.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const AGENT_FILE_MAP: Record<AgentName, string> = {
  "product-owner": "product-owner.md",
  "tech-lead-planner": "tech-lead-planner.md",
  "tech-lead-consolidator": "tech-lead-consolidator.md",
  architect: "architect.md",
  dba: "dba.md",
  developer: "developer.md",
  reviewer: "reviewer.md",
  security: "security.md",
  qa: "qa.md",
  "code-explorer": "code-explorer.md",
  debugger: "debugger.md",
  implementer: "implementer.md",
};

export const SHARED_FILES = [
  "_Severity-and-Ownership.md",
  "Skill-Squad-Dev.md",
  "Skill-Squad-Review.md",
];

function defaultLocalDir(): string {
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appdata, "squad-mcp", "agents");
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "squad-mcp", "agents");
}

/**
 * Returns the configured override directory and whether it was set explicitly
 * via `SQUAD_AGENTS_DIR`. Empty string is treated as unset.
 */
export function getLocalDir(): { rawDir: string; explicit: boolean } {
  const env = process.env.SQUAD_AGENTS_DIR;
  if (env !== undefined && env !== "") {
    return { rawDir: env, explicit: true };
  }
  return { rawDir: defaultLocalDir(), explicit: false };
}

export function getEmbeddedDir(): string {
  return path.resolve(__dirname, "..", "..", "agents");
}

/**
 * Path to the shared docs directory at repo root (`<repo>/shared/`). Lives
 * outside `agents/` so the Claude Code plugin manifest's agent validator does
 * not see non-agent files. Mirrors to `<localOverrideDir>/shared/` when the
 * user runs init_local_config.
 */
export function getEmbeddedSharedDir(): string {
  return path.resolve(__dirname, "..", "..", "shared");
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
  if (process.platform !== "win32") {
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
  if (process.platform !== "win32") {
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
  if (process.platform === "win32") return;
  if (permWarnEmitted) return;
  permWarnEmitted = true;
  try {
    const s = await fs.stat(dir);
    if ((s.mode & 0o002) !== 0) {
      logger.warn("override directory is world-writable", {
        details: {
          configured_path: dir,
          mode: "0o" + (s.mode & 0o777).toString(8),
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
    throw new SquadError("AGENT_DIR_MISSING", `embedded agents directory missing at ${dir}`);
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
      logger.warn(
        "SQUAD_AGENTS_DIR set but directory not found; falling back to embedded defaults",
        {
          details: { configured_path: rawDir },
        },
      );
    }
    overrideValidationCache.set(rawDir, null);
    return null;
  }

  const result = await validateOverrideDir(rawDir);

  if (!result.ok) {
    if (explicit) {
      const size = await getAllowlistSize();
      const err = rejectionToError(result, size);
      logger.warn("SQUAD_AGENTS_DIR rejected", {
        error_code: err.code,
        details: { reason: result.reason, configured_path: rawDir },
      });
      throw err;
    }
    // Platform-default rejection: log warn, fall back silently. Rare.
    logger.warn("platform default agent directory failed validation", {
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
      source: explicit ? "env" : "platform_default",
    };
    if (result.unsafeOverride) {
      logger.warn("agent override active (unsafe escape hatch)", {
        details: fields,
      });
    } else {
      logger.info("agent override active", { details: fields });
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
    throw new SquadError("UNKNOWN_AGENT", `unknown agent: ${name}`, { name });
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
    throw new SquadError("INVALID_INPUT", `shared file not allowed: ${file}`, {
      file,
    });
  }
  const override = await resolveOverride();
  if (override) {
    // Override mirrors source layout: `<localOverrideDir>/shared/<file>`.
    const overrideFile = await validateOverrideFile(
      override.resolvedPath,
      path.join("shared", file),
    );
    if (overrideFile) return overrideFile;
  }
  return path.join(getEmbeddedSharedDir(), file);
}

export async function readAgentDefinition(name: AgentName): Promise<string> {
  const filePath = await resolveAgentFile(name);
  return fs.readFile(filePath, "utf8");
}

/**
 * Allowed language identifier shape for the on-disk supplement layout
 * (`agents/<agent>.langs/<lang>.md`). Restricted to lowercase letters, digits,
 * underscore, hyphen — matches `Language` type in `src/exec/detect-languages.ts`
 * (which uses `typescript`, `csharp`, etc) AND defends against path traversal
 * (`../foo`) at the validation layer before any fs call.
 *
 * If the language identifier doesn't match this shape, the supplement read
 * silently returns null — the language is treated as "no supplement available"
 * rather than throwing. Same envelope as the existing `validateOverrideFile`
 * fallback contract.
 */
const LANGUAGE_ID_REGEX = /^[a-z0-9_-]+$/;

/**
 * Read a single per-language supplement file for an agent, returning the file
 * body or `null` when the file does not exist (no `.langs/` directory, or no
 * `<lang>.md` inside it).
 *
 * Language-supplement layout:
 *   agents/
 *     reviewer.md            ← core (always loaded as agent system prompt)
 *     reviewer.langs/        ← optional directory
 *       typescript.md         ← per-language addendum
 *       python.md
 *       csharp.md
 *
 * The directory is OPTIONAL. Agents without `.langs/` (e.g. `architect`,
 * `tech-lead-*`) just return null for every language — caller composes the
 * bundle without supplements and the agent runs on its core prompt only.
 *
 * Override directory support is intentionally NOT plumbed in v0.13 — supplement
 * files ship with the package and are not user-overridable yet. When a user
 * customises an agent role they edit the core `.md`; per-language addenda are
 * curated. Adding override support is a follow-up if the demand surfaces.
 */
export async function readAgentLanguageSupplement(
  name: AgentName,
  language: string,
): Promise<string | null> {
  await ensureEmbeddedDir();
  assertKnownAgent(name);
  if (typeof language !== "string" || !LANGUAGE_ID_REGEX.test(language)) {
    // Path-traversal defence: only well-formed language ids reach the fs.
    return null;
  }
  const embedded = getEmbeddedDir();
  const supplementPath = path.join(embedded, `${name}.langs`, `${language}.md`);
  try {
    return await fs.readFile(supplementPath, "utf8");
  } catch {
    // ENOENT (no supplement for this lang) and any other read failure are
    // treated the same — supplements are an optimisation, never load-bearing.
    return null;
  }
}

/**
 * Bulk variant: load supplements for multiple languages at once. Returns a
 * record keyed by language, value = content. Languages with no supplement on
 * disk are OMITTED from the result (not present as `null`) so callers can
 * iterate `Object.entries` and trust every value is a real string.
 */
export async function readAgentLanguageSupplements(
  name: AgentName,
  languages: readonly string[],
): Promise<Record<string, string>> {
  const results = await Promise.all(
    languages.map(async (lang) => {
      const body = await readAgentLanguageSupplement(name, lang);
      return [lang, body] as const;
    }),
  );
  const out: Record<string, string> = {};
  for (const [lang, body] of results) {
    if (body !== null) out[lang] = body;
  }
  return out;
}

/**
 * Read a single per-framework supplement file for an agent, returning the
 * file body or `null` when it does not exist. The `.frameworks/` layout
 * mirrors `.langs/`:
 *   agents/
 *     reviewer.md            ← core
 *     reviewer.frameworks/   ← optional directory
 *       react.md
 *       vue.md
 *
 * The directory is OPTIONAL — agents without it return null for every
 * framework. Today only `reviewer` ships a `.frameworks/` directory.
 */
export async function readAgentFrameworkSupplement(
  name: AgentName,
  framework: string,
): Promise<string | null> {
  await ensureEmbeddedDir();
  assertKnownAgent(name);
  if (typeof framework !== "string" || !LANGUAGE_ID_REGEX.test(framework)) {
    // Path-traversal defence: only well-formed framework ids reach the fs.
    return null;
  }
  const embedded = getEmbeddedDir();
  const supplementPath = path.join(embedded, `${name}.frameworks`, `${framework}.md`);
  try {
    return await fs.readFile(supplementPath, "utf8");
  } catch {
    // ENOENT / any read failure — supplements are an optimisation, never
    // load-bearing. Same fail-soft envelope as the language variant.
    return null;
  }
}

/** Bulk variant of `readAgentFrameworkSupplement` — see `readAgentLanguageSupplements`. */
export async function readAgentFrameworkSupplements(
  name: AgentName,
  frameworks: readonly string[],
): Promise<Record<string, string>> {
  const results = await Promise.all(
    frameworks.map(async (fw) => [fw, await readAgentFrameworkSupplement(name, fw)] as const),
  );
  const out: Record<string, string> = {};
  for (const [fw, body] of results) {
    if (body !== null) out[fw] = body;
  }
  return out;
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

export async function initLocalConfig(
  force = false,
): Promise<{ created: string[]; skipped: string[]; dir: string }> {
  await ensureEmbeddedDir();
  const { rawDir } = getLocalDir();
  await createSecureDir(rawDir);
  const created: string[] = [];
  const skipped: string[] = [];
  // SECURITY: file names come from hardcoded constants only; never accept user-supplied names here.
  // Agent files mirror to <rawDir>/<file>.md.
  // Shared docs mirror to <rawDir>/shared/<file>.md (matches the source layout
  // since the dir was lifted out of agents/ in v0.6.1 to satisfy the Claude
  // Code plugin manifest validator).
  const targets: { src: string; dst: string; rel: string }[] = [
    ...Object.values(AGENT_FILE_MAP).map((file) => ({
      src: path.join(getEmbeddedDir(), file),
      dst: path.join(rawDir, file),
      rel: file,
    })),
    ...SHARED_FILES.map((file) => ({
      src: path.join(getEmbeddedSharedDir(), file),
      dst: path.join(rawDir, "shared", file),
      rel: path.join("shared", file),
    })),
  ];
  for (const { src, dst, rel } of targets) {
    if ((await exists(dst)) && !force) {
      skipped.push(rel);
      continue;
    }
    const parent = path.dirname(dst);
    if (parent !== rawDir) {
      await createSecureDir(parent);
    }
    await copyFileSecure(src, dst);
    created.push(rel);
  }
  return { created, skipped, dir: rawDir };
}
