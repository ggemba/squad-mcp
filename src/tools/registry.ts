import { z, ZodTypeAny } from 'zod';
import { scoreRiskTool } from './score-risk.js';
import { selectSquadTool } from './select-squad.js';
import { sliceFilesForAgentTool } from './slice-files.js';
import { listAgentsTool, getAgentDefinitionTool, initLocalConfigTool } from './agents.js';
import { applyConsolidationRulesTool } from './consolidate.js';
import { classifyWorkTypeTool } from './classify-work-type.js';
import { detectChangedFilesTool } from './detect-changed-files.js';
import { validatePlanTextTool } from './validate-plan-text.js';
import { isSquadError } from '../errors.js';
import { logger, newRequestId } from '../observability/logger.js';

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

export function registerTools(): void {
  register(scoreRiskTool);
  register(selectSquadTool);
  register(sliceFilesForAgentTool);
  register(listAgentsTool);
  register(getAgentDefinitionTool);
  register(initLocalConfigTool);
  register(applyConsolidationRulesTool);
  register(classifyWorkTypeTool);
  register(detectChangedFilesTool);
  register(validatePlanTextTool);
}

export function listTools() {
  return Array.from(tools.values()).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.schema),
  }));
}

interface ToolErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

function asToolErrorResponse(body: ToolErrorBody) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
    isError: true,
  };
}

function shapeOf(args: unknown): Record<string, unknown> | undefined {
  if (args === null || typeof args !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (v === null || v === undefined) {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = `[Array(${v.length})]`;
    } else if (typeof v === 'object') {
      out[k] = '[object]';
    } else if (typeof v === 'string') {
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
    logger.warn('unknown tool', {
      tool: name,
      request_id: requestId,
      outcome: 'unknown_tool',
      duration_ms: Date.now() - started,
    });
    return asToolErrorResponse({
      error: { code: 'UNKNOWN_TOOL', message: `unknown tool: ${name}` },
    });
  }

  logger.debug('tool call', { tool: name, request_id: requestId, input_shape: shapeOf(args) });

  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    logger.warn('invalid input', {
      tool: name,
      request_id: requestId,
      outcome: 'invalid_input',
      duration_ms: Date.now() - started,
    });
    return asToolErrorResponse({
      error: {
        code: 'INVALID_INPUT',
        message: parsed.error.message,
        details: { issues: parsed.error.issues.length },
      },
    });
  }

  try {
    const result = await tool.handler(parsed.data);
    logger.info('tool ok', {
      tool: name,
      request_id: requestId,
      outcome: 'success',
      duration_ms: Date.now() - started,
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const duration_ms = Date.now() - started;
    if (isSquadError(err)) {
      logger.warn('tool error', {
        tool: name,
        request_id: requestId,
        outcome: 'tool_error',
        duration_ms,
        error_code: err.code,
      });
      return asToolErrorResponse({
        error: { code: err.code, message: err.message, details: err.details },
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error('internal error', {
      tool: name,
      request_id: requestId,
      outcome: 'internal_error',
      duration_ms,
      details: { message },
    });
    return asToolErrorResponse({
      error: { code: 'INTERNAL_ERROR', message: 'internal tool error' },
    });
  }
}

function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      if (!value.isOptional()) required.push(key);
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}) };
  }
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodArray) return { type: 'array', items: zodToJsonSchema(schema.element) };
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: schema.options };
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodDefault) return zodToJsonSchema(schema.removeDefault());
  if (schema instanceof z.ZodEffects) return zodToJsonSchema(schema.innerType());
  return {};
}
