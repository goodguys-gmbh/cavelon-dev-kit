import { promises as fs } from "node:fs";
import path from "node:path";
import { bundledSkills, generatedCopy, INSTALLED_MCP_COMMAND, mcpCommand, type Skill } from "./agents.js";
import { readJsonFile, readTextFile, writeFileAtomic } from "./fsutil.js";
import { findProgram } from "./git.js";
import { isGenerated, removeBlock, removeJsonEntry, upsertBlock, upsertJsonEntry, type BlockResult } from "./markers.js";
import { cacheDir, homeDir } from "./paths.js";
import { runProgram } from "./run-program.js";
import { KIT_VERSION } from "./version.js";

/**
 * The coding agents `cavelon setup` sets up for the person, at user level:
 * through the agent's own plugin command where it installs without asking
 * (Claude Code, Codex, and Gemini CLI from the release's extension), otherwise
 * with the `cavelon` MCP server in the agent's user MCP configuration and the
 * skills in its user skills folder. Cursor, VS Code and Kiro keep the files:
 * their plugins install only through their own window (Cursor, and VS Code,
 * where plugins are off until a setting turns them on), or load only when a
 * prompt names the power's keywords (Kiro), while the files always work.
 * Every change is one the kit can find and undo again: a JSON entry it
 * recognises as its own, a TOML block between its markers, skill files marked
 * as generated, a plugin it installed. Where each agent keeps these is in its own documentation, cited
 * in docs/installation.md.
 */

type Env = Record<string, string | undefined>;

/** The marketplace in this repository, as both clients name it. */
export const MARKETPLACE_SOURCE = "goodguys-gmbh/cavelon-dev-kit";
export const MARKETPLACE = "cavelon-dev-kit";
export const PLUGIN_ID = "cavelon@cavelon-dev-kit";
/** Gemini CLI installs extensions from a GitHub repository's release, by the tag. */
export const GEMINI_EXTENSION = "cavelon";
export const GEMINI_SOURCE = `https://github.com/${MARKETPLACE_SOURCE}`;

type PluginKind = "claude" | "codex" | "gemini";

export type McpFile =
  | { file: string; format: "json"; keys: string[]; extra: Record<string, unknown> }
  | { file: string; format: "toml" };

export interface SetupAgent {
  name: string;
  label: string;
  /** Commands on PATH that show the agent is installed; the first one runs its plugin commands. */
  commands: string[];
  /** User folders that show it is installed. */
  folders: string[];
  /** The agent installs plugins itself. */
  plugin?: PluginKind;
  /** Its user-level MCP configuration. */
  mcp: McpFile;
  /** Its user-level skills folder. */
  skills: string;
}

/** Where VS Code keeps the default profile's user settings. */
function vscodeUserDir(env: Env, platform: NodeJS.Platform): string {
  const home = homeDir(env);
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Code", "User");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Code", "User");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Code", "User");
}

const json = (file: string, key = "mcpServers", extra: Record<string, unknown> = {}): McpFile => ({ file, format: "json", keys: [key, "cavelon"], extra });

/** Gemini CLI's user folder. */
function geminiHome(env: Env): string {
  return path.join(env.GEMINI_CLI_HOME || homeDir(env), ".gemini");
}

