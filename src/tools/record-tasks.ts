import { z } from "zod";
import type { ToolDef } from "./registry.js";
import { recordTasks } from "../tasks/store.js";
import { readSquadYaml } from "../config/squad-yaml.js";
import { resolveSafePath, createSafePathContext } from "../util/path-safety.js";
import { AGENT_NAMES_TUPLE } from "../config/ownership-matrix.js";

const taskInputSchema = z.object({
  id: z.number().int().positive().optional(),
  title: z.string().min(1).max(512),
  description: z.string().max(4096).optional(),
  dependencies: z.array(z.number().int().positive()).max(50).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  details: z.string().max(16384).optional(),
  test_strategy: z.string().max(4096).optional(),
  scope: z.string().min(1).max(512).optional(),
  agent_hints: z.array(z.enum(AGENT_NAMES_TUPLE)).optional(),
});

const schema = z.object({
  workspace_root: z.string().min(1).max(4096),
  tasks: z.array(taskInputSchema).min(1).max(500),
});

type Input = z.infer<typeof schema>;

export interface RecordTasksOutput {
  recorded: true;
  file: string;
  ids: number[];
}

export async function recordTasksTool(
  input: Input,
): Promise<RecordTasksOutput> {
  const ctx = createSafePathContext();
  const safeRoot = await resolveSafePath(input.workspace_root, ".", ctx);
  const config = await readSquadYaml(safeRoot);
  // Writes stay open even when reads disabled — same policy as learnings.

  const result = await recordTasks(
    safeRoot,
    input.tasks.map((t) => ({
      ...(t.id !== undefined && { id: t.id }),
      title: t.title,
      ...(t.description !== undefined && { description: t.description }),
      ...(t.dependencies !== undefined && { dependencies: t.dependencies }),
      ...(t.priority !== undefined && { priority: t.priority }),
      ...(t.details !== undefined && { details: t.details }),
      ...(t.test_strategy !== undefined && { test_strategy: t.test_strategy }),
      ...(t.scope !== undefined && { scope: t.scope }),
      ...(t.agent_hints !== undefined && { agent_hints: t.agent_hints }),
    })),
    { configuredPath: config.tasks.path },
  );

  return { recorded: true, file: result.filePath, ids: result.ids };
}

export const recordTasksToolDef: ToolDef<typeof schema> = {
  name: "record_tasks",
  description:
    "Bulk-create tasks in `.squad/tasks.json`. Each task: id (optional, auto-allocated), title, description, dependencies, priority, details, test_strategy, scope (glob), agent_hints. Side-effecting — atomic write (tmp + rename). Validates: unique ids, all dependencies resolve, no self-deps. The host LLM is responsible for confirming with the user before bulk-recording from a parsed PRD.",
  schema,
  handler: recordTasksTool,
};
