import { ompConfig, ompDirectory, ompPolicy } from "./omp-config.js";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { parseTree, type ParseError } from "jsonc-parser";
import { readTextFile } from "./fsutil.js";
import { readJsoncEntry } from "./jsonc-config.js";
import { readYamlEntry } from "./yaml-config.js";
import { isKitMcpEntry, type McpEntryFormat } from "./mcp-entry.js";
import { homeDir } from "./paths.js";

type Env = Record<string, string | undefined>;

export interface NativeMcpConfig {
  client: "opencode" | "pi" | "qwen" | "cline" | "kilo" | "goose" | "omp";
  format: "native";
  file: string;
  /** Low to high precedence; never create a companion when one already exists. */
  files: string[];
  /** A personal user entry must not be silently shadowed by a new project entry. */
  shadowFiles?: string[];
  /** Read-only operator settings that must not be silently overridden. */
  managedFiles?: string[];
  /** Compatible configs are inspected but belong to another client. */
  compatibilityFiles?: string[];
  /** Opaque operator policies cannot be safely merged by file setup. */
  managedOpaqueFiles?: string[];
  syntax: "json" | "jsonc" | "json-comments" | "yaml";
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

function gooseConfigDir(env: Env, platform: NodeJS.Platform): string {
  if (env.GOOSE_PATH_ROOT && path.isAbsolute(env.GOOSE_PATH_ROOT)) return path.join(env.GOOSE_PATH_ROOT, "config");
  const home = homeDir(env);
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Block", "goose", "config");
  const xdg = env.XDG_CONFIG_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".config"), "goose");
}

function gooseAdditionalPaths(value: string | undefined, platform: NodeJS.Platform): string[] {
  if (value === undefined) return [];
  // Rust split_paths strips Windows quotes and splits only outside them.
  const paths: string[] = [];
  let segment = "";
  let quoted = false;
  const separator = platform === "win32" ? ";" : ":";
  for (const char of value) {
    if (platform === "win32" && char === '"') quoted = !quoted;
    else if (char === separator && !quoted) { paths.push(segment); segment = ""; }
    else segment += char;
  }
  paths.push(segment);
  return paths;
}

function gooseUser(env: Env, platform: NodeJS.Platform = process.platform): ReturnType<NativeClient["user"]> {
  const dir = gooseConfigDir(env, platform);
  const system = platform === "win32" ? path.join(env.PROGRAMDATA || String.raw`C:\ProgramData`, "goose", "config.yaml") : "/etc/goose/config.yaml";
  const additional = gooseAdditionalPaths(env.GOOSE_ADDITIONAL_CONFIG_FILES, platform);
  const file = path.join(dir, "config.yaml");
  let blocked: string | undefined;
  if (additional.some(file => !file)) blocked = "GOOSE_ADDITIONAL_CONFIG_FILES contains an empty path; review it before setup";
  else if (env.GOOSE_ALLOWLIST) blocked = "Goose's extension allowlist is active; ask the operator to review Cavelon's binding in that policy";
  return {
    mcp: { client: "goose", format: "native", file, files: [file], syntax: "yaml", keys: ["extensions", "cavelon"], entryFormat: "goose-stdio",
      extra: { type: "stdio", name: "cavelon", enabled: true }, managedFiles: [...new Set([system, ...additional])], ...(blocked ? { blocked } : {}) },
    skills: path.join(dir, "skills"), folders: [dir],
  };
}

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
export function hasNativeApprovalAdapter(config: NativeMcpConfig): config is NativeMcpConfig & { client: "opencode" | "pi" | "kilo" | "omp" } {
  return config.client === "opencode" || config.client === "pi" || config.client === "kilo" || config.client === "omp";
}

const kiloNames = ["kilo.json", "kilo.jsonc", "opencode.json", "opencode.jsonc"];
const kiloFiles = (dir: string) => kiloNames.map(name => path.join(dir, name));
const kiloCompatibility = (files: string[]) => files.filter(file => ["opencode.json", "opencode.jsonc"].includes(path.basename(file)));

async function kiloAncestorFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  let dir = path.resolve(root);
  while (path.dirname(dir) !== dir && !await fs.stat(path.join(dir, ".git")).then(() => true, () => false)) {
    dir = path.dirname(dir);
    files.push(...kiloFiles(dir), ...kiloFiles(path.join(dir, ".kilocode")), ...kiloFiles(path.join(dir, ".kilo")));
  }
  return files;
}

