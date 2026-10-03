import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MCP_COMMAND } from "../src/agents.js";

/**
 * The plugin for Claude Code and Codex: one
 * folder, plugin/, that both marketplaces at the repository's root name, with
 * the skills in plugin/skills/ (their one source) and the `cavelon mcp` entry
 * in plugin/.mcp.json, started through npx at this version's minor. One version
 * for the binary and the plugin.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGIN = path.join(ROOT, "plugin");
const json = <T>(...parts: string[]) => JSON.parse(readFileSync(path.join(ROOT, ...parts), "utf8")) as T;
const version = json<{ version: string }>("cli", "package.json").version;

interface ClaudeMarketplace {
  name: string;
  owner: { name: string };
  plugins: Array<{ name: string; source: string; version?: string }>;
}
interface CodexMarketplace {
  name: string;
  plugins: Array<{ name: string; source: { source: string; path: string }; policy: { installation: string; authentication: string }; category: string }>;
}
interface Manifest {
  name: string;
  version: string;
  skills?: string;
  mcpServers?: string;
  interface?: Record<string, unknown>;
}

/** A manifest's "./…" path, which must stay inside the plugin folder. */
function inPlugin(relative: string): string {
  expect(relative.startsWith("./"), relative).toBe(true);
  const resolved = path.resolve(PLUGIN, relative);
  expect(path.relative(PLUGIN, resolved).startsWith(".."), relative).toBe(false);
  return resolved;
}

describe("the marketplaces", () => {
  it("Claude Code's names the plugin in plugin/, at the binary's version", () => {
    const market = json<ClaudeMarketplace>(".claude-plugin", "marketplace.json");
    expect(market.name).toBe("cavelon-dev-kit");
    expect(market.owner.name).toBeTruthy();
    expect(market.plugins).toEqual([expect.objectContaining({ name: "cavelon", source: "./plugin", version })]);
  });

  it("Codex's names the same folder as a local plugin", () => {
    const market = json<CodexMarketplace>(".agents", "plugins", "marketplace.json");
    expect(market.name).toBe("cavelon-dev-kit");
    expect(market.plugins).toEqual([
      expect.objectContaining({
        name: "cavelon",
        source: { source: "local", path: "./plugin" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: expect.any(String),
      }),
    ]);
  });
});

describe("the plugin", () => {
  it("has one manifest per client, both at the binary's version", () => {
    const claude = json<Manifest>("plugin", ".claude-plugin", "plugin.json");
    const codex = json<Manifest>("plugin", ".codex-plugin", "plugin.json");
    expect(claude).toMatchObject({ name: "cavelon", version });
    expect(codex).toMatchObject({ name: "cavelon", version });
    expect(codex.interface).toMatchObject({ displayName: "Cavelon", category: expect.any(String), capabilities: expect.any(Array) });
    // Codex is told where the skills and the MCP entry are; Claude Code finds them in their default places.
    expect(statSync(inPlugin(codex.skills!)).isDirectory()).toBe(true);
    expect(inPlugin(codex.mcpServers!)).toBe(path.join(PLUGIN, ".mcp.json"));
  });

  it("starts `cavelon mcp` through npx, pinned to this version's minor, as init --agents writes it", () => {
    const mcp = json<{ mcpServers: Record<string, { command: string; args: string[] }> }>("plugin", ".mcp.json");
    const minor = version.split(".").slice(0, 2).join(".");
    expect(mcp.mcpServers).toEqual({ cavelon: { command: "npx", args: ["-y", `@cavelon/cli@${minor}`, "mcp"] } });
    expect(mcp.mcpServers.cavelon).toEqual(MCP_COMMAND);
  });

  it("carries every skill of plugin/skills/, each named after its folder", () => {
    const skills = readdirSync(path.join(PLUGIN, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory());
    expect(skills.map((s) => s.name).sort()).toEqual(["cavelon-authoring", "cavelon-long-running", "cavelon-loop", "cavelon-testing"]);
    for (const skill of skills) {
      const text = readFileSync(path.join(PLUGIN, "skills", skill.name, "SKILL.md"), "utf8");
      expect(text.startsWith("---\n"), skill.name).toBe(true);
      const end = text.indexOf("\n---\n", 4);
      expect(end, skill.name).toBeGreaterThan(0);
      const meta = parse(text.slice(4, end)) as { name: string; description: string };
      expect(meta.name).toBe(skill.name);
      expect(meta.description.length).toBeGreaterThan(0);
    }
    // One source: no second copy of the skills in the plugin.
    expect(existsSync(path.join(PLUGIN, ".claude-plugin", "skills"))).toBe(false);
    expect(existsSync(path.join(PLUGIN, ".codex-plugin", "skills"))).toBe(false);
  });
});