export function setupAgents(env: Env, platform: NodeJS.Platform = process.platform): SetupAgent[] {
  const home = homeDir(env);
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  const codexDir = env.CODEX_HOME || path.join(home, ".codex");
  const geminiDir = geminiHome(env);
  const vscode = vscodeUserDir(env, platform);
  return [
    {
      name: "claude",
      label: "Claude Code",
      commands: ["claude"],
      folders: [claudeDir],
      plugin: "claude",
      // User-scope servers live in .claude.json, beside the folder or inside CLAUDE_CONFIG_DIR.
      mcp: json(env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(home, ".claude.json")),
      skills: path.join(claudeDir, "skills"),
    },
    {
      name: "codex",
      label: "Codex",
      commands: ["codex"],
      folders: [codexDir],
      plugin: "codex",
      mcp: { file: path.join(codexDir, "config.toml"), format: "toml" },
      skills: path.join(home, ".agents", "skills"),
    },
    {
      name: "cursor",
      label: "Cursor",
      commands: ["cursor", "cursor-agent"],
      folders: [path.join(home, ".cursor")],
      mcp: json(path.join(home, ".cursor", "mcp.json")),
      skills: path.join(home, ".cursor", "skills"),
    },
    {
      name: "copilot",
      label: "VS Code with GitHub Copilot",
      commands: ["code"],
      folders: [vscode],
      mcp: json(path.join(vscode, "mcp.json"), "servers", { type: "stdio" }),
      skills: path.join(home, ".copilot", "skills"),
    },
    {
      name: "gemini",
      label: "Gemini CLI",
      commands: ["gemini"],
      folders: [geminiDir],
      plugin: "gemini",
      mcp: json(path.join(geminiDir, "settings.json")),
      skills: path.join(geminiDir, "skills"),
    },
    {
      name: "kiro",
      label: "Kiro",
      commands: ["kiro", "kiro-cli"],
      folders: [path.join(home, ".kiro")],
      mcp: json(path.join(home, ".kiro", "settings", "mcp.json")),
      skills: path.join(home, ".kiro", "skills"),
    },
  ];
}

const ALIASES: Record<string, string> = { "claude-code": "claude", vscode: "copilot", "vs-code": "copilot", "gemini-cli": "gemini", "cursor-agent": "cursor" };

export function agentByName(agents: SetupAgent[], raw: string): SetupAgent | undefined {
  const name = raw.trim().toLowerCase();
  return agents.find((a) => a.name === (ALIASES[name] ?? name));
}

// ---------------------------------------------------------------------------
// Finding an agent
// ---------------------------------------------------------------------------

/** Windows installs an agent's command as an executable or as npm's batch file. */
const WINDOWS_EXTENSIONS = [".exe", ".cmd", ".bat"];

export interface Found {
  /** The agent's command, when it is on PATH. */
  program?: string;
  /** The user folder that is there. */
  folder?: string;
}

export async function findAgent(agent: SetupAgent, env: Env, platform: NodeJS.Platform = process.platform): Promise<Found> {
  const found: Found = {};
  for (const command of agent.commands) {
    found.program = await findProgram(command, env, platform, WINDOWS_EXTENSIONS);
    if (found.program) break;
  }
  for (const folder of agent.folders) {
    if (await isDirectory(folder)) {
      found.folder = folder;
      break;
    }
  }
  return found;
}

async function isDirectory(dir: string): Promise<boolean> {
  return fs.stat(dir).then((st) => st.isDirectory(), () => false);
}

// ---------------------------------------------------------------------------
// The MCP server's command
// ---------------------------------------------------------------------------

export interface ServerCommand {
  command: string;
  args: string[];
}

/**
 * How an agent starts the server: the installed `cavelon` when it is on PATH
 * (the standalone executable on Windows, which starts without a shell),
 * otherwise the release line through npx, as the plugin does.
 */
export async function serverCommand(env: Env, platform: NodeJS.Platform = process.platform): Promise<ServerCommand> {
  return (await findProgram("cavelon", env, platform, [".exe"])) ? INSTALLED_MCP_COMMAND : mcpCommand(platform);
}

/** Every form of the entry the kit writes, on any system: the kit's own, and so its to replace or remove. */
function knownCommands(): ServerCommand[] {
  return [INSTALLED_MCP_COMMAND, mcpCommand("linux"), mcpCommand("win32")];
}

function jsonEntry(mcp: Extract<McpFile, { format: "json" }>, command: ServerCommand): Record<string, unknown> {
  return { ...mcp.extra, command: command.command, args: command.args };
}

function isOwnJsonEntry(mcp: Extract<McpFile, { format: "json" }>, value: unknown): boolean {
  return knownCommands().some((c) => JSON.stringify(jsonEntry(mcp, c)) === JSON.stringify(value));
}

function tomlBlock(command: ServerCommand): string {
  return ["[mcp_servers.cavelon]", `command = ${JSON.stringify(command.command)}`, `args = [${command.args.map((a) => JSON.stringify(a)).join(", ")}]`].join("\n");
}

