import { z } from 'zod';
import type { ToolDef } from './registry.js';
import { AGENTS, type AgentName } from '../config/ownership-matrix.js';
import { listAvailableAgents, readAgentDefinition, initLocalConfig, getLocalDir } from '../resources/agent-loader.js';

const listSchema = z.object({});

export const listAgentsTool: ToolDef<typeof listSchema> = {
  name: 'list_agents',
  description: 'List all configured agents with their roles, ownership, and naming conventions.',
  schema: listSchema,
  handler: async () => {
    const { rawDir, explicit } = getLocalDir();
    return { agents: await listAvailableAgents(), local_dir: rawDir, local_dir_explicit: explicit };
  },
};

const getSchema = z.object({
  name: z.enum(Object.keys(AGENTS) as [AgentName, ...AgentName[]]),
});

export const getAgentDefinitionTool: ToolDef<typeof getSchema> = {
  name: 'get_agent_definition',
  description: 'Return the full markdown system prompt for a given agent. Resolves from local override → embedded default.',
  schema: getSchema,
  handler: async ({ name }) => ({
    name,
    definition: await readAgentDefinition(name),
  }),
};

const initSchema = z.object({
  force: z.boolean().optional().default(false),
});

export const initLocalConfigTool: ToolDef<typeof initSchema> = {
  name: 'init_local_config',
  description:
    'Copy embedded agent defaults to the local override directory ($SQUAD_AGENTS_DIR or %APPDATA%/squad-mcp/agents). Files locally edited override the bundled versions.',
  schema: initSchema,
  handler: async ({ force }) => initLocalConfig(force),
};
