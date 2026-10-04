import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { embeddedContent } from "./embedded.js";
import { usageError } from "./errors.js";
import { GENERATED_TOKEN } from "./markers.js";
import { KIT_VERSION } from "./version.js";

/**
 * The fallback for coding agents without the Cavelon plugin (plan 04,
 * "Without a plugin"): the skills, copied into the solution, and the
 * `cavelon mcp` entry in each agent's project MCP configuration.
 */

// The released package through npx, as the plugin's .mcp.json starts it. The pin
// is this version's minor: in 0.x a minor release may break, and it must not
// reach a solution's MCP entry unannounced. A release of a new minor moves both.
export const MCP_COMMAND = { command: "npx", args: ["-y", "@cavelon/cli@0.1", "mcp"] };

// The installed executable (one-line install, Homebrew or npm i -g), for a team
// without Node.js: `init` does not write it, but keeps an entry changed to it.
export const INSTALLED_MCP_COMMAND = { command: "cavelon", args: ["mcp"] };

/**
 * How an agent on `platform` starts the MCP server. On native Windows `npx` is
 * `npx.cmd`, which an agent that starts its servers without a shell cannot run,
 * so it goes through `cmd /c`.
 */
export function mcpCommand(platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  return platform === "win32" ? { command: "cmd", args: ["/c", MCP_COMMAND.command, ...MCP_COMMAND.args] } : MCP_COMMAND;
}

export type McpTarget =
  | { file: string; format: "json"; keys: string[]; entry: Record<string, unknown>; others: Array<Record<string, unknown>> }
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
    ["[mcp_servers.cavelon]", `command = "${command}"`, `args = [${args.map((a) => `"${a}"`).join(", ")}]`].join("\n");
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
  // Agents that read AGENTS.md and run shell commands, with no MCP entry to write.
  agent("pi", "Pi"),
  agent("other", "any other agent with a shell"),
];

const ALIASES: Record<string, string> = { "claude-code": "claude", vscode: "copilot", "gemini-cli": "gemini" };

/** `--agents claude,codex` (or repeated), as targets; `all` names every one. */
export function parseAgents(values: string[]): AgentTarget[] {
  const names = values.flatMap((v) => v.split(",")).map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (names.includes("all")) return AGENTS;
  const out: AgentTarget[] = [];
  for (const raw of names) {
    const name = ALIASES[raw] ?? raw;
    const target = AGENTS.find((a) => a.name === name);
    if (!target) throw usageError(`Unknown agent "${raw}".`, `Known: ${AGENTS.map((a) => a.name).join(", ")}, or all.`);
    if (!out.includes(target)) out.push(target);
  }
  return out;
}

/** Where the skills go: `.agents/skills/` for most agents, `.claude/skills/` for Claude Code. */
export const SKILL_ROOTS = [".agents/skills", ".claude/skills"];

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
 * A skill file as `init` writes it into a solution: marked as generated, so
 * `init --update` may replace it and nothing else. The mark goes after a
 * SKILL.md's front matter, which must stay first.
 */
export function generatedCopy(file: SkillFile): string {
  if (!file.path.endsWith(".md")) return file.content;
  const mark = `<!-- ${GENERATED_TOKEN}: written by \`cavelon init --agents\` (cavelon ${KIT_VERSION}); \`cavelon init --update\` replaces this file. Put your own notes in another file. -->`;
  const front = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(file.content);
  if (front) return `${front[0]}${mark}\n${file.content.slice(front[0].length)}`;
  return `${mark}\n${file.content}`;
}