/** A `[mcp_servers.cavelon]` table outside the kit's block: the person's own, which a second table would break. */
function hasOwnTomlServer(text: string): boolean {
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "# cavelon:begin") inBlock = true;
    else if (trimmed === "# cavelon:end") inBlock = false;
    else if (!inBlock && /^\[\s*mcp_servers\s*\.\s*"?cavelon"?\s*\]/.test(trimmed)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// What setup did, so --remove undoes exactly that
// ---------------------------------------------------------------------------

export interface FileRecord {
  file: string;
  /** The kit created the file; removing its entry removes the file when nothing else is left. */
  created: boolean;
  /** How many of the entry's keys the file had before (JSON). */
  kept?: number;
  /** The topmost folder the kit created for the file, removed again when empty. */
  created_dir?: string;
}

export interface AgentRecord {
  marketplace_added?: boolean;
  plugin_installed?: boolean;
  mcp?: FileRecord;
  skills?: { dir: string; created_dir?: string };
}

export interface SetupState {
  agents: Record<string, AgentRecord>;
}

// ---------------------------------------------------------------------------
// One change, planned and applied
// ---------------------------------------------------------------------------

export type ChangeKind = "plugin" | "marketplace" | "mcp" | "skills";

export interface Change {
  kind: ChangeKind;
  /** For a person: what changes, in plain words. */
  summary: string;
  /** The file or folder it changes, or the command it runs. */
  target: string;
  outcome: "planned" | "done" | "unchanged" | "skipped" | "failed" | "removed";
  reason?: string;
}

export interface AgentPlan {
  agent: SetupAgent;
  found: Found;
  /** "plugin": the agent's own plugin command; "files": its MCP configuration and skills folder. */
  method: "plugin" | "files";
  changes: Change[];
  /** The plugin's state, read from the agent (plugin method). */
  plugin?: { marketplace: boolean; installed: boolean; enabled: boolean };
}

const RUN_TIMEOUT_MS = 180_000;
const LIST_TIMEOUT_MS = 60_000;

function display(program: string, args: string[]): string {
  return [path.basename(program).replace(/\.(exe|cmd|bat)$/i, ""), ...args].join(" ");
}

/** The plugin's state as the agent reports it, or why it could not be read. */
async function pluginState(kind: PluginKind, program: string, env: Env): Promise<{ marketplace: boolean; installed: boolean; enabled: boolean } | { error: string }> {
  const read = async (args: string[]): Promise<{ value: unknown } | { error: string }> => {
    const result = await runProgram(program, args, { env, timeoutMs: LIST_TIMEOUT_MS });
    if (result.code !== 0) return { error: result.error ?? `\`${display(program, args)}\` failed: ${firstLine(result.stderr || result.stdout)}` };
    try {
      return { value: JSON.parse(result.stdout) as unknown };
    } catch {
      return { error: `\`${display(program, args)}\` did not answer in JSON` };
    }
  };
  if (kind === "gemini") {
    // Read where Gemini CLI's docs keep extensions: `extensions list` writes its JSON to stderr, cut off at 64 KiB through a pipe.
    const manifest = await readJsonFile<{ name?: unknown }>(path.join(geminiHome(env), "extensions", GEMINI_EXTENSION, "gemini-extension.json"));
    // Gemini CLI has no marketplace: the extension names its source itself.
    return { marketplace: true, installed: manifest?.name === GEMINI_EXTENSION, enabled: true };
  }
  const plugins = await read(["plugin", "list", "--json"]);
  if ("error" in plugins) return { error: plugins.error };
  const markets = await read(["plugin", "marketplace", "list", "--json"]);
  if ("error" in markets) return { error: markets.error };
  if (kind === "claude") {
    const list = Array.isArray(plugins.value) ? (plugins.value as Array<{ id?: string; scope?: string; enabled?: boolean }>) : [];
    const mine = list.find((p) => p.id === PLUGIN_ID && p.scope === "user");
    const names = Array.isArray(markets.value) ? (markets.value as Array<{ name?: string }>).map((m) => m.name) : [];
    return { marketplace: names.includes(MARKETPLACE), installed: Boolean(mine), enabled: mine?.enabled !== false };
  }
  const installed = ((plugins.value as { installed?: Array<{ pluginId?: string; installed?: boolean; enabled?: boolean }> })?.installed ?? []).find(
    (p) => p.pluginId === PLUGIN_ID && p.installed !== false,
  );
  const names = ((markets.value as { marketplaces?: Array<{ name?: string }> })?.marketplaces ?? []).map((m) => m.name);
  return { marketplace: names.includes(MARKETPLACE), installed: Boolean(installed), enabled: installed?.enabled !== false };
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, 300);
}

