import path from "node:path";
import { parseTree, type ParseError } from "jsonc-parser";
import { readTextFile } from "./fsutil.js";
import { readJsoncEntry } from "./jsonc-config.js";
import { isKitMcpEntry, type McpEntryFormat } from "./mcp-entry.js";
import { homeDir } from "./paths.js";

type Env = Record<string, string | undefined>;

export interface NativeMcpConfig {
  client: "opencode" | "pi" | "qwen" | "cline";
  format: "native";
  file: string;
  /** Low to high precedence; never create a companion when one already exists. */
  files: string[];
  /** A personal user entry must not be silently shadowed by a new project entry. */
  shadowFiles?: string[];
  /** Read-only operator settings that must not be silently overridden. */
  managedFiles?: string[];
  syntax: "json" | "jsonc" | "json-comments";
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
  project(env?: Env): NativeMcpConfig | undefined;
  user(env: Env, platform?: NodeJS.Platform): { mcp: NativeMcpConfig; skills: string; folders: string[] };
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

function clineUser(env: Env): ReturnType<NativeClient["user"]> {
  const candidate = env.HOME?.trim();
  const profile = env.USERPROFILE?.trim() || (env.HOMEDRIVE?.trim() && env.HOMEPATH?.trim() ? `${env.HOMEDRIVE.trim()}${env.HOMEPATH.trim()}` : undefined);
  const home = homeDir({ HOME: candidate && candidate !== "~" ? candidate : undefined, USERPROFILE: profile });
  const dir = env.CLINE_DIR?.trim() || path.join(home, ".cline");
  const data = env.CLINE_DATA_DIR?.trim() || path.join(dir, "data");
  const file = env.CLINE_MCP_SETTINGS_PATH?.trim() || path.join(data, "settings", "cline_mcp_settings.json");
  return {
    mcp: { client: "cline", format: "native", file, files: [file], syntax: "json", keys: ["mcpServers", "cavelon"], entryFormat: "command-args", extra: { type: "stdio" } },
    skills: path.join(dir, "skills"), folders: [...new Set([dir, data])],
  };
}

function qwenDir(env: Env): string {
  const raw = env.QWEN_HOME;
  if (!raw) return path.join(homeDir(env), ".qwen");
  const expanded = raw === "~" ? homeDir(env) : raw.startsWith("~/") || raw.startsWith("~\\")
    ? path.join(homeDir(env), ...raw.slice(2).split(/[/\\]+/)) : raw;
  return path.resolve(expanded);
}

function qwenManagedFiles(env: Env, platform: NodeJS.Platform): string[] {
  const system = env.QWEN_CODE_SYSTEM_SETTINGS_PATH || (platform === "darwin" ? "/Library/Application Support/QwenCode/settings.json"
    : platform === "win32" ? "C:\\ProgramData\\qwen-code\\settings.json" : "/etc/qwen-code/settings.json");
  return [env.QWEN_CODE_SYSTEM_DEFAULTS_PATH || path.join(path.dirname(system), "system-defaults.json"), system];
}

const qwenConfig = (file: string, env: Env, platform = process.platform): NativeMcpConfig => ({
  client: "qwen", format: "native", file, files: [file], syntax: "json-comments", keys: ["mcpServers", "cavelon"],
  entryFormat: "command-args", extra: {}, managedFiles: qwenManagedFiles(env, platform),
});

/** A native configuration format does not imply a person-dialog adapter. */
export function hasNativeApprovalAdapter(config: NativeMcpConfig): config is NativeMcpConfig & { client: "opencode" | "pi" } {
  return config.client === "opencode" || config.client === "pi";
}

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
    notes: ["Setup installs separate native OpenCode server/TUI plugins and disables only its duplicate Cavelon MCP entry. Guarded changes require a fresh person dialog; missing UI returns a command for the person's own terminal. File checks do not certify actual UI loading."],
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
      "Setup installs the native Cavelon extension and disables only its duplicate built-in MCP entry. Guarded changes require a fresh person dialog; missing UI returns a command for the person's own terminal. File checks do not certify actual UI loading.",
    ],
  },
  {
    name: "qwen", label: "Qwen Code CLI", aliases: ["qwen-code", "qwen-cli"], commands: ["qwen"], projectSkills: [".qwen/skills"],
    project: (env = {}) => ({ ...qwenConfig(".qwen/settings.json", env), shadowFiles: [path.join(qwenDir(env), "settings.json")] }),
    user: (env, platform = process.platform) => {
      const dir = qwenDir(env);
      return { mcp: qwenConfig(path.join(dir, "settings.json"), env, platform), skills: path.join(dir, "skills"), folders: [dir] };
    },
    notes: [
      "Qwen Code CLI 0.25.0 reads native Cavelon skills and MCP settings; project settings depend on project trust. System MCP policies and personal servers are preserved.",
      "This client does not advertise MCP form elicitation. Guarded changes return a preview and a command for the person's own terminal; tool permission approval and automatic modes cannot confirm the Cavelon change.",
    ],
  },
  {
    name: "cline", label: "Cline CLI / current VS Code extension", aliases: ["cline-cli", "cline-vscode"], commands: ["cline"], projectSkills: [".cline/skills"],
    project: () => undefined,
    user: clineUser,
    notes: [
      "Cline CLI 3.0.70 and VS Code extension 4.1.23 use shared user MCP settings; project init copies native skills only. Run cavelon setup --agents cline for the MCP entry. Older editor profiles and other surfaces require separate verification.",
      "Set the same absolute CLINE_DIR, CLINE_DATA_DIR and CLINE_MCP_SETTINGS_PATH overrides for setup and the CLI. Mirror CLI --config / --data-dir in setup's environment. The editor's compatibility UI retains legacy path handling: use default shared paths and check its settings and skills independently. Setup does not migrate older editor profiles.",
      "This client's MCP transport does not advertise form elicitation. Guarded changes return an exact command for the person's own terminal; automatic tool approval cannot confirm the change. Launch the coding client with CAVELON_AGENT=1 so its shell commands keep the kit's person-only guards.",
    ],
  },
];

