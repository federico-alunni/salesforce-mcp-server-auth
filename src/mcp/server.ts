import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { listToolsHandler } from "./handlers/listTools.js";
import { callToolHandler } from "./handlers/callTool.js";

export function createMCPServer(): Server {
  const server = new Server(
    { name: "salesforce-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, listToolsHandler);
  server.setRequestHandler(CallToolRequestSchema, callToolHandler);
  return server;
}
