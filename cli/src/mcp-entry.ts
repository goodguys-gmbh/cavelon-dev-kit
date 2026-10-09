import { isDeepStrictEqual } from "node:util";
import { currentMcpCommands, kitMcpCommands } from "./mcp-command.js";

export interface McpCommand {
  command: string;
  args: string[];
}

export type McpEntryFormat = "command-args" | "command-array" | "goose-stdio";

/** Client-specific extras stay outside the platform-specific process command. */
export function encodeMcpEntry(command: McpCommand, format: McpEntryFormat, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return format === "command-array" ? { ...extra, command: [command.command, ...command.args] } : { ...extra, [format === "goose-stdio" ? "cmd" : "command"]: command.command, args: command.args };
}

export function decodeMcpEntry(value: unknown, format: McpEntryFormat): McpCommand | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  const words = format === "command-array" ? entry.command : [entry[format === "goose-stdio" ? "cmd" : "command"], ...(Array.isArray(entry.args) ? entry.args : [])];
  if (format !== "command-array" && !Array.isArray(entry.args)) return undefined;
  if (!Array.isArray(words) || !words.length || !words.every(word => typeof word === "string") || !words[0]) return undefined;
  return { command: words[0] as string, args: words.slice(1) as string[] };
}

/** Extra personal options mean the entry is no longer owned by setup; an earlier release line's entry still is. */
export function isKitMcpEntry(value: unknown, format: McpEntryFormat, extra: Record<string, unknown> = {}): boolean {
  return matchesAny(kitMcpCommands(), value, format, extra);
}

/** The kit's entry as this release writes it, for any system: nothing to update. */
export function isCurrentMcpEntry(value: unknown, format: McpEntryFormat, extra: Record<string, unknown> = {}): boolean {
  return matchesAny(currentMcpCommands(), value, format, extra);
}

function matchesAny(commands: McpCommand[], value: unknown, format: McpEntryFormat, extra: Record<string, unknown>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return commands.some(command => isDeepStrictEqual(encodeMcpEntry(command, format, extra), value));
}
