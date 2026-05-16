import { promises as fs } from "node:fs";
import path from "node:path";
import type { ZodType, ZodTypeDef } from "zod";
import { SquadError } from "../errors.js";
import { ensureRelativeInsideRoot } from "./path-safety.js";
import { withFileLock } from "./file-lock.js";
import { logger } from "../observability/logger.js";

/**
 * GENERIC JSONL STORE — shared discipline for append-only journals.
 *
 * Extracted in v0.14.x (deep-review D1) to consolidate three nearly-identical
 * implementations of "JSONL with mtime+size cache, withFileLock, atomic
 * append-under-PIPE_BUF, schema_version pre-check, quarantine of corrupt
 * rows, 0o600 file mode". Until D1, each store re-implemented the same
 * pattern with subtle drift (e.g. learning/store had no schema_version
 * pre-check; tasks/store cache was mtime-only without size).
 *
 * Migration status:
 *  - `src/learning/store.ts` — MIGRATED to JsonlStore<LearningEntry>.
 *  - `src/runs/store.ts` — INTENTIONALLY NOT MIGRATED. It already carries
 *    the full discipline (mtime+size, schema_version gate, 0o600, lock
 *    around append) and its writer-side controls (control-char strip,
 *    RECORD_TOO_LARGE) are bespoke. Migrating would require either an
 *    invasive generic-extension or duplicating logic the class doesn't
 *    own. TODO: revisit consolidating runs/store once a second non-tasks
 *    consumer lands and the abstraction has settled.
 *  - `src/tasks/store.ts` — JSON (not JSONL) + mutate-in-place, not JSONL
 *    + append-only, so it does NOT use this class. Surgical hygiene fixes
 *    (size in cache key, 0o600 on writes + .prev) applied in-line.
 *
 * Discipline guarantees:
 *
 *  1. **mtime + size cache key.** Two writes landing in the same millisecond
 *     keep mtime identical; size always differs because each append-only
 *     line grows the file. Both must match for cache reuse — mirrors the
 *     runs/store pattern.
 *
 *  2. **schema_version pre-check BEFORE Zod.** Rows whose `schema_version` is
 *     not accepted by `isAcceptedVersion` are SKIPPED + LOGGED (not
 *     quarantined). This lets an incompatible producer's output be partially
 *     read without bricking, AND lets legacy rows be skipped instead of
 *     failing Zod validation. Only rows that pass the predicate are passed
 *     to Zod; Zod failures DO quarantine. The predicate defaults to a single
 *     literal match against the configured write version, but a consumer
 *     that reads a multi-version journal (e.g. learnings accepting {2, 3})
 *     supplies its own.
 *
 *  3. **Quarantine on corruption.** Unparseable JSON and Zod-violating rows
 *     are written to `${path}.corrupt-${Date.now()}.jsonl` with mode 0o600
 *     and a `# line N: <reason>` header per row. The original file is
 *     untouched and the surviving entries are returned in append order.
 *
 *  4. **Append discipline.** Each append: validate Zod → assert byte size ≤
 *     `maxRecordBytes` → take cross-process file lock → mkdir dir 0o700 →
 *     `fs.open(path, "a", 0o600)` → defensive `fh.chmod(0o600)` (catches
 *     pre-existing files older versions left at 0o644) → write line → close.
 *
 *  5. **No multi-row partial fallback.** Oversize records throw
 *     RECORD_TOO_LARGE. Splitting into continuation rows would erode the
 *     one-row-per-record invariant and reopen parsing ambiguity — see the
 *     runs/store header for the full advisor consensus.
 */

const DEFAULT_MAX_RECORD_BYTES = 4_000;

/**
 * Constructor options. `defaultPath` is the workspace-relative default;
 * callers may override per-call via `options.configuredPath` on read/append.
 *
 * `resolvePath` is an escape hatch: when a consumer needs custom path
 * resolution (e.g. honouring `.squad.yaml.learnings.path` lookup), it can
 * inject its own resolver. The default behaviour is "use `defaultPath` when
 * `configuredPath` is undefined; otherwise validate via `ensureRelativeInsideRoot`."
 */
