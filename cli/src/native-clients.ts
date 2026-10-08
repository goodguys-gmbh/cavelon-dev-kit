import path from "node:path";
import { readTextFile } from "./fsutil.js";
import { readJsoncEntry } from "./jsonc-config.js";
import { isKitMcpEntry, type McpEntryFormat } from "./mcp-entry.js";
import { homeDir } from "./paths.js";

type Env = Record<string, string | undefined>;

export interface NativeMcpConfig {
  client: "opencode" | "pi";
  format: "native";
  file: string;
  /** Low to high precedence; never create a companion when one already exists. */
  files: string[];
  /** A personal user entry must not be silently shadowed by a new project entry. */
  shadowFiles?: string[];
  syntax: "json" | "jsonc";
  keys: string[];
  entryFormat: McpEntryFormat;
  extra: Record<string, unknown>;
  blocked?: string;
}

export interface NativeClient {
  name: string;
  label: string;
  aliases: string[];
  commands: string[];
  projectSkills: string[];
  project(env?: Env): NativeMcpConfig;
  user(env: Env): { mcp: NativeMcpConfig; skills: string; folders: string[] };
  notes: string[];
}

const openCodeConfig = (file: string, files: string[], blocked?: string): NativeMcpConfig => ({
  client: "opencode", format: "native", file, files, syntax: "jsonc", keys: ["mcp", "cavelon"], entryFormat: "command-array", extra: { type: "local" },
  ...(blocked ? { blocked } : {}),
});
const piConfig = (file: string): NativeMcpConfig => ({
  client: "pi", format: "native", file, files: [file], syntax: "json", keys: ["mcpServers", "cavelon"], entryFormat: "command-args", extra: {},
});

const piDir = (env: Env) => env.PI_CODING_AGENT_DIR || path.join(homeDir(env), ".pi", "agent");

function openCodeUserFiles(env: Env): string[] {
  const dir = path.join(env.XDG_CONFIG_HOME || path.join(homeDir(env), ".config"), "opencode");
  return [path.join(dir, "config.json"), path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc"), ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : [])];
}

export const NATIVE_CLIENTS: NativeClient[] = [
  {
    name: "opencode", label: "OpenCode", aliases: ["opencode-ai"], commands: ["opencode"], projectSkills: [],
    project: (env = {}) => ({ ...openCodeConfig("opencode.json", ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"],
      env.OPENCODE_CONFIG_CONTENT ? "OPENCODE_CONFIG_CONTENT overrides file settings; configure Cavelon in that managed configuration" :
        env.OPENCODE_DISABLE_PROJECT_CONFIG === "true" || env.OPENCODE_DISABLE_PROJECT_CONFIG === "1" ? "OpenCode project configuration is disabled" :
          env.OPENCODE_CONFIG_DIR ? "OPENCODE_CONFIG_DIR may override project settings; configure Cavelon in that directory" : undefined), shadowFiles: openCodeUserFiles(env) }),
    user: env => {
      const global = path.join(env.XDG_CONFIG_HOME || path.join(homeDir(env), ".config"), "opencode");
      const dir = env.OPENCODE_CONFIG_DIR || global;
      const files = openCodeUserFiles(env);
      if (dir !== global) files.push(path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc"));
      return {
        mcp: openCodeConfig(env.OPENCODE_CONFIG || path.join(dir, "opencode.json"), [...new Set(files)],
          env.OPENCODE_CONFIG_CONTENT ? "OPENCODE_CONFIG_CONTENT overrides file settings; configure Cavelon in that managed configuration" : undefined),
        skills: path.join(dir, "skills"), folders: [...new Set([global, dir])],
      };
    },
    notes: ["OpenCode's built-in MCP path does not provide Cavelon form approval; guarded changes return a command for the person's own terminal. Native dialog qualification is separate."],
  },
  {
    name: "pi", label: "Pi", aliases: ["pi-coding-agent"], commands: ["pi"], projectSkills: [".pi/skills"],
    project: (env = {}) => ({ ...piConfig(".pi/mcp.json"), shadowFiles: [path.join(piDir(env), "mcp.json")] }),
    user: env => {
      const dir = piDir(env);
      return { mcp: piConfig(path.join(dir, "mcp.json")), skills: path.join(dir, "skills"), folders: [dir] };
    },
    notes: [
      "Pi reads project MCP only after the person grants project trust. A project entry overrides a user entry with the same name.",
      "Replacement /mcp extensions can override Pi's built-in MCP; inspect them in Pi before using these settings. Setup does not install or disable another MCP extension.",
      "Pi's built-in MCP path does not provide Cavelon form approval; guarded changes return a command for the person's own terminal. Native dialog qualification is separate.",
    ],
  },
];

export const nativeClient = (name: string): NativeClient | undefined => NATIVE_CLIENTS.find(client => client.name === name || client.aliases.includes(name));

export function readNativeMcp(text: string | undefined, config: NativeMcpConfig): ReturnType<typeof readJsoncEntry> {
  if (text !== undefined && config.syntax === "json") {
    try { JSON.parse(text); } catch { return { error: "this client requires plain JSON; correct the file before setup" }; }
  }
  return readJsoncEntry(text, config.keys);
}

/** Refuse duplicate effective entries instead of guessing which a merged client config uses. */
export async function resolveNativeMcp(config: NativeMcpConfig, root?: string): Promise<
  { file: string; text: string | undefined; current: unknown; kept: number } | { file: string; error: string }
> {
  const full = (file: string) => root ? path.resolve(root, file) : path.resolve(file);
  if (config.blocked) return { file: full(config.file), error: config.blocked };
  for (const file of config.shadowFiles ?? []) {
    const entry = readNativeMcp(await readTextFile(file), config);
    if ("error" in entry) return { file: full(config.file), error: `${file}: ${entry.error}; review user/project precedence manually` };
    if (entry.value !== undefined && !isKitMcpEntry(entry.value, config.entryFormat, config.extra)) {
      return { file: full(config.file), error: `a personal Cavelon server in ${file} would be shadowed; review user/project precedence manually` };
    }
  }
  const found: Array<{ file: string; text: string; current: unknown; kept: number }> = [];
  for (const candidate of config.files) {
    const file = full(candidate);
    const text = await readTextFile(file);
    if (text === undefined) continue;
    const entry = readNativeMcp(text, config);
    if ("error" in entry) return { file, error: entry.error };
    found.push({ file, text, current: entry.value, kept: Math.min(entry.kept, config.keys.length - 1) });
  }
  const owners = found.filter(candidate => candidate.current !== undefined);
  if (owners.length > 1) return { file: owners.at(-1)!.file, error: `multiple configuration files define ${config.keys.join(".")}; resolve their precedence manually` };
  const selected = owners[0] ?? found.at(-1);
  return selected ?? { file: full(config.file), text: undefined, current: undefined, kept: 0 };
}
