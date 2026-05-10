#!/usr/bin/env node
// Bulk-add tasks to `.squad/tasks.json`. Reads a JSON array of task inputs
// from stdin (or a file via --input) and appends them.
//
// Usage:
//   echo '[{"title":"Add CSRF","scope":"src/api/**"}]' | tools/record-tasks.mjs
//   tools/record-tasks.mjs --input parsed-prd.json
//
// Each task input may include: title (required), description, dependencies,
// priority, details, test_strategy, scope, agent_hints. id is optional —
// auto-allocated as max(existing) + 1 in input order.
//
// Flags:
//   --input <path>           Read JSON from this file instead of stdin
//   --workspace <path>       Default: cwd
//   --file <relpath>         Override the JSON store location
//   --dry-run                Validate + print resulting file, do not write
//
// Exit codes:
//   0 success
//   2 invalid input
//
// This CLI is intentionally minimal — no schema validation beyond shape.
// Production use should go through the MCP `record_tasks` tool which
// validates the full zod schema.

import { promises as fs } from "node:fs";
import { readTasksFile, writeTasksFile, VALID_PRIORITIES, fail } from "./_tasks-io.mjs";

const args = process.argv.slice(2);
const PROG = "record-tasks";

function parseArgs(argv) {
  const out = {
    input: null,
    workspace: process.cwd(),
    file: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--input":
        out.input = argv[++i];
        break;
      case "--workspace":
        out.workspace = argv[++i];
        break;
      case "--file":
        out.file = argv[++i];
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "usage: record-tasks.mjs [--input PATH | <stdin>] [--workspace PATH] [--file PATH] [--dry-run]\n",
        );
        process.exit(0);
      default:
        fail(PROG, 2, `unknown flag: ${a}`);
    }
  }
  return out;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function validateInputs(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    fail(PROG, 2, "input must be a non-empty array of task objects");
  }
  for (const [i, t] of inputs.entries()) {
    if (!t || typeof t !== "object") {
      fail(PROG, 2, `input[${i}]: not an object`);
    }
    if (typeof t.title !== "string" || t.title.length === 0) {
      fail(PROG, 2, `input[${i}]: title is required and must be a string`);
    }
    if (t.priority !== undefined && !VALID_PRIORITIES.includes(t.priority)) {
      fail(PROG, 2, `input[${i}]: priority must be low|medium|high`);
    }
    if (t.dependencies !== undefined && !Array.isArray(t.dependencies)) {
      fail(PROG, 2, `input[${i}]: dependencies must be an array`);
    }
    if (t.id !== undefined && (!Number.isInteger(t.id) || t.id <= 0)) {
      fail(PROG, 2, `input[${i}]: id must be a positive integer`);
    }
  }
}

async function main() {
  const opts = parseArgs(args);
  const raw = opts.input ? await fs.readFile(opts.input, "utf8") : await readStdin();

  let inputs;
  try {
    inputs = JSON.parse(raw);
  } catch (err) {
    fail(PROG, 2, `invalid JSON on input: ${err.message}`);
  }
  validateInputs(inputs);

  const { filePath, data } = await readTasksFile(opts.workspace, opts.file);
  const existingIds = new Set(data.tasks.map((t) => t.id));
  let cursor = data.tasks.reduce((m, t) => Math.max(m, t.id), 0);
  const ts = new Date().toISOString();
  const newTasks = [];
  const seen = new Set(existingIds);

  for (const inp of inputs) {
    let id = inp.id;
    if (id === undefined) {
      cursor += 1;
      id = cursor;
    } else {
      if (seen.has(id)) {
        fail(PROG, 2, `duplicate task id ${id}`);
      }
      cursor = Math.max(cursor, id);
    }
    seen.add(id);
    newTasks.push({
      id,
      title: inp.title,
      ...(inp.description !== undefined && { description: inp.description }),
      status: "pending",
      dependencies: inp.dependencies ?? [],
      priority: inp.priority ?? "medium",
      ...(inp.details !== undefined && { details: inp.details }),
      ...(inp.test_strategy !== undefined && {
        test_strategy: inp.test_strategy,
      }),
      ...(inp.scope !== undefined && { scope: inp.scope }),
      ...(inp.agent_hints !== undefined && { agent_hints: inp.agent_hints }),
      subtasks: [],
      created_at: ts,
      updated_at: ts,
    });
  }

  // Validate deps after id allocation (forward refs allowed in batch).
  for (const t of newTasks) {
    for (const dep of t.dependencies) {
      if (!seen.has(dep)) {
        fail(PROG, 2, `task ${t.id} depends on unknown id ${dep}`);
      }
      if (dep === t.id) {
        fail(PROG, 2, `task ${t.id} cannot depend on itself`);
      }
    }
  }

  const next = {
    version: data.version ?? 1,
    tasks: [...data.tasks, ...newTasks],
  };

  if (opts.dryRun) {
    process.stdout.write(JSON.stringify(next, null, 2) + "\n");
    process.stderr.write(
      `would record: ${newTasks.length} task(s), ids ${newTasks.map((t) => t.id).join(", ")}\n`,
    );
    return;
  }

  await writeTasksFile(filePath, next);
  process.stdout.write(
    `recorded: ${newTasks.length} task(s), ids ${newTasks.map((t) => t.id).join(", ")}\n`,
  );
  process.stdout.write(`file:     ${filePath}\n`);
}

main().catch((err) => fail(PROG, 2, err.message ?? String(err)));