export interface JsonlStoreOptions<TVersion extends number, T> {
  /** Workspace-relative default path (e.g. `.squad/learnings.jsonl`). */
  defaultPath: string;
  /**
   * Zod schema for one row. The OUTPUT type MUST satisfy
   * `T extends { schema_version: TVersion }`; the INPUT type may differ
   * (e.g. when the schema uses `.default(N)` on `schema_version`, the input
   * has `N | undefined` while the output is `N`). We deliberately use the
   * 3-param `ZodType<Output, Def, Input>` form with a permissive Input so
   * consumers can use `.default()` for backward-compat row reading without
   * fighting the type system.
   */
  schema: ZodType<T, ZodTypeDef, unknown>;
  /**
   * The schema version this store WRITES. Used as the default
   * `isAcceptedVersion` predicate (`(v) => v === writeVersion`) when no
   * explicit predicate is supplied. A store that reads a multi-version
   * journal still writes exactly one version, so this is unambiguous.
   */
  writeVersion: TVersion;
  /**
   * Read-gate acceptance predicate. A row whose `schema_version` fails this
   * predicate is SKIPPED + LOGGED (not quarantined). When omitted, the
   * default is a single-literal match against `writeVersion`. Supply a
   * widened predicate when a consumer must read more than one version
   * (e.g. learnings: `(v) => v === 2 || v === 3`).
   */
  isAcceptedVersion?: (v: unknown) => boolean;
  /** Per-row byte cap (post-serialisation including trailing newline). Default 4000. */
  maxRecordBytes?: number;
  /** Custom resolver. Default uses `defaultPath` + `ensureRelativeInsideRoot`. */
  resolvePath?: (
    workspaceRoot: string,
    configuredPath: string | undefined,
  ) => Promise<string> | string;
  /** Setting name used in PATH_TRAVERSAL_DENIED errors when `configuredPath` is rejected. */
  settingName?: string;
  /** Human-readable label for log messages (e.g. "learnings", "runs"). Defaults to "jsonl". */
  label?: string;
}

/**
 * Per-process cache entry. Keyed by absolute workspace root inside the
 * store's `cache` map.
 */
interface CacheEntry<T> {
  mtimeMs: number;
  /**
   * File size at the time of caching. Used with `mtimeMs` to guard against
   * same-millisecond writes that mtime-only cannot distinguish.
   */
  size: number;
  filePath: string;
  entries: T[];
}

/**
 * Generic append-only JSONL store. One instance per consumer (module-scope
 * singleton); the orchestrator MUST NOT instantiate per public-function call,
 * or the per-process cache will be thrown away on every call.
 */
export class JsonlStore<TVersion extends number, T extends { schema_version: TVersion }> {
  private readonly options: Required<
    Omit<
      JsonlStoreOptions<TVersion, T>,
      "resolvePath" | "settingName" | "label" | "isAcceptedVersion"
    >
  > & {
    resolvePath: (
      workspaceRoot: string,
      configuredPath: string | undefined,
    ) => Promise<string> | string;
    settingName: string;
    label: string;
    isAcceptedVersion: (v: unknown) => boolean;
  };
  private cache = new Map<string, CacheEntry<T>>();

  constructor(options: JsonlStoreOptions<TVersion, T>) {
    const settingName = options.settingName ?? "jsonl.path";
    const defaultResolver = (workspaceRoot: string, configuredPath: string | undefined): string => {
      const rel = configuredPath ?? options.defaultPath;
      if (configuredPath !== undefined) {
        ensureRelativeInsideRoot(workspaceRoot, rel, settingName);
      }
      return path.resolve(workspaceRoot, rel);
    };
    // Default read-gate predicate: single-literal match against the
    // configured write version. A consumer reading a multi-version journal
    // overrides this with a widened predicate.
    const defaultIsAcceptedVersion = (v: unknown): boolean => v === options.writeVersion;
    this.options = {
      defaultPath: options.defaultPath,
      schema: options.schema,
      writeVersion: options.writeVersion,
      maxRecordBytes: options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES,
      resolvePath: options.resolvePath ?? defaultResolver,
      settingName,
      label: options.label ?? "jsonl",
      isAcceptedVersion: options.isAcceptedVersion ?? defaultIsAcceptedVersion,
    };
  }

  /**
   * Test-only: clear the per-process cache. Production code MUST NOT call this.
   */
  __resetCacheForTests(): void {
    this.cache.clear();
  }

  /**
   * Resolve the absolute file path for a given workspace + optional override.
   */
  resolveFilePath(workspaceRoot: string, configuredPath: string | undefined): Promise<string> {
    return Promise.resolve(this.options.resolvePath(workspaceRoot, configuredPath));
  }

  /**
   * Read all rows. Returns `[]` if the file does not exist (a fresh repo
   * with no rows is the common case). Rows whose `schema_version` fails the
   * `isAcceptedVersion` predicate are skipped + logged. Rows that fail Zod
   * validation are quarantined.
   */
  async read(workspaceRoot: string, options: { configuredPath?: string } = {}): Promise<T[]> {
    const filePath = await this.resolveFilePath(workspaceRoot, options.configuredPath);
    const absRoot = path.resolve(workspaceRoot);

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return [];
    }
    if (!stat.isFile()) return [];

    const cached = this.cache.get(absRoot);
    if (
      cached &&
      cached.filePath === filePath &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      return cached.entries;
    }

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (err) {
      throw new SquadError(
        "CONFIG_READ_FAILED",
        `failed to read ${this.options.label} file ${filePath}: ${(err as Error).message}`,
        { source: filePath },
      );
    }