function lastLine(text: string): string {
  return (text.split(/\r?\n/).findLast((l) => l.trim()) ?? "").trim().slice(0, 300);
}

/**
 * The folder Gemini CLI's commands run in: `extensions install` trusts the
 * folder it runs in, so that is an empty one of the kit's, never the person's.
 */
async function geminiFolder(kind: PluginKind, env: Env): Promise<string | undefined> {
  if (kind !== "gemini") return undefined;
  const dir = path.join(cacheDir(env), "gemini");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function pluginCommands(kind: PluginKind) {
  if (kind === "gemini") {
    return {
      marketplaceAdd: [],
      marketplaceRemove: [],
      // This release's extension, so the skills match this cavelon; --consent is the person's yes to setup's plan.
      install: ["extensions", "install", GEMINI_SOURCE, "--ref", `v${KIT_VERSION}`, "--consent"],
      uninstall: ["extensions", "uninstall", GEMINI_EXTENSION],
    };
  }
  return {
    marketplaceAdd: ["plugin", "marketplace", "add", MARKETPLACE_SOURCE],
    marketplaceRemove: ["plugin", "marketplace", "remove", MARKETPLACE],
    install: kind === "claude" ? ["plugin", "install", PLUGIN_ID, "--scope", "user"] : ["plugin", "add", PLUGIN_ID],
    uninstall: kind === "claude" ? ["plugin", "uninstall", PLUGIN_ID, "--scope", "user"] : ["plugin", "remove", PLUGIN_ID],
  };
}

/**
 * What setup would change for one agent, read without changing anything.
 * The plugin's MCP entry starts through `sh`, which native Windows does not
 * have, so there a plugin agent also gets the server in its MCP file.
 */
export async function planAgent(agent: SetupAgent, found: Found, env: Env, command: ServerCommand, skills: Skill[], platform: NodeJS.Platform = process.platform): Promise<AgentPlan> {
  const usePlugin = Boolean(agent.plugin && found.program);
  const state = usePlugin ? await pluginState(agent.plugin!, found.program!, env) : undefined;
  const plan: AgentPlan = { agent, found, method: usePlugin ? "plugin" : "files", changes: [] };
  if (usePlugin && state) {
    const kind = agent.plugin!;
    const program = found.program!;
    const commands = pluginCommands(kind);
    if ("error" in state) {
      plan.changes.push({ kind: "plugin", summary: "install the Cavelon plugin", target: display(program, commands.install), outcome: "failed", reason: state.error });
      return plan;
    }
    plan.plugin = state;
    if (!state.marketplace && commands.marketplaceAdd.length) {
      plan.changes.push({ kind: "marketplace", summary: "add the Cavelon plugin marketplace", target: display(program, commands.marketplaceAdd), outcome: "planned" });
    }
    plan.changes.push({
      kind: "plugin",
      summary: kind === "gemini" ? "install the Cavelon extension (skills and tools)" : "install the Cavelon plugin (skills and tools)",
      target: display(program, commands.install),
      outcome: state.installed ? "unchanged" : "planned",
      ...(state.installed && !state.enabled ? { reason: `it is installed but turned off; turn it on in ${agent.label}` } : {}),
    });
  }
  if (!usePlugin || platform === "win32") plan.changes.push(await mcpChange(agent.mcp, command, false));
  if (!usePlugin) plan.changes.push(await skillsChange(agent.skills, skills, false));
  return plan;
}

async function mcpChange(mcp: McpFile, command: ServerCommand, apply: boolean, state?: AgentRecord): Promise<Change> {
  const summary = 'add the "cavelon" tools server to';
  const existing = await readTextFile(mcp.file);
  let result: BlockResult;
  if (mcp.format === "json") {
    let current: unknown;
    try {
      current = existing ? mcp.keys.reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined), JSON.parse(existing)) : undefined;
    } catch {
      current = undefined;
    }
    if (current !== undefined && !isOwnJsonEntry(mcp, current)) {
      return { kind: "mcp", summary, target: mcp.file, outcome: "skipped", reason: `it already has a "cavelon" server of its own; left as it is` };
    }
    result = upsertJsonEntry(existing, mcp.keys, jsonEntry(mcp, command));
    if (result.outcome === "skipped") result.reason = `${result.reason}; add "${mcp.keys.join(".")}": ${JSON.stringify(jsonEntry(mcp, command))} yourself`;
  } else {
    if (existing !== undefined && hasOwnTomlServer(existing)) {
      return { kind: "mcp", summary, target: mcp.file, outcome: "skipped", reason: "it already has an [mcp_servers.cavelon] table of its own; left as it is" };
    }
    result = upsertBlock(existing, tomlBlock(command), "hash");
  }
  if (result.outcome === "unchanged") return { kind: "mcp", summary, target: mcp.file, outcome: "unchanged" };
  if (result.outcome === "skipped") return { kind: "mcp", summary, target: mcp.file, outcome: "skipped", reason: result.reason };
  if (!apply) return { kind: "mcp", summary: result.outcome === "updated" ? 'update the "cavelon" tools server in' : summary, target: mcp.file, outcome: "planned" };
  const createdDir = await topmostMissing(path.dirname(mcp.file));
  await writeKeepingMode(mcp.file, result.content!);
  if (state && !state.mcp) {
    state.mcp = {
      file: mcp.file,
      created: existing === undefined,
      ...(mcp.format === "json" ? { kept: existing ? keptDepth(existing, mcp.keys) : 0 } : {}),
      ...(createdDir ? { created_dir: createdDir } : {}),
    };
  }
  return { kind: "mcp", summary, target: mcp.file, outcome: "done" };
}

