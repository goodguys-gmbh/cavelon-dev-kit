import path from "node:path";
import { homeDir } from "./paths.js";
import { readTextFile } from "./fsutil.js";
import { readJsoncEntry } from "./jsonc-config.js";
import type { NativeMcpConfig } from "./native-clients.js";

type Env = Record<string, string | undefined>;

/** Released OMP profiles derive an agent directory; a named profile ignores the default override. */
export function ompDirectory(env: Env): { directory: string; blocked?: string } {
  const home = homeDir(env);
  const root = path.join(home, env.PI_CONFIG_DIR || ".omp");
  const profile = (env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE)?.trim();
  if (profile && profile !== "default") {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) || profile === ".." || profile.endsWith(".") || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i.test(profile)) {
      return { directory: path.join(root, "agent"), blocked: "Invalid OMP profile; select a valid profile before setup." };
    }
    return { directory: path.join(root, "profiles", profile, "agent") };
  }
  return { directory: env.PI_CODING_AGENT_DIR ? path.resolve(env.PI_CODING_AGENT_DIR) : path.join(root, "agent") };
}

const nativeFiles = (directory: string) => [path.join(directory, "mcp.json"), path.join(directory, ".mcp.json")];
const compatibleFiles = (directory: string) => [
  ".claude.json", ".mcp.json", "mcp.json", ".claude/.mcp.json", ".cursor/mcp.json", ".vscode/mcp.json",
  ".gemini/settings.json", ".qwen/settings.json", ".opencode/opencode.json", ".opencode/opencode.jsonc",
  "opencode.json", "opencode.jsonc", ".codex/config.toml",
].map(file => path.join(directory, file));

export function ompConfig(env: Env, project = false): NativeMcpConfig {
  const user = ompDirectory(env);
  const directory = project ? ".omp" : user.directory;
  return {
    client: "omp", format: "native", file: path.join(directory, "mcp.json"), files: nativeFiles(directory),
    syntax: "json", keys: ["mcpServers", "cavelon"], entryFormat: "command-args", extra: {},
    compatibilityFiles: compatibleFiles(project ? "." : homeDir(env)),
    ...(project ? { shadowFiles: nativeFiles(user.directory), managedFiles: [path.join(user.directory, "mcp.json")] } : {}),
    ...(user.blocked ? { blocked: user.blocked } : {}),
  };
}

/** User deny/force-enable lists must never be bypassed by the native adapter. */
export function ompListPolicy(text: string | undefined): string | undefined {
  for (const key of ["disabledServers", "enabledServers"]) {
    const selected = readJsoncEntry(text, [key]);
    if ("error" in selected) return selected.error;
    if (selected.value === undefined) continue;
    if (!Array.isArray(selected.value) || !selected.value.every(value => typeof value === "string")) return `The OMP ${key} policy is invalid; review it manually.`;
    if (selected.value.includes("cavelon")) return `The OMP ${key} policy names Cavelon; review it in OMP before native setup.`;
  }
  return undefined;
}

export async function ompPolicy(config: NativeMcpConfig, full: (file: string) => string): Promise<string | undefined> {
  for (const file of new Set([...(config.managedFiles ?? []), ...config.files.map(full)])) {
    const error = ompListPolicy(await readTextFile(file));
    if (error) return `${file}: ${error}`;
  }
  for (const candidate of config.compatibilityFiles ?? []) {
    const file = full(candidate);
    const error = compatiblePolicy(await readTextFile(file), file);
    if (error) return error;
  }
  return undefined;
}

function compatiblePolicy(text: string | undefined, file: string): string | undefined {
  if (text === undefined) return undefined;
  if (file.endsWith(".toml")) {
    return /cavelon/i.test(text) ? `A compatible Cavelon binding may exist in ${file}; inspect its TOML before OMP setup.` : undefined;
  }
  for (const key of ["mcpServers", "mcp", "servers"]) {
    const selected = readJsoncEntry(text, [key, "cavelon"]);
    if ("error" in selected) return `${file}: ${selected.error}`;
    if (selected.value !== undefined) return `A compatible Cavelon server in ${file} is preserved; review that binding before OMP setup.`;
  }
  return undefined;
}
