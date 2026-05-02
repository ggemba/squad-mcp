import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SquadError } from '../errors.js';
import { rejectIfMalformed, realpathOrSelf } from './path-internal.js';

/**
 * Validates that a directory chosen as the agent-override location lives under
 * a known user-controlled prefix, and that per-file resolutions inside it stay
 * under that directory after symlink resolution.
 *
 * This module is distinct from `path-safety.ts` because the abstraction differs:
 *  - `path-safety` validates many files against ONE workspace root.
 *  - `override-allowlist` validates ONE directory against MANY allowed prefixes.
 * Merging the two would give `resolveSafePath` two operating modes selected by
 * argument shape (SRP violation). Keep them separate.
 *
 * TOCTOU posture: identical to `path-safety.ts`. A symlink can be swapped between
 * `realpath()` and `fs.readFile()`. Acceptable for a single-user dev tool — an
 * attacker with write access to a user-allowlisted root has already won.
 */

export type OverrideRejectionReason =
  | 'malformed'
  | 'not_absolute'
  | 'unc_or_device_namespace'
  | 'outside_allowlist'
  | 'symlink_escape';

export interface AllowlistRoot {
  source: 'home' | 'appdata' | 'localappdata' | 'xdg_config_home' | 'cwd';
  lexical: string;
  real: string;
}

export interface ValidationOk {
  ok: true;
  resolvedPath: string;
  allowlistMatch: AllowlistRoot['source'] | 'unsafe_override';
  unsafeOverride: boolean;
}

export interface ValidationFail {
  ok: false;
  reason: OverrideRejectionReason;
  rejectedPath: string;
}

export type ValidationResult = ValidationOk | ValidationFail;

let allowlistCache: AllowlistRoot[] | null = null;

/**
 * Test-only: clears the memoized allowlist so env-var changes take effect.
 * Production code should never call this.
 */
export function __resetOverrideAllowlistCache(): void {
  allowlistCache = null;
}

function isUnsafeOverrideEnabled(): boolean {
  return process.env.SQUAD_AGENTS_ALLOW_UNSAFE === '1';
}

function isUncOrDeviceNamespace(absolute: string): boolean {
  if (process.platform !== 'win32') return false;
  if (absolute.startsWith('\\\\?\\')) return true;
  if (absolute.startsWith('\\\\.\\')) return true;
  if (absolute.startsWith('\\\\')) return true;
  return false;
}

async function buildAllowlist(): Promise<AllowlistRoot[]> {
  if (allowlistCache !== null) return allowlistCache;
  const roots: AllowlistRoot[] = [];
  const seen = new Set<string>();

  const candidates: { source: AllowlistRoot['source']; raw: string | undefined }[] = [
    { source: 'home', raw: os.homedir() },
    { source: 'cwd', raw: process.cwd() },
  ];
  if (process.platform === 'win32') {
    candidates.push({ source: 'appdata', raw: process.env.APPDATA });
    candidates.push({ source: 'localappdata', raw: process.env.LOCALAPPDATA });
  } else {
    candidates.push({ source: 'xdg_config_home', raw: process.env.XDG_CONFIG_HOME });
  }

  for (const c of candidates) {
    if (!c.raw) continue;
    if (!path.isAbsolute(c.raw)) continue;
    try {
      rejectIfMalformed(c.raw);
    } catch {
      // hostile env var (e.g. APPDATA injected with NUL) — silently skip from allowlist
      continue;
    }
    if (isUncOrDeviceNamespace(c.raw)) continue;
    const lexical = path.normalize(c.raw);
    const real = await realpathOrSelf(lexical);
    if (seen.has(real)) continue;
    seen.add(real);
    roots.push({ source: c.source, lexical, real });
  }

  allowlistCache = roots;
  return roots;
}

function isInsideRoot(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const rel = path.relative(root, candidate);
  if (rel === '' || rel === '.') return true;
  if (path.isAbsolute(rel)) return false;
  if (rel === '..') return false;
  if (rel.startsWith('..' + path.sep)) return false;
  return true;
}

