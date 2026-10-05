import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../src/commands/index.js";
import { removeBlock, removeJsonEntry, upsertBlock, upsertJsonEntry } from "../src/markers.js";
import { MARKETPLACE, MARKETPLACE_SOURCE, PLUGIN_ID } from "../src/setup-agents.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * `cavelon setup` against fake agent homes: the exact entries it writes for
 * each agent on macOS, Linux and Windows, a second run that changes nothing,
 * `--remove` that restores every file, the plugin commands of Claude Code and
 * Codex (played by a fake), the question on a terminal, `--check`, and the
 * login it hands to `login`.
 */

const FAKE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-agent-cli.mjs");
const NPX = { command: "npx", args: ["-y", "@cavelon/cli@0.1", "mcp"] };
const NPX_WINDOWS = { command: "cmd", args: ["/c", "npx", "-y", "@cavelon/cli@0.1", "mcp"] };
const INSTALLED = { command: "cavelon", args: ["mcp"] };
const SKILLS = ["cavelon-authoring", "cavelon-long-running", "cavelon-loop", "cavelon-testing"];

let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

/** Run as if on another operating system: paths and entries depend on it. */
async function onPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

const read = (file: string) => readFileSync(file, "utf8");
const readJson = (file: string) => JSON.parse(read(file)) as Record<string, any>;

/** Every file under `dir` with its content, and every folder, to compare a home before and after. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (sub: string) => {
    for (const entry of readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = path.join(sub, entry.name);
      if (entry.isDirectory()) {
        out[`${rel}/`] = "";
        walk(rel);
      } else if (!entry.name.startsWith(".fake-")) {
        out[rel] = read(path.join(dir, rel));
      }
    }
  };
  walk("");
  return out;
}

/** A folder of fake commands: each name runs the fake agent CLI. */
function fakeBin(names: string[]): string {
  const bin = path.join(sb.home, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of names) {
    if (process.platform === "win32") {
      writeFileSync(path.join(bin, `${name}.cmd`), `@"${process.execPath}" "${FAKE_CLI}" ${name} %*\r\n`);
    } else {
      const file = path.join(bin, name);
      writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" ${name} "$@"\n`);
      chmodSync(file, 0o755);
    }
  }
  return bin;
}

/** The environment a fake command needs on Windows to start at all. */
function pathEnv(bin: string): Record<string, string> {
  if (process.platform !== "win32") return { PATH: bin };
  const system = process.env.SystemRoot ?? "C:\\Windows";
  return { PATH: `${bin};${path.join(system, "System32")}`, SystemRoot: system, ComSpec: process.env.ComSpec ?? path.join(system, "System32", "cmd.exe") };
}

function log(agent: string): string[] {
  const file = path.join(sb.home, `.fake-${agent}.log`);
  return existsSync(file) ? read(file).trim().split("\n").filter(Boolean) : [];
}

interface Layout {
  claudeMcp: string;
  claudeSkills: string;
  codexConfig: string;
  codexSkills: string;
  cursorMcp: string;
  cursorSkills: string;
  vscodeMcp: string;
  copilotSkills: string;
  geminiSettings: string;
  geminiSkills: string;
  kiroMcp: string;
  kiroSkills: string;
}

