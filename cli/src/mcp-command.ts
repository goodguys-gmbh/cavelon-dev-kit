// Keep the release-line pin in step with plugin/.mcp.json. When it moves, the
// line it leaves goes into EARLIER_RELEASE_LINES.
const RELEASE_LINE = "0.2";
// Entries an earlier release line wrote stay the kit's own, so setup and
// init --update move them to this line and setup --remove takes them out.
export const EARLIER_RELEASE_LINES = ["0.1"];

const npx = (line: string) => ({ command: "npx", args: ["-y", `@cavelon/cli@${line}`, "mcp"] });

export const MCP_COMMAND = npx(RELEASE_LINE);
export const INSTALLED_MCP_COMMAND = { command: "cavelon", args: ["mcp"] };

/** Native Windows cannot spawn npx.cmd as an executable without cmd. */
export function mcpCommand(platform: NodeJS.Platform = process.platform, line = RELEASE_LINE): { command: string; args: string[] } {
  const command = line === RELEASE_LINE ? MCP_COMMAND : npx(line);
  return platform === "win32" ? { command: "cmd", args: ["/c", command.command, ...command.args] } : command;
}

/** The forms this release writes, on any system: an entry in one of them is current. */
export function currentMcpCommands(): Array<{ command: string; args: string[] }> {
  return [INSTALLED_MCP_COMMAND, mcpCommand("linux"), mcpCommand("win32")];
}

/** Every form any release line of the kit wrote: the kit's own to replace or remove. */
export function kitMcpCommands(): Array<{ command: string; args: string[] }> {
  return [...currentMcpCommands(), ...EARLIER_RELEASE_LINES.flatMap(line => [mcpCommand("linux", line), mcpCommand("win32", line)])];
}
