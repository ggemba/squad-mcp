#!/usr/bin/env node
// Flip a task (or subtask) status.
//
// Usage:
//   tools/update-task-status.mjs --task 5 --status in-progress
//   tools/update-task-status.mjs --task 5 --subtask 2 --status done
//
// Flags:
//   --task <id>                                                (required)
//   --status pending|in-progress|review|done|blocked|cancelled (required)
//   --subtask <id>                                             (optional)
//   --workspace <path>                                         (default: cwd)
//   --file <relpath>                                           (override path)
//
// Exit codes:
//   0 success
//   2 invalid input or task/subtask not found

import { readTasksFile, writeTasksFile, VALID_STATUSES, fail } from "./_tasks-io.mjs";

const args = process.argv.slice(2);
const PROG = "update-task-status";

function parseArgs(argv) {
  const out = {
    task: null,
    subtask: null,
    status: null,
    workspace: process.cwd(),
    file: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--task":
        out.task = Number(argv[++i]);
        if (!Number.isInteger(out.task) || out.task <= 0) {
          fail(PROG, 2, "--task must be a positive integer");
        }
        break;
      case "--subtask":
        out.subtask = Number(argv[++i]);
        if (!Number.isInteger(out.subtask) || out.subtask <= 0) {
          fail(PROG, 2, "--subtask must be a positive integer");
        }
        break;
      case "--status":
        out.status = argv[++i];
        if (!VALID_STATUSES.includes(out.status)) {
          fail(PROG, 2, `unknown status: ${out.status}`);
        }
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
          "usage: update-task-status.mjs --task ID --status STATUS [--subtask ID] [--workspace PATH] [--file PATH]\n",
        );
        process.exit(0);
      default:
        fail(PROG, 2, `unknown flag: ${a}`);
    }
  }
  if (out.task === null) fail(PROG, 2, "--task is required");
  if (out.status === null) fail(PROG, 2, "--status is required");
  return out;
}

async function main() {
  const opts = parseArgs(args);
  const { filePath, data } = await readTasksFile(opts.workspace, opts.file);

  const idx = data.tasks.findIndex((t) => t.id === opts.task);
  if (idx < 0) fail(PROG, 2, `task ${opts.task} not found`);

  const ts = new Date().toISOString();
  const original = data.tasks[idx];

  if (opts.subtask !== null) {
    const sIdx = (original.subtasks ?? []).findIndex((s) => s.id === opts.subtask);
    if (sIdx < 0) {
      fail(PROG, 2, `subtask ${opts.subtask} not found on task ${opts.task}`);
    }
    const newSubtasks = [...original.subtasks];
    newSubtasks[sIdx] = { ...newSubtasks[sIdx], status: opts.status };
    data.tasks[idx] = {
      ...original,
      subtasks: newSubtasks,
      updated_at: ts,
    };
  } else {
    data.tasks[idx] = { ...original, status: opts.status, updated_at: ts };
  }

  await writeTasksFile(filePath, data);
  process.stdout.write(
    `updated: task ${opts.task}${opts.subtask !== null ? `.${opts.subtask}` : ""} -> ${opts.status}\n`,
  );
  process.stdout.write(`file:    ${filePath}\n`);
}

main().catch((err) => fail(PROG, 2, err.message ?? String(err)));
