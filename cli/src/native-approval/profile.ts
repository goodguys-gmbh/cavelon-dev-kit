import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readJsoncEntry } from "../jsonc-config.js";

export interface NativeProfile {
  client: "opencode" | "pi";
  version: string;
  configFile: string;
  entryHash: string;
  scope: "user" | "project";
  projectRoot?: string;
}

export interface NativeRuntime {
  command: StdioServerParameters;
  version: string;
  runtimeDir: string;
  scope: "user" | "project";
  projectRoot?: string;
  waitMs?: number;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Profiles carry a binding hash, never a copy of command environment values. */
export function nativeEntryHash(entry: unknown): string {
  return createHash("sha256").update(canonical(entry)).digest("hex");
}

export function nativeRuntimeDirectory(profileFile: string): string {
  const identity = process.getuid?.().toString() ?? os.userInfo().username;
  const suffix = createHash("sha256").update(`${identity}\n${path.resolve(profileFile)}`).digest("hex").slice(0, 20);
  // macOS's TMPDIR and deeply nested projects can exceed the Unix socket limit.
  const temp = process.platform !== "win32" && Buffer.byteLength(os.tmpdir()) > 40 ? "/tmp" : os.tmpdir();
  return path.join(temp, `cavelon-native-${suffix}`);
}

/** Re-read the selected configuration; personal edits invalidate native ownership. */
export async function loadNativeRuntime(profileFile: string, client: NativeProfile["client"]): Promise<NativeRuntime> {
  const profile = JSON.parse(await fs.readFile(profileFile, "utf8")) as NativeProfile;
  if (profile.client !== client || typeof profile.version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(profile.version)
    || typeof profile.configFile !== "string" || !path.isAbsolute(profile.configFile)
    || typeof profile.entryHash !== "string" || !/^[a-f0-9]{64}$/.test(profile.entryHash)
    || !["user", "project"].includes(profile.scope)
    || (profile.scope === "project" && (typeof profile.projectRoot !== "string" || !path.isAbsolute(profile.projectRoot)))) {
    throw new Error("Invalid Cavelon native profile; repeat cavelon setup or init.");
  }
  const text = await fs.readFile(profile.configFile, "utf8");
  if (client === "pi") JSON.parse(text);
  const selected = readJsoncEntry(text, [client === "opencode" ? "mcp" : "mcpServers", "cavelon"]);
  if ("error" in selected || !selected.value || nativeEntryHash(selected.value) !== profile.entryHash) {
    throw new Error("The Cavelon MCP entry changed; review it and repeat setup before using native approval.");
  }
  const entry = selected.value as Record<string, unknown>;
  if (entry.enabled !== false || (client === "opencode" && entry.type !== "local")) {
    throw new Error("Native approval must own only Cavelon; disable its duplicate built-in MCP entry.");
  }
  const words = client === "opencode" ? entry.command : [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])];
  if (!Array.isArray(words) || !words.length || !words.every(word => typeof word === "string") || !words[0]
    || (client === "pi" && !Array.isArray(entry.args))) throw new Error("Invalid Cavelon MCP process command.");
  const overrides = entry[client === "opencode" ? "environment" : "env"];
  if (overrides !== undefined && (!overrides || typeof overrides !== "object" || Array.isArray(overrides)
    || Object.values(overrides).some(value => typeof value !== "string"))) throw new Error("Invalid Cavelon MCP environment.");
  const env = Object.fromEntries(Object.entries({ ...process.env, ...(overrides as Record<string, string> | undefined) }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return {
    version: profile.version, scope: profile.scope, ...(profile.projectRoot ? { projectRoot: profile.projectRoot } : {}),
    runtimeDir: nativeRuntimeDirectory(profileFile), command: { command: words[0], args: words.slice(1), env },
  };
}
