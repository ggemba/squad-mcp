import { z } from "zod";
import type { ToolDef } from "./registry.js";
import { readTasks } from "../tasks/store.js";
import { matchesGlob, readSquadYaml } from "../config/squad-yaml.js";
import { resolveSafePath, createSafePathContext } from "../util/path-safety.js";
import { SquadError } from "../errors.js";

const schema = z.object({
  workspace_root: z.string().min(1).max(4096),
  task_id: z.number().int().positive(),
  files: z.array(z.string().min(1).max(4096)).max(10_000),
});

type Input = z.infer<typeof schema>;

export interface SliceFilesForTaskOutput {
  task_id: number;
  scope: string | null;
  matched: string[];
  unmatched: string[];
}

/**
 * Filter a file list down to those that fall inside a task's scope glob.
 * When the task has no scope (repo-wide), all files match. Wraps the same
 * `matchesGlob` primitive used by skip_paths and learnings scope filters —
 * single source of glob semantics across squad-mcp.
 */
export async function sliceFilesForTaskTool(input: Input): Promise<SliceFilesForTaskOutput> {
  const ctx = createSafePathContext();
  const safeRoot = await resolveSafePath(input.workspace_root, ".", ctx);
  const config = await readSquadYaml(safeRoot);

  const file = await readTasks(safeRoot, { configuredPath: config.tasks.path });
  const task = file.tasks.find((t) => t.id === input.task_id);
  if (!task) {
    throw new SquadError("INVALID_INPUT", `task ${input.task_id} not found in store`);
  }

  if (!task.scope) {
    return {
      task_id: input.task_id,
      scope: null,
      matched: [...input.files],
      unmatched: [],
    };
  }

  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const f of input.files) {
    if (matchesGlob(task.scope, f)) {
      matched.push(f);
    } else {
      unmatched.push(f);
    }
  }

  return { task_id: input.task_id, scope: task.scope, matched, unmatched };
}

export const sliceFilesForTaskToolDef: ToolDef<typeof schema> = {
  name: "slice_files_for_task",
  description:
    "Filter a file list to those matching a task's `scope` glob. Without a scope, the task is repo-wide and all files match. Same glob primitive as skip_paths and learnings scope.",
  schema,
  handler: sliceFilesForTaskTool,
};
