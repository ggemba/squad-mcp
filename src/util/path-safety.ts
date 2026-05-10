import { promises as fs } from "node:fs";
import path from "node:path";
import { SquadError } from "../errors.js";
import { rejectIfMalformed, realpathOrSelf } from "./path-internal.js";

export const MAX_BYTES = 16_384;

export interface SafePathContext {
  rootRealCache: Map<string, string>;
}

export function createSafePathContext(): SafePathContext {
  return { rootRealCache: new Map() };
}

/**
 * Lexical-only containment check for a config-supplied relative path
 * (e.g. `.squad.yaml` `learnings.path` / `tasks.path`).
 *
 * Sync; no filesystem access. Throws PATH_TRAVERSAL_DENIED if `configuredPath`
 * is absolute, or escapes `workspaceRoot` after lexical normalization. Used at
 * the boundary where the LLM-controllable config first becomes a real fs path
 * — without this, `.squad.yaml` with `learnings.path: ../../etc/whatever` gives
 * an arbitrary-write primitive (CWE-22).
 *
 * Does NOT resolve symlinks. The config itself lives inside the workspace, so
 * TOCTOU symlink swap is not in this gateway's threat model — the writer side
 * (resolveSafePath) handles that for the data write path.
 */
export function ensureRelativeInsideRoot(
  workspaceRoot: string,
  configuredPath: string,
  settingName: string,
): void {
  if (path.isAbsolute(configuredPath)) {
    throw new SquadError(
      "PATH_TRAVERSAL_DENIED",
      `${settingName} must be a workspace-relative path, not absolute`,
      { setting: settingName, configuredPath },
    );
  }
  const rootAbs = path.resolve(workspaceRoot);
  const candidateAbs = path.resolve(rootAbs, configuredPath);
  const rel = path.relative(rootAbs, candidateAbs);
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(".." + path.sep)) {
    throw new SquadError("PATH_TRAVERSAL_DENIED", `${settingName} escapes workspace_root`, {
      setting: settingName,
      configuredPath,
    });
  }
}

/**
 * Resolve a user-supplied file path safely against a workspace root.
 *
 * - When `workspaceRoot` is undefined, returns the path verbatim and the caller
 *   MUST treat it as path-only (no fs reads). Still rejects malformed input.
 * - When `workspaceRoot` is set, requires it to be absolute, normalizes both,
 *   collapses symlinks via fs.realpath, and asserts the candidate stays inside.
 *
 * Residual TOCTOU risk: a symlink can be swapped between realpath() and fs.open().
 * Acceptable for a single-user dev tool; document if used in a multi-tenant context.
 */
export async function resolveSafePath(
  workspaceRoot: string | undefined,
  file: string,
  ctx: SafePathContext,
): Promise<string> {
  rejectIfMalformed(file);

  if (workspaceRoot === undefined) {
    if (path.isAbsolute(file) || file.includes("..")) {
      throw new SquadError(
        "PATH_REQUIRES_WORKSPACE",
        "absolute or traversal-bearing path requires workspace_root",
        { file },
      );
    }
    return file;
  }

  if (!path.isAbsolute(workspaceRoot)) {
    throw new SquadError("PATH_INVALID", "workspace_root must be absolute", {
      workspaceRoot,
    });
  }

  const rootNormalized = path.normalize(workspaceRoot);
  let rootReal = ctx.rootRealCache.get(rootNormalized);
  if (rootReal === undefined) {
    rootReal = await realpathOrSelf(rootNormalized);
    ctx.rootRealCache.set(rootNormalized, rootReal);
  }

  const fileNormalized = path.normalize(file);
  const candidateAbs = path.resolve(rootReal, fileNormalized);

  const lexicalRel = path.relative(rootReal, candidateAbs);
  if (
    path.isAbsolute(lexicalRel) ||
    lexicalRel === ".." ||
    lexicalRel.startsWith(".." + path.sep)
  ) {
    throw new SquadError("PATH_TRAVERSAL_DENIED", "path escapes workspace_root (lexical)", {
      file,
    });
  }

  let candidateExists = false;
  try {
    await fs.access(candidateAbs);
    candidateExists = true;
  } catch {
    // file does not exist yet — lexical check above is enough
  }

  if (candidateExists) {
    const candidateReal = await realpathOrSelf(candidateAbs);
    const realRel = path.relative(rootReal, candidateReal);
    if (path.isAbsolute(realRel) || realRel === ".." || realRel.startsWith(".." + path.sep)) {
      throw new SquadError(
        "PATH_TRAVERSAL_DENIED",
        "path escapes workspace_root (after realpath)",
        { file },
      );
    }
    return candidateReal;
  }

  return candidateAbs;
}

export interface ReadSnippetResult {
  content: string;
  truncated: boolean;
}

/**
 * Read up to MAX_BYTES from a previously validated absolute path.
 *
 * Returns null on file-not-found or unreadable (silent).
 * Throws SquadError only if the caller's path-safety contract is violated upstream.
 */
export async function readSnippet(absPath: string): Promise<ReadSnippetResult | null> {
  let fh;
  try {
    fh = await fs.open(absPath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(MAX_BYTES);
    const { bytesRead } = await fh.read(buf, 0, MAX_BYTES, 0);
    return {
      content: buf.slice(0, bytesRead).toString("utf8"),
      truncated: bytesRead === MAX_BYTES,
    };
  } finally {
    await fh.close();
  }
}
