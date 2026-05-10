import { z } from "zod";
import type { ToolDef } from "./registry.js";
import { expandTask, type Task } from "../tasks/store.js";
import { readSquadYaml } from "../config/squad-yaml.js";
import { resolveSafePath, createSafePathContext } from "../util/path-safety.js";

const subtaskInputSchema = z.object({
  title: z.string().min(1).max(512),
  description: z.string().max(4096).optional(),
  /** Reference sibling subtasks by id (assigned in input order, starting at max+1). */
  dependencies: z.array(z.number().int().positive()).max(50).optional(),
  details: z.string().max(8192).optional(),
});

const schema = z.object({
  workspace_root: z.string().min(1).max(4096),
  task_id: z.number().int().positive(),
  subtasks: z.array(subtaskInputSchema).min(1).max(50),
});

type Input = z.infer<typeof schema>;

export interface ExpandTaskOutput {
  expanded: true;
  file: string;
  task: Task;
}

export async function expandTaskTool(input: Input): Promise<ExpandTaskOutput> {
  const ctx = createSafePathContext();
  const safeRoot = await resolveSafePath(input.workspace_root, ".", ctx);
  const config = await readSquadYaml(safeRoot);

  const result = await expandTask(
    safeRoot,
    input.task_id,
    input.subtasks.map((s) => ({
      title: s.title,
      ...(s.description !== undefined && { description: s.description }),
      ...(s.dependencies !== undefined && { dependencies: s.dependencies }),
      ...(s.details !== undefined && { details: s.details }),
    })),
    { configuredPath: config.tasks.path },
  );

  return { expanded: true, file: result.filePath, task: result.task };
}

export const expandTaskToolDef: ToolDef<typeof schema> = {
  name: "expand_task",
  description:
    "Append subtasks to an existing task. Mechanical only — the caller (skill or LLM) supplies the subtask inputs. Subtask ids allocated sequentially starting from `max(existing.subtasks.id) + 1`. Side-effecting, atomic write.",
  schema,
  handler: expandTaskTool,
};
