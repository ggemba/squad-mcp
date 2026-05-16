#!/usr/bin/env node
// Migrate agent identifiers in `.squad/runs.jsonl`, `.squad/learnings.jsonl`,
// and `.squad.yaml` from the pre-rename `senior-*` form to the post-rename
// bare form, AND bump `schema_version` from 1 → 2 in the two JSONL files.
//
// Pre-rename → post-rename mapping (8 identifiers):
//   senior-architect    → architect
//   senior-dba          → dba
//   senior-debugger     → debugger
//   senior-developer    → developer
//   senior-dev-reviewer → reviewer
//   senior-dev-security → security
//   senior-implementer  → implementer
//   senior-qa           → qa
//
// Usage:
//   node tools/migrate-jsonl-agents.mjs [--workspace-root <path>] [--dry-run] [--yes]
//
// Flags:
//   --workspace-root <path>  defaults to cwd
//   --dry-run                report what would change; write nothing; no prompt
//   --yes                    skip the interactive confirmation prompt
//
// Confirmation prompt:
//   By default the tool computes the changes (preview pass), prints a
//   summary, and asks `proceed? [y/N]` on stdin before writing. Pass
//   `--yes` to skip the prompt (recommended in CI). `--dry-run` implies
//   `--yes` (nothing is written so no confirmation is needed). When
//   stdin is not a TTY and `--yes` is absent, the tool exits 2 with an
//   actionable error rather than silently running unconfirmed.
//
// Exit codes:
//   0 success (or dry-run completed, or user declined the prompt)
//   1 partial failure (some files written, others failed)
//   2 invalid input (unknown flag, missing flag value, non-TTY without --yes)
//   3 unexpected runtime error (filesystem, permission, etc.)
//
// Atomicity: each .jsonl is rewritten to a temp file in the same directory,
// then `fs.rename`d over the original (same-fs atomic-replace contract). The
// .squad.yaml uses the same pattern.
//
// No external deps — Node built-ins only.

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

const PROG = "migrate-jsonl-agents";

const AGENT_RENAMES = [
  ["senior-architect", "architect"],
  ["senior-dba", "dba"],
  ["senior-debugger", "debugger"],
  ["senior-developer", "developer"],
  ["senior-dev-reviewer", "reviewer"],
  ["senior-dev-security", "security"],
  ["senior-implementer", "implementer"],
  ["senior-qa", "qa"],
];

// Schema version this tool bumps v1 rows TO. This migration is the historical
// agent-rename pass (senior-* → bare names) and targets v2 for BOTH journals.
// It is intentionally pinned to the literal 2 — not the live learnings
// constant — because PR2 bumped `.squad/learnings.jsonl` to v3 additively:
// a v1 row migrated here lands at v2 (agent names fixed) and is then read
// natively by the v3 learnings store (which accepts {2, 3}). Re-stamping v1
// rows straight to 3 would skip the v2 contract this migration documents.
// `src/util/schema-version.ts` now exports RUNS_SCHEMA_VERSION (=2) and
// LEARNINGS_SCHEMA_VERSION (=3); this literal corresponds to the former.
const MIGRATION_TARGET_SCHEMA_VERSION = 2;

