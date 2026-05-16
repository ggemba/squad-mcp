// @ts-check

/**
 * AUTO-JOURNALING — POSTTOOLUSE I/O ADAPTER (PR1 / Fase 1a).
 *
 * ROLE: the thin, side-effecting layer of the opt-in journaling hook. All
 * decision logic lives in the pure `journal-event.mjs`; this file only does
 * I/O — read stdin, parse, delegate, append a line. Keeping the two apart
 * means the logic is unit-testable with no process plumbing.
 *
 * POSTTOOLUSE STDIN CONTRACT: Claude Code invokes a PostToolUse hook by
 * spawning the configured command and writing a JSON payload to the hook's
 * stdin (fields include `tool_name` and `tool_input`). The hook reads stdin
 * to EOF, does its work, and exits.
 *
 * EXIT-0 CONTRACT — THE INVIOLABLE RULE OF THIS FILE: this hook ALWAYS exits
 * 0. A PostToolUse hook that exits non-zero (or throws) surfaces as an error
 * back in the user's Claude Code session and can disrupt their workflow.
 * Journaling is a passive, best-effort capture; it must never be able to
 * break the thing it observes. Every failure path — empty stdin, malformed
 * JSON, an unwritable `.squad/`, an oversized pending file — is swallowed:
 * one diagnostic line to `process.stderr` (prefixed `squad-journal:`) and
 * `exit(0)`. Never a thrown error, never a non-zero code.
 *
 * ZERO DEPENDENCIES, OUTSIDE `src/` AND THE BUNDLE: this script is copied
 * verbatim into the user's `.squad/hooks/` by `/squad:enable-journaling` and
 * run as `node .squad/hooks/post-tool-use.mjs`. It is NOT part of the esbuild
 * bundle and cannot import anything `npm`-installed in this package — hence
 * plain Node ESM with only `node:`-builtin imports. It deliberately does NOT
 * import `CURRENT_SCHEMA_VERSION`; pending rows are version-less by design
 * (see `src/journal/pending.ts` for the rationale).
 *
 * CONCURRENCY: the append is lock-free. POSIX guarantees a single `write()`
 * of a buffer no larger than `PIPE_BUF` to a file opened `O_APPEND` is atomic
 * across processes — a breadcrumb line is far under that. The DRAIN side
 * (`drainPending` in `src/journal/pending.ts`) uses an atomic `rename`, so
 * there is no read-then-truncate window for an append to fall into. The hook
 * therefore needs no lock file.
 */

import { promises as fs } from "node:fs";
import { statSync } from "node:fs";
import path from "node:path";
import { processEvent, serializeBreadcrumb } from "./journal-event.mjs";

/** Pending staging file, relative to the process cwd (the user's repo root). */
const PENDING_REL = path.join(".squad", "pending-journal.jsonl");

/**
 * Defensive size cap. If the pending file is already larger than this, the
 * append is skipped. This is a CHEAP byte-count guard, NOT a load-bearing
 * bound — growth is properly bounded by the drain-side atomic rename (PR2).
 * It exists only so a never-drained file in a stale repo cannot grow without
 * limit. No line counting, just one `statSync`.
 */
const MAX_PENDING_BYTES = 512 * 1024;

/** Read all of stdin to a string. Resolves with "" on an empty stream. */
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}

/** Emit one diagnostic line to stderr. Never throws. */
function warn(reason) {
  try {
    process.stderr.write(`squad-journal: ${reason}\n`);
  } catch {
    // stderr itself is unavailable — nothing more we can safely do.
  }
}

/**
 * Entire body is wrapped so the process exits 0 on every path. Any thrown
 * error, rejected promise, or bad input becomes a stderr line + exit 0.
 */
async function main() {
  const raw = await readStdin();

  // Empty stdin → nothing to journal. Silent no-op (not even a warning —
  // this is a legitimate, expected case, not a failure).
  if (raw.trim() === "") return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    warn("malformed JSON on stdin");
    return;
  }

  const crumb = processEvent(payload);
  // null → self-trigger or unusable event. Skip silently.
  if (crumb === null) return;

  const line = serializeBreadcrumb(crumb);
  const cwd = process.cwd();
  const pendingPath = path.resolve(cwd, PENDING_REL);
  const squadDir = path.resolve(cwd, ".squad");

  // Ensure `.squad/` exists, user-only (0o700) — mirrors the runs store.
  try {
    await fs.mkdir(squadDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    warn(`could not create .squad dir: ${(err && err.message) || err}`);
    return;
  }

  // Defensive size cap — cheap byte check before the append.
  try {
    const st = statSync(pendingPath);
    if (st.size > MAX_PENDING_BYTES) {
      warn(`pending file over ${MAX_PENDING_BYTES} bytes; skipping append`);
      return;
    }
  } catch {
    // File absent (first append) — that is fine, fall through to create it.
  }

  // Append. `O_APPEND` makes a sub-PIPE_BUF write atomic across processes
  // with no lock. Mode 0o600 applies on create; a defensive chmod re-asserts
  // it in case the file pre-existed with a looser mode.
  let fh;
  try {
    fh = await fs.open(pendingPath, "a", 0o600);
    await fh.chmod(0o600);
    await fh.writeFile(line, "utf8");
  } catch (err) {
    warn(`append failed: ${(err && err.message) || err}`);
  } finally {
    if (fh !== undefined) {
      try {
        await fh.close();
      } catch {
        // close failure is non-fatal — the write already landed or didn't.
      }
    }
  }
}

main()
  .catch((err) => {
    warn(`unexpected: ${(err && err.message) || err}`);
  })
  .finally(() => {
    // Belt-and-braces: guarantee exit 0 regardless of how main() settled.
    process.exit(0);
  });
