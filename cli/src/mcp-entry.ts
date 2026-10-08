import { isDeepStrictEqual } from "node:util";
import { INSTALLED_MCP_COMMAND, mcpCommand } from "./mcp-command.js";

export interface McpCommand {
  command: string;
  args: string[];
}

export type McpEntryFormat = "command-args" | "command-array";

/** Client-specific extras stay outside the platform-specific process command. */
export function encodeMcpEntry(command: McpCommand, format: McpEntryFormat, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return format === "command-array" ? { ...extra, command: [command.command, ...command.args] } : { ...extra, command: command.command, args: command.args };
}

export function decodeMcpEntry(value: unknown, format: McpEntryFormat): McpCommand | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  const words = format === "command-array" ? entry.command : [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])];
  if (format === "command-args" && !Array.isArray(entry.args)) return undefined;
  if (!Array.isArray(words) || !words.length || !words.every(word => typeof word === "string") || !words[0]) return undefined;
  return { command: words[0] as string, args: words.slice(1) as string[] };
}

/** Extra personal options mean the entry is no longer owned by setup. */
export function isKitMcpEntry(value: unknown, format: McpEntryFormat, extra: Record<string, unknown> = {}): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return [INSTALLED_MCP_COMMAND, mcpCommand("linux"), mcpCommand("win32")].some(command => isDeepStrictEqual(encodeMcpEntry(command, format, extra), value));
}
