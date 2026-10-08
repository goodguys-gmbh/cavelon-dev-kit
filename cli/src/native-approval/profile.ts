import { ompListPolicy } from "../omp-config.js";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readJsoncEntry } from "../jsonc-config.js";

export interface NativeProfile {
  /** Version 2 project paths resolve from the profile, so clones can move. */
  format?: 2;
  client: "opencode" | "pi" | "kilo" | "omp";
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
  /** A client with merged/remote settings can check its effective entry too. */
  entryHash?: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    // Confirmation binding uses ordinal keys, independent of the host's locale.
    const keys = Object.keys(value).toSorted((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const fields = keys.map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key]));
    return "{" + fields.join(",") + "}";
  }
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

/** A project integration cannot be reused as another workspace's UI owner. */
export async function assertNativeWorkspace(runtime: NativeRuntime, directory: string): Promise<void> {
  if (runtime.scope !== "project") return;
  if (!runtime.projectRoot || await fs.realpath(directory) !== await fs.realpath(runtime.projectRoot)) {
    throw new Error("Cavelon project integration requires its matching project workspace.");
  }
}

/** A verified project adapter takes precedence over the user's adapter. */
export async function hasNativeProjectOwner(runtime: NativeRuntime, client: NativeProfile["client"], directory: string): Promise<boolean> {
  if (runtime.scope !== "user") return false;
  const file = path.join(directory, `.${client}`, "cavelon", "profile.json");
  const present = await fs.stat(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
  if (!present) return false;
  const project = await loadNativeRuntime(file, client);
  if (project.scope !== "project") throw new Error("The project native profile does not own this project.");
  await assertNativeWorkspace(project, directory);
  return true;
}

/** Re-read the selected configuration; personal edits invalidate native ownership. */
function projectRootValid(profile: NativeProfile): boolean {
  if (profile.format === 2) return profile.scope === "project" && relativePath(profile.projectRoot);
  return profile.scope !== "project" || (typeof profile.projectRoot === "string" && path.isAbsolute(profile.projectRoot));
}

function relativePath(value: unknown): value is string {
  // Portable profiles use forward slashes and cannot contain drive-relative paths.
  return typeof value === "string" && Boolean(value.trim()) && !/[\0\\:]/.test(value) && !path.isAbsolute(value);
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function loadNativeRuntime(profileFile: string, client: NativeProfile["client"]): Promise<NativeRuntime> {
  let profile: NativeProfile;
  const profileText = await fs.readFile(profileFile, "utf8");
  try { profile = JSON.parse(profileText) as NativeProfile; }
  catch { throw new Error("Invalid Cavelon native profile; review it and repeat setup."); }
  if (!profile || ![undefined, 2].includes(profile.format)
    || profile.client !== client || typeof profile.version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(profile.version)
    || (profile.format === 2 ? !relativePath(profile.configFile) : typeof profile.configFile !== "string" || !path.isAbsolute(profile.configFile))
    || typeof profile.entryHash !== "string" || !/^[a-f0-9]{64}$/.test(profile.entryHash)
    || !["user", "project"].includes(profile.scope)
    || !projectRootValid(profile)) {
    throw new Error("Invalid Cavelon native profile; repeat cavelon setup or init.");
  }
  const base = path.dirname(await fs.realpath(profileFile));
  const projectRoot = profile.scope === "project" ? await fs.realpath(path.resolve(base, profile.projectRoot!)) : undefined;
  const configFile = path.resolve(base, profile.configFile);
  if (profile.format === 2 && !inside(projectRoot!, configFile)) throw new Error("Cavelon native configuration is outside its project.");
  const realConfig = await fs.realpath(configFile);
  if (profile.format === 2 && !inside(projectRoot!, realConfig)) throw new Error("Cavelon native configuration is outside its project.");
  const text = await fs.readFile(realConfig, "utf8");
  const commandArgs = client === "pi" || client === "omp";
  if (commandArgs) {
    try { JSON.parse(text); }
    catch { throw new Error(`The ${client === "pi" ? "Pi" : "OMP"} MCP configuration requires plain JSON; review it before native startup.`); }
  }
  if (client === "omp") { const policy = ompListPolicy(text); if (policy) throw new Error(policy); }
  const selected = readJsoncEntry(text, [commandArgs ? "mcpServers" : "mcp", "cavelon"]);
  if ("error" in selected || !selected.value || nativeEntryHash(selected.value) !== profile.entryHash) {
    throw new Error("The Cavelon MCP entry changed; review it and repeat setup before using native approval.");
  }
  const entry = selected.value as Record<string, unknown>;
  if (entry.enabled !== false || (!commandArgs && entry.type !== "local")) {
    throw new Error("Native approval must own only Cavelon; disable its duplicate built-in MCP entry.");
  }
  const words = !commandArgs ? entry.command : [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])];
  if (!Array.isArray(words) || !words.length || !words.every(word => typeof word === "string") || !words[0]
    || (commandArgs && !Array.isArray(entry.args))) throw new Error("Invalid Cavelon MCP process command.");
  const overrides = entry[!commandArgs ? "environment" : "env"];
  if (overrides !== undefined && (!overrides || typeof overrides !== "object" || Array.isArray(overrides)
    || Object.values(overrides).some(value => typeof value !== "string"))) throw new Error("Invalid Cavelon MCP environment.");
  const env = Object.fromEntries(Object.entries({ ...process.env, ...(overrides as Record<string, string> | undefined) }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return {
    version: profile.version, scope: profile.scope, entryHash: profile.entryHash, ...(projectRoot ? { projectRoot } : {}),
    runtimeDir: nativeRuntimeDirectory(profileFile), command: { command: words[0], args: words.slice(1), env },
  };
}