/** How many leading keys of `keys` the JSON already has. */
function keptDepth(text: string, keys: string[]): number {
  let node: unknown;
  try {
    node = JSON.parse(text);
  } catch {
    return keys.length;
  }
  let depth = 0;
  for (const key of keys.slice(0, -1)) {
    if (!node || typeof node !== "object" || !(key in (node as object))) break;
    node = (node as Record<string, unknown>)[key];
    depth++;
  }
  return depth;
}

async function writeKeepingMode(file: string, content: string): Promise<void> {
  // A file that holds a person's settings keeps its permissions; a new one is the person's alone.
  const target = await fs.realpath(file).catch(() => file);
  const mode = await fs.stat(target).then((st) => st.mode & 0o777, () => 0o600);
  await writeFileAtomic(target, content, mode, 0o700);
}

async function skillsChange(dir: string, skills: Skill[], apply: boolean, state?: AgentRecord): Promise<Change> {
  const summary = `copy the ${skills.length} Cavelon skills to`;
  const target = dir + path.sep;
  const createdDir = await topmostMissing(dir);
  let changed = 0;
  const foreign: string[] = [];
  for (const skill of skills) {
    for (const file of skill.files) {
      const full = path.join(dir, skill.name, ...file.path.split("/"));
      const content = generatedCopy(file, "setup");
      const existing = await readTextFile(full);
      if (existing === content) continue;
      if (existing !== undefined && !isGenerated(existing)) {
        foreign.push(`${skill.name}/${file.path}`);
        continue;
      }
      changed++;
      if (apply) await writeFileAtomic(full, content);
    }
  }
  if (apply && changed && state && !state.skills) state.skills = { dir, ...(createdDir ? { created_dir: createdDir } : {}) };
  const reason = foreign.length ? `${foreign.join(", ")} ${foreign.length === 1 ? "is" : "are"} not cavelon's; left as ${foreign.length === 1 ? "it is" : "they are"}` : undefined;
  if (!changed) return { kind: "skills", summary, target, outcome: foreign.length ? "skipped" : "unchanged", ...(reason ? { reason } : {}) };
  return { kind: "skills", summary, target, outcome: apply ? "done" : "planned", ...(reason ? { reason } : {}) };
}