function kiloUser(env: Env) {
  const home = (env.KILO_TEST_HOME ?? homeDir(env)).trim();
  // Kilo uses xdg-basedir on every platform and removes CR/LF from its paths.
  const xdg = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(homeDir(env), ".config");
  const global = path.join(xdg.replace(/[\r\n]/g, ""), "kilo");
  const dir = env.KILO_CONFIG_DIR || global;
  const files = [...new Set([path.join(global, "config.json"), ...kiloFiles(global), ...(env.KILO_CONFIG ? [env.KILO_CONFIG] : []),
    ...kiloFiles(path.join(home, ".kilocode")), ...kiloFiles(path.join(home, ".kilo")), ...(dir !== global ? kiloFiles(dir) : [])])];
  return { dir, global, files, compatibilityFiles: kiloCompatibility(files) };
}

function kiloConfig(file: string, files: string[], env: Env, platform: NodeJS.Platform, blocked?: string): NativeMcpConfig {
  const managed = env.KILO_TEST_MANAGED_CONFIG_DIR || (platform === "darwin" ? "/Library/Application Support/kilo"
    : platform === "win32" ? path.join(env.ProgramData || "C:\\ProgramData", "kilo") : "/etc/kilo");
  return {
    client: "kilo", format: "native", file, files, syntax: "jsonc", keys: ["mcp", "cavelon"], entryFormat: "command-array", extra: { type: "local" },
    compatibilityFiles: kiloCompatibility(files), managedFiles: kiloFiles(managed),
    managedOpaqueFiles: platform === "darwin" ? [path.join("/Library/Managed Preferences", os.userInfo().username, "ai.opencode.managed.plist"),
      "/Library/Managed Preferences/ai.opencode.managed.plist"] : [],
    ...(blocked ? { blocked } : env.KILO_CONFIG_CONTENT ? { blocked: "KILO_CONFIG_CONTENT overrides file settings; configure Cavelon in that managed configuration" } : {}),
  };
}

