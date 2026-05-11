import { runGit, validateRef, type RunGitOptions } from "./git.js";
import { SquadError } from "../errors.js";

/**
 * Diff-hunk extraction over the hardened `runGit` wrapper. Used by the advisory
 * bundle (`compose_advisory_bundle`) to feed each agent the changed regions of
 * each file instead of the whole file content — typically cuts the prompt to
 * 10-30% of the original size and removes 10-20% of Sonnet wall-clock per
 * dispatch (the squad-mcp v0.12 perf series).
 *
 * Design notes:
 *  - Single `git diff` call for the union of files, not one call per file. On
 *    a 30-file PR the per-call approach burned ~3-5s in subprocess overhead;
 *    one call returns concatenated unified-diff sections we then split.
 *  - `truncated`: per-file byte cap (default 8 KB) protects the prompt budget
 *    from giant deletions / generated-code diffs. Agents see a truncation
 *    marker and have `Read` tool access to retrieve full context if needed.
 *  - `full_file_changed`: set on file ADD / DELETE (git uses dedicated headers
 *    `new file mode` / `deleted file mode`). The caller can decide to fall
 *    back to passing full content (or skip the agent for deleted files).
 *  - No mutation: pure `git diff` invocation, no side effects on the workspace.
 */

export interface FileHunk {
  /** Unified diff for this file, possibly truncated. */
  diff: string;
  /** True iff `diff` was cut at `max_bytes_per_file`. */
  truncated: boolean;
  /**
   * True iff the file was added or deleted whole (git emits `new file mode`
   * or `deleted file mode` in the diff header). Caller may choose to pass
   * the full file content via `Read` instead of relying on the diff.
   */
  full_file_changed: boolean;
  /**
   * True iff git classified the file as binary (`Binary files a/x and b/y differ`
   * or similar — no `@@` hunk header, no usable text diff). Callers must use
   * `Read` (or skip the agent for this file) — the `diff` field carries
   * only the one-line git marker, not the actual change.
   */
  is_binary: boolean;
  /** Pre-truncation byte size of the section, useful for budget telemetry. */
  byte_size: number;
}

export interface ExtractHunksInput {
  /** Absolute path to the git working tree. */
  cwd: string;
  /** Files (workspace-relative) to extract hunks for. */
  files: string[];
  /**
   * Compare against this ref instead of `HEAD~1`. Must satisfy
   * `validateRef` (see `git.ts`).
   */
  base_ref?: string;
  /**
   * Diff the staging area (`--cached`) instead of a commit range. When true,
   * `base_ref` is ignored.
   */
  staged_only?: boolean;
  /**
   * Per-file byte cap on the returned diff. Default 8 KB — large enough for
   * a typical multi-hunk change, small enough that 10+ files fit in the
   * Sonnet prompt budget. Truncated diffs carry a marker line.
   */
  max_bytes_per_file?: number;
  /**
   * Lines of unified-diff context. Default 3 (git default). Bump to 5 if
   * cross-hunk reasoning is needed; the prompt-budget cost is linear in
   * context size.
   */
  unified_context?: number;
}

export type ExtractHunksOptions = RunGitOptions;

const DEFAULT_MAX_BYTES_PER_FILE = 8192;
const DEFAULT_UNIFIED = 3;
const TRUNCATION_MARKER = "\n[... diff truncated by squad-mcp max_bytes_per_file ...]\n";
/**
 * Test-only export of the truncation marker so test fixtures can compute
 * exact bounds without duplicating the literal. NOT part of the public
 * runtime contract — agents and downstream consumers MUST branch on the
 * `truncated: boolean` field, never on the marker substring.
 */
export const TRUNCATION_MARKER_FOR_TESTS = TRUNCATION_MARKER;

/**
 * Extract per-file diff hunks via `git diff`. Returns a map keyed by the
 * post-change (b/) path. Files with no diff (e.g. supplied but unchanged)
 * are absent from the result rather than returned with an empty string.
 *
 * Throws SquadError on git failure or invalid base_ref.
 */
export async function extractFileHunks(
  input: ExtractHunksInput,
  opts: ExtractHunksOptions = {},
): Promise<Record<string, FileHunk>> {
  if (input.files.length === 0) return {};

  const maxBytes = input.max_bytes_per_file ?? DEFAULT_MAX_BYTES_PER_FILE;
  const unified = input.unified_context ?? DEFAULT_UNIFIED;

  // `--no-ext-diff`: pin git to its internal diff implementation regardless of
  // user global config. Without it, a user with `diff.external = mytool` in
  // their `~/.gitconfig` (or `GIT_EXTERNAL_DIFF` env var) hits a spawn-error
  // chain. The runGit hardening prefix passes `-c diff.external=` but in
  // practice the empty-override is unreliable across git versions; the flag
  // is the canonical defeat.
  const args: string[] = ["--no-ext-diff", `--unified=${unified}`];
  if (input.staged_only) {
    args.push("--cached");
  } else if (input.base_ref) {
    validateRef(input.base_ref);
    args.push(`${input.base_ref}..HEAD`);
  } else {
    args.push("HEAD~1..HEAD");
  }
  // `--` separator: everything after is a path. Defends against a file named
  // `-something` being interpreted as a flag.
  args.push("--");
  for (const f of input.files) args.push(f);

  const result = await runGit("diff", args, input.cwd, opts);
  if (result.code !== 0) {
    throw new SquadError(
      "GIT_EXEC_DENIED",
      `git diff exit ${result.code}: ${result.stderr.slice(0, 256)}`,
    );
  }

  return parseUnifiedDiff(result.stdout, maxBytes);
}

