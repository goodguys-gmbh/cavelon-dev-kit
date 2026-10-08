// Keep the release-line pin in step with plugin/.mcp.json.
export const MCP_COMMAND = { command: "npx", args: ["-y", "@cavelon/cli@0.1", "mcp"] };
export const INSTALLED_MCP_COMMAND = { command: "cavelon", args: ["mcp"] };

/** Native Windows cannot spawn npx.cmd as an executable without cmd. */
export function mcpCommand(platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  return platform === "win32" ? { command: "cmd", args: ["/c", MCP_COMMAND.command, ...MCP_COMMAND.args] } : MCP_COMMAND;
}
