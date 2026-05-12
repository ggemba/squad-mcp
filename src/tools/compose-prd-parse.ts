import { z } from "zod";
import type { ToolDef } from "./registry.js";
import { readTasks, type Task } from "../tasks/store.js";
import { readSquadYaml } from "../config/squad-yaml.js";
import { resolveSafePath, createSafePathContext } from "../util/path-safety.js";
import { sanitizeForPrompt } from "../util/prompt-sanitize.js";
import { AGENT_NAMES_TUPLE } from "../config/ownership-matrix.js";

const schema = z.object({
  workspace_root: z.string().min(1).max(4096),
  /**
   * PRD text. Free-form; the LLM is responsible for extracting structure.
   * Sanitized for prompt-injection codepoints before interpolation.
   */
  prd_text: z.string().min(1).max(200_000),
  /** Optional max number of tasks to extract (soft hint passed to the LLM). */
  max_tasks: z.number().int().positive().max(200).optional().default(40),
  /**
   * When true (default), include the existing tasks in the prompt so the LLM
   * doesn't duplicate ids or re-decompose work already captured.
   */
  include_existing: z.boolean().optional().default(true),
});

type Input = z.infer<typeof schema>;

export interface ComposePrdParseOutput {
  /** Markdown prompt to feed to the host LLM. */
  prompt: string;
  /** JSON schema the LLM is instructed to emit. Caller validates against this. */
  output_schema: Record<string, unknown>;
  /** Existing tasks, injected into the prompt and returned for caller convenience. */
  existing: { id: number; title: string; status: string }[];
  /** Highest existing id, so caller can pre-allocate or warn the LLM. */
  next_id_floor: number;
  /** Recommended next step (string, for the host LLM): call record_tasks. */
  next_action: "call_record_tasks_with_user_confirmation";
}

const TASK_INPUT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", maxLength: 512 },
    description: { type: "string", maxLength: 4096 },
    dependencies: {
      type: "array",
      items: { type: "integer", minimum: 1 },
      description:
        "Task IDs this task depends on. May reference existing tasks or other tasks in the same parsed batch (forward refs allowed — IDs assigned by record_tasks in array order starting from next_id_floor + 1).",
    },
    priority: { type: "string", enum: ["low", "medium", "high"] },
    details: { type: "string", maxLength: 16384 },
    test_strategy: { type: "string", maxLength: 4096 },
    scope: {
      type: "string",
      maxLength: 512,
      description:
        "Glob limiting which files this task touches (e.g. 'src/auth/**'). Optional. Used by slice_files_for_task and the advisory squad to narrow review.",
    },
    agent_hints: {
      type: "array",
      items: { type: "string", enum: AGENT_NAMES_TUPLE },
      description:
        "Subset of squad agents most relevant for this task. Empty/absent means repo-wide.",
    },
  },
  required: ["title"],
} as const;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: TASK_INPUT_SCHEMA,
      maxItems: 200,
    },
  },
  required: ["tasks"],
};

function renderExisting(existing: Task[]): string {
  if (existing.length === 0) {
    return "_(no existing tasks — this is a fresh decomposition)_";
  }
  // Task titles are stored user input that flows verbatim into the PRD prompt
  // template. Sanitize at the prompt boundary — strips invisibles, role tokens,
  // normalises NFKC. See src/util/prompt-sanitize.ts.
  const lines = existing.map((t) => `- ${t.id}. [${t.status}] ${sanitizeForPrompt(t.title)}`);
  return lines.join("\n");
}

/**
 * Build the prompt + output schema for decomposing a PRD into squad-mcp tasks.
 * Pure-MCP: this tool does NOT call any LLM. It returns the materials the host
 * LLM (Claude Code, Cursor, etc.) needs to do the decomposition itself, and
 * then call `record_tasks` with the result.
 *
 * Why pure-MCP: keeps squad-mcp deterministic and free of provider keys; the
 * host already pays for inference and has the user's consent to do so.
 */