/**
 * Split concatenated `git diff` output into per-file sections. Each section
 * starts with `diff --git a/<path> b/<path>`. The post-change path (`b/`) is
 * the canonical key — matches what `detect_changed_files` reports for renames.
 *
 * Header shapes handled:
 *   `diff --git a/<path> b/<path>`         — common case, ASCII path
 *   `diff --git "a/<path>" "b/<path>"`     — quoted form (paths with spaces,
 *                                              non-ASCII bytes, control chars)
 *                                              when `core.quotePath = true`
 *                                              (git default). The quoted body
 *                                              uses C-escape sequences.
 *
 * On Windows, `git diff` may emit CRLF line endings in the body. The
 * `\nnew file mode ` / `\ndeleted file mode ` substring checks would miss
 * a leading `\r`, so we normalise line endings before scanning for those
 * markers. The output `diff` field retains the original line endings.
 *
 * Binary files (`Binary files a/x and b/y differ`) are detected via the
 * absence of any `@@` hunk header AND the literal `Binary files` marker.
 * Callers must check `is_binary` and fall back to `Read` (or skip the file).
 *
 * Exported for tests; not for general use.
 */
export function parseUnifiedDiff(stdout: string, maxBytes: number): Record<string, FileHunk> {
  const out: Record<string, FileHunk> = {};
  if (stdout.length === 0) return out;

  // Split keeping each `diff --git` block. The lookahead-positive regex keeps
  // the delimiter at the head of each chunk. `^` is line-anchored under the
  // `m` flag, so a literal `diff --git ` appearing inside the diff body (in
  // a context, addition, or deletion line — all start with ` `/`+`/`-`, never
  // column 0) cannot be misinterpreted as a new section header.
  const sections = stdout.split(/(?=^diff --git )/m).filter((s) => s.startsWith("diff --git "));
  for (const section of sections) {
    const firstLineEnd = section.search(/\r?\n/);
    const header = firstLineEnd >= 0 ? section.slice(0, firstLineEnd) : section;

    const filePath = extractPostChangePath(header);
    if (filePath === null) continue;

    // Normalise line endings for the marker-presence checks only. The output
    // diff retains the original encoding so callers feeding it back into
    // tools that expect git's native format are not surprised.
    const normalised = section.replace(/\r\n/g, "\n");
    const byteSize = Buffer.byteLength(section, "utf8");
    const fullFileChanged =
      normalised.includes("\nnew file mode ") || normalised.includes("\ndeleted file mode ");
    // Binary detection: git emits `Binary files a/x and b/y differ` (or
    // `GIT binary patch` on full binary patch mode). Either is a hard signal
    // that the agent will not get a usable text diff.
    const isBinary =
      /\nBinary files .+ differ\b/.test(normalised) || normalised.includes("\nGIT binary patch\n");

    const truncated = byteSize > maxBytes;
    const diff = truncated
      ? section.slice(0, Math.max(0, maxBytes - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER
      : section;

    out[filePath] = {
      diff,
      truncated,
      full_file_changed: fullFileChanged,
      is_binary: isBinary,
      byte_size: byteSize,
    };
  }
  return out;
}

/**
 * Extract the post-change (`b/`) path from a `diff --git` header line.
 * Handles both unquoted and quoted forms.
 *
 *   Unquoted: `diff --git a/src/foo.ts b/src/foo.ts`
 *   Quoted:   `diff --git "a/src/path with space.ts" "b/src/path with space.ts"`
 *
 * Quoted paths use C-escape syntax (`\t`, `\"`, `\\`, `\<octal>` for high
 * bytes). For now we strip the surrounding quotes and unescape only the
 * common one — `\"`. Other escape sequences are left as-is in the returned
 * path; agents see git's escaped form rather than a corrupted reconstruction.
 *
 * Returns null when the header doesn't match either shape — caller should
 * skip the section.
 */
function extractPostChangePath(header: string): string | null {
  // Unquoted: greedy on the a/ side, capture the b/ tail to end of line.
  const unquoted = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
  if (unquoted) {
    return unquoted[2] ?? null;
  }
  // Quoted: both paths in double quotes.
  const quoted = /^diff --git "a\/((?:\\.|[^"\\])*)" "b\/((?:\\.|[^"\\])*)"$/.exec(header);
  if (quoted) {
    const raw = quoted[2];
    if (!raw) return null;
    return raw.replace(/\\"/g, '"');
  }
  return null;
}
