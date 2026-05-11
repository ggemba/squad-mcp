import { promises as fs } from "node:fs";
import path from "node:path";
import { SquadError } from "../errors.js";
import { rejectIfMalformed, realpathOrSelf } from "./path-internal.js";

export const MAX_BYTES = 16_384;

/**
 * Truncate absolute filesystem paths inside a string to their last 3 segments,
 * with a `…/` prefix indicating truncation. Used by the MCP dispatch boundary
 * (`src/tools/registry.ts`) to sanitise `SquadError.message` and
 * `SquadError.details` before they leave the server to a (potentially
 * untrusted) MCP client.
 *
 * Why: error messages routinely embed `workspaceRoot` or absolute file paths
 * (e.g. `failed to read runs file /home/<user>/work/some-repo/.squad/runs.jsonl`).
 * The full path leaks the local user's home directory and folder layout —
 * useful debug context, but a sidechannel for username discovery if an MCP
 * client logs or relays error payloads.
 *
 * The transform is purely cosmetic — the `SquadError` itself, in-process,
 * still carries the full path for local debugging. Only the serialised
 * payload that crosses the dispatch boundary is sanitised.
 *
 * Recognised path shapes (handled non-greedily so multiple paths in one
 * string each truncate independently):
 *
 *   - POSIX absolute: `/foo/bar/baz/qux/file.ts`  → `…/baz/qux/file.ts`
 *   - Windows drive: `C:\foo\bar\baz\qux\file.ts` → `…/baz/qux/file.ts`
 *
 * Paths with fewer than 4 non-empty segments do not match the pattern (the
 * regex requires at least two interior separators) and are returned as-is.
 * Already-truncated paths (begin with `…/`) are idempotent under this
 * function (lookbehind prevents re-matching).
 */
export function pathSafe(s: string): string {
  if (typeof s !== "string" || s.length === 0) return s;
  // POSIX absolute path: starts with /, captures everything until a whitespace,
  // quote, or message-formatting boundary. The `(?<!…)` lookbehind prevents
  // re-matching after an already-truncated `…/` prefix (idempotency).
  const posix = /(?<!…)\/(?:[A-Za-z0-9._-][^\s'"`<>:,)\]]*\/)+[A-Za-z0-9._-][^\s'"`<>:,)\]]*/g;
  // Windows drive path: drive letter + colon + backslash, captured similarly.
  // Note: the Windows segment char-class adds a space (`[A-Za-z0-9._ -]` vs
  // POSIX's `[A-Za-z0-9._-]`) because Windows directory names commonly contain
  // spaces (`C:\Program Files\...`). POSIX paths conventionally do not, so
  // the asymmetry is intentional, not a copy-paste oversight.
  const win = /[A-Za-z]:\\(?:[A-Za-z0-9._ -][^\s'"`<>:,)\]]*\\)+[A-Za-z0-9._ -][^\s'"`<>:,)\]]*/g;
  const truncate = (match: string, sep: string): string => {
    // Drop empty leading segment from absolute paths (leading `/` gives `""`).
    const segments = match.split(sep).filter((p) => p.length > 0);
    if (segments.length <= 3) return match;
    return "…/" + segments.slice(-3).join("/");
  };
  return s.replace(posix, (m) => truncate(m, "/")).replace(win, (m) => truncate(m, "\\"));
}

/**
 * Recursively apply `pathSafe` to every string leaf in an error-details
 * payload. Top-level wrapper for `SquadError.details` sanitisation at the
 * dispatch boundary. Returns a deep-cloned object — the in-process error
 * is not mutated.
 */
export function pathSafeDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (details === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (typeof v === "string") {
      out[k] = pathSafe(v);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) => (typeof item === "string" ? pathSafe(item) : item));
    } else if (v !== null && typeof v === "object") {
      out[k] = pathSafeDetails(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

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
