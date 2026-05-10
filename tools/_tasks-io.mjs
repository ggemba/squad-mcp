// Shared read/write for the task CLI helpers in this directory.
// Mirrors src/tasks/store.ts on-disk format. Keeps the CLIs from depending
// on the compiled dist/ output so they run in any node 18+ environment.

import { promises as fs } from "node:fs";
import path from "node:path";

export const DEFAULT_TASKS_PATH = ".squad/tasks.json";

export async function readTasksFile(workspace, file) {
  const filePath = path.resolve(workspace, file ?? DEFAULT_TASKS_PATH);
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return { filePath, data: { version: 1, tasks: [] } };
    }
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${filePath}: invalid JSON: ${err.message}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray(parsed.tasks)
  ) {
    throw new Error(`${filePath}: missing tasks array`);
  }
  return { filePath, data: parsed };
}

export async function writeTasksFile(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const ordered = {
    version: data.version ?? 1,
    tasks: [...data.tasks]
      .sort((a, b) => a.id - b.id)
      .map((t) => ({
        ...t,
        subtasks: Array.isArray(t.subtasks)
          ? [...t.subtasks].sort((a, b) => a.id - b.id)
          : [],
      })),
  };
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(ordered, null, 2) + "\n", "utf8");
  await fs.rename(tmp, filePath);
}

export const VALID_STATUSES = [
  "pending",
  "in-progress",
  "review",
  "done",
  "blocked",
  "cancelled",
];

export const VALID_PRIORITIES = ["low", "medium", "high"];

export function fail(prog, code, msg) {
  process.stderr.write(`${prog}: ${msg}\n`);
  process.exit(code);
}
