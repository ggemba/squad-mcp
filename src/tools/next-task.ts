import { z } from "zod";
import type { ToolDef } from "./registry.js";
import { readTasks, type Task } from "../tasks/store.js";
import { nextTask as nextTaskFn } from "../tasks/select.js";
import { readSquadYaml } from "../config/squad-yaml.js";
import { resolveSafePath, createSafePathContext } from "../util/path-safety.js";
import { AGENT_NAMES_TUPLE } from "../config/ownership-matrix.js";

const taskStatusEnum = z.enum([
  "pending",
  "in-progress",
  "review",
  "done",
  "blocked",
  "cancelled",
]);

const schema = z.object({
  workspace_root: z.string().min(1).max(4096),
  agent: z.enum(AGENT_NAMES_TUPLE).optional(),
  changed_files: z.array(z.string().min(1).max(4096)).max(5000).optional(),
  /** Override default candidate statuses (default `["pending"]`). */
  candidate_statuses: z.array(taskStatusEnum).max(6).optional(),
  /** Override what "complete" means for dep checks (default `["done"]`). */
  done_statuses: z.array(taskStatusEnum).max(6).optional(),
});

type Input = z.infer<typeof schema>;

export interface NextTaskOutput {
  task: Task | null;
  reason: "no_candidates" | "all_blocked" | "ok";
  blocked: Array<{ id: number; title: string; missing_deps: number[] }>;
}

export async function nextTaskTool(input: Input): Promise<NextTaskOutput> {
  const ctx = createSafePathContext();
  const safeRoot = await resolveSafePath(input.workspace_root, ".", ctx);
  const config = await readSquadYaml(safeRoot);

  if (!config.tasks.enabled) {
    return { task: null, reason: "no_candidates", blocked: [] };
  }

  const file = await readTasks(safeRoot, { configuredPath: config.tasks.path });
  const result = nextTaskFn(file.tasks, {
    ...(input.agent !== undefined && { agent: input.agent }),
    ...(input.changed_files !== undefined && {
      changed_files: input.changed_files,
    }),
    ...(input.candidate_statuses !== undefined && {
      candidate_statuses: input.candidate_statuses,
    }),
    ...(input.done_statuses !== undefined && {
      done_statuses: input.done_statuses,
    }),
  });

  return {
    task: result.task,
    reason: result.reason,
    blocked: result.blocked.map((b) => ({
      id: b.task.id,
      title: b.task.title,
      missing_deps: b.missing_deps,
    })),
  };
}

export const nextTaskToolDef: ToolDef<typeof schema> = {
  name: "next_task",
  description:
    "Pick the next ready task: candidate status (default pending), all dependencies done, optional agent / changed_files filter. Tiebreaker priority then id. Returns null with reason when none ready, plus the blocked list so callers can show 'X is next when Y completes'.",
  schema,
  handler: nextTaskTool,
};
