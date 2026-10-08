import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { embeddedContent } from "./embedded.js";
import { usageError } from "./errors.js";
import { GENERATED_TOKEN } from "./markers.js";
import { KIT_VERSION } from "./version.js";
import { INSTALLED_MCP_COMMAND, mcpCommand } from "./mcp-command.js";
import { encodeMcpEntry } from "./mcp-entry.js";
import { NATIVE_CLIENTS, nativeClient, type NativeMcpConfig } from "./native-clients.js";

export { MCP_COMMAND, INSTALLED_MCP_COMMAND, mcpCommand } from "./mcp-command.js";

/**
 * The fallback for coding agents without the Cavelon plugin (plan 04,
 * "Without a plugin"): the skills, copied into the solution, and the
 * `cavelon mcp` entry in each agent's project MCP configuration.
 */

export type McpTarget =
  | { file: string; format: "json"; keys: string[]; entry: Record<string, unknown>; others: Array<Record<string, unknown>> }
  | (NativeMcpConfig & { entry: Record<string, unknown>; others: Array<Record<string, unknown>> })
  | { file: string; format: "toml"; block: string; others: string[] };

export interface AgentTarget {
  name: string;
  label: string;
  mcp?: McpTarget;
}

// A solution's MCP files are shared through git, and one person's system must
// not rewrite another's working entry: the other system's form counts as
// current, and so does the installed cavelon.
const PLATFORMS: NodeJS.Platform[] = ["win32", "linux"];
const otherPlatforms = () => PLATFORMS.filter((p) => (p === "win32") !== (process.platform === "win32"));

const jsonServer = (file: string, key = "mcpServers", extra: Record<string, unknown> = {}): McpTarget => ({
  file,
  format: "json",
  keys: [key, "cavelon"],
  entry: { ...extra, ...mcpCommand() },
  others: [...otherPlatforms().map((p) => ({ ...extra, ...mcpCommand(p) })), { ...extra, ...INSTALLED_MCP_COMMAND }],
});

const tomlServer = (file: string): McpTarget => {
  const block = ({ command, args }: { command: string; args: string[] }) =>
    ["[mcp_servers.cavelon]", `command = "${command}"`, `args = [${args.map((a) => JSON.stringify(a)).join(", ")}]`].join("\n");
  return {
    file,
    format: "toml",
    block: block(mcpCommand()),
    others: [...otherPlatforms().map((p) => block(mcpCommand(p))), block(INSTALLED_MCP_COMMAND)],
  };
};

/** An agent whose MCP entry is made when it is written, for the system the command runs on. */
function agent(name: string, label: string, mcp?: () => McpTarget): AgentTarget {
  if (!mcp) return { name, label };
  return {
    name,
    label,
    get mcp() {
      return mcp();
    },
  };
}

export const AGENTS: AgentTarget[] = [
  agent("claude", "Claude Code", () => jsonServer(".mcp.json")),
  agent("codex", "Codex", () => tomlServer(".codex/config.toml")),
  agent("cursor", "Cursor", () => jsonServer(".cursor/mcp.json")),
  agent("copilot", "GitHub Copilot in VS Code", () => jsonServer(".vscode/mcp.json", "servers", { type: "stdio" })),
  agent("gemini", "Gemini CLI", () => jsonServer(".gemini/settings.json")),
  agent("kiro", "Kiro", () => jsonServer(".kiro/settings/mcp.json")),
  ...NATIVE_CLIENTS.map(client => agent(client.name, client.label, () => {
    const config = client.project();
    return { ...config, entry: encodeMcpEntry(mcpCommand(), config.entryFormat, config.extra),
      others: [...otherPlatforms().map(p => encodeMcpEntry(mcpCommand(p), config.entryFormat, config.extra)), encodeMcpEntry(INSTALLED_MCP_COMMAND, config.entryFormat, config.extra)] };
  })),
  // Agents that read AGENTS.md and run shell commands, with no MCP entry to write.
  agent("other", "any other agent with a shell"),
];

