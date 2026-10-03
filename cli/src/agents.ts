import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

export type McpTarget =
  | { file: string; format: "json"; keys: string[]; entry: Record<string, unknown> }
  | { file: string; format: "toml"; block: string };

export interface AgentTarget {
  name: string;
  label: string;
  mcp?: McpTarget;
}

const jsonServer = (file: string, key = "mcpServers", extra: Record<string, unknown> = {}): McpTarget => ({
  file,
  format: "json",
  keys: [key, "cavelon"],
  entry: { ...extra, ...MCP_COMMAND },
});

export const AGENTS: AgentTarget[] = [
  { name: "claude", label: "Claude Code", mcp: jsonServer(".mcp.json") },
  {
    name: "codex",
    label: "Codex",
    mcp: {
      file: ".codex/config.toml",
      format: "toml",
      block: ["[mcp_servers.cavelon]", `command = "${MCP_COMMAND.command}"`, `args = [${MCP_COMMAND.args.map((a) => `"${a}"`).join(", ")}]`].join("\n"),
    },
  },
  { name: "cursor", label: "Cursor", mcp: jsonServer(".cursor/mcp.json") },
  { name: "copilot", label: "GitHub Copilot in VS Code", mcp: jsonServer(".vscode/mcp.json", "servers", { type: "stdio" }) },
  { name: "gemini", label: "Gemini CLI", mcp: jsonServer(".gemini/settings.json") },
  { name: "kiro", label: "Kiro", mcp: jsonServer(".kiro/settings/mcp.json") },
  // Agents that read AGENTS.md and run shell commands, with no MCP entry to write.
  { name: "pi", label: "Pi" },
  { name: "other", label: "any other agent with a shell" },
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
 * repository's `plugin/skills/` when running from a checkout.
 */
export function skillsSource(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [path.join(here, "skills"), path.resolve(here, "..", "..", "plugin", "skills")];
}

export async function bundledSkills(): Promise<Skill[]> {
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