    const lines = raw.split(/\r?\n/);
    const entries: T[] = [];
    const corruptLines: { line: number; raw: string; reason: string }[] = [];
    let skippedUnknownVersion = 0;
    let lineNo = 0;
    for (const line of lines) {
      lineNo++;
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        corruptLines.push({
          line: lineNo,
          raw: trimmed,
          reason: `invalid JSON: ${(err as Error).message}`,
        });
        continue;
      }
      // schema_version gate — skip+log instead of quarantining. A row from an
      // incompatible producer would otherwise be treated as corrupt; this
      // allows a heterogeneous-version journal to be partially read. Legacy
      // rows (pre-rename) AND rows lacking `schema_version` are ALSO
      // skip+logged — the schema cannot accept them so they would otherwise
      // quarantine. The acceptance test is the `isAcceptedVersion` predicate
      // (default: single-literal match against `writeVersion`; learnings
      // widens it to {2, 3}). Migration is via `tools/migrate-jsonl-agents.mjs`.
      const rowVersion =
        typeof parsed === "object" && parsed !== null
          ? (parsed as { schema_version: unknown }).schema_version
          : undefined;
      if (!this.options.isAcceptedVersion(rowVersion)) {
        skippedUnknownVersion++;
        continue;
      }
      const validated = this.options.schema.safeParse(parsed);
      if (!validated.success) {
        corruptLines.push({
          line: lineNo,
          raw: trimmed,
          reason: `schema violation: ${validated.error.message}`,
        });
        continue;
      }
      entries.push(validated.data);
    }

    if (skippedUnknownVersion > 0) {
      logger.warn(`${this.options.label}: skipped rows with unknown schema_version`, {
        details: { file: filePath, count: skippedUnknownVersion },
      });
    }

    if (corruptLines.length > 0) {
      // Quarantine bad rows to a timestamped sibling file with restricted
      // mode. Best-effort: if the write fails we still surface the warning.
      const quarantinePath = `${filePath}.corrupt-${Date.now()}.jsonl`;
      try {
        const body = corruptLines.map((c) => `# line ${c.line}: ${c.reason}\n${c.raw}\n`).join("");
        await fs.writeFile(quarantinePath, body, { encoding: "utf8", mode: 0o600 });
      } catch {
        // Diagnostic write is not load-bearing.
      }
      logger.warn(`${this.options.label}: corrupt lines quarantined`, {
        details: {
          file: filePath,
          quarantine: quarantinePath,
          count: corruptLines.length,
          lines: corruptLines.map((c) => c.line),
        },
      });
    }

    this.cache.set(absRoot, { mtimeMs: stat.mtimeMs, size: stat.size, filePath, entries });
    return entries;
  }

  /**
   * Append one row. Returns the (possibly schema-transformed) entry that
   * landed on disk. Throws:
   *  - INVALID_INPUT on schema validation failure
   *  - RECORD_TOO_LARGE when the serialised line exceeds `maxRecordBytes`
   *  - PATH_TRAVERSAL_DENIED when `configuredPath` escapes workspaceRoot
   */
  async append(
    workspaceRoot: string,
    entry: T,
    options: { configuredPath?: string } = {},
  ): Promise<{ filePath: string; entry: T }> {
    const validated = this.options.schema.safeParse(entry);
    if (!validated.success) {
      throw new SquadError(
        "INVALID_INPUT",
        `${this.options.label} entry schema violation: ${validated.error.message}`,
        { issues: validated.error.issues.length },
      );
    }

    const line = JSON.stringify(validated.data) + "\n";
    const byteLen = Buffer.byteLength(line, "utf8");
    if (byteLen > this.options.maxRecordBytes) {
      throw new SquadError(
        "RECORD_TOO_LARGE",
        `${this.options.label} record exceeds maxRecordBytes (${byteLen} > ${this.options.maxRecordBytes})`,
        { byteLen, max: this.options.maxRecordBytes },
      );
    }

    const filePath = await this.resolveFilePath(workspaceRoot, options.configuredPath);
    const dir = path.dirname(filePath);
    // Directory mode 0o700 — user-only. mkdir-recursive is idempotent on an
    // existing dir's mode, so this only stamps the mode on creation.
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    // Cross-process lock around the append. fs.open(path, "a", 0o600) sets
    // mode only when O_CREAT applies (i.e. file is being created). For
    // pre-existing files (e.g. created by an older version at 0o644) we
    // defensively fchmod inside the lock to enforce 0o600 every time —
    // closes the bug-class flagged by developer (Major #1+#2).
    await withFileLock(filePath, async () => {
      const fh = await fs.open(filePath, "a", 0o600);
      try {
        await fh.chmod(0o600);
        await fh.writeFile(line, "utf8");
      } finally {
        await fh.close();
      }
    });

    // Invalidate cache so the next read picks up the append.
    const absRoot = path.resolve(workspaceRoot);
    this.cache.delete(absRoot);

    logger.info(`${this.options.label} appended`, {
      details: { file: filePath },
    });

    return { filePath, entry: validated.data };
  }
}
