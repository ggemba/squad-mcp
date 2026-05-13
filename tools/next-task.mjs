#!/usr/bin/env node
// Pick the next ready task: candidate status (default pending), all
// dependencies done, optional agent filter. Tiebreaker priority then id.
//
// Usage:
//   tools/next-task.mjs [--agent dba] [--workspace <path>]
//                       [--file <relpath>] [--json]
//
// Prints a one-line summary by default, or the full task as JSON with --json.
// If no ready task, prints reason ("no_candidates" / "all_blocked") and the
// blocked list.
//
// Exit codes:
//   0 ready task surfaced (or json mode, regardless of ready)
//   1 no ready task (text mode only — for shell pipelines)
//   2 invalid input

import { readTasksFile, fail } from "./_tasks-io.mjs";

const args = process.argv.slice(2);
const PROG = "next-task";
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

function parseArgs(argv) {
  const out = {
    agent: null,
    workspace: process.cwd(),
    file: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--agent":
        out.agent = argv[++i];
        break;
      case "--workspace":
        out.workspace = argv[++i];
        break;
      case "--file":
        out.file = argv[++i];
        break;
      case "--json":
        out.json = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "usage: next-task.mjs [--agent NAME] [--workspace PATH] [--file PATH] [--json]\n",
        );
        process.exit(0);
      default:
        fail(PROG, 2, `unknown flag: ${a}`);
    }
  }
  return out;
}

function pickNext(tasks, opts) {
  const doneIds = new Set(tasks.filter((t) => t.status === "done").map((t) => t.id));
  let candidates = tasks.filter((t) => t.status === "pending");
  if (opts.agent) {
    candidates = candidates.filter(
      (t) => !t.agent_hints || t.agent_hints.length === 0 || t.agent_hints.includes(opts.agent),
    );
  }
  if (candidates.length === 0) {
    return { task: null, reason: "no_candidates", blocked: [] };
  }
  const ready = [];
  const blocked = [];
  for (const t of candidates) {
    const missing = (t.dependencies ?? []).filter((d) => !doneIds.has(d));
    if (missing.length === 0) {
      ready.push(t);
    } else {
      blocked.push({ id: t.id, title: t.title, missing_deps: missing });
    }
  }
  if (ready.length === 0) {
    return { task: null, reason: "all_blocked", blocked };
  }
  ready.sort((a, b) => {
    const p = PRIORITY_RANK[a.priority ?? "medium"] - PRIORITY_RANK[b.priority ?? "medium"];
    if (p !== 0) return p;
    return a.id - b.id;
  });
  return { task: ready[0], reason: "ok", blocked };
}

async function main() {
  const opts = parseArgs(args);
  const { data } = await readTasksFile(opts.workspace, opts.file);
  const result = pickNext(data.tasks, opts);

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  if (result.task) {
    const t = result.task;
    process.stdout.write(`#${t.id} [${t.priority ?? "medium"}] ${t.title}\n`);
    if (t.scope) process.stdout.write(`  scope: ${t.scope}\n`);
    if (t.agent_hints && t.agent_hints.length > 0) {
      process.stdout.write(`  agents: ${t.agent_hints.join(", ")}\n`);
    }
    return;
  }

  if (result.reason === "no_candidates") {
    process.stderr.write("no pending tasks\n");
  } else {
    process.stderr.write("all candidates blocked:\n");
    for (const b of result.blocked) {
      process.stderr.write(`  #${b.id} ${b.title} (missing deps: ${b.missing_deps.join(", ")})\n`);
    }
  }
  process.exit(1);
}

main().catch((err) => fail(PROG, 2, err.message ?? String(err)));