function fail(code, msg) {
  process.stderr.write(`${PROG}: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = {
    workspaceRoot: process.cwd(),
    dryRun: false,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--workspace-root": {
        const v = argv[++i];
        if (!v) fail(2, "--workspace-root requires a value");
        out.workspaceRoot = path.resolve(v);
        break;
      }
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--yes":
        out.yes = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "usage: migrate-jsonl-agents.mjs [--workspace-root PATH] [--dry-run] [--yes]\n",
        );
        process.exit(0);
      default:
        fail(2, `unknown flag: ${a}`);
    }
  }
  return out;
}

function renameAgentValues(value) {
  // Recursively walk the parsed JSON value and rewrite any string value that
  // exactly matches one of the 8 old agent names. Operates on STRINGS, not
  // keys — agent names appear as values in `runs.jsonl` (e.g. `agents[i].name`,
  // `language_supplements.agents_with_supplement[]`) and in `learnings.jsonl`
  // (the top-level `agent` field).
  let count = 0;
  const walk = (v) => {
    if (typeof v === "string") {
      for (const [from, to] of AGENT_RENAMES) {
        if (v === from) {
          count++;
          return to;
        }
      }
      return v;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        v[i] = walk(v[i]);
      }
      return v;
    }
    if (v !== null && typeof v === "object") {
      for (const k of Object.keys(v)) {
        v[k] = walk(v[k]);
      }
      return v;
    }
    return v;
  };
  return { value: walk(value), count };
}

// Compute (don't write) the migrated contents of one .jsonl file.
// Returns { stats, newBody, originalBody } so the caller can decide whether
// to commit the write after a user confirmation. Two-pass design lets the
// preview message be accurate.
async function planJsonl(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return {
        visited: false,
        rows: 0,
        rowsRewritten: 0,
        rowsBumped: 0,
        agentNamesChanged: 0,
        unparseable: 0,
        bytes: 0,
        newBody: null,
        originalBody: null,
        changed: false,
      };
    }
    throw err;
  }
  const lines = raw.split(/\r?\n/);
  const outLines = [];
  let rows = 0;
  let rowsRewritten = 0;
  let rowsBumped = 0;
  let agentNamesChanged = 0;
  let unparseable = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      // Preserve trailing empty line (final newline) by keeping the slot.
      outLines.push("");
      continue;
    }
    rows++;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Unparseable row: leave it untouched. The store's quarantine path
      // will catch it on next read. Tracked separately so the summary
      // surfaces it to the user.
      unparseable++;
      outLines.push(line);
      continue;
    }
    const before = JSON.stringify(parsed);
    const { value: rewritten, count } = renameAgentValues(parsed);
    let bumpedThisRow = false;
    if (
      rewritten !== null &&
      typeof rewritten === "object" &&
      !Array.isArray(rewritten) &&
      rewritten.schema_version === 1
    ) {
      rewritten.schema_version = MIGRATION_TARGET_SCHEMA_VERSION;
      bumpedThisRow = true;
    }
    const after = JSON.stringify(rewritten);
    if (after !== before) {
      rowsRewritten++;
      // Track agent renames and version bumps as separate signals so the
      // summary line is meaningful when a row is rewritten purely for a
      // version bump (count === 0, bumpedThisRow === true) versus a row
      // rewritten for an agent rename (count > 0).
      agentNamesChanged += count;
      if (bumpedThisRow) rowsBumped++;
    }
    outLines.push(after);
  }
  const newBody = outLines.join("\n");
  const bytes = Buffer.byteLength(newBody, "utf8");
  return {
    visited: true,
    rows,
    rowsRewritten,
    rowsBumped,
    agentNamesChanged,
    unparseable,
    bytes,
    newBody,
    originalBody: raw,
    changed: newBody !== raw,
  };
}

async function planYaml(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return {
        visited: false,
        replacements: 0,
        bytes: 0,
        newBody: null,
        originalBody: null,
        changed: false,
      };
    }
    throw err;
  }
  // Regex-based substitution preserves comments + layout. Match the bare
  // identifier as a word so `senior-dba-extra` (hypothetical custom name) is
  // not partially replaced. Word boundaries that also accept '-' as part of
  // the identifier mean we anchor on look-around for non-identifier chars.
  //
  // NOTE: comment-line content is also rewritten — a YAML comment like
  // `# disable senior-developer temporarily` becomes `# disable developer
  // temporarily`. This is by design (the renaming is consistent across
  // structural and prose surfaces); CHANGELOG documents this.
  let body = raw;
  let replacements = 0;
  // Order matters: longer prefix patterns first so `senior-dev-security`
  // doesn't get clipped by an early match on `senior-d` substring rules.
  // (We use exact full-word matches anyway, but keep the longer-first ordering
  // as a defence in depth.)
  for (const [from, to] of AGENT_RENAMES) {
    // \b doesn't treat '-' as a word boundary character, so use look-around
    // anchors on non-[a-zA-Z0-9_-] characters explicitly.
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![a-zA-Z0-9_-])${escaped}(?![a-zA-Z0-9_-])`, "g");
    body = body.replace(re, () => {
      replacements++;
      return to;
    });
  }
  const bytes = Buffer.byteLength(body, "utf8");
  return {
    visited: true,
    replacements,
    bytes,
    newBody: body,
    originalBody: raw,
    changed: body !== raw,
  };
}

async function writeAtomically(filePath, body) {
  const tmp = `${filePath}.migrate-${Date.now()}.tmp`;
  await fs.writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, filePath);
}

function formatJsonlSummaryLine(label, targetPath, s, mode) {
  if (!s) return `  ${targetPath}: ERROR`;
  if (!s.visited) return `  ${targetPath}: not present (skipped)`;
  const tail = mode === "dry-run" ? " (dry-run)" : s.changed ? " (written)" : " (no change)";
  const parts = [
    `${s.rows} rows`,
    `${s.rowsRewritten} rewritten`,
    `${s.agentNamesChanged} agent-name replacements`,
    `${s.rowsBumped} version bumps`,
  ];
  if (s.unparseable > 0) parts.push(`${s.unparseable} unparseable (preserved)`);
  parts.push(`${s.bytes} bytes`);
  return `  ${targetPath}: ${parts.join(", ")}${tail}`;
}

function formatYamlSummaryLine(targetPath, y, mode) {
  if (!y) return `  ${targetPath}: ERROR`;
  if (!y.visited) return `  ${targetPath}: not present (skipped)`;
  const tail = mode === "dry-run" ? " (dry-run)" : y.changed ? " (written)" : " (no change)";
  return `  ${targetPath}: ${y.replacements} agent-name replacements, ${y.bytes} bytes${tail}`;
}

async function confirm(plans, targets) {
  // Print the would-change summary, then prompt y/N on stdin.
  const previewLines = [];
  previewLines.push(`${PROG}: pending changes (preview):`);
  previewLines.push(formatJsonlSummaryLine("runs", targets.runs, plans.runs, "preview"));
  previewLines.push(
    formatJsonlSummaryLine("learnings", targets.learnings, plans.learnings, "preview"),
  );
  previewLines.push(formatYamlSummaryLine(targets.yaml, plans.yaml, "preview"));
  process.stdout.write(previewLines.join("\n") + "\n");

  if (!process.stdin.isTTY) {
    fail(
      2,
      "stdin is not a TTY; refusing to run without explicit confirmation. " +
        "Pass --yes to skip the prompt, or --dry-run to preview without writing.",
    );
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("proceed? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = opts.workspaceRoot;

  const targets = {
    runs: path.join(root, ".squad", "runs.jsonl"),
    learnings: path.join(root, ".squad", "learnings.jsonl"),
    yaml: path.join(root, ".squad.yaml"),
  };

  if (opts.dryRun) {
    process.stdout.write(`${PROG}: dry-run mode — no files will be written\n`);
  }
  process.stdout.write(`${PROG}: workspace-root = ${root}\n`);

  // Pass 1: compute plans for all three targets. No writes.
  const plans = {};
  let partialFailure = false;
  for (const key of ["runs", "learnings"]) {
    try {
      plans[key] = await planJsonl(targets[key]);
    } catch (err) {
      partialFailure = true;
      process.stderr.write(`${PROG}: failed to plan ${targets[key]}: ${err.message}\n`);
      plans[key] = null;
    }
  }
  try {
    plans.yaml = await planYaml(targets.yaml);
  } catch (err) {
    partialFailure = true;
    process.stderr.write(`${PROG}: failed to plan ${targets.yaml}: ${err.message}\n`);
    plans.yaml = null;
  }

  // Decide whether to write. Dry-run never writes. Otherwise confirm unless
  // --yes was passed.
  let shouldWrite = !opts.dryRun;
  if (shouldWrite && !opts.yes) {
    const proceed = await confirm(plans, targets);
    if (!proceed) {
      process.stdout.write(`${PROG}: aborted by user; no files written\n`);
      process.exit(0);
    }
  }

  // Pass 2: write the planned bodies for each file whose plan reported a
  // change. Files with no change are skipped (no point bumping mtime).
  if (shouldWrite) {
    for (const key of ["runs", "learnings"]) {
      const s = plans[key];
      if (!s || !s.visited || !s.changed) continue;
      try {
        await writeAtomically(targets[key], s.newBody);
      } catch (err) {
        partialFailure = true;
        process.stderr.write(`${PROG}: failed to write ${targets[key]}: ${err.message}\n`);
      }
    }
    const y = plans.yaml;
    if (y && y.visited && y.changed) {
      try {
        await writeAtomically(targets.yaml, y.newBody);
      } catch (err) {
        partialFailure = true;
        process.stderr.write(`${PROG}: failed to write ${targets.yaml}: ${err.message}\n`);
      }
    }
  }

  // Final summary.
  const mode = opts.dryRun ? "dry-run" : "written";
  const lines = [];
  for (const key of ["runs", "learnings"]) {
    lines.push(formatJsonlSummaryLine(key, targets[key], plans[key], mode));
  }
  lines.push(formatYamlSummaryLine(targets.yaml, plans.yaml, mode));
  process.stdout.write(lines.join("\n") + "\n");

  if (partialFailure) {
    process.exit(1);
  }
}

main().catch((err) => {
  fail(3, `unexpected error: ${err && err.stack ? err.stack : err}`);
});
