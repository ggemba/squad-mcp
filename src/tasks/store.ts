import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AGENT_NAMES_TUPLE } from "../config/ownership-matrix.js";
import { SquadError } from "../errors.js";
import { ensureRelativeInsideRoot } from "../util/path-safety.js";
import { withFileLock } from "../util/file-lock.js";
import { logger } from "../observability/logger.js";

/**
 * Mutable JSON store for tasks. Lives at `.squad/tasks.json` (path overridable
 * via `.squad.yaml.tasks.path`). Distinct from learnings/ which is JSONL +
 * append-only — tasks mutate (status flips, subtasks expand) so JSON with
 * atomic write (tmp + rename) is the right primitive.
 *
 * Schema is small on purpose. Inspired by claude-task-master but adapted to
 * squad-mcp primitives:
 *  - `scope`: glob limiting which files this task touches (reuses matchesGlob)
 *  - `agent_hints`: which advisory agents are relevant for this task
 *
 * No `tags` system in V1 — single linear list. Add later if multi-feature
 * parallel work in the same repo becomes a real need.
 */

const taskStatusSchema = z.enum([
  "pending",
  "in-progress",
  "review",
  "done",
  "blocked",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

const taskPrioritySchema = z.enum(["low", "medium", "high"]);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

const subtaskSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1).max(512),
  description: z.string().max(4096).optional(),
  status: taskStatusSchema,
  dependencies: z.array(z.number().int().positive()).max(50).default([]),
  details: z.string().max(8192).optional(),
});
export type Subtask = z.infer<typeof subtaskSchema>;

const taskSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1).max(512),
  description: z.string().max(4096).optional(),
  status: taskStatusSchema,
  dependencies: z.array(z.number().int().positive()).max(50).default([]),
  priority: taskPrioritySchema.default("medium"),
  details: z.string().max(16384).optional(),
  test_strategy: z.string().max(4096).optional(),
  /**
   * Glob limiting which files belong to this task (e.g. "src/auth/**"). Used
   * by slice_files_for_task. Optional — without scope, the task is repo-wide.
   */
  scope: z.string().min(1).max(512).optional(),
  /**
   * Subset of squad agents most relevant for this task. Used by /squad:task
   * to narrow the advisory squad. Optional — without hints, the task uses
   * the standard select_squad heuristic.
   */
  agent_hints: z.array(z.enum(AGENT_NAMES_TUPLE)).max(AGENT_NAMES_TUPLE.length).optional(),
  subtasks: z.array(subtaskSchema).max(50).default([]),
  /** ISO timestamp set on first record. */
  created_at: z.string().min(1).max(40),
  /** ISO timestamp updated on every mutation (status change, subtask add, etc). */
  updated_at: z.string().min(1).max(40),
});
export type Task = z.infer<typeof taskSchema>;

const tasksFileSchema = z.object({
  /** Schema version — bump when breaking changes ship. Readers reject newer versions. */
  version: z.literal(1).default(1),
  tasks: z.array(taskSchema).max(2000),
});
export type TasksFile = z.infer<typeof tasksFileSchema>;

export const DEFAULT_TASKS_PATH = ".squad/tasks.json";

interface CacheEntry {
  mtimeMs: number;
  filePath: string;
  data: TasksFile;
}
const cache = new Map<string, CacheEntry>();

export function __resetTasksStoreCacheForTests(): void {
  cache.clear();
}

function resolveTasksFile(workspaceRoot: string, configuredPath: string | undefined): string {
  const rel = configuredPath ?? DEFAULT_TASKS_PATH;
  if (configuredPath !== undefined) {
    ensureRelativeInsideRoot(workspaceRoot, rel, "tasks.path");
  }
  return path.resolve(workspaceRoot, rel);
}

const EMPTY_FILE: TasksFile = { version: 1, tasks: [] };

/**
 * Read tasks.json. Returns an empty file shape if the file does not exist
 * (a fresh repo with no tasks is the common case). Cached by mtime.
 */
export async function readTasks(
  workspaceRoot: string,
  options: { configuredPath?: string } = {},
): Promise<TasksFile> {
  const filePath = resolveTasksFile(workspaceRoot, options.configuredPath);
  const absRoot = path.resolve(workspaceRoot);

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return EMPTY_FILE;
  }
  if (!stat.isFile()) {
    return EMPTY_FILE;
  }

  const cached = cache.get(absRoot);
  if (cached && cached.filePath === filePath && cached.mtimeMs === stat.mtimeMs) {
    return cached.data;
  }

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    throw new SquadError(
      "CONFIG_READ_FAILED",
      `failed to read tasks file ${filePath}: ${(err as Error).message}`,
      { source: filePath },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SquadError("INVALID_INPUT", `${filePath}: invalid JSON: ${(err as Error).message}`, {
      source: filePath,
    });
  }

  const validated = tasksFileSchema.safeParse(parsed);
  if (!validated.success) {
    throw new SquadError(
      "INVALID_INPUT",
      `${filePath}: schema violation: ${validated.error.message}`,
      { source: filePath, issues: validated.error.issues.length },
    );
  }

  cache.set(absRoot, {
    mtimeMs: stat.mtimeMs,
    filePath,
    data: validated.data,
  });
  return validated.data;
}

