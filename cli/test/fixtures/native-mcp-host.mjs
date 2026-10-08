// Synthetic protocol fixture: no instance, customer credential or model is used.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "synthetic-cavelon", version: "test" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "read", description: "Synthetic Unicode read", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "change", description: "Synthetic exact preview", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (request.params.name === "read") return { isError: request.params.arguments?.fail === true, content: [{ type: "text", text: "Grüße 東京 🐳" }] };
  if (request.params.name !== "change") throw new Error("Unknown synthetic tool.");
  if (!server.getClientCapabilities()?.elicitation?.form) return { content: [{ type: "text", text: "person-terminal" }] };
  const answer = await server.elicitInput({ mode: "form", message: request.params.arguments.message, requestedSchema: {
    type: "object", properties: { approve: { type: "boolean" } }, required: ["approve"],
  } });
  return { content: [{ type: "text", text: answer.action === "accept" && answer.content?.approve === true ? "approved" : "declined" }] };
});
await server.connect(new StdioServerTransport());
