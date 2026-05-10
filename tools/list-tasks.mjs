#!/usr/bin/env node
// List tasks from `.squad/tasks.json`.
//
// Usage:
//   tools/list-tasks.mjs [--status pending,done] [--agent senior-dba]
//                        [--workspace <path>] [--file <relpath>] [--json]
//
// Without --json, prints a compact table to stdout. With --json, prints
// the filtered tasks as one JSON document.
//
// Exit codes:
//   0 success
//   2 invalid input

import { readTasksFile, VALID_STATUSES, fail } from "./_tasks-io.mjs";

const args = process.argv.slice(2);
const PROG = "list-tasks";

function parseArgs(argv) {
  const out = {
    status: null,
    agent: null,
    workspace: process.cwd(),
    file: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--status": {
        const v = argv[++i];
        if (!v) fail(PROG, 2, "--status requires a value");
        out.status = v.split(",").map((s) => s.trim());
        for (const s of out.status) {
          if (!VALID_STATUSES.includes(s)) {
            fail(PROG, 2, `unknown status: ${s}`);
          }
        }
        break;
      }
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
          "usage: list-tasks.mjs [--status p,d] [--agent NAME] [--workspace PATH] [--file PATH] [--json]\n",
        );
        process.exit(0);
      default:
        fail(PROG, 2, `unknown flag: ${a}`);
    }
  }
  return out;
}

function filter(tasks, opts) {
  let out = tasks;
  if (opts.status) {
    const s = new Set(opts.status);
    out = out.filter((t) => s.has(t.status));
  }
  if (opts.agent) {
    out = out.filter(
      (t) => !t.agent_hints || t.agent_hints.length === 0 || t.agent_hints.includes(opts.agent),
    );
  }
  return out;
}

function renderTable(tasks) {
  if (tasks.length === 0) {
    return "(no tasks match filters)\n";
  }
  const lines = [];
  lines.push("ID\tSTATUS\t\tPRI\tTITLE");
  for (const t of tasks) {
    const status = t.status.padEnd(12);
    const pri = (t.priority ?? "medium").padEnd(6);
    lines.push(`${t.id}\t${status}\t${pri}\t${t.title}`);
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const opts = parseArgs(args);
  const { data } = await readTasksFile(opts.workspace, opts.file);
  const filtered = filter(data.tasks, opts);

  if (opts.json) {
    process.stdout.write(JSON.stringify(filtered, null, 2) + "\n");
  } else {
    process.stdout.write(renderTable(filtered));
  }
}

main().catch((err) => fail(PROG, 2, err.message ?? String(err)));
