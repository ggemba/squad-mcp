import { z, ZodTypeAny } from 'zod';
import { scoreRiskTool } from './score-risk.js';
import { selectSquadTool } from './select-squad.js';
import { sliceFilesForAgentTool } from './slice-files.js';
import { listAgentsTool, getAgentDefinitionTool, initLocalConfigTool } from './agents.js';
import { applyConsolidationRulesTool } from './consolidate.js';

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
}

export function listTools() {
  return Array.from(tools.values()).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.schema),
  }));
}

export async function dispatchTool(name: string, args: unknown) {
  const tool = tools.get(name);
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: 'text', text: `Invalid input: ${parsed.error.message}` }],
      isError: true,
    };
  }
  try {
    const result = await tool.handler(parsed.data);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Tool error: ${msg}` }], isError: true };
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
  return {};
}