const ALIASES: Record<string, string> = { "claude-code": "claude", vscode: "copilot", "gemini-cli": "gemini" };

/** `--agents claude,codex` (or repeated), as targets; `all` names every one. */
export function parseAgents(values: string[]): AgentTarget[] {
  const names = values.flatMap((v) => v.split(",")).map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (names.includes("all")) return AGENTS;
  const out: AgentTarget[] = [];
  for (const raw of names) {
    const name = ALIASES[raw] ?? nativeClient(raw)?.name ?? raw;
    const target = AGENTS.find((a) => a.name === name);
    if (!target) throw usageError(`Unknown agent "${raw}".`, `Known: ${AGENTS.map((a) => a.name).join(", ")}, or all.`);
    if (!out.includes(target)) out.push(target);
  }
  return out;
}

/** Where the skills go: `.agents/skills/` for most agents, `.claude/skills/` for Claude Code. */
export const SKILL_ROOTS = [".agents/skills", ".claude/skills"];

/** Keep existing generic copies and add native roots only for selected clients. */
export function skillRootsFor(agents: AgentTarget[]): string[] {
  return [...new Set([...SKILL_ROOTS, ...agents.flatMap(agent => nativeClient(agent.name)?.projectSkills ?? [])])];
}

export const KNOWN_SKILL_ROOTS = [...new Set([...SKILL_ROOTS, ...NATIVE_CLIENTS.flatMap(client => client.projectSkills)])];

export interface SkillFile {
  /** Relative to the skill's folder, with forward slashes. */
  path: string;
  content: string;
}

export interface Skill {
  name: string;
  files: SkillFile[];
}

/**
 * The skills shipped with this binary: `dist/skills/` in the package, the
 * repository's `plugin/skills/` when running from a checkout, or the copy a
 * standalone executable carries.
 */
export function skillsSource(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [path.join(here, "skills"), path.resolve(here, "..", "..", "plugin", "skills")];
}

export async function bundledSkills(): Promise<Skill[]> {
  const embedded = embeddedContent();
  if (embedded) return embedded.skills;
  for (const dir of skillsSource()) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const skills: Skill[] = [];
    for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const files: SkillFile[] = [];
      const walk = async (sub: string) => {
        for (const item of await fs.readdir(path.join(dir, entry.name, sub), { withFileTypes: true })) {
          const relative = sub ? `${sub}/${item.name}` : item.name;
          if (item.isDirectory()) await walk(relative);
          // LF whatever the checkout did, so every machine writes the same bytes.
          else if (item.isFile()) files.push({ path: relative, content: (await fs.readFile(path.join(dir, entry.name, relative), "utf8")).replace(/\r\n/g, "\n") });
        }
      };
      await walk("");
      if (files.some((f) => f.path === "SKILL.md")) skills.push({ name: entry.name, files: files.sort((a, b) => a.path.localeCompare(b.path, "en")) });
    }
    if (skills.length) return skills;
  }
  return [];
}

/**
 * A skill file as `init` writes it into a solution, or `setup` into an
 * agent's user folder: marked as generated, so the kit may replace or remove
 * it and nothing else. The mark goes after a
 * SKILL.md's front matter, which must stay first.
 */
export function generatedCopy(file: SkillFile, by: "init" | "setup" = "init"): string {
  if (!file.path.endsWith(".md")) return file.content;
  const how = by === "init" ? "`cavelon init --agents` (cavelon " + KIT_VERSION + "); `cavelon init --update` replaces this file" : "`cavelon setup` (cavelon " + KIT_VERSION + "); `cavelon setup` replaces it and `cavelon setup --remove` removes it";
  const mark = `<!-- ${GENERATED_TOKEN}: written by ${how}. Put your own notes in another file. -->`;
  const front = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(file.content);
  if (front) return `${front[0]}${mark}\n${file.content.slice(front[0].length)}`;
  return `${mark}\n${file.content}`;
}
