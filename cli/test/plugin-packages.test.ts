import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MCP_COMMAND } from "../src/agents.js";
import { PLUGIN_VERSION_VARIABLE } from "../src/update-check.js";

/**
 * The plugin packages a release attaches (packaging/plugins.mjs), rendered
 * from plugin/ as the release workflow does: every manifest checked against
 * the schema its client publishes (Agent Plugins 1.0, kept in
 * contracts/clients/) or, for Gemini CLI, which publishes none, against the
 * rules its loader applies; the same skills in each; the same bytes on every
 * render.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const version = (JSON.parse(readFileSync(path.join(ROOT, "cli", "package.json"), "utf8")) as { version: string }).version;
const SKILLS = ["cavelon-authoring", "cavelon-long-running", "cavelon-loop", "cavelon-testing"];
const NPX = [MCP_COMMAND.command, ...MCP_COMMAND.args].join(" ");

let out: string;

function render(dir: string, ...args: string[]): string[] {
  const result = spawnSync(process.execPath, [path.join("packaging", "render.mjs"), "plugins", "--out", dir, ...args], { cwd: ROOT, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim().split(/\r?\n/).map((f) => path.basename(f));
}

/** The files of a .tar.gz the renderer wrote, by name. */
function unpack(file: string): Map<string, Buffer> {
  const bytes = gunzipSync(readFileSync(file));
  const files = new Map<string, Buffer>();
  for (let at = 0; at + 512 <= bytes.length; ) {
    const header = bytes.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, length: number) => header.subarray(start, start + length).toString("ascii").split("\0")[0]!;
    expect(field(257, 6)).toBe("ustar");
    expect(field(156, 1)).toBe("0");
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = parseInt(field(124, 12), 8);
    files.set(name, Buffer.from(bytes.subarray(at + 512, at + 512 + size)));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const jsonOf = <T>(files: Map<string, Buffer>, name: string): T => JSON.parse(files.get(name)!.toString("utf8")) as T;

function expectSkills(files: Map<string, Buffer>, prefix = "skills/"): void {
  const names = [...files.keys()].filter((n) => n.startsWith(prefix));
  expect([...new Set(names.map((n) => n.slice(prefix.length).split("/")[0]))].sort()).toEqual(SKILLS);
  // The skills byte for byte as plugin/skills holds them: one source.
  for (const name of names) expect(files.get(name)!.equals(readFileSync(path.join(ROOT, "plugin", "skills", ...name.slice(prefix.length).split("/")))), name).toBe(true);
}

beforeAll(() => {
  out = mkdtempSync(path.join(os.tmpdir(), "cavelon-packages-"));
});
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("the plugin packages", () => {
  it("are the Agent Plugins package for macOS/Linux and Windows, a Gemini CLI extension per platform, and the marketplace", () => {
    expect(render(path.join(out, "a"))).toEqual([
      "cavelon-agent-plugin.tar.gz",
      "cavelon-agent-plugin-windows.tar.gz",
      "darwin.cavelon-gemini-extension.tar.gz",
      "linux.cavelon-gemini-extension.tar.gz",
      "win32.cavelon-gemini-extension.tar.gz",
      "cavelon-marketplace.tar.gz",
    ]);
  });

  it("are the same bytes on every render", () => {
    render(path.join(out, "b"));
    for (const name of readdirSync(path.join(out, "a")).filter((n) => n.endsWith(".tar.gz"))) {
      expect(readFileSync(path.join(out, "b", name)).equals(readFileSync(path.join(out, "a", name))), name).toBe(true);
    }
  });

  it("Agent Plugins: plugin.json and mcp.json match the published schemas, with what Kiro and Cursor also require", () => {
    const schema = (name: string) => JSON.parse(readFileSync(path.join(ROOT, "contracts", "clients", "agent-plugins-1.0.0", name), "utf8")) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validPlugin = ajv.compile(schema("plugin.schema.json"));
    const validMcp = ajv.compile(schema("mcp.schema.json"));
    for (const [suffix, server] of [
      ["", { command: "sh", args: ["-c", `if command -v cavelon >/dev/null 2>&1; then exec cavelon mcp; else exec ${NPX}; fi`] }],
      ["-windows", { command: "cmd", args: ["/c", ...NPX.split(" ")] }],
    ] as const) {
      const files = unpack(path.join(out, "a", `cavelon-agent-plugin${suffix}.tar.gz`));
      const plugin = jsonOf<Record<string, unknown>>(files, "plugin.json");
      const mcp = jsonOf<{ $schema: string; mcpServers: Record<string, unknown> }>(files, "mcp.json");
      expect(validPlugin(plugin), JSON.stringify(validPlugin.errors)).toBe(true);
      expect(validMcp(mcp), JSON.stringify(validMcp.errors)).toBe(true);
      // Kiro's powers also require these; the MCP file's schema version must match the manifest's.
      expect(plugin).toMatchObject({ name: "cavelon", version, description: expect.any(String), author: { name: expect.any(String) }, keywords: expect.arrayContaining(["cavelon"]) });
      expect(mcp.$schema.replace("mcp.schema", "plugin.schema")).toBe(plugin.$schema);
      expect(mcp.mcpServers).toEqual({ cavelon: { type: "stdio", ...server, env: { [PLUGIN_VERSION_VARIABLE]: version } } });
      expect([...files.keys()]).toEqual(expect.arrayContaining(["LICENSE", "README.md"]));
      expectSkills(files);
    }
  });

  it("Gemini CLI: gemini-extension.json as its loader requires, the skills in skills/, and a server for each platform", () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      const files = unpack(path.join(out, "a", `${platform}.cavelon-gemini-extension.tar.gz`));
      const manifest = jsonOf<{ name: string; version: string; mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> }>(files, "gemini-extension.json");
      // Gemini CLI refuses an extension without a name of letters, digits and dashes, or without a version.
      expect(manifest.name).toMatch(/^[a-zA-Z0-9-]+$/);
      expect(manifest.version).toBe(version);
      expect(Object.keys(manifest)).toEqual(["name", "version", "description", "mcpServers"]);
      expect(manifest.mcpServers.cavelon!.command).toBe(platform === "win32" ? "cmd" : "sh");
      expect(manifest.mcpServers.cavelon!.env).toEqual({ [PLUGIN_VERSION_VARIABLE]: version });
      expectSkills(files);
    }
  });

  it("the marketplace carries plugin/ as it is, with both marketplaces", () => {
    const files = unpack(path.join(out, "a", "cavelon-marketplace.tar.gz"));
    for (const name of [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json", "plugin/.mcp.json", "plugin/.claude-plugin/plugin.json", "plugin/.codex-plugin/plugin.json"]) {
      expect(files.get(name)!.equals(readFileSync(path.join(ROOT, ...name.split("/")))), name).toBe(true);
    }
    expectSkills(files, "plugin/skills/");
  });

  it("--server installed starts the cavelon on the PATH in every package, for machines without the npm registry", () => {
    render(path.join(out, "installed"), "--server", "installed");
    const installed = { command: "cavelon", args: ["mcp"], env: { [PLUGIN_VERSION_VARIABLE]: version } };
    expect(jsonOf<any>(unpack(path.join(out, "installed", "cavelon-agent-plugin-windows.tar.gz")), "mcp.json").mcpServers.cavelon).toEqual({ type: "stdio", ...installed });
    expect(jsonOf<any>(unpack(path.join(out, "installed", "linux.cavelon-gemini-extension.tar.gz")), "gemini-extension.json").mcpServers.cavelon).toEqual(installed);
    expect(jsonOf<any>(unpack(path.join(out, "installed", "cavelon-marketplace.tar.gz")), "plugin/.mcp.json").mcpServers.cavelon).toEqual(installed);
  });

  it("refuses an unknown --server", () => {
    const result = spawnSync(process.execPath, [path.join("packaging", "render.mjs"), "plugins", "--out", path.join(out, "x"), "--server", "npx"], { cwd: ROOT, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--server is auto or installed");
  });
});
