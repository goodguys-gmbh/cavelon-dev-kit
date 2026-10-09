import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsoncEntry } from "../src/jsonc-config.js";
import { EARLIER_RELEASE_LINES, mcpCommand } from "../src/mcp-command.js";
import { agentByName, applyPlan, checkAgent, loadSkills, planAgent, removeAgent, setupAgents, type AgentRecord } from "../src/setup-agents.js";
import { KIT_VERSION } from "../src/version.js";
import { startFakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * A person who set up an earlier release line keeps its `npx -y @cavelon/cli@0.1`
 * entries until the new kit moves them: setup, init --update and setup --remove
 * must still treat them as the kit's own, and leave everything else as it was.
 */

const CURRENT = "@cavelon/cli@0.2";
const EARLIER = "@cavelon/cli@0.1";
const read = (file: string) => readFileSync(file, "utf8");
const earlier = (text: string) => text.split(CURRENT).join(EARLIER);

let sb: Sandbox;
beforeEach(() => { sb = sandbox(); });
afterEach(() => sb.cleanup());

async function onLinux<T>(run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: "linux" });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

it("knows this minor's pin and every earlier line's", () => {
  const minor = Number(KIT_VERSION.split(".")[1]);
  expect(mcpCommand("linux").args[1]).toBe(CURRENT);
  expect(EARLIER_RELEASE_LINES).toEqual(Array.from({ length: minor - 1 }, (_, i) => `0.${minor - 1 - i}`));
});

describe("cavelon setup over an earlier release line's files", () => {
  const files = () => ({
    cursor: path.join(sb.home, ".cursor", "mcp.json"),
    gemini: path.join(sb.home, ".gemini", "settings.json"),
    codex: path.join(sb.home, ".codex", "config.toml"),
    kiro: path.join(sb.home, ".kiro", "settings", "mcp.json"),
  });
  const customer = {
    cursor: '{\n    "mcpServers": {\n        "github": {\n            "command": "gh-mcp"\n        }\n    }\n}\n',
    gemini: '{\n  "theme": "Dracula"\n}',
    codex: '# my model\nmodel = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n',
    kiro: '{\r\n  "mcpServers": {\r\n    "notes": {\r\n      "command": "notes-mcp"\r\n    }\r\n  }\r\n}\r\n',
  };
  const env = { PATH: "" };
  const agents = ["setup", "--yes", "--json", "--agents", "cursor,gemini,codex,kiro"];
  // Without a login or npx the whole check fails; each agent's own part must not.
  const checked = async () => {
    const check = await onLinux(() => cli(sb, ["setup", "--check", "--json"], { env }));
    return check.json<any>().agents.map((agent: any) => [agent.name, agent.ok]);
  };
  const allOk = [["codex", true], ["cursor", true], ["gemini", true], ["kiro", true]];

  /** The homes as the earlier line's setup left them: the same bytes, with its pin. */
  async function setUpEarlierLine(): Promise<Record<keyof typeof customer, string>> {
    const at = files();
    for (const name of Object.keys(at) as Array<keyof typeof customer>) {
      mkdirSync(path.dirname(at[name]), { recursive: true });
      writeFileSync(at[name], customer[name]);
    }
    const first = await onLinux(() => cli(sb, agents, { env }));
    expect(first.code, first.stderr + first.stdout).toBe(0);
    for (const file of Object.values(at)) writeFileSync(file, earlier(read(file)));
    for (const file of Object.values(at)) expect(read(file)).toContain(EARLIER);
    return at;
  }

  it("moves each entry to this line, keeps the person's servers and comments, checks and removes cleanly", async () => {
    const at = await setUpEarlierLine();
    expect(await checked()).toEqual(allOk);

    const update = await onLinux(() => cli(sb, agents, { env }));
    expect(update.code, update.stderr + update.stdout).toBe(0);
    for (const agent of update.json<any>().agents) expect(agent.changes.find((c: any) => c.kind === "mcp")).toMatchObject({ outcome: "done" });
    for (const file of Object.values(at)) {
      expect(read(file)).toContain(CURRENT);
      expect(read(file)).not.toContain(EARLIER);
    }
    expect(JSON.parse(read(at.cursor)).mcpServers.github).toEqual({ command: "gh-mcp" });
    expect(JSON.parse(read(at.gemini)).theme).toBe("Dracula");
    expect(read(at.codex).startsWith(customer.codex)).toBe(true);
    expect(read(at.kiro)).toContain('"notes": {\r\n      "command": "notes-mcp"\r\n    }');
    expect(await checked()).toEqual(allOk);

    const removed = await onLinux(() => cli(sb, ["setup", "--remove", "--yes"], { env }));
    expect(removed.code, removed.stderr + removed.stdout).toBe(0);
    for (const name of Object.keys(at) as Array<keyof typeof customer>) expect(read(at[name])).toBe(customer[name]);
  });

  it("--remove takes out the earlier line's entries without an update first", async () => {
    const at = await setUpEarlierLine();
    const removed = await onLinux(() => cli(sb, ["setup", "--remove", "--yes", "--json"], { env }));
    expect(removed.code, removed.stderr + removed.stdout).toBe(0);
    for (const agent of removed.json<any>().agents) expect(agent.changes.find((c: any) => c.kind === "mcp")).toMatchObject({ outcome: "removed" });
    for (const name of Object.keys(at) as Array<keyof typeof customer>) expect(read(at[name])).toBe(customer[name]);
  });
});