/** The fake home of one system, with every agent's user folder, and where each agent's files belong. */
function agentHome(platform: NodeJS.Platform): { env: Record<string, string>; layout: Layout } {
  const home = sb.home;
  const env: Record<string, string> = { PATH: "" };
  let vscode: string;
  if (platform === "win32") {
    env.APPDATA = path.join(home, "AppData", "Roaming");
    vscode = path.join(env.APPDATA, "Code", "User");
  } else if (platform === "darwin") {
    vscode = path.join(home, "Library", "Application Support", "Code", "User");
  } else {
    vscode = path.join(home, ".config", "Code", "User");
  }
  for (const dir of [".claude", ".codex", ".cursor", ".gemini", ".kiro"]) mkdirSync(path.join(home, dir), { recursive: true });
  mkdirSync(vscode, { recursive: true });
  return {
    env,
    layout: {
      claudeMcp: path.join(home, ".claude.json"),
      claudeSkills: path.join(home, ".claude", "skills"),
      codexConfig: path.join(home, ".codex", "config.toml"),
      codexSkills: path.join(home, ".agents", "skills"),
      cursorMcp: path.join(home, ".cursor", "mcp.json"),
      cursorSkills: path.join(home, ".cursor", "skills"),
      vscodeMcp: path.join(vscode, "mcp.json"),
      copilotSkills: path.join(home, ".copilot", "skills"),
      geminiSettings: path.join(home, ".gemini", "settings.json"),
      geminiSkills: path.join(home, ".gemini", "skills"),
      kiroMcp: path.join(home, ".kiro", "settings", "mcp.json"),
      kiroSkills: path.join(home, ".kiro", "skills"),
    },
  };
}

function expectSkills(dir: string): void {
  expect(readdirSync(dir).sort()).toEqual(SKILLS);
  for (const skill of SKILLS) {
    const text = read(path.join(dir, skill, "SKILL.md"));
    expect(text.startsWith("---\n"), skill).toBe(true);
    expect(text).toContain("cavelon:generated: written by `cavelon setup`");
  }
}