/** Make the planned changes for one agent; a failure is reported and stops only that agent. */
export async function applyPlan(plan: AgentPlan, env: Env, command: ServerCommand, skills: Skill[], record: AgentRecord): Promise<Change[]> {
  const done: Change[] = [];
  for (const change of plan.changes) {
    if (change.outcome !== "planned") {
      done.push(change);
      continue;
    }
    try {
      if (change.kind === "marketplace" || change.kind === "plugin") {
        const kind = plan.agent.plugin!;
        const commands = pluginCommands(kind);
        const args = change.kind === "marketplace" ? commands.marketplaceAdd : commands.install;
        const result = await runProgram(plan.found.program!, args, { env, timeoutMs: RUN_TIMEOUT_MS, cwd: await geminiFolder(kind, env) });
        if (result.code !== 0) {
          if (kind === "gemini") {
            // Gemini CLI prints the consent it was given first and its error last.
            const reason = result.error ?? (lastLine(`${result.stdout}\n${result.stderr}`) || `exit ${result.code}`);
            // A release without the extension (one before it, or a build from a clone): the files work as well.
            done.push({ ...change, outcome: "skipped", reason: `${reason}; the tools server and skills go into Gemini CLI's files instead` });
            done.push(await mcpChange(plan.agent.mcp, command, true, record));
            done.push(await skillsChange(plan.agent.skills, skills, true, record));
            break;
          }
          done.push({ ...change, outcome: "failed", reason: result.error ?? (firstLine(result.stderr || result.stdout) || `exit ${result.code}`) });
          break;
        }
        if (change.kind === "marketplace") record.marketplace_added = true;
        else record.plugin_installed = true;
        done.push({ ...change, outcome: "done" });
        // The extension replaces what an earlier setup wrote into Gemini CLI's files, whose skills would hide the extension's.
        if (kind === "gemini" && change.kind === "plugin") done.push(...(await removeFiles(plan.agent, record, skills, new Set())));
      } else if (change.kind === "mcp") {
        done.push(await mcpChange(plan.agent.mcp, command, true, record));
      } else {
        done.push(await skillsChange(plan.agent.skills, skills, true, record));
      }
    } catch (error) {
      done.push({ ...change, outcome: "failed", reason: error instanceof Error ? error.message : String(error) });
      break;
    }
  }
  return done;
}

// ---------------------------------------------------------------------------
// Undoing it
// ---------------------------------------------------------------------------

/**
 * Undo what setup recorded for one agent: the plugin and marketplace it
 * installed, its MCP entry or block, and its generated skill files. A file
 * the kit created goes when nothing else is left in it; an entry someone
 * changed since stays.
 */
export async function removeAgent(agent: SetupAgent, record: AgentRecord, env: Env, skills: Skill[], sharedSkillDirs: Set<string>): Promise<Change[]> {
  const changes: Change[] = [];
  if (record.plugin_installed || record.marketplace_added) {
    const found = await findAgent(agent, env);
    const commands = pluginCommands(agent.plugin!);
    const steps: Array<[ChangeKind, string[], string, keyof AgentRecord]> = [];
    if (record.plugin_installed) steps.push(["plugin", commands.uninstall, `uninstall the Cavelon ${agent.plugin === "gemini" ? "extension" : "plugin"}`, "plugin_installed"]);
    if (record.marketplace_added) steps.push(["marketplace", commands.marketplaceRemove, "remove the Cavelon plugin marketplace", "marketplace_added"]);
    for (const [kind, args, summary, key] of steps) {
      if (!found.program) {
        changes.push({ kind, summary, target: [agent.commands[0], ...args].join(" "), outcome: "failed", reason: `${agent.commands[0]} is not on the PATH; run it yourself` });
        continue;
      }
      const result = await runProgram(found.program, args, { env, timeoutMs: RUN_TIMEOUT_MS, cwd: await geminiFolder(agent.plugin!, env) });
      if (result.code === 0) {
        delete record[key];
        changes.push({ kind, summary, target: display(found.program, args), outcome: "removed" });
      } else {
        changes.push({ kind, summary, target: display(found.program, args), outcome: "failed", reason: result.error ?? firstLine(result.stderr || result.stdout) });
      }
    }
  }
  changes.push(...(await removeFiles(agent, record, skills, sharedSkillDirs)));
  return changes;
}

