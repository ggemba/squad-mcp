#!/usr/bin/env node
// Append a team decision (accept | reject) to `.squad/learnings.jsonl`.
//
// Usage:
//   tools/record-learning.mjs --reject \
//     --agent senior-dev-security \
//     --finding "missing CSRF on POST /api/refund" \
//     --reason "CSRF terminated at API gateway, see infra/edge.tf" \
//     --pr 42
//
//   tools/record-learning.mjs --accept \
//     --agent senior-architect \
//     --finding "cross-module coupling Auth -> Billing" \
//     --reason "refactored to event bus" \
//     --branch refactor/auth
//
// Flags:
//   --accept | --reject                 (required, mutually exclusive)
//   --agent <name>                      (required)
//   --finding "<short title>"           (required)
//   --reason "<rationale>"              (optional but recommended)
//   --severity Blocker|Major|Minor|Suggestion  (optional)
//   --pr <number>                       (optional)
//   --branch <name>                     (optional)
//   --scope "<glob>"                    (optional, e.g. "src/auth/**")
//   --workspace <path>                  (default: cwd)
//   --file <relpath>                    (override the JSONL location for this run)
//
// Exit codes:
//   0 success
//   2 invalid input

import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureRelativeInsideRoot } from "./_tasks-io.mjs";

const args = process.argv.slice(2);

function fail(code, msg) {
  process.stderr.write(`record-learning: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = {
    decision: null, // 'accept' | 'reject'
    agent: null,
    finding: null,
    reason: null,
    severity: null,
    pr: null,
    branch: null,
    scope: null,
    workspace: process.cwd(),
    file: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--accept":
        if (out.decision) fail(2, "--accept and --reject are mutually exclusive");
        out.decision = "accept";
        break;
      case "--reject":
        if (out.decision) fail(2, "--accept and --reject are mutually exclusive");
        out.decision = "reject";
        break;
      case "--agent":
        out.agent = argv[++i];
        break;
      case "--finding":
        out.finding = argv[++i];
        break;
      case "--reason":
        out.reason = argv[++i];
        break;
      case "--severity":
        out.severity = argv[++i];
        break;
      case "--pr":
        out.pr = Number(argv[++i]);
        if (!Number.isInteger(out.pr) || out.pr <= 0) {
          fail(2, "--pr must be a positive integer");
        }
        break;
      case "--branch":
        out.branch = argv[++i];
        break;
      case "--scope":
        out.scope = argv[++i];
        break;
      case "--workspace":
        out.workspace = argv[++i];
        break;
      case "--file":
        out.file = argv[++i];
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "usage: record-learning.mjs --accept|--reject --agent <name> --finding <title> [options]\n",
        );
        process.exit(0);
      default:
        fail(2, `unknown flag: ${a}`);
    }
  }
  if (!out.decision) fail(2, "one of --accept or --reject is required");
  if (!out.agent) fail(2, "--agent <name> is required");
  if (!out.finding) fail(2, "--finding <title> is required");
  return out;
}

async function main() {
  const opts = parseArgs(args);
  const ts = new Date().toISOString();
  const entry = {
    ts,
    agent: opts.agent,
    finding: opts.finding,
    decision: opts.decision,
  };
  if (opts.severity) entry.severity = opts.severity;
  if (opts.reason) entry.reason = opts.reason;
  if (opts.pr) entry.pr = opts.pr;
  if (opts.branch) entry.branch = opts.branch;
  if (opts.scope) entry.scope = opts.scope;

  if (opts.file !== undefined) {
    ensureRelativeInsideRoot(opts.workspace, opts.file, "learnings.path");
  }
  const target = path.resolve(opts.workspace, opts.file ?? ".squad/learnings.jsonl");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(target, JSON.stringify(entry) + "\n", "utf8");

  process.stdout.write(`recorded: ${opts.decision} on ${opts.agent} — "${opts.finding}"\n`);
  process.stdout.write(`file:     ${target}\n`);
}

main().catch((err) => {
  fail(2, `unexpected error: ${err && err.stack ? err.stack : err}`);
});