function findAllowlistMatch(
  candidateLexical: string,
  candidateReal: string,
  roots: AllowlistRoot[],
): AllowlistRoot | null {
  // Lexical AND realpath both must be inside the same allowlist entry.
  // (Either alone is a known bypass: a symlinked-out lexical-allowed path,
  // or a realpath-allowed path that lexically points elsewhere.)
  for (const r of roots) {
    if (isInsideRoot(candidateLexical, r.lexical) && isInsideRoot(candidateReal, r.real)) {
      return r;
    }
  }
  return null;
}

/**
 * Validate an override directory.
 *
 * Returns the resolved (realpath) directory on success. Throws `OVERRIDE_REJECTED`
 * for policy violations (UNC, malformed, not absolute, outside allowlist, symlink
 * escape) UNLESS `SQUAD_AGENTS_ALLOW_UNSAFE=1` is set, in which case the violation
 * is bypassed (still rejects malformed inputs hard — those are not policy choices).
 */
export async function validateOverrideDir(rawDir: string): Promise<ValidationResult> {
  // Hard rejections — never bypassed by the escape hatch.
  try {
    rejectIfMalformed(rawDir);
  } catch (err) {
    return { ok: false, reason: 'malformed', rejectedPath: rawDir };
  }

  if (!path.isAbsolute(rawDir)) {
    return { ok: false, reason: 'not_absolute', rejectedPath: rawDir };
  }

  if (isUncOrDeviceNamespace(rawDir)) {
    return { ok: false, reason: 'unc_or_device_namespace', rejectedPath: rawDir };
  }

  const lexical = path.normalize(rawDir);
  const real = await realpathOrSelf(lexical);

  const unsafe = isUnsafeOverrideEnabled();
  const roots = await buildAllowlist();
  const match = findAllowlistMatch(lexical, real, roots);

  if (match) {
    return { ok: true, resolvedPath: real, allowlistMatch: match.source, unsafeOverride: false };
  }

  // Distinguish lexical-only escape (likely symlink) from outright outside-allowlist.
  // If lexical matches some root but realpath does not, the user did `ln -s /tmp/x ~/.squad`.
  let lexicalMatchExists = false;
  for (const r of roots) {
    if (isInsideRoot(lexical, r.lexical)) {
      lexicalMatchExists = true;
      break;
    }
  }
  const reason: OverrideRejectionReason = lexicalMatchExists ? 'symlink_escape' : 'outside_allowlist';

  if (unsafe) {
    return { ok: true, resolvedPath: real, allowlistMatch: 'unsafe_override', unsafeOverride: true };
  }

  return { ok: false, reason, rejectedPath: rawDir };
}

/**
 * Convert a `ValidationFail` into a structured `OVERRIDE_REJECTED` error.
 * Caller decides whether to throw or downgrade to a warn-and-fallback.
 */
export function rejectionToError(fail: ValidationFail, allowlistSize: number): SquadError {
  return new SquadError('OVERRIDE_REJECTED', `override directory rejected: ${fail.reason}`, {
    reason: fail.reason,
    path: fail.rejectedPath,
    allowlist_size: allowlistSize,
  });
}

export async function getAllowlistSize(): Promise<number> {
  const roots = await buildAllowlist();
  return roots.length;
}

/**
 * Validate that a candidate file path inside a previously-validated override
 * directory does not escape (after symlink resolution).
 *
 * Returns the file's realpath on success, or `null` if the file does not exist
 * or escapes the directory. Per-file escape is NOT a policy-level error — the
 * caller falls back to embedded for that file only and continues.
 */
export async function validateOverrideFile(validatedDirReal: string, fileName: string): Promise<string | null> {
  try {
    rejectIfMalformed(fileName);
  } catch {
    return null;
  }

  // Lexical: file name must not contain traversal segments.
  const normalized = path.normalize(fileName);
  if (path.isAbsolute(normalized)) return null;
  if (normalized === '..' || normalized.startsWith('..' + path.sep) || normalized.includes(path.sep + '..' + path.sep)) {
    return null;
  }

  const candidate = path.resolve(validatedDirReal, normalized);

  // Lexical containment.
  if (!isInsideRoot(candidate, validatedDirReal)) return null;

  // Existence check before realpath.
  try {
    await fs.access(candidate);
  } catch {
    return null;
  }

  const real = await realpathOrSelf(candidate);
  if (!isInsideRoot(real, validatedDirReal)) return null;

  return real;
}