export const nativeClient = (name: string): NativeClient | undefined => NATIVE_CLIENTS.find(client => client.name === name || client.aliases.includes(name));

export function readNativeMcp(text: string | undefined, config: NativeMcpConfig): ReturnType<typeof readJsoncEntry> {
  if (text !== undefined && config.syntax === "json") {
    try { JSON.parse(text); } catch { return { error: "this client requires plain JSON; correct the file before setup" }; }
  }
  if (text !== undefined && config.syntax === "json-comments") {
    const errors: ParseError[] = [];
    parseTree(text, errors, { allowTrailingComma: false });
    if (errors.length) return { error: "this client accepts JSON comments but not trailing commas; correct the file before setup" };
  }
  return readJsoncEntry(text, config.keys);
}

function serverMatches(pattern: string): boolean {
  // Qwen's policies accept only * and ? globs, not arbitrary regular expressions.
  let positions = new Set([0]);
  for (const char of pattern) {
    const next = new Set<number>();
    for (const at of positions) {
      if (char === "*") for (let end = at; end <= "cavelon".length; end++) next.add(end);
      else if (at < "cavelon".length && (char === "?" || char === "cavelon"[at])) next.add(at + 1);
    }
    positions = next;
  }
  return positions.has("cavelon".length);
}

async function qwenPolicy(config: NativeMcpConfig, full: (file: string) => string): Promise<string | undefined> {
  for (const file of new Set([...(config.managedFiles ?? []), ...(config.shadowFiles ?? []), ...config.files.map(full)])) {
    const text = await readTextFile(file);
    if (text === undefined) continue;
    const parsed = readNativeMcp(text, config);
    if ("error" in parsed) return `${file}: ${parsed.error}`;
    if (config.managedFiles?.includes(file) && parsed.value !== undefined) return `managed settings in ${file} define Cavelon; review that binding with the operator instead of writing another entry`;
    const policy = readJsoncEntry(text, ["mcp"]);
    if ("error" in policy) return `${file}: ${policy.error}`;
    if (policy.value === undefined) continue;
    if (!policy.value || typeof policy.value !== "object" || Array.isArray(policy.value)) return `the MCP policy in ${file} is invalid; review it manually`;
    const settings = policy.value as Record<string, unknown>;
    for (const key of ["allowed", "excluded"]) {
      const patterns = settings[key];
      if (patterns === undefined) continue;
      if (!Array.isArray(patterns) || !patterns.every(pattern => typeof pattern === "string")) return `the MCP ${key} policy in ${file} is invalid; review it manually`;
      const matches = patterns.some(serverMatches);
      if (key === "allowed" ? !matches : matches) return `the MCP ${key} policy in ${file} prevents Cavelon; ask the person or operator to review it`;
    }
  }
  return undefined;
}

/** Refuse duplicate effective entries instead of guessing which a merged client config uses. */
export async function resolveNativeMcp(config: NativeMcpConfig, root?: string): Promise<
  { file: string; text: string | undefined; current: unknown; kept: number } | { file: string; error: string }
> {
  const full = (file: string) => root ? path.resolve(root, file) : path.resolve(file);
  if (config.blocked) return { file: full(config.file), error: config.blocked };
  if (config.client === "qwen") {
    const error = await qwenPolicy(config, full);
    if (error) return { file: full(config.file), error };
  }
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
