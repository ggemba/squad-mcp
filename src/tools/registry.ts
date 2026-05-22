import { z, ZodTypeAny } from "zod";
import { scoreRiskTool } from "./score-risk.js";
import { selectSquadTool } from "./select-squad.js";
import { sliceFilesForAgentTool } from "./slice-files.js";
import { listAgentsTool, getAgentDefinitionTool, initLocalConfigTool } from "./agents.js";
import { applyConsolidationRulesTool } from "./consolidate.js";
import { scoreRubricTool } from "./score-rubric.js";
import { readSquadConfigTool } from "./read-squad-config.js";
import { readLearningsToolDef } from "./read-learnings.js";
import { recordLearningToolDef } from "./record-learning.js";
import { pruneLearningsToolDef } from "./prune-learnings.js";
import { listTasksToolDef } from "./list-tasks.js";
import { nextTaskToolDef } from "./next-task.js";
import { recordTasksToolDef } from "./record-tasks.js";
import { updateTaskStatusToolDef } from "./update-task-status.js";
import { expandTaskToolDef } from "./expand-task.js";
import { sliceFilesForTaskToolDef } from "./slice-files-for-task.js";
import { composePrdParseToolDef } from "./compose-prd-parse.js";
import { classifyWorkTypeTool } from "./classify-work-type.js";
import { detectChangedFilesTool } from "./detect-changed-files.js";
import { validatePlanTextTool } from "./validate-plan-text.js";
import { composeSquadWorkflowTool } from "./compose-squad-workflow.js";
import { composeAdvisoryBundleTool } from "./compose-advisory-bundle.js";
import { recordRunToolDef } from "./record-run.js";
import { listRunsToolDef } from "./list-runs.js";
import { drainJournalToolDef } from "./drain-journal.js";
import { isSquadError } from "../errors.js";
import { pathSafe, pathSafeDetails } from "../util/path-safety.js";
import { logger, newRequestId } from "../observability/logger.js";

export interface ToolDef<T extends ZodTypeAny = ZodTypeAny> {
  name: string;
  description: string;
  schema: T;
  handler: (input: z.infer<T>) => Promise<unknown> | unknown;
}

const tools = new Map<string, ToolDef>();

export function register<T extends ZodTypeAny>(def: ToolDef<T>): void {
  tools.set(def.name, def as unknown as ToolDef);
}

/**
 * Remove a tool from the registry. The registry is a module-level singleton,
 * so this exists for tests that register a throwaway tool and must not leak it
 * into the shared Map for any test that runs afterwards.
 */
export function unregister(name: string): void {
  tools.delete(name);
}

export function registerTools(): void {
  register(scoreRiskTool);
  register(selectSquadTool);
  register(sliceFilesForAgentTool);
  register(listAgentsTool);
  register(getAgentDefinitionTool);
  register(initLocalConfigTool);
  register(applyConsolidationRulesTool);
  register(scoreRubricTool);
  register(readSquadConfigTool);
  register(readLearningsToolDef);
  register(recordLearningToolDef);
  register(pruneLearningsToolDef);
  register(listTasksToolDef);
  register(nextTaskToolDef);
  register(recordTasksToolDef);
  register(updateTaskStatusToolDef);
  register(expandTaskToolDef);
  register(sliceFilesForTaskToolDef);
  register(composePrdParseToolDef);
  register(classifyWorkTypeTool);
  register(detectChangedFilesTool);
  register(validatePlanTextTool);
  register(composeSquadWorkflowTool);
  register(composeAdvisoryBundleTool);
  register(recordRunToolDef);
  register(listRunsToolDef);
  register(drainJournalToolDef);
}

export function listTools() {
  return Array.from(tools.values()).map((t) => {
    let inputSchema: Record<string, unknown>;
    try {
      inputSchema = zodToJsonSchema(t.schema);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("schema conversion failed", {
        tool: t.name,
        details: { message },
      });
      // Re-throw so an unconvertible schema fails fast at startup rather than
      // shipping a vacuous schema to MCP clients; the log above makes it
      // diagnosable from structured context, not just a bare stack trace.
      throw err;
    }
    return {
      name: t.name,
      description: t.description,
      inputSchema,
    };
  });
}

interface ToolErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

function asToolErrorResponse(body: ToolErrorBody) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    isError: true,
  };
}

function shapeOf(args: unknown): Record<string, unknown> | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (v === null || v === undefined) {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = `[Array(${v.length})]`;
    } else if (typeof v === "object") {
      out[k] = "[object]";
    } else if (typeof v === "string") {
      out[k] = `[string(${v.length})]`;
    } else {
      out[k] = typeof v;
    }
  }
  return out;
}

