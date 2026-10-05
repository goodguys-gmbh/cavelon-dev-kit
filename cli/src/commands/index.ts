import type { CommandSpec } from "../command.js";
import { table } from "../format.js";
import { api, apiDescribe, apiList } from "./api.js";
import { wait, watch } from "./async.js";
import { chat, deactivate } from "./chat.js";
import { docsGet, docsSearch } from "./docs.js";
import { login, logout, status, use, whoami } from "./session.js";
import { init } from "./init.js";
import { fmt } from "./fmt.js";
import { setup } from "./setup.js";
import { limits } from "./limits.js";
import { limitsSet } from "./limits-set.js";
import { modelsList, modelsSetLimit } from "./models.js";
import { activate, apply, explain, pull, validate } from "./solution.js";
import { schema } from "./schema.js";
import { harnessClone, harnessDefault, harnessList, harnessNew, tenantCreate, tenantList } from "./tenants.js";
import { kbUpload, testRun, trace } from "./work.js";
import { secretsDelete, secretsList, secretsSet, variablesDelete, variablesGet, variablesList, variablesSet } from "./values.js";
import { loopCancel, loopIterations, loopPause, loopResume, loopStart, loopWatch, triggerIdentity } from "./loops.js";
import {
  artifactsExport,
  sandboxActivity,
  sandboxCat,
  sandboxFiles,
  sandboxList,
  sandboxLogs,
  sandboxReceipt,
  sandboxRefresh,
  sandboxSeed,
  sandboxValidate,
} from "./sandboxes.js";

const commandsList: CommandSpec = {
  name: "commands",
  summary: "List every command, whether it is read-only, and its MCP tool.",
  readOnly: true,
  idempotent: true,
  mcpTool: false,
  async run() {
    const items = COMMANDS.map((c) => ({
      command: c.name,
      read_only: c.readOnly,
      destructive: Boolean(c.destructive),
      mcp_tool: c.mcpTool || null,
      summary: c.summary,
    }));
    return { data: { items }, text: table(items, ["command", "read_only", "mcp_tool", "summary"], 70) };
  },
};

const mcp: CommandSpec = {
  name: "mcp",
  summary: "Serve the commands as MCP tools on stdio (for coding agents).",
  description: "Started by the agent's plugin (`cavelon mcp`); it does not return until the agent disconnects.",
  readOnly: false,
  mcpTool: false,
  async run(ctx) {
    const { createMcpServer } = await import("../mcp.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const server = createMcpServer(ctx.io, COMMANDS);
    const transport = new StdioServerTransport();
    // The agent ends the session by closing our stdin.
    const closed = new Promise<void>((resolve) => {
      server.onclose = () => resolve();
      ctx.io.stdin.on?.("end", () => resolve());
      ctx.io.stdin.on?.("close", () => resolve());
    });
    await server.connect(transport);
    await closed;
    await server.close().catch(() => undefined);
    return { data: undefined, text: "" };
  },
};

export const COMMANDS: CommandSpec[] = [
  setup,
  login,
  logout,
  whoami,
  use,
  status,
  limits,
  limitsSet,
  modelsList,
  modelsSetLimit,
  tenantCreate,
  tenantList,
  harnessList,
  harnessDefault,
  harnessNew,
  harnessClone,
  activate,
  deactivate,
  chat,
  init,
  pull,
  validate,
  fmt,
  schema,
  apply,
  explain,
  variablesList,
  variablesGet,
  variablesSet,
  variablesDelete,
  secretsList,
  secretsSet,
  secretsDelete,
  apiList,
  apiDescribe,
  api,
  docsSearch,
  docsGet,
  wait,
  watch,
  kbUpload,
  testRun,
  trace,
  loopStart,
  loopCancel,
  loopWatch,
  loopIterations,
  loopPause,
  loopResume,
  triggerIdentity,
  sandboxList,
  sandboxValidate,
  sandboxFiles,
  sandboxCat,
  sandboxActivity,
  sandboxLogs,
  sandboxReceipt,
  sandboxSeed,
  sandboxRefresh,
  artifactsExport,
  commandsList,
  mcp,
];