/**
 * Atomic write: serialise to a tmp file in the same directory, then rename
 * over the target. Rename is atomic on POSIX within the same filesystem.
 * Stable key order + 2-space indent so git diffs stay readable.
 */
async function writeTasks(
  workspaceRoot: string,
  data: TasksFile,
  configuredPath?: string,
): Promise<string> {
  const filePath = resolveTasksFile(workspaceRoot, configuredPath);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const validated = tasksFileSchema.safeParse(data);
  if (!validated.success) {
    throw new SquadError("INVALID_INPUT", `tasks schema violation: ${validated.error.message}`, {
      issues: validated.error.issues.length,
    });
  }

  const ordered = orderTasksFile(validated.data);
  // tmp filename uses pid + ms + counter so two Promise.all writes inside the
  // same process don't collide on the same millisecond.
  writeCounter += 1;
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${writeCounter}`;
  await fs.writeFile(tmp, JSON.stringify(ordered, null, 2) + "\n", "utf8");

  // Snapshot the prior generation so a future corruption (or accidental edit)
  // has at least one recoverable backup. Best-effort: if the original is
  // missing or rename fails, swallow — the new write is still atomic.
  try {
    await fs.rename(filePath, `${filePath}.prev`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Non-fatal — log via stderr but proceed; the new file will land.
      logger.warn("tasks .prev snapshot failed", {
        details: {
          file: filePath,
          error: (err as Error).message,
        },
      });
    }
  }

  await fs.rename(tmp, filePath);

  // Invalidate cache.
  cache.delete(path.resolve(workspaceRoot));
  return filePath;
}

let writeCounter = 0;

function orderTasksFile(data: TasksFile): TasksFile {
  return {
    version: data.version,
    tasks: [...data.tasks]
      .sort((a, b) => a.id - b.id)
      .map((t) => ({
        ...t,
        subtasks: [...t.subtasks].sort((a, b) => a.id - b.id),
      })),
  };
}

interface RecordTaskInput {
  /** When omitted, an id is allocated as `max(existing) + 1`. */
  id?: number;
  title: string;
  description?: string;
  dependencies?: number[];
  priority?: TaskPriority;
  details?: string;
  test_strategy?: string;
  scope?: string;
  agent_hints?: Task["agent_hints"];
}

/**
 * Bulk-add tasks. Allocates ids sequentially when not supplied. Validates that
 * supplied ids are unique and that all dependencies refer to ids that exist
 * either in the existing file or in the same batch.
 *
 * Returns the IDs of the tasks that were appended (in input order).
 */
export async function recordTasks(
  workspaceRoot: string,
  inputs: RecordTaskInput[],
  options: { configuredPath?: string } = {},
): Promise<{ filePath: string; ids: number[] }> {
  if (inputs.length === 0) {
    throw new SquadError("INVALID_INPUT", "recordTasks requires at least one task");
  }

  const lockTarget = resolveTasksFile(workspaceRoot, options.configuredPath);
  return withFileLock(lockTarget, () => recordTasksLocked(workspaceRoot, inputs, options));
}

async function recordTasksLocked(
  workspaceRoot: string,
  inputs: RecordTaskInput[],
  options: { configuredPath?: string },
): Promise<{ filePath: string; ids: number[] }> {
  const current = await readTasks(workspaceRoot, options);
  const existingIds = new Set(current.tasks.map((t) => t.id));
  const allIds = new Set(existingIds);

  const ts = new Date().toISOString();
  const newTasks: Task[] = [];
  let cursor = current.tasks.reduce((m, t) => Math.max(m, t.id), 0);

  for (const input of inputs) {
    let id = input.id;
    if (id === undefined) {
      cursor += 1;
      id = cursor;
    } else {
      if (allIds.has(id)) {
        throw new SquadError(
          "INVALID_INPUT",
          `duplicate task id ${id} (already exists in store or batch)`,
        );
      }
      cursor = Math.max(cursor, id);
    }
    allIds.add(id);

    const task: Task = {
      id,
      title: input.title,
      ...(input.description !== undefined && {
        description: input.description,
      }),
      status: "pending",
      dependencies: input.dependencies ?? [],
      priority: input.priority ?? "medium",
      ...(input.details !== undefined && { details: input.details }),
      ...(input.test_strategy !== undefined && {
        test_strategy: input.test_strategy,
      }),
      ...(input.scope !== undefined && { scope: input.scope }),
      ...(input.agent_hints !== undefined && {
        agent_hints: input.agent_hints,
      }),
      subtasks: [],
      created_at: ts,
      updated_at: ts,
    };
    newTasks.push(task);
  }

  // Validate dependencies after id allocation so forward references in the
  // batch resolve correctly.
  for (const t of newTasks) {
    for (const dep of t.dependencies) {
      if (!allIds.has(dep)) {
        throw new SquadError("INVALID_INPUT", `task ${t.id} depends on unknown id ${dep}`);
      }
      if (dep === t.id) {
        throw new SquadError("INVALID_INPUT", `task ${t.id} cannot depend on itself`);
      }
    }
  }

  const next: TasksFile = {
    version: current.version,
    tasks: [...current.tasks, ...newTasks],
  };
  const filePath = await writeTasks(workspaceRoot, next, options.configuredPath);

  logger.info("tasks recorded", {
    details: { count: newTasks.length, file: filePath },
  });

  return { filePath, ids: newTasks.map((t) => t.id) };
}

/**
 * Update task status (or subtask status when subtask_id is provided). Stamps
 * updated_at. Returns the updated task. Throws if the id is not found.
 */
export async function updateTaskStatus(
  workspaceRoot: string,
  taskId: number,
  status: TaskStatus,
  options: { subtaskId?: number; configuredPath?: string } = {},
): Promise<{ filePath: string; task: Task }> {
  const lockTarget = resolveTasksFile(workspaceRoot, options.configuredPath);
  return withFileLock(lockTarget, () =>
    updateTaskStatusLocked(workspaceRoot, taskId, status, options),
  );
}

async function updateTaskStatusLocked(
  workspaceRoot: string,
  taskId: number,
  status: TaskStatus,
  options: { subtaskId?: number; configuredPath?: string },
): Promise<{ filePath: string; task: Task }> {
  const current = await readTasks(workspaceRoot, options);
  const idx = current.tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) {
    throw new SquadError("INVALID_INPUT", `task ${taskId} not found`);
  }
  const ts = new Date().toISOString();
  const original = current.tasks[idx]!;
  let updated: Task;

  if (options.subtaskId !== undefined) {
    const sIdx = original.subtasks.findIndex((s) => s.id === options.subtaskId);
    if (sIdx < 0) {
      throw new SquadError(
        "INVALID_INPUT",
        `subtask ${options.subtaskId} not found on task ${taskId}`,
      );
    }
    const newSubtasks = [...original.subtasks];
    newSubtasks[sIdx] = { ...newSubtasks[sIdx]!, status };
    updated = { ...original, subtasks: newSubtasks, updated_at: ts };
  } else {
    updated = { ...original, status, updated_at: ts };
  }

  const nextTasks = [...current.tasks];
  nextTasks[idx] = updated;
  const filePath = await writeTasks(
    workspaceRoot,
    { version: current.version, tasks: nextTasks },
    options.configuredPath,
  );

  logger.info("task status updated", {
    details: {
      task: taskId,
      ...(options.subtaskId !== undefined && { subtask: options.subtaskId }),
      status,
    },
  });

  return { filePath, task: updated };
}

interface SubtaskInput {
  title: string;
  description?: string;
  dependencies?: number[];
  details?: string;
}

/**
 * Append subtasks to an existing task. Allocates subtask ids sequentially
 * starting from `max(existing.subtasks.id) + 1`. Mechanical only — no LLM
 * decomposition here. The host LLM is responsible for generating the subtask
 * inputs (typically via a future compose_task_expand prompt-pattern).
 */
export async function expandTask(
  workspaceRoot: string,
  taskId: number,
  subtasks: SubtaskInput[],
  options: { configuredPath?: string } = {},
): Promise<{ filePath: string; task: Task }> {
  if (subtasks.length === 0) {
    throw new SquadError("INVALID_INPUT", "expandTask requires at least one subtask");
  }
  const lockTarget = resolveTasksFile(workspaceRoot, options.configuredPath);
  return withFileLock(lockTarget, () => expandTaskLocked(workspaceRoot, taskId, subtasks, options));
}

async function expandTaskLocked(
  workspaceRoot: string,
  taskId: number,
  subtasks: SubtaskInput[],
  options: { configuredPath?: string },
): Promise<{ filePath: string; task: Task }> {
  const current = await readTasks(workspaceRoot, options);
  const idx = current.tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) {
    throw new SquadError("INVALID_INPUT", `task ${taskId} not found`);
  }
  const original = current.tasks[idx]!;

  let cursor = original.subtasks.reduce((m, s) => Math.max(m, s.id), 0);
  const ts = new Date().toISOString();
  const newSubs: Subtask[] = subtasks.map((s) => {
    cursor += 1;
    return {
      id: cursor,
      title: s.title,
      ...(s.description !== undefined && { description: s.description }),
      status: "pending" as const,
      dependencies: s.dependencies ?? [],
      ...(s.details !== undefined && { details: s.details }),
    };
  });

  const updated: Task = {
    ...original,
    subtasks: [...original.subtasks, ...newSubs],
    updated_at: ts,
  };

  // Validate that all subtask deps point at sibling subtasks that exist.
  const siblingIds = new Set(updated.subtasks.map((s) => s.id));
  for (const s of newSubs) {
    for (const dep of s.dependencies) {
      if (!siblingIds.has(dep)) {
        throw new SquadError("INVALID_INPUT", `subtask ${s.id} depends on unknown sibling ${dep}`);
      }
    }
  }

  const nextTasks = [...current.tasks];
  nextTasks[idx] = updated;
  const filePath = await writeTasks(
    workspaceRoot,
    { version: current.version, tasks: nextTasks },
    options.configuredPath,
  );

  return { filePath, task: updated };
}