describe("cavelon setup writes each agent's user configuration", () => {
  it.each([["linux"], ["darwin"], ["win32"]] as Array<[NodeJS.Platform]>)("on %s: the exact entries, nothing on a second run, and --remove restores the home", async (platform) => {
    const { env, layout } = agentHome(platform);
    const before = tree(sb.home);
    const entry = platform === "win32" ? NPX_WINDOWS : NPX;

    const first = await onPlatform(platform, () => cli(sb, ["setup", "--yes", "--json"], { env }));
    expect(first.code, first.stderr + first.stdout).toBe(0);
    const data = first.json<any>();
    expect(data.agents.map((a: any) => a.name)).toEqual(["claude", "codex", "cursor", "copilot", "gemini", "kiro"]);
    for (const agent of data.agents) {
      expect(agent.method).toBe("files");
      expect(agent.changes.map((c: any) => [c.kind, c.outcome])).toEqual([
        ["mcp", "done"],
        ["skills", "done"],
      ]);
    }
    expect(data.server).toEqual(entry);
    expect(data.login).toMatchObject({ status: "not_logged_in" });
    expect(data.next.join("\n")).toMatch(/cavelon login --instance/);

    expect(read(layout.claudeMcp)).toBe(JSON.stringify({ mcpServers: { cavelon: entry } }, null, 2) + "\n");
    expect(read(layout.cursorMcp)).toBe(JSON.stringify({ mcpServers: { cavelon: entry } }, null, 2) + "\n");
    expect(read(layout.vscodeMcp)).toBe(JSON.stringify({ servers: { cavelon: { type: "stdio", ...entry } } }, null, 2) + "\n");
    expect(read(layout.geminiSettings)).toBe(JSON.stringify({ mcpServers: { cavelon: entry } }, null, 2) + "\n");
    expect(read(layout.kiroMcp)).toBe(JSON.stringify({ mcpServers: { cavelon: entry } }, null, 2) + "\n");
    expect(read(layout.codexConfig)).toBe(
      [
        "# cavelon:begin",
        "[mcp_servers.cavelon]",
        `command = "${entry.command}"`,
        `args = [${entry.args.map((a) => `"${a}"`).join(", ")}]`,
        "# cavelon:end",
        "",
      ].join("\n"),
    );
    for (const dir of [layout.claudeSkills, layout.codexSkills, layout.cursorSkills, layout.copilotSkills, layout.geminiSkills, layout.kiroSkills]) expectSkills(dir);

    const written = tree(sb.home);
    const second = await onPlatform(platform, () => cli(sb, ["setup", "--yes", "--json"], { env }));
    expect(second.code).toBe(0);
    for (const agent of second.json<any>().agents) for (const change of agent.changes) expect(change.outcome).toBe("unchanged");
    expect(tree(sb.home)).toEqual(written);

    const removed = await onPlatform(platform, () => cli(sb, ["setup", "--remove", "--yes", "--json"], { env }));
    expect(removed.code, removed.stderr + removed.stdout).toBe(0);
    expect(tree(sb.home)).toEqual({ ...before, "config/": "" });
  });

  it("changes only its own entry in files that hold other settings, and --remove restores them byte for byte", async () => {
    const { env, layout } = agentHome("linux");
    const cursor = '{\n    "mcpServers": {\n        "github": {\n            "command": "gh-mcp"\n        }\n    }\n}\n';
    const gemini = '{\n  "theme": "Dracula"\n}';
    const codex = 'model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n';
    const vscode = '{\n  // my servers\n  "servers": {}\n}\n';
    mkdirSync(path.dirname(layout.kiroMcp), { recursive: true });
    const kiro = '{\r\n  "mcpServers": {}\r\n}\r\n';
    writeFileSync(layout.cursorMcp, cursor);
    writeFileSync(layout.geminiSettings, gemini);
    writeFileSync(layout.codexConfig, codex);
    writeFileSync(layout.vscodeMcp, vscode);
    writeFileSync(layout.kiroMcp, kiro);

    const result = await onPlatform("linux", () => cli(sb, ["setup", "--yes", "--json"], { env }));
    expect(result.code, result.stderr).toBe(0);
    expect(readJson(layout.cursorMcp).mcpServers).toEqual({ github: { command: "gh-mcp" }, cavelon: NPX });
    expect(read(layout.cursorMcp)).toMatch(/^\{\n {4}"mcpServers"/);
    expect(readJson(layout.geminiSettings)).toEqual({ theme: "Dracula", mcpServers: { cavelon: NPX } });
    expect(read(layout.codexConfig).startsWith(codex + "\n# cavelon:begin\n[mcp_servers.cavelon]\n")).toBe(true);
    expect(read(layout.kiroMcp)).toBe('{\r\n  "mcpServers": {\r\n    "cavelon": {\r\n      "command": "npx",\r\n      "args": [\r\n        "-y",\r\n        "@cavelon/cli@0.1",\r\n        "mcp"\r\n      ]\r\n    }\r\n  }\r\n}\r\n');
    // A file with comments is left as it is, with what to add.
    expect(read(layout.vscodeMcp)).toBe(vscode);
    const copilot = result.json<any>().agents.find((a: any) => a.name === "copilot");
    expect(copilot.changes[0]).toMatchObject({ kind: "mcp", outcome: "skipped" });
    expect(copilot.changes[0].reason).toMatch(/not plain JSON.*add "servers\.cavelon"/);

    const removed = await onPlatform("linux", () => cli(sb, ["setup", "--remove", "--yes"], { env }));
    expect(removed.code, removed.stderr + removed.stdout).toBe(0);
    expect(read(layout.cursorMcp)).toBe(cursor);
    expect(read(layout.geminiSettings)).toBe(gemini);
    expect(read(layout.codexConfig)).toBe(codex);
    expect(read(layout.vscodeMcp)).toBe(vscode);
    expect(read(layout.kiroMcp)).toBe(kiro);
  });

  it("leaves a cavelon server of the person's own, a skill file it did not write and a codex table of its own", async () => {
    const { env, layout } = agentHome("linux");
    const own = JSON.stringify({ mcpServers: { cavelon: { command: "/opt/dev/cavelon", args: ["mcp"] } } }, null, 2) + "\n";
    writeFileSync(layout.cursorMcp, own);
    const codex = '[mcp_servers.cavelon]\ncommand = "/opt/dev/cavelon"\nargs = ["mcp"]\n';
    writeFileSync(layout.codexConfig, codex);
    mkdirSync(path.join(layout.geminiSkills, "cavelon-loop"), { recursive: true });
    writeFileSync(path.join(layout.geminiSkills, "cavelon-loop", "SKILL.md"), "my own notes\n");

    const result = await onPlatform("linux", () => cli(sb, ["setup", "--yes", "--json", "--agents", "cursor,codex,gemini"], { env }));
    expect(result.code).toBe(0);
    const agents = result.json<any>().agents;
    expect(agents.find((a: any) => a.name === "cursor").changes[0]).toMatchObject({ outcome: "skipped", reason: expect.stringMatching(/of its own/) });
    expect(agents.find((a: any) => a.name === "codex").changes[0]).toMatchObject({ outcome: "skipped", reason: expect.stringMatching(/of its own/) });
    expect(agents.find((a: any) => a.name === "gemini").changes[1]).toMatchObject({ outcome: "done", reason: expect.stringMatching(/cavelon-loop\/SKILL\.md is not cavelon's/) });
    expect(read(layout.cursorMcp)).toBe(own);
    expect(read(layout.codexConfig)).toBe(codex);
    expect(read(path.join(layout.geminiSkills, "cavelon-loop", "SKILL.md"))).toBe("my own notes\n");

    await onPlatform("linux", () => cli(sb, ["setup", "--remove", "--yes"], { env }));
    expect(read(layout.cursorMcp)).toBe(own);
    expect(read(path.join(layout.geminiSkills, "cavelon-loop", "SKILL.md"))).toBe("my own notes\n");
    expect(existsSync(path.join(layout.geminiSkills, "cavelon-testing"))).toBe(false);
  });

  it("follows CLAUDE_CONFIG_DIR, CODEX_HOME and GEMINI_CLI_HOME", async () => {
    const claude = path.join(sb.home, "claude-config");
    const codex = path.join(sb.home, "codex-home");
    const gemini = path.join(sb.home, "gemini-home");
    for (const dir of [claude, codex, path.join(gemini, ".gemini")]) mkdirSync(dir, { recursive: true });
    const env = { PATH: "", CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, GEMINI_CLI_HOME: gemini };
    const result = await onPlatform("linux", () => cli(sb, ["setup", "--yes", "--json"], { env }));
    expect(result.code).toBe(0);
    expect(result.json<any>().agents.map((a: any) => a.name)).toEqual(["claude", "codex", "gemini"]);
    expect(readJson(path.join(claude, ".claude.json")).mcpServers.cavelon).toEqual(NPX);
    expectSkills(path.join(claude, "skills"));
    expect(read(path.join(codex, "config.toml"))).toContain("[mcp_servers.cavelon]");
    expect(readJson(path.join(gemini, ".gemini", "settings.json")).mcpServers.cavelon).toEqual(NPX);
  });

  it("names an agent that is not installed only when asked for it, and refuses unknown names", async () => {
    const env = { PATH: "" };
    const none = await cli(sb, ["setup", "--yes"], { env });
    expect(none.code).toBe(0);
    expect(none.stdout).toMatch(/No coding agent found/);
    expect(none.stdout).toMatch(/cavelon setup --agents cursor/);
    const named = await onPlatform("linux", () => cli(sb, ["setup", "--yes", "--json", "--agents", "kiro"], { env }));
    expect(named.json<any>().agents.map((a: any) => a.name)).toEqual(["kiro"]);
    expect(existsSync(path.join(sb.home, ".kiro", "settings", "mcp.json"))).toBe(true);
    const unknown = await cli(sb, ["setup", "--agents", "notepad", "--json"], { env });
    expect(unknown.code).toBe(2);
    expect(unknown.json<any>().error.message).toMatch(/Unknown agent "notepad"/);
  });
});

describe.skipIf(process.platform === "win32")("with cavelon installed", () => {
  it("entries start `cavelon mcp`, and an entry in the npx form moves to it", async () => {
    const { layout } = agentHome("linux");
    const npxFirst = await cli(sb, ["setup", "--yes", "--agents", "cursor,codex"], { env: { PATH: "" } });
    expect(npxFirst.code).toBe(0);
    expect(readJson(layout.cursorMcp).mcpServers.cavelon).toEqual(NPX);
    const bin = fakeBin(["cavelon"]);
    const result = await cli(sb, ["setup", "--yes", "--json", "--agents", "cursor,codex"], { env: pathEnv(bin) });
    expect(result.json<any>().server).toEqual(INSTALLED);
    expect(readJson(layout.cursorMcp).mcpServers.cavelon).toEqual(INSTALLED);
    expect(read(layout.codexConfig)).toBe('# cavelon:begin\n[mcp_servers.cavelon]\ncommand = "cavelon"\nargs = ["mcp"]\n# cavelon:end\n');
    // Either form is the kit's own, so --remove takes it out.
    await cli(sb, ["setup", "--remove", "--yes"], { env: pathEnv(bin) });
    expect(existsSync(layout.cursorMcp)).toBe(false);
    expect(existsSync(layout.codexConfig)).toBe(false);
  });
});

describe("Claude Code and Codex get the plugin through their own commands", () => {
  it("adds the marketplace and installs the plugin once; --remove undoes exactly that", async () => {
    const env = pathEnv(fakeBin(["claude", "codex"]));
    const result = await cli(sb, ["setup", "--yes", "--json"], { env });
    expect(result.code, result.stderr + result.stdout).toBe(0);
    const agents = result.json<any>().agents;
    expect(agents.map((a: any) => [a.name, a.method])).toEqual([
      ["claude", "plugin"],
      ["codex", "plugin"],
    ]);
    const plugin = (name: string) => agents.find((a: any) => a.name === name).changes.filter((c: any) => c.kind !== "mcp");
    expect(plugin("claude")).toEqual([
      { kind: "marketplace", summary: expect.any(String), target: `claude plugin marketplace add ${MARKETPLACE_SOURCE}`, outcome: "done" },
      { kind: "plugin", summary: expect.any(String), target: `claude plugin install ${PLUGIN_ID} --scope user`, outcome: "done" },
    ]);
    expect(plugin("codex").map((c: any) => c.target)).toEqual([`codex plugin marketplace add ${MARKETPLACE_SOURCE}`, `codex plugin add ${PLUGIN_ID}`]);
    expect(log("claude")).toEqual([
      "plugin list --json",
      "plugin marketplace list --json",
      `plugin marketplace add ${MARKETPLACE_SOURCE}`,
      `plugin install ${PLUGIN_ID} --scope user`,
    ]);
    // The plugin brings the skills; no skills folder is written.
    expect(existsSync(path.join(sb.home, ".claude", "skills"))).toBe(false);
    expect(existsSync(path.join(sb.home, ".agents", "skills"))).toBe(false);
    // On native Windows the plugin's npx entry cannot start, so the server goes into the user MCP file too.
    const claudeJson = path.join(sb.home, ".claude.json");
    if (process.platform === "win32") expect(readJson(claudeJson).mcpServers.cavelon).toEqual(NPX_WINDOWS);
    else expect(existsSync(claudeJson)).toBe(false);

    const again = await cli(sb, ["setup", "--yes", "--json"], { env });
    for (const agent of again.json<any>().agents) for (const change of agent.changes) expect(change.outcome).toBe("unchanged");
    expect(log("claude").slice(4)).toEqual(["plugin list --json", "plugin marketplace list --json"]);

    const removed = await cli(sb, ["setup", "--remove", "--yes"], { env });
    expect(removed.code, removed.stderr + removed.stdout).toBe(0);
    expect(log("claude").slice(6)).toEqual([`plugin uninstall ${PLUGIN_ID} --scope user`, `plugin marketplace remove ${MARKETPLACE}`]);
    expect(log("codex").slice(-2)).toEqual([`plugin remove ${PLUGIN_ID}`, `plugin marketplace remove ${MARKETPLACE}`]);
    expect(existsSync(claudeJson)).toBe(false);
    expect(existsSync(path.join(sb.env.CAVELON_CONFIG_DIR!, "setup.json"))).toBe(false);
  });

  it("keeps a marketplace the person added before, and reports a failing command", async () => {
    const env = pathEnv(fakeBin(["claude"]));
    writeFileSync(path.join(sb.home, ".fake-claude.json"), JSON.stringify({ marketplaces: [MARKETPLACE], plugins: [] }));
    const failing = await cli(sb, ["setup", "--yes", "--json"], { env: { ...env, FAKE_AGENT_FAIL: "plugin install" } });
    expect(failing.code).toBe(1);
    const change = failing.json<any>().agents[0].changes.find((c: any) => c.kind === "plugin");
    expect(change).toMatchObject({ outcome: "failed", reason: "claude: could not reach github.com" });

    const result = await cli(sb, ["setup", "--yes", "--json"], { env });
    expect(result.code).toBe(0);
    expect(log("claude")).not.toContain(`plugin marketplace add ${MARKETPLACE_SOURCE}`);
    await cli(sb, ["setup", "--remove", "--yes"], { env });
    expect(log("claude")).toContain(`plugin uninstall ${PLUGIN_ID} --scope user`);
    expect(log("claude")).not.toContain(`plugin marketplace remove ${MARKETPLACE}`);
  });

  it("uses the files when the agent's folder is there but not its command", async () => {
    mkdirSync(path.join(sb.home, ".claude"));
    const result = await onPlatform("linux", () => cli(sb, ["setup", "--yes", "--json"], { env: { PATH: "" } }));
    expect(result.json<any>().agents[0]).toMatchObject({ name: "claude", method: "files" });
    expect(readJson(path.join(sb.home, ".claude.json")).mcpServers.cavelon).toEqual(NPX);
  });
});

describe("asking a person", () => {
  it("without a terminal and without --yes it changes nothing and shows the plan", async () => {
    const { env, layout } = agentHome("linux");
    const result = await onPlatform("linux", () => cli(sb, ["setup", "--json"], { env }));
    expect(result.code).toBe(2);
    const error = result.json<any>().error;
    expect(error.code).toBe("confirmation_required");
    expect(error.details.agents.find((a: any) => a.name === "cursor").changes[0]).toMatchObject({ kind: "mcp", outcome: "planned", target: layout.cursorMcp });
    expect(existsSync(layout.cursorMcp)).toBe(false);
  });

  it("on a terminal it shows what changes and asks once; no changes nothing", async () => {
    const { env, layout } = agentHome("linux");
    const declined = await onPlatform("linux", () => cli(sb, ["setup", "--agents", "cursor"], { env, tty: true, stdin: "n\n" }));
    expect(declined.code).toBe(0);
    expect(declined.stderr).toContain("cavelon setup will change this for you:");
    expect(declined.stderr).toContain(`add the "cavelon" tools server to ${layout.cursorMcp}`);
    expect(declined.stderr).toMatch(/Make these changes\? \[Y\/n\]/);
    expect(declined.stdout).toMatch(/Nothing was changed/);
    expect(existsSync(layout.cursorMcp)).toBe(false);
  });

  it("Enter takes the default: yes to the changes; then an empty address leaves the login for later", async () => {
    const { env, layout } = agentHome("linux");
    const result = await onPlatform("linux", () => cli(sb, ["setup", "--agents", "cursor"], { env, tty: true, stdin: "\n\n" }));
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(readJson(layout.cursorMcp).mcpServers.cavelon).toEqual(NPX);
    expect(result.stderr).toMatch(/Cavelon address \(Enter to log in later\)/);
    expect(result.stdout).toMatch(/Log in later: cavelon login --instance/);
    expect(result.stdout).toMatch(/Open an empty folder in Cursor and describe what to build/);
    expect(result.stdout).toMatch(/Restart Cursor if it is open/);
  });

  it("--remove asks too, and its default is no", async () => {
    const { env, layout } = agentHome("linux");
    await onPlatform("linux", () => cli(sb, ["setup", "--yes", "--agents", "cursor"], { env }));
    const kept = await onPlatform("linux", () => cli(sb, ["setup", "--remove"], { env, tty: true, stdin: "\n" }));
    expect(kept.stderr).toMatch(/Undo these changes\? \[y\/N\]/);
    expect(existsSync(layout.cursorMcp)).toBe(true);
    const removed = await onPlatform("linux", () => cli(sb, ["setup", "--remove"], { env, tty: true, stdin: "y\n" }));
    expect(removed.code).toBe(0);
    expect(existsSync(layout.cursorMcp)).toBe(false);
    const nothing = await cli(sb, ["setup", "--remove"], { env });
    expect(nothing.stdout).toMatch(/Nothing to remove/);
  });

  it("is a command for people only: no MCP tool", () => {
    expect(COMMANDS.find((c) => c.name === "setup")!.mcpTool).toBe(false);
  });
});

describe("login and --check", () => {
  let server: FakeServer;
  let token: string;

  beforeAll(async () => {
    server = await startFakeServer();
    const tenant = server.addTenant("acme", "Acme");
    token = server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant });
  });
  afterAll(async () => {
    await server.close();
  });

  it("logs in through login, asking for the address and the token", async () => {
    const { env } = agentHome("linux");
    const address = server.url.replace(/^http:\/\//, "http://");
    const result = await onPlatform("linux", () =>
      cli(sb, ["setup", "--agents", "cursor"], { env, tty: true, stdin: `\n${address}\n${token}\n` }),
    );
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(result.stderr).toMatch(/Personal access tokens/);
    expect(result.stdout).toMatch(/Logged in to /);
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).not.toContain(token);
    const again = await onPlatform("linux", () => cli(sb, ["setup", "--yes", "--agents", "cursor"], { env }));
    expect(again.stdout).toMatch(/Already logged in to /);
  });

  it("an operator's token that reaches every tenant: Enter at the tenant question logs in without a tenant", async () => {
    const { env } = agentHome("linux");
    const operator = server.addToken({ kind: "pat", tenantIds: [], reachesAll: true, globalRole: "superadmin" });
    const result = await onPlatform("linux", () =>
      cli(sb, ["setup", "--agents", "cursor"], { env: { ...env, NO_COLOR: "1" }, tty: true, stdin: `\n${server.url}\n${operator}\n\n` }),
    );
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(result.stderr).toContain("Which tenant to start in? (type part of its name, or press Enter to choose later)");
    expect(result.stdout).toContain("No tenant is chosen yet: `cavelon use <name or slug>` chooses one");
    expect(result.stdout + result.stderr).not.toContain(operator);
  });

  it.skipIf(process.platform === "win32")("reports each agent, the server starting and the login", async () => {
    const { layout } = agentHome(process.platform);
    const env = pathEnv(fakeBin(["cavelon", "claude"]));
    await cli(sb, ["setup", "--yes", "--agents", "claude,cursor,codex"], { env });
    const notLoggedIn = await cli(sb, ["setup", "--check", "--json"], { env });
    expect(notLoggedIn.code).toBe(1);
    const report = notLoggedIn.json<any>();
    expect(report.agents.map((a: any) => [a.name, a.ok])).toEqual([
      ["claude", true],
      ["codex", true],
      ["cursor", true],
      ["copilot", false],
      ["gemini", false],
      ["kiro", false],
    ]);
    expect(report.agents.find((a: any) => a.name === "cursor").details.join("\n")).toContain(layout.cursorMcp);
    // Codex without its command on the PATH: the TOML block, read back.
    expect(report.agents.find((a: any) => a.name === "codex")).toMatchObject({ method: "files", ok: true });
    // The plugin and the files both start the installed cavelon, which answers.
    expect(report.server).toEqual([{ command: "cavelon mcp", ok: true, server: "cavelon 9.9.9" }]);
    expect(report.login).toMatchObject({ ok: false, problem: expect.stringMatching(/not logged in/) });

    await login(sb, server.url, token);
    const text = await cli(sb, ["setup", "--check", "--agents", "cursor"], { env });
    expect(text.code, text.stdout).toBe(0);
    expect(text.stdout).toMatch(/ok {2}Cursor/);
    expect(text.stdout).toMatch(/ok {2}The Cavelon tools start: cavelon mcp \(cavelon 9\.9\.9\)/);
    expect(text.stdout).toMatch(/ok {2}Logged in to .* tenant Acme/);

    // Agents found but never set up for Cavelon are reported and skipped; --strict counts them.
    const all = await cli(sb, ["setup", "--check"], { env });
    expect(all.code, all.stdout).toBe(0);
    expect(all.stdout).toMatch(/^skip {2}VS Code with GitHub Copilot: found, not set up for Cavelon \(cavelon setup --agents copilot sets it up\)$/m);
    expect((await cli(sb, ["setup", "--check", "--json"], { env })).json<any>().agents.find((a: any) => a.name === "gemini")).toMatchObject({ ok: false, skipped: true });
    const strict = await cli(sb, ["setup", "--check", "--strict"], { env });
    expect(strict.code).toBe(1);
    expect(strict.stdout).toMatch(/^no {2}VS Code with GitHub Copilot$/m);
    expect((await cli(sb, ["setup", "--strict"], { env })).code).toBe(2);
  });

  it("--check without anything set up says what is missing", async () => {
    const result = await cli(sb, ["setup", "--check"], { env: { PATH: "" } });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/No coding agent found/);
    expect(result.stdout).toMatch(/no {2}The Cavelon tools start: (cmd \/c )?npx -y @cavelon\/cli@0\.1 mcp \(/);
    expect(result.stdout).toMatch(/Login: not logged in/);
  });
});

describe("marked entries come out as they went in", () => {
  it("removeBlock undoes upsertBlock", () => {
    for (const original of [undefined, "", "a = 1\n", "a = 1\n\n[x]\nb = 2\n", "a = 1\r\n"]) {
      const added = upsertBlock(original, "[mcp_servers.cavelon]\ncommand = \"cavelon\"", "hash").content!;
      const removed = removeBlock(added, "hash");
      if (!original) expect(removed.empty).toBe(true);
      else expect(removed.content).toBe(original);
    }
  });

  it("removeJsonEntry undoes upsertJsonEntry, keeping parents the file had", () => {
    const value = { command: "cavelon", args: ["mcp"] };
    const same = (v: unknown) => JSON.stringify(v) === JSON.stringify(value);
    for (const [original, kept] of [
      ['{\n  "theme": "x"\n}\n', 0],
      ['{\n  "mcpServers": {}\n}\n', 1],
      ['{\n\t"mcpServers": {\n\t\t"a": {}\n\t}\n}', 1],
    ] as Array<[string, number]>) {
      const added = upsertJsonEntry(original, ["mcpServers", "cavelon"], value).content!;
      expect(removeJsonEntry(added, ["mcpServers", "cavelon"], same, kept).content).toBe(original);
    }
    const changed = removeJsonEntry('{"mcpServers":{"cavelon":{"command":"x"}}}', ["mcpServers", "cavelon"], same);
    expect(changed.outcome).toBe("skipped");
  });

  it("names the marketplace and plugin this repository publishes", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const market = JSON.parse(read(path.join(root, ".claude-plugin", "marketplace.json"))) as { name: string; plugins: Array<{ name: string }> };
    const codex = JSON.parse(read(path.join(root, ".agents", "plugins", "marketplace.json"))) as { name: string; plugins: Array<{ name: string }> };
    expect(MARKETPLACE).toBe(market.name);
    expect(MARKETPLACE).toBe(codex.name);
    expect(PLUGIN_ID).toBe(`${market.plugins[0]!.name}@${market.name}`);
    expect(statSync(path.join(root, "plugin")).isDirectory()).toBe(true);
  });
});