describe("a native client's settings from an earlier release line", () => {
  it("setup updates and removes the entry, keeping comments and personal servers", async () => {
    const env = { ...sb.env, PATH: "" };
    const agent = agentByName(setupAgents(env, "linux"), "qwen")!;
    mkdirSync(path.dirname(agent.mcp.file), { recursive: true });
    const before = '{\n// my model\n"model":{"name":"internal/model"},\n"mcpServers":{"other":{"command":"other-mcp","args":[]}}\n}\n';
    writeFileSync(agent.mcp.file, before);
    const skills = await loadSkills();
    const record: AgentRecord = {};
    const old = mcpCommand("linux", "0.1");
    await applyPlan(await planAgent(agent, {}, env, old, skills, "linux"), env, old, skills, record);
    expect(readJsoncEntry(read(agent.mcp.file), ["mcpServers", "cavelon"])).toMatchObject({ value: old });
    const installedByEarlier = read(agent.mcp.file);

    const current = mcpCommand("linux");
    const update = await planAgent(agent, {}, env, current, skills, "linux");
    expect(update.changes.find(change => change.kind === "mcp")).toMatchObject({ outcome: "planned" });
    await applyPlan(update, env, current, skills, record);
    expect(readJsoncEntry(read(agent.mcp.file), ["mcpServers", "cavelon"])).toMatchObject({ value: current });
    expect(read(agent.mcp.file)).toContain("// my model");
    expect(await checkAgent(agent, env, record, "linux")).toMatchObject({ ok: true, servers: [current] });

    writeFileSync(agent.mcp.file, installedByEarlier);
    const change = (await removeAgent(agent, record, env, skills, new Set())).find(item => item.kind === "mcp");
    expect(change).toMatchObject({ outcome: "removed" });
    expect(read(agent.mcp.file)).toBe(before);
  });

  it("an earlier line's entry with personal options stays the person's", async () => {
    const env = { ...sb.env, PATH: "" };
    const agent = agentByName(setupAgents(env, "linux"), "qwen")!;
    mkdirSync(path.dirname(agent.mcp.file), { recursive: true });
    const personal = `{"mcpServers":{"cavelon":${JSON.stringify({ ...mcpCommand("linux", "0.1"), env: { CUSTOM: "synthetic" } })}}}`;
    writeFileSync(agent.mcp.file, personal);
    const skills = await loadSkills();
    const record: AgentRecord = {};
    const plan = await planAgent(agent, {}, env, mcpCommand("linux"), skills, "linux");
    expect(plan.changes.find(change => change.kind === "mcp")).toMatchObject({ outcome: "skipped" });
    await applyPlan(plan, env, mcpCommand("linux"), skills, record);
    record.mcp = { file: agent.mcp.file, created: false, kept: 1 };
    expect((await removeAgent(agent, record, env, skills, new Set())).find(item => item.kind === "mcp")).toMatchObject({ outcome: "skipped" });
    expect(read(agent.mcp.file)).toBe(personal);
  });

  it("init --update moves project entries to this line and leaves current and installed entries alone", async () => {
    const server = await startFakeServer();
    try {
      const tenant = server.addTenant("example", "Example");
      await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
      const project = path.join(sb.home, "solution");
      mkdirSync(path.join(project, ".qwen"), { recursive: true });
      const file = path.join(project, ".qwen", "settings.json");
      const env = { PATH: "" };
      const init = await cli(sb, ["init", "--agents", "qwen-code,claude,codex", "--json"], { cwd: project, env });
      expect(init.code, init.stderr + init.stdout).toBe(0);
      const settings = (entry: unknown) => `{\n// project model\n"model":{"name":"internal/model"},\n"mcpServers":{"other":{"command":"other-mcp","args":[]},"cavelon":${JSON.stringify(entry)}}\n}\n`;

      const claude = path.join(project, ".mcp.json");
      const codex = path.join(project, ".codex", "config.toml");
      const mine = '# my model\nmodel = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n\n';
      writeFileSync(codex, mine + earlier(read(codex)));
      writeFileSync(claude, `${JSON.stringify({ mcpServers: { other: { command: "other-mcp" }, cavelon: mcpCommand(process.platform, "0.1") } }, null, 2)}\n`);
      writeFileSync(file, settings(mcpCommand("win32", "0.1")));
      const update = await cli(sb, ["init", "--update", "--json"], { cwd: project, env });
      expect(update.code, update.stderr + update.stdout).toBe(0);
      expect(JSON.parse(read(claude))).toEqual({ mcpServers: { other: { command: "other-mcp" }, cavelon: mcpCommand() } });
      expect(read(codex).startsWith(mine)).toBe(true);
      expect(read(codex)).toContain(CURRENT);
      expect(read(codex)).not.toContain(EARLIER);
      expect(readJsoncEntry(read(file), ["mcpServers", "cavelon"])).toMatchObject({ value: mcpCommand() });
      expect(read(file)).toContain("// project model");
      expect(readJsoncEntry(read(file), ["mcpServers", "other"])).toMatchObject({ value: { command: "other-mcp", args: [] } });

      for (const entry of [{ command: "cavelon", args: ["mcp"] }, mcpCommand("win32"), mcpCommand("linux")]) {
        writeFileSync(file, settings(entry));
        expect((await cli(sb, ["init", "--update", "--json"], { cwd: project, env })).code).toBe(0);
        expect(read(file)).toBe(settings(entry));
      }
    } finally { await server.close(); }
  });
});