/** Take out the MCP entry and skill files setup recorded for an agent. */
async function removeFiles(agent: SetupAgent, record: AgentRecord, skills: Skill[], sharedSkillDirs: Set<string>): Promise<Change[]> {
  const changes: Change[] = [];
  if (record.mcp) {
    const change = await removeMcp(agent.mcp, record.mcp);
    if (change.outcome !== "failed" && change.outcome !== "skipped") delete record.mcp;
    changes.push(change);
  }
  if (record.skills) {
    const change = await removeSkills(record.skills, skills, sharedSkillDirs.has(record.skills.dir));
    delete record.skills;
    changes.push(change);
  }
  return changes;
}

async function removeMcp(mcp: McpFile, record: FileRecord): Promise<Change> {
  const summary = 'remove the "cavelon" tools server from';
  const existing = await readTextFile(mcp.file);
  if (existing === undefined) return { kind: "mcp", summary, target: mcp.file, outcome: "unchanged" };
  const result =
    mcp.format === "json"
      ? removeJsonEntry(existing, mcp.keys, (value) => isOwnJsonEntry(mcp, value), record.kept ?? mcp.keys.length - 1)
      : removeBlock(existing, "hash");
  if (result.outcome === "unchanged") return { kind: "mcp", summary, target: mcp.file, outcome: "unchanged" };
  if (result.outcome === "skipped") return { kind: "mcp", summary, target: mcp.file, outcome: "skipped", reason: result.reason };
  if (result.empty && record.created) {
    await fs.rm(mcp.file, { force: true });
    if (record.created_dir) await removeEmptyDirs(path.dirname(mcp.file), record.created_dir);
  } else {
    await writeKeepingMode(mcp.file, result.content!);
  }
  return { kind: "mcp", summary, target: mcp.file, outcome: "removed" };
}

async function removeSkills(record: { dir: string; created_dir?: string }, skills: Skill[], stillUsed: boolean): Promise<Change> {
  const summary = "remove the Cavelon skills from";
  const target = record.dir + path.sep;
  if (stillUsed) return { kind: "skills", summary, target, outcome: "unchanged", reason: "another agent set up by cavelon still uses them" };
  let removed = 0;
  for (const skill of skills) {
    const folder = path.join(record.dir, skill.name);
    for (const file of skill.files) {
      const full = path.join(folder, ...file.path.split("/"));
      if (isGenerated(await readTextFile(full).catch(() => undefined))) {
        await fs.rm(full, { force: true });
        removed++;
      }
    }
    await fs.rmdir(folder).catch(() => undefined);
  }
  if (record.created_dir) await removeEmptyDirs(record.dir, record.created_dir);
  return { kind: "skills", summary, target, outcome: removed ? "removed" : "unchanged" };
}

/** Remove `dir` and its parents up to and including `top`, each only while it is empty. */
async function removeEmptyDirs(dir: string, top: string): Promise<void> {
  const last = path.resolve(top);
  let current = path.resolve(dir);
  while (current.startsWith(last)) {
    try {
      await fs.rmdir(current);
    } catch {
      return;
    }
    if (current === last) return;
    current = path.dirname(current);
  }
}

