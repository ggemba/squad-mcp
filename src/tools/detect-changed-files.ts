import { z } from "zod";
import path from "node:path";
import type { ToolDef } from "./registry.js";
import { runGit, validateRef, type RunGitOptions } from "../exec/git.js";
import { isSquadError, SquadError } from "../errors.js";
import { createSafePathContext, resolveSafePath } from "../util/path-safety.js";
import { SafeString as safeString } from "./_shared/schemas.js";
import { logger } from "../observability/logger.js";

const schema = z
  .object({
    workspace_root: safeString(4096),
    base_ref: safeString(200).optional(),
    staged_only: z.boolean().optional().default(false),
    /**
     * Review the dirty working tree (everything not yet committed: staged
     * AND unstaged changes vs HEAD). Equivalent to `git diff HEAD`. The
     * common /squad:review use case where the user has been editing in a
     * branch and wants the squad to look at the work-in-progress before
     * committing.
     *
     * Mutually exclusive with `base_ref` and `staged_only` — see the
     * `.refine` below. Introduced v1.7.
     */
    working_tree: z.boolean().optional().default(false),
    /**
     * When true, run an additional `git diff --numstat` and sum
     * `insertions + deletions` across all changed text files. The result lands
     * in `total_loc_changed`. Default false to preserve the cheap-path
     * (one git subprocess) for callers that don't need the stat.
     *
     * Introduced v1.7 — feeds the `micro` auto-detect LOC cap in `selectMode`.
     * Binary files (numstat reports them as `-\t-\t<path>`) are excluded from
     * the sum; same for entries with a non-numeric add/del column.
     */
    with_stats: z.boolean().optional().default(false),
  })
  .refine((v) => !(v.working_tree && (v.base_ref !== undefined || v.staged_only)), {
    message:
      "working_tree is mutually exclusive with base_ref and staged_only — pass only one diff mode",
    path: ["working_tree"],
  });

type Input = z.infer<typeof schema>;

export type ChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type_changed"
  | "unknown";

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  raw_status: string;
  old_path?: string;
}

export interface DetectChangedFilesOutput {
  files: ChangedFile[];
  base_ref: string | null;
  staged_only: boolean;
  invocation: string;
  /**
   * Sum of `insertions + deletions` across all changed text files. Present
   * only when the caller passed `with_stats: true`. Excludes binary files
   * (numstat reports them as `-\t-\t<path>`) and any line whose first two
   * columns are not non-negative integers. Introduced v1.7 — feeds the
   * `micro` auto-detect LOC cap.
   */
  total_loc_changed?: number;
}

/**
 * Sum `git diff --numstat` output to a single LOC counter. The numstat format
 * is one line per file: `<adds>\t<dels>\t<path>` for text files,
 * `-\t-\t<path>` for binaries. Renames emit `<adds>\t<dels>\t<old> => <new>`
 * — we still count the line because both halves of the rename are reported
 * with real adds/dels when present.
 *
 * Defensive parse: any line where either column fails to parse as a
 * non-negative integer is silently skipped (the caller doesn't need to
 * distinguish "binary" from "malformed"; both yield 0 LOC for that entry).
 */
function sumNumstat(stdout: string): number {
  let total = 0;
  for (const lineRaw of stdout.split("\n")) {
    const line = lineRaw.trim();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const adds = Number.parseInt(parts[0]!, 10);
    const dels = Number.parseInt(parts[1]!, 10);
    if (!Number.isFinite(adds) || adds < 0) continue;
    if (!Number.isFinite(dels) || dels < 0) continue;
    total += adds + dels;
  }
  return total;
}

function mapStatus(raw: string): ChangeStatus {
  const code = raw[0];
  switch (code) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type_changed";
    default:
      return "unknown";
  }
}

function parseNameStatus(stdout: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  for (const lineRaw of stdout.split("\n")) {
    const line = lineRaw.trim();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const rawStatus = parts[0]!;
    const status = mapStatus(rawStatus);
    if (rawStatus.startsWith("R") || rawStatus.startsWith("C")) {
      const oldPath = parts[1];
      const newPath = parts[2];
      if (newPath !== undefined) {
        const entry: ChangedFile = {
          path: newPath,
          status,
          raw_status: rawStatus,
        };
        if (oldPath !== undefined) entry.old_path = oldPath;
        out.push(entry);
      }
    } else {
      const filePath = parts[1];
      if (filePath !== undefined) {
        out.push({ path: filePath, status, raw_status: rawStatus });
      }
    }
  }
  return out;
}

export type DetectOptions = RunGitOptions;