export async function dispatchTool(name: string, args: unknown) {
  const requestId = newRequestId();
  const started = Date.now();
  const tool = tools.get(name);

  if (!tool) {
    logger.warn("unknown tool", {
      tool: name,
      request_id: requestId,
      outcome: "unknown_tool",
      duration_ms: Date.now() - started,
    });
    return asToolErrorResponse({
      error: { code: "UNKNOWN_TOOL", message: `unknown tool: ${name}` },
    });
  }

  logger.debug("tool call", {
    tool: name,
    request_id: requestId,
    input_shape: shapeOf(args),
  });

  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    logger.warn("invalid input", {
      tool: name,
      request_id: requestId,
      outcome: "invalid_input",
      duration_ms: Date.now() - started,
    });
    return asToolErrorResponse({
      error: {
        code: "INVALID_INPUT",
        message: parsed.error.message,
        details: { issues: parsed.error.issues.length },
      },
    });
  }

  try {
    const result = await tool.handler(parsed.data);
    logger.info("tool ok", {
      tool: name,
      request_id: requestId,
      outcome: "success",
      duration_ms: Date.now() - started,
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const duration_ms = Date.now() - started;
    if (isSquadError(err)) {
      logger.warn("tool error", {
        tool: name,
        request_id: requestId,
        outcome: "tool_error",
        duration_ms,
        error_code: err.code,
      });
      // Sanitize absolute filesystem paths before the payload crosses the MCP
      // dispatch boundary to the (potentially untrusted) client. The in-
      // process SquadError still carries full paths for local debug; only
      // this serialised copy is truncated. See path-safety.ts:pathSafe for
      // the truncation shape (last 3 segments with `…/` prefix).
      return asToolErrorResponse({
        error: {
          code: err.code,
          message: pathSafe(err.message),
          details: pathSafeDetails(err.details),
        },
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error("internal error", {
      tool: name,
      request_id: requestId,
      outcome: "internal_error",
      duration_ms,
      details: { message },
    });
    return asToolErrorResponse({
      error: { code: "INTERNAL_ERROR", message: "internal tool error" },
    });
  }
}

export function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      if (!value.isOptional()) required.push(key);
    }
    return {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
    };
  }
  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodArray)
    return { type: "array", items: zodToJsonSchema(schema.element) };
  if (schema instanceof z.ZodEnum) return { type: "string", enum: schema.options };
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodDefault) return zodToJsonSchema(schema.removeDefault());
  if (schema instanceof z.ZodEffects) return zodToJsonSchema(schema.innerType());
  // A literal pins a single permitted value. JSON Schema `const` is the exact
  // equivalent; `.value` is the public Zod v3 getter for the literal payload.
  if (schema instanceof z.ZodLiteral) return { const: schema.value };
  // A union admits any of its variant schemas. `.options` is the public Zod v3
  // array of variant schemas; map each through the converter.
  if (schema instanceof z.ZodUnion) {
    return { anyOf: (schema.options as ZodTypeAny[]).map(zodToJsonSchema) };
  }
  // A nullable field accepts the inner schema OR JSON `null`. `.unwrap()`
  // returns the wrapped inner schema; pair it with an explicit null branch.
  if (schema instanceof z.ZodNullable) {
    return { anyOf: [zodToJsonSchema(schema.unwrap()), { type: "null" }] };
  }
  if (schema instanceof z.ZodRecord) {
    const out: Record<string, unknown> = {
      type: "object",
      additionalProperties: zodToJsonSchema(schema.valueSchema),
    };
    // An enum-keyed record constrains which property names are legal; a
    // string-keyed record (the Zod default key type) does not, so guard the
    // instanceof check and only emit propertyNames for the enum case.
    if (schema.keySchema instanceof z.ZodEnum) {
      out.propertyNames = { enum: schema.keySchema.options };
    }
    return out;
  }
  // Fail loud on any unhandled Zod type. A silent `return {}` previously let a
  // vacuous JSON Schema reach MCP clients with no error signal; an explicit
  // throw makes an unsupported type a startup-time failure instead.
  const typeName =
    (schema as { _def?: { typeName?: string } })._def?.typeName ?? schema.constructor.name;
  throw new Error(
    `zodToJsonSchema: unsupported Zod type "${typeName}". ` +
      `Add a branch for it in src/tools/registry.ts.`,
  );
}
