#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { registerTools, dispatchTool, listTools } from "./tools/registry.js";
import { listResources, readResource } from "./resources/registry.js";
import { listPrompts, getPrompt } from "./prompts/registry.js";
import { logger, setupProcessHandlers } from "./observability/logger.js";

setupProcessHandlers();

const SERVER_VERSION = "0.6.3";

const server = new Server(
  {
    name: "squad-mcp",
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  },
);

registerTools();

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: listTools(),
}));
server.setRequestHandler(CallToolRequestSchema, async (req) =>
  dispatchTool(req.params.name, req.params.arguments ?? {}),
);

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: await listResources(),
}));
server.setRequestHandler(ReadResourceRequestSchema, async (req) =>
  readResource(req.params.uri),
);

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: listPrompts(),
}));
server.setRequestHandler(GetPromptRequestSchema, async (req) =>
  getPrompt(req.params.name, req.params.arguments ?? {}),
);

const transport = new StdioServerTransport();
await server.connect(transport);

logger.info("server started", {
  details: { version: SERVER_VERSION, tools: listTools().length },
});
