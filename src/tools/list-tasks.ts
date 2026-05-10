import { z } from "zod";
import type { ToolDef } from "./registry.js";
import { readTasks, type Task } from "../tasks/store.js";
import { listTasks as listTasksFn } from "../tasks/select.js";
import { readSquadYaml } from "../config/squad-yaml.js";
import { resolveSafePath, createSafePathContext } from "../util/path-safety.js";
import { AGENT_NAMES_TUPLE } from "../config/ownership-matrix.js";

const taskStatusEnum = z.enum(["pending", "in-progress", "review", "done", "blocked", "cancelled"]);

const schema = z.object({
  workspace_root: z.string().min(1).max(4096),
  status: z.array(taskStatusEnum).max(6).optional(),
  agent: z.enum(AGENT_NAMES_TUPLE).optional(),
  changed_files: z.array(z.string().min(1).max(4096)).max(5000).optional(),
  limit: z.number().int().positive().max(2000).optional(),
});

type Input = z.infer<typeof schema>;

export interface ListTasksOutput {
  tasks: Task[];
  total_in_store: number;
  source: string | null;
}

export async function listTasksTool(input: Input): Promise<ListTasksOutput> {
  const ctx = createSafePathContext();
  const safeRoot = await resolveSafePath(input.workspace_root, ".", ctx);
  const config = await readSquadYaml(safeRoot);

  if (!config.tasks.enabled) {
    return { tasks: [], total_in_store: 0, source: null };
  }

  const file = await readTasks(safeRoot, { configuredPath: config.tasks.path });
  const filtered = listTasksFn(file.tasks, {
    ...(input.status !== undefined && { status: input.status }),
    ...(input.agent !== undefined && { agent: input.agent }),
    ...(input.changed_files !== undefined && {
      changed_files: input.changed_files,
    }),
    ...(input.limit !== undefined && { limit: input.limit }),
  });

  return {
    tasks: filtered,
    total_in_store: file.tasks.length,
    source: file.tasks.length > 0 ? `${safeRoot}/${config.tasks.path}` : null,
  };
}

export const listTasksToolDef: ToolDef<typeof schema> = {
  name: "list_tasks",
  description:
    "List tasks from `.squad/tasks.json` with optional filters (status, agent, changed_files glob match against task.scope). Returns the filtered tasks plus the total count in the store.",
  schema,
  handler: listTasksTool,
};