export async function detectChangedFiles(
  input: Input,
  opts: DetectOptions = {},
): Promise<DetectChangedFilesOutput> {
  const ctx = createSafePathContext();
  const cwd = await resolveSafePath(input.workspace_root, ".", ctx);
  if (!path.isAbsolute(cwd)) {
    throw new SquadError("PATH_REQUIRES_WORKSPACE", "workspace_root must resolve to absolute path");
  }

  let nameArgs: string[];
  let invocation: string;
  let baseRefUsed: string | null = null;
  let rangeSuffix: string[];

  if (input.working_tree) {
    // `git diff HEAD` — single-ref form (no `..`) — emits all changes
    // between HEAD and the working tree, which covers BOTH staged and
    // unstaged modifications. Mutual exclusivity with base_ref/staged_only
    // is enforced by the schema refine above.
    rangeSuffix = ["HEAD"];
    nameArgs = ["--name-status", "--no-renames", "HEAD"];
    invocation = "git diff --name-status --no-renames HEAD";
    baseRefUsed = "HEAD";
  } else if (input.staged_only) {
    rangeSuffix = ["--cached"];
    nameArgs = ["--name-status", "--no-renames", "--cached"];
    invocation = "git diff --name-status --no-renames --cached";
  } else if (input.base_ref) {
    validateRef(input.base_ref);
    baseRefUsed = input.base_ref;
    rangeSuffix = [`${input.base_ref}..HEAD`];
    nameArgs = ["--name-status", "--no-renames", `${input.base_ref}..HEAD`];
    invocation = `git diff --name-status --no-renames ${input.base_ref}..HEAD`;
  } else {
    rangeSuffix = ["HEAD~1..HEAD"];
    nameArgs = ["--name-status", "--no-renames", "HEAD~1..HEAD"];
    invocation = "git diff --name-status --no-renames HEAD~1..HEAD";
    baseRefUsed = "HEAD~1";
  }

  // Run name-status and (optionally) numstat in parallel. Both subprocesses
  // talk to the same git index and don't block each other; the LOC stat is
  // cheap (one extra git fork, ~50-150ms cold) but waiting on it sequentially
  // would tax callers that ALWAYS pass with_stats=true (e.g. compose-core
  // auto-detect path). Promise.allSettled sequences by wall-clock max AND
  // isolates numstat failure: name-status is the authoritative result, a
  // numstat rejection (allowlist regression, OOM, transient git error) must
  // never kill the detect call. Fail-soft is intentional and documented in
  // the schema field's JSDoc.
  let nameResult: Awaited<ReturnType<typeof runGit>>;
  let numstatResult: Awaited<ReturnType<typeof runGit>> | null = null;
  if (input.with_stats) {
    const numstatArgs = ["--numstat", "--no-renames", ...rangeSuffix];
    const [nameSettled, numstatSettled] = await Promise.allSettled([
      runGit("diff", nameArgs, cwd, opts),
      runGit("diff", numstatArgs, cwd, opts),
    ]);
    if (nameSettled.status === "rejected") {
      const err = nameSettled.reason;
      if (isSquadError(err)) throw err;
      throw new SquadError("GIT_EXEC_DENIED", err instanceof Error ? err.message : String(err));
    }
    nameResult = nameSettled.value;
    if (numstatSettled.status === "fulfilled") {
      numstatResult = numstatSettled.value;
    } else {
      const err = numstatSettled.reason;
      const code = isSquadError(err) ? err.code : "UNKNOWN";
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("numstat subprocess rejected; omitting total_loc_changed", {
        details: { code, message },
      });
    }
  } else {
    try {
      nameResult = await runGit("diff", nameArgs, cwd, opts);
    } catch (err) {
      if (isSquadError(err)) throw err;
      throw new SquadError("GIT_EXEC_DENIED", err instanceof Error ? err.message : String(err));
    }
  }

  if (nameResult.code !== 0) {
    throw new SquadError(
      "GIT_EXEC_DENIED",
      `git exit ${nameResult.code}: ${nameResult.stderr.slice(0, 256)}`,
    );
  }

  const output: DetectChangedFilesOutput = {
    files: parseNameStatus(nameResult.stdout),
    base_ref: baseRefUsed,
    staged_only: input.staged_only,
    invocation,
  };

  // Numstat is an additive signal — if the second subprocess returned non-zero
  // OR was rejected outright (logged above), we surface the file list anyway
  // and just omit `total_loc_changed`. The caller's worst case is a downstream
  // auto-detect that falls through to `quick`/`normal` because the LOC cap
  // can't be evaluated; that is strictly safer than crashing the whole detect.
  if (numstatResult !== null && numstatResult.code === 0) {
    output.total_loc_changed = sumNumstat(numstatResult.stdout);
  }

  return output;
}

export const detectChangedFilesTool: ToolDef<typeof schema> = {
  name: "detect_changed_files",
  description:
    'Detect changed files in a git workspace via "git diff --name-status". Defaults to HEAD~1..HEAD; ' +
    "use base_ref to override or staged_only=true for index-staged changes. " +
    'Allowlisted refs only (no leading "-", no ".." substring, no "@{", max 200 chars). 10s timeout, 1MB output cap.',
  schema,
  handler: detectChangedFiles,
};
