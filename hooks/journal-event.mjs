// @ts-check

/**
 * AUTO-JOURNALING — PURE EVENT-PROCESSING LOGIC (PR1 / Fase 1a).
 *
 * This module is the testable core of the opt-in PostToolUse hook. It is
 * deliberately split from the I/O adapter (`post-tool-use.mjs`) so the
 * decision logic — "is this event worth a breadcrumb, and what is the
 * breadcrumb?" — can be unit-tested directly with no filesystem, no stdin,
 * and no subprocess. The adapter is the only side-effecting layer.
 *
 * Plain Node ESM, ZERO dependencies. Reasons it must stay dep-free:
 *
 *  - It runs INSIDE the user's repo as a Claude Code PostToolUse hook,
 *    invoked by `node .squad/hooks/post-tool-use.mjs`. It is NOT part of the
 *    esbuild bundle in `dist/` — Claude Code spawns it as a standalone
 *    script, so it cannot rely on anything `npm`-installed in this package.
 *  - Bundling it would couple hook execution to a build step the user never
 *    runs; staying zero-dep keeps `enable-journaling` a pure file-copy.
 *
 * SCOPE BOUNDARY (PR1): this captures only WORK-TRAIL METADATA — a timestamp,
 * the tool name, and (when present and safe) the edited file path. It NEVER
 * captures file CONTENTS. `tool_input` carries the full edit payload; this
 * module reads exactly two named fields off it (`file_path`, `path`) and
 * touches nothing else. No `JSON.stringify(tool_input)` anywhere.
 *
 * Schema change (the learnings-store rows) is intentionally deferred to PR2.
 * This file emits a version-less breadcrumb shape; `src/journal/pending.ts`
 * documents why pending rows carry no `schema_version`.
 */

import path from "node:path";

/**
 * Hard ceiling on a captured path length. A path longer than this is almost
 * certainly not a real edit target (4096 is the common `PATH_MAX`); over-long
 * input is dropped to `path = null` rather than recorded.
 */
const MAX_PATH_LENGTH = 4096;

/**
 * Lexical containment check for a candidate path against the process cwd.
 *
 * Returns the SANITISED path string when the path is safe to record, or
 * `null` when it must be dropped. A `null` here drops only the `path` field —
 * the breadcrumb (ts + tool) is still recorded. The caller never drops a
 * whole event because of a bad path.
 *
 * Rejection rules (any one → null):
 *  - non-string / empty input
 *  - contains a NUL byte (mirrors the learnings store's NUL refine)
 *  - length exceeds MAX_PATH_LENGTH
 *  - starts with `~` (home-relative; not workspace-relative — reject lexically)
 *  - after `path.resolve` against cwd, escapes cwd (traversal)
 */
function sanitisePath(candidate, cwd) {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  if (candidate.indexOf("\0") !== -1) return null;
  if (candidate.length > MAX_PATH_LENGTH) return null;
  // `~` paths are home-relative; `path.resolve` does NOT expand `~`, so a
  // lexical reject is the only correct guard here.
  if (candidate.startsWith("~")) return null;

  const rootAbs = path.resolve(cwd);
  const candidateAbs = path.resolve(rootAbs, candidate);
  const rel = path.relative(rootAbs, candidateAbs);
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(".." + path.sep)) {
    return null;
  }
  return candidate;
}

/**
 * Self-trigger guard. The journaling consumer (PR2) and the hook itself write
 * under `.squad/` — capturing those writes would make the journal feed on its
 * own tail. Returns `true` when the resolved path lands inside `.squad/`.
 *
 * Uses a RESOLVED-ABSOLUTE prefix check, never a substring match: a substring
 * test would false-positive on a sibling like `my.squad-notes/` and
 * false-negative on `./foo/../.squad/x`.
 */
function isInsideSquadDir(candidate, cwd) {
  const rootAbs = path.resolve(cwd);
  const candidateAbs = path.resolve(rootAbs, candidate);
  const squadPrefix = path.resolve(rootAbs, ".squad") + path.sep;
  return candidateAbs.startsWith(squadPrefix);
}

/**
 * Process one parsed PostToolUse payload into a breadcrumb, or `null` to skip.
 *
 * Input: the object produced by `JSON.parse` of the hook's stdin. Treated as
 * fully untrusted — every field access is defensive.
 *
 * Output:
 *  - `{ ts, tool, path }` — a breadcrumb. `path` is a sanitised string or
 *    `null`. `ts` is an ISO 8601 timestamp. `tool` is the tool name.
 *  - `null` — skip this event entirely. Two reasons: (a) no usable tool name,
 *    or (b) the edited path is inside `.squad/` (self-trigger).
 *
 * @param {unknown} payload
 * @returns {{ ts: string, tool: string, path: string | null } | null}
 */
export function processEvent(payload) {
  if (payload === null || typeof payload !== "object") return null;
  const obj = /** @type {Record<string, unknown>} */ (payload);

  // tool name — required. Absent or non-string → unusable, skip the event.
  const tool = obj.tool_name;
  if (typeof tool !== "string" || tool.length === 0) return null;

  // path — extract by NAMED destructure ONLY. We read exactly `file_path` and
  // `path` off tool_input and nothing else. tool_input is NEVER stringified,
  // so no file content can leak into the breadcrumb.
  const toolInput =
    obj.tool_input !== null && typeof obj.tool_input === "object"
      ? /** @type {Record<string, unknown>} */ (obj.tool_input)
      : {};
  const { file_path, path: pathField } = toolInput;
  const rawPath =
    typeof file_path === "string" ? file_path : typeof pathField === "string" ? pathField : null;

  const cwd = process.cwd();

  // Sanitise. A failure drops only the `path` field — the event is still
  // recorded (ts + tool still carry signal).
  let safePath = rawPath === null ? null : sanitisePath(rawPath, cwd);

  // Self-trigger guard. Only meaningful when we still have a usable path.
  // A write into `.squad/` skips the WHOLE event (return null) — otherwise
  // the journal would record its own drain/append churn.
  if (safePath !== null && isInsideSquadDir(safePath, cwd)) {
    return null;
  }

  return {
    ts: new Date().toISOString(),
    tool,
    path: safePath,
  };
}

/**
 * Serialise a breadcrumb into a single JSONL line, newline-terminated.
 * One object per line is the JSONL invariant the pending store relies on.
 *
 * @param {{ ts: string, tool: string, path: string | null }} crumb
 * @returns {string}
 */
export function serializeBreadcrumb(crumb) {
  return JSON.stringify(crumb) + "\n";
}