/** The topmost of `dir` and its parents that does not exist yet: what writing into `dir` creates. */
async function topmostMissing(dir: string): Promise<string | undefined> {
  let missing: string | undefined;
  let current = path.resolve(dir);
  while (!(await fs.stat(current).then(() => true, () => false))) {
    missing = current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Checking it
// ---------------------------------------------------------------------------

export interface AgentCheck {
  name: string;
  label: string;
  found: boolean;
  method: "plugin" | "files" | null;
  ok: boolean;
  details: string[];
  /** The server commands its entries name, for the start check. */
  servers: ServerCommand[];
}

export async function checkAgent(agent: SetupAgent, env: Env, record: AgentRecord | undefined, platform: NodeJS.Platform = process.platform): Promise<AgentCheck> {
  const found = await findAgent(agent, env, platform);
  const check: AgentCheck = { name: agent.name, label: agent.label, found: Boolean(found.program || found.folder), method: null, ok: true, details: [], servers: [] };
  const state = agent.plugin && found.program ? await pluginState(agent.plugin, found.program, env) : undefined;
  // Gemini CLI without the extension may have the files instead (setup's fallback).
  const viaFiles = !state || (agent.plugin === "gemini" && ("error" in state || !state.installed));
  const what = agent.plugin === "gemini" ? "extension" : "plugin";
  if (state && !viaFiles) {
    check.method = "plugin";
    if ("error" in state) {
      check.ok = false;
      check.details.push(`could not ask ${agent.label} about its plugins: ${state.error}`);
    } else if (!state.installed) {
      check.ok = false;
      check.details.push(`the Cavelon ${what} is not installed`);
    } else if (!state.enabled) {
      check.ok = false;
      check.details.push(`the Cavelon ${what} is installed but turned off; turn it on in ${agent.label}`);
    } else {
      check.details.push(`the Cavelon ${what} is installed`);
      // The plugin starts the installed cavelon when there is one, otherwise npx.
      if (platform !== "win32") check.servers.push(await serverCommand(env, platform));
    }
    if (platform !== "win32") return check;
  } else {
    check.method = "files";
  }
  const entry = await readEntry(agent.mcp);
  if (entry.server) {
    check.details.push(`the "cavelon" tools server is in ${agent.mcp.file}`);
    check.servers.push(entry.server);
  } else {
    check.ok = false;
    check.details.push(entry.problem ?? `${agent.mcp.file} has no "cavelon" tools server`);
  }
  if (check.method === "files") {
    const missing = [];
    for (const skill of await bundledSkills()) {
      if ((await readTextFile(path.join(agent.skills, skill.name, "SKILL.md"))) === undefined) missing.push(skill.name);
    }
    if (missing.length) {
      check.ok = false;
      check.details.push(`skills missing in ${agent.skills}: ${missing.join(", ")}`);
    } else {
      check.details.push(`the Cavelon skills are in ${agent.skills}`);
    }
  }
  if (!record && !check.found) check.ok = false;
  return check;
}

/** The server an agent's MCP file names for "cavelon", whoever wrote it. */
async function readEntry(mcp: McpFile): Promise<{ server?: ServerCommand; problem?: string }> {
  const text = await readTextFile(mcp.file);
  if (text === undefined) return { problem: `${mcp.file} does not exist` };
  if (mcp.format === "toml") {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((l) => /^\[\s*mcp_servers\s*\.\s*"?cavelon"?\s*\]/.test(l.trim()));
    if (start < 0) return { problem: `${mcp.file} has no [mcp_servers.cavelon]` };
    const value = (key: string) => {
      for (const line of lines.slice(start + 1)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("[")) break;
        const equals = trimmed.indexOf("=");
        if (equals > 0 && trimmed.slice(0, equals).trim() === key) return trimmed.slice(equals + 1).trim();
      }
      return undefined;
    };
    try {
      const command = JSON.parse(value("command") ?? "null") as unknown;
      const args = JSON.parse(value("args") ?? "[]") as unknown;
      if (typeof command === "string" && Array.isArray(args)) return { server: { command, args: args.map(String) } };
    } catch {
      // Not in the simple form the kit writes; the agent reads it, the check cannot.
    }
    return { problem: `the [mcp_servers.cavelon] table in ${mcp.file} is not in a form setup can read` };
  }
  let value: unknown;
  try {
    value = mcp.keys.reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined), JSON.parse(text));
  } catch {
    return { problem: `${mcp.file} is not plain JSON, so setup cannot read it` };
  }
  const entry = value as { command?: unknown; args?: unknown } | undefined;
  if (!entry || typeof entry.command !== "string") return { problem: `${mcp.file} has no "cavelon" tools server` };
  return { server: { command: entry.command, args: Array.isArray(entry.args) ? entry.args.map(String) : [] } };
}

export async function loadSkills(): Promise<Skill[]> {
  return bundledSkills();
}