export async function composePrdParseTool(input: Input): Promise<ComposePrdParseOutput> {
  const ctx = createSafePathContext();
  const safeRoot = await resolveSafePath(input.workspace_root, ".", ctx);
  const config = await readSquadYaml(safeRoot);

  // Sanitize at the prompt boundary — strips invisibles, role tokens, normalises NFKC.
  // See src/util/prompt-sanitize.ts.
  const safePrdText = sanitizeForPrompt(input.prd_text);

  const existingFile = input.include_existing
    ? await readTasks(safeRoot, { configuredPath: config.tasks.path })
    : { tasks: [] as Task[], version: 1 as const };

  const nextIdFloor = existingFile.tasks.reduce((m, t) => Math.max(m, t.id), 0);

  const existingSection = input.include_existing
    ? `## Existing tasks (do not duplicate)

The repo already has these tasks. Do NOT redecompose work they cover; reference
their IDs in \`dependencies\` if your new tasks depend on them.

${renderExisting(existingFile.tasks)}

The next available task ID will be ${nextIdFloor + 1}.`
    : `## Existing tasks
_(skipped — caller passed \`include_existing: false\`)_`;

  const agentList = AGENT_NAMES_TUPLE.filter(
    (a) => a !== "tech-lead-planner" && a !== "tech-lead-consolidator",
  ).join(", ");

  const prompt = `# Decompose the PRD below into atomic, ordered tasks.

You are decomposing a Product Requirements Document into a list of tasks for the
\`squad-mcp\` task store. The tasks will be reviewed by the user, then bulk-recorded
via the \`record_tasks\` MCP tool, then executed one-at-a-time by the squad.

## Output contract

Emit ONE JSON object matching the schema below. No prose before or after — your
entire response is parsed as JSON.

\`\`\`json
${JSON.stringify(OUTPUT_SCHEMA, null, 2)}
\`\`\`

## Decomposition rules

1. **Atomic** — each task should be small enough that a developer can complete
   it in a single sitting (one PR, one commit). If a task feels like "the whole
   feature", break it down further.
2. **Ordered via dependencies** — if task B can't start until task A is done,
   set \`B.dependencies = [A's id]\`. IDs are assigned in array order starting
   from ${nextIdFloor + 1}.
3. **Cap at ${input.max_tasks} tasks** — if the PRD is huge, prefer fewer
   higher-level tasks; the squad can \`expand_task\` later as needed.
4. **Scope when sensible** — if a task touches a clearly-bounded directory
   tree (e.g. just \`src/auth/\`), set \`scope\` to a glob (\`src/auth/**\`).
   Skip \`scope\` for repo-wide tasks (config, docs, refactors).
5. **Agent hints when obvious** — \`agent_hints\` narrows which squad agents
   review the task. Available: ${agentList}. Pick 1-3 agents whose ownership
   genuinely covers the task. Skip when the task spans multiple domains.
6. **Test strategy** — for code tasks, write 1-3 sentences on how to verify.
   Skip for non-code tasks (docs, config, deps).
7. **Priority** — use \`high\` for blockers / security / critical path,
   \`medium\` for normal work, \`low\` for nice-to-haves. Default \`medium\`.
8. **No AI fluff** — \`title\` and \`description\` are read by humans.
   Lead with the action verb. Example: "Add CSRF token to checkout flow",
   not "Implementation of CSRF protection mechanism for the checkout module".

## What NOT to do

- Don't generate "setup", "init", or "scaffolding" tasks unless the PRD
  explicitly requires them. Bias toward what the PRD actually asks for.
- Don't invent tasks. If the PRD doesn't mention testing, don't add a
  generic "write tests" task. The host can ask separately.
- Don't reference task IDs that don't exist in either the existing list
  or your own batch.
- Don't emit a self-dependency (a task depending on itself).

${existingSection}

## PRD

${safePrdText}

## Now emit the JSON

Remember: ONE JSON object, schema above, no prose before or after.`;

  return {
    prompt,
    output_schema: OUTPUT_SCHEMA,
    existing: existingFile.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
    })),
    next_id_floor: nextIdFloor,
    next_action: "call_record_tasks_with_user_confirmation",
  };
}

export const composePrdParseToolDef: ToolDef<typeof schema> = {
  name: "compose_prd_parse",
  description:
    "Build a prompt + JSON schema for the host LLM to decompose a PRD into atomic tasks. Pure-MCP: does NOT call any LLM. Caller (skill/host) feeds the prompt to its LLM, receives JSON, then calls record_tasks with user confirmation. Includes existing tasks in the prompt to prevent duplication.",
  schema,
  handler: composePrdParseTool,
};