function openCodeUserFiles(env: Env): string[] {
  const dir = path.join(env.XDG_CONFIG_HOME || path.join(homeDir(env), ".config"), "opencode");
  return [path.join(dir, "config.json"), path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc"), ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : [])];
}

export const NATIVE_CLIENTS: NativeClient[] = [
  {
    name: "omp", label: "OMP (Oh My Pi)", aliases: ["oh-my-pi", "ohmypi"], commands: ["omp"], projectSkills: [".omp/skills"],
    project: (env = {}) => ompConfig(env, true),
    user: env => {
      const { directory } = ompDirectory(env);
      return { mcp: ompConfig(env), skills: path.join(directory, "skills"), folders: [directory] };
    },
    notes: [
      "OMP is a separate client from Pi. Setup follows OMP_PROFILE / PI_PROFILE, PI_CONFIG_DIR and its default PI_CODING_AGENT_DIR override; use the same profile environment when launching OMP.",
      "Setup installs an owned native autoload extension without rewriting YAML or legacy settings. It disables only the duplicate Cavelon MCP entry and preserves compatible client bindings and deny/force-enable policies.",
      "The native TUI asks the person afresh for each guarded change. Print/RPC modes return an exact command for the person's own terminal. Launch OMP with CAVELON_AGENT=1; file checks cannot qualify actual UI loading or custom extension policies.",
    ],
  },
  {
    name: "goose", label: "Goose", aliases: ["goose-cli"], commands: ["goose"], projectSkills: [],
    project: () => undefined, user: gooseUser,
    notes: [
      "Goose uses user YAML extension settings and native skills; project init copies .agents/skills only. Run cavelon setup --agents goose for the MCP entry. System and additional config layers are inspected without overriding their Cavelon binding. Keep GOOSE_PATH_ROOT, XDG_CONFIG_HOME and GOOSE_ADDITIONAL_CONFIG_FILES the same for setup and the client.",
      "Goose CLI's interactive MCP form can ask the person for the exact change; headless clients must refuse or return the person's terminal route. Automatic tool permissions cannot answer that form. Launch Goose with CAVELON_AGENT=1 to guard shells in modes that do not set a session marker. Actual UI qualification is separate from setup checks.",
    ],
  },
  {
    name: "kilo", label: "Kilo CLI / current VS Code extension", aliases: ["kilocode", "kilo-code"], commands: ["kilo", "kilocode"], projectSkills: [".kilo/skills"],
    project: (env = {}) => ({ ...kiloConfig("kilo.json", [...kiloFiles("."), ...kiloFiles(".kilocode"), ...kiloFiles(".kilo")], env, process.platform,
      env.KILO_DISABLE_PROJECT_CONFIG === "true" || env.KILO_DISABLE_PROJECT_CONFIG === "1" ? "Kilo project configuration is disabled" :
        env.KILO_CONFIG_DIR ? "KILO_CONFIG_DIR may override project settings; use user setup for that directory" : undefined), shadowFiles: kiloUser(env).files }),
    user: (env, platform = process.platform) => {
      const { dir, global, files } = kiloUser(env);
      return { mcp: kiloConfig(env.KILO_CONFIG || path.join(dir, "kilo.json"), files, env, platform), skills: path.join(dir, "skills"), folders: [...new Set([global, dir])] };
    },
    notes: [
      "Kilo CLI and current VS Code extension 7.8.8 use Kilo's own MCP settings and skills. Compatible OpenCode files are inspected and preserved; setup does not migrate another client's binding.",
      "Setup installs separate Kilo server/TUI plugins and disables only the duplicate Cavelon MCP entry. CLI TUI approval requires a fresh person dialog; the editor and headless modes return a command for the person's own terminal.",
      "Start Kilo with CAVELON_AGENT=1 scoped to its process, including a fresh VS Code process for the editor. A separate person's terminal must not inherit that marker. Check effective cloud/organization policies in Kilo; file checks cannot certify remote settings or actual UI loading.",
    ],
  },
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
  if (config.syntax === "yaml") return readYamlEntry(text, config.keys);
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

function gooseExtensionName(key: string, value: unknown): { cavelon: boolean; conflicting: boolean } {
  const name = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).name : undefined;
  const equivalent = (name: string) => name.replace(/\s/g, "").toLowerCase() === "cavelon";
  const cavelon = equivalent(key) || (typeof name === "string" && equivalent(name));
  return { cavelon, conflicting: key !== "cavelon" || (name !== undefined && name !== "cavelon") };
}

function gooseExtensionsPolicy(value: unknown, managed: boolean, file: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `the extensions in ${file} are not a mapping; review them manually`;
  for (const [key, entry] of Object.entries(value)) {
    const name = gooseExtensionName(key, entry);
    if (!name.cavelon) continue;
    if (managed) return `a system or additional Cavelon extension in ${file} is preserved; review its binding with the operator`;
    if (name.conflicting) return `another Cavelon extension name in ${file} would conflict; review that binding manually`;
  }
  return undefined;
}

async function goosePolicy(config: NativeMcpConfig, full: (file: string) => string): Promise<string | undefined> {
  for (const candidate of new Set([...(config.managedFiles ?? []), ...config.files])) {
    const file = full(candidate);
    const text = await readTextFile(file);
    if (text === undefined) continue;
    const extensions = readYamlEntry(text, ["extensions"]);
    if ("error" in extensions) return `${file}: ${extensions.error}`;
    const error = gooseExtensionsPolicy(extensions.value, config.managedFiles?.includes(candidate) ?? false, file);
    if (error) return error;
    const allowlist = readYamlEntry(text, ["GOOSE_ALLOWLIST"]);
    if ("error" in allowlist) return `${file}: ${allowlist.error}`;
    if (allowlist.value) return `Goose's extension allowlist in ${file} requires operator review before Cavelon setup`;
  }
  return undefined;
}

/** Refuse duplicate effective entries instead of guessing which a merged client config uses. */
export async function resolveNativeMcp(config: NativeMcpConfig, root?: string): Promise<
  { file: string; text: string | undefined; current: unknown; kept: number } | { file: string; error: string }
> {
  const full = (file: string) => root ? path.resolve(root, file) : path.resolve(file);
  if (config.blocked) return { file: full(config.file), error: config.blocked };
  if (config.client === "omp") {
    const error = await ompPolicy(config, full);
    if (error) return { file: full(config.file), error };
  }
  if (config.client === "goose") {
    const error = await goosePolicy(config, full);
    if (error) return { file: full(config.file), error };
  }
  if (config.client === "kilo") {
    for (const file of config.managedOpaqueFiles ?? []) {
      if (await readTextFile(file) !== undefined) return { file: full(config.file), error: `managed preferences in ${file} may override Cavelon; review the binding with the operator` };
    }
    for (const candidate of [...(config.managedFiles ?? []), ...(config.compatibilityFiles ?? [])]) {
      const file = full(candidate);
      const selected = readNativeMcp(await readTextFile(file), config);
      if ("error" in selected) return { file, error: selected.error };
      if (selected.value !== undefined) return { file, error: `a managed or OpenCode-compatible Cavelon server in ${file} is preserved; review its binding before Kilo setup` };
    }
    if (root) for (const file of await kiloAncestorFiles(root)) {
      const selected = readNativeMcp(await readTextFile(file), config);
      if ("error" in selected) return { file, error: selected.error };
      if (selected.value !== undefined) return { file, error: `an inherited Cavelon server in ${file} would be shadowed; review its binding before project setup` };
    }
  }
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
    if (config.compatibilityFiles?.includes(candidate)) continue;
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
