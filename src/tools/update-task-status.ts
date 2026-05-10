import { z } from "zod";
import type { ToolDef } from "./registry.js";
import { updateTaskStatus, type Task } from "../tasks/store.js";
import { readSquadYaml } from "../config/squad-yaml.js";
import { resolveSafePath, createSafePathContext } from "../util/path-safety.js";

const schema = z.object({
  workspace_root: z.string().min(1).max(4096),
  task_id: z.number().int().positive(),
  /** When set, update that subtask's status instead of the parent task's. */
  subtask_id: z.number().int().positive().optional(),
  status: z.enum(["pending", "in-progress", "review", "done", "blocked", "cancelled"]),
});

type Input = z.infer<typeof schema>;

export interface UpdateTaskStatusOutput {
  updated: true;
  file: string;
  task: Task;
}

export async function updateTaskStatusTool(input: Input): Promise<UpdateTaskStatusOutput> {
  const ctx = createSafePathContext();
  const safeRoot = await resolveSafePath(input.workspace_root, ".", ctx);
  const config = await readSquadYaml(safeRoot);

  const result = await updateTaskStatus(safeRoot, input.task_id, input.status, {
    ...(input.subtask_id !== undefined && { subtaskId: input.subtask_id }),
    configuredPath: config.tasks.path,
  });

  return { updated: true, file: result.filePath, task: result.task };
}

export const updateTaskStatusToolDef: ToolDef<typeof schema> = {
  name: "update_task_status",
  description:
    "Flip a task (or subtask) status: pending / in-progress / review / done / blocked / cancelled. Stamps updated_at. Atomic write. Throws when the task / subtask id is unknown.",
  schema,
  handler: updateTaskStatusTool,
};
