import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentByName, applyPlan, checkAgent, loadSkills, planAgent, removeAgent, serverCommand, setupAgents, type AgentRecord } from "../src/setup-agents.js";
import { readJsoncEntry } from "../src/jsonc-config.js";
import { startFakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox;
beforeEach(() => { sb = sandbox(); });
afterEach(() => sb.cleanup());

const read = (file: string) => readFileSync(file, "utf8");
const installed = { command: "cavelon", args: ["mcp"] };

async function setupClient(name: string, env: Record<string, string> = sb.env) {
  const agent = agentByName(setupAgents(env), name)!;
  const skills = await loadSkills();
  const record: AgentRecord = {};
  const plan = await planAgent(agent, { folder: path.dirname(agent.mcp.file) }, env, installed, skills);
  const changes = await applyPlan(plan, env, installed, skills, record);
  return { agent, skills, record, changes, env };
}

describe("OpenCode and Pi setup", () => {
  it("sets up OpenCode's user command array and native skills", async () => {
    const agent = agentByName(setupAgents(sb.env), "opencode");
    expect(agent, "OpenCode is a user-level setup target").toBeDefined();
    const skills = await loadSkills();
    const plan = await planAgent(agent!, {}, sb.env, installed, skills);
    const record: AgentRecord = {};
    const changes = await applyPlan(plan, sb.env, installed, skills, record);
    expect(changes.every(change => change.outcome === "done")).toBe(true);
    expect(JSON.parse(read(agent!.mcp.file))).toEqual({ mcp: { cavelon: { type: "local", command: ["cavelon", "mcp"], enabled: false } }, plugin: ["./cavelon/opencode-server-entry.mjs"] });
    for (const skill of skills) expect(existsSync(path.join(agent!.skills, skill.name, "SKILL.md"))).toBe(true);
  });

  it("initializes Pi's native project MCP and skills instead of relying on generic copies", async () => {
    const server = await startFakeServer();
    try {
      const tenant = server.addTenant("example", "Example");
      await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
      const project = path.join(sb.home, "solution");
      mkdirSync(project);
      const result = await cli(sb, ["init", "--agents", "pi", "--json"], { cwd: project });
      expect(result.code, result.stderr + result.stdout).toBe(0);
      const entry = JSON.parse(read(path.join(project, ".pi", "mcp.json"))).mcpServers.cavelon;
      expect(entry.args.at(-1)).toBe("mcp");
      expect(entry.enabled).toBe(false);
      expect(JSON.parse(read(path.join(project, ".pi", "cavelon", "profile.json")))).toMatchObject({ format: 2, scope: "project" });
      expect(readJsoncEntry(read(path.join(project, ".pi", "settings.json")), ["extensions"])).toMatchObject({ value: ["./cavelon/pi-extension.mjs"] });
      for (const skill of await loadSkills()) expect(existsSync(path.join(project, ".pi", "skills", skill.name, "SKILL.md"))).toBe(true);
      expect(existsSync(path.join(project, "opencode.json"))).toBe(false);
      expect(result.stdout).toContain("project trust");
      const skillFile = path.join(project, ".pi", "skills", "cavelon-loop", "SKILL.md");
      const skill = read(skillFile);
      writeFileSync(skillFile, skill.replace("# The Cavelon development loop", "# Old version"));
      const mcpFile = path.join(project, ".pi", "mcp.json");
      const mcp = JSON.stringify({ mcpServers: { cavelon: installed } });
      writeFileSync(mcpFile, mcp);
      const update = await cli(sb, ["init", "--update", "--json"], { cwd: project });
      expect(update.code, update.stderr).toBe(0);
      expect(read(skillFile)).toBe(skill);
      expect(read(mcpFile)).toBe(mcp);
      const openCodeProject = path.join(sb.home, "opencode solution");
      mkdirSync(openCodeProject);
      const jsoncFile = path.join(openCodeProject, "opencode.jsonc");
      const before = '{\n// operator settings\n"mcp":{"other":{"type":"local","command":["other"]}}\n}\n';
      writeFileSync(jsoncFile, before);
      const openCode = await cli(sb, ["init", "--agents", "opencode-ai", "--json"], { cwd: openCodeProject });
      expect(openCode.code, openCode.stderr).toBe(0);
      expect(readJsoncEntry(read(jsoncFile), ["mcp", "cavelon"])).toMatchObject({ value: { type: "local", enabled: false } });
      expect(existsSync(path.join(openCodeProject, ".opencode", "cavelon", "installation.json"))).toBe(true);
      expect(read(jsoncFile)).toContain("// operator settings");
      expect(existsSync(path.join(openCodeProject, "opencode.json"))).toBe(false);
      expect(existsSync(path.join(openCodeProject, ".pi"))).toBe(false);
      const installedJsonc = '{\n// operator settings\n"mcp":{"cavelon":{"type":"local","command":["cmd","/c","npx","-y","@cavelon/cli@0.2","mcp"]}}\n}\n';
      writeFileSync(jsoncFile, installedJsonc);
      expect((await cli(sb, ["init", "--update", "--json"], { cwd: openCodeProject })).code).toBe(0);
      expect(read(jsoncFile)).toBe(installedJsonc);
    } finally {
      await server.close();
    }
  });

  it.each(["linux", "darwin", "win32"] as const)("keeps the platform-aware process command on %s", async platform => {
    const env = { ...sb.env, PATH: "" };
    const command = await serverCommand(env, platform);
    for (const name of ["opencode", "pi"]) {
      const agent = agentByName(setupAgents(env, platform), name)!;
      const skills = await loadSkills();
      const plan = await planAgent(agent, {}, env, command, skills, platform);
      await applyPlan(plan, env, command, skills, {});
      const data = JSON.parse(read(agent.mcp.file));
      const entry = name === "opencode" ? data.mcp.cavelon : data.mcpServers.cavelon;
      expect(entry.command).toEqual(name === "opencode" ? [command.command, ...command.args] : command.command);
      if (name === "pi") expect(entry.args).toEqual(command.args);
    }
  });

  it("updates and removes an existing JSONC file without a companion or lost comments/modes", async () => {
    const env = { ...sb.env, XDG_CONFIG_HOME: path.join(sb.home, "config with spaces") };
    const dir = path.join(env.XDG_CONFIG_HOME, "opencode");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "opencode.jsonc");
    const before = '{\r\n  // personal model\r\n  "model": "internal/model",\r\n  "mcp": { "other": { "type": "local", "command": ["other"] } }\r\n}\r\n';
    writeFileSync(file, before);
    chmodSync(file, 0o640);
    const { agent, skills, record, changes } = await setupClient("opencode", env);
    expect(changes[0]!.target).toBe(path.join(dir, "cavelon"));
    expect(read(file)).toContain('// personal model\r\n  "model": "internal/model"');
    expect(existsSync(agent.mcp.file)).toBe(false);
    expect(record.native?.directory).toBe(path.join(dir, "cavelon"));
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o640);
    const rerun = await planAgent(agent, {}, env, installed, skills);
    expect(rerun.changes.every(change => change.outcome === "unchanged")).toBe(true);
    const check = await checkAgent(agent, env, record);
    expect(check.ok, check.details.join("\n")).toBe(true);
    expect(check.servers).toEqual([installed]);
    expect(check.details.some(detail => detail.includes("native tools and person-dialog files"))).toBe(true);
    const moved = agentByName(setupAgents({ ...env, OPENCODE_CONFIG_DIR: path.join(sb.home, "later override") }), "opencode")!;
    await removeAgent(moved, record, env, skills, new Set());
    expect(readJsoncEntry(read(file), ["mcp", "cavelon"])).toMatchObject({ value: undefined });
    expect(readJsoncEntry(read(file), ["mcp", "other"])).toMatchObject({ value: { type: "local", command: ["other"] } });
    expect(read(file)).toContain('// personal model\r\n  "model": "internal/model"');
  });

  it("preserves a personal server and refuses competing entries rather than shadowing either", async () => {
    const agent = agentByName(setupAgents(sb.env), "opencode")!;
    const dir = path.dirname(agent.mcp.file);
    mkdirSync(dir, { recursive: true });
    const before = JSON.stringify({ mcp: { cavelon: { type: "local", command: ["personal"], env: { EXAMPLE: "value" } } } });
    writeFileSync(agent.mcp.file, before);
    let plan = await planAgent(agent, {}, sb.env, installed, await loadSkills());
    expect(plan.changes[0]!.outcome).toBe("skipped");
    expect(read(agent.mcp.file)).toBe(before);
    const companion = path.join(dir, "opencode.jsonc");
    expect(existsSync(companion)).toBe(false);
    writeFileSync(companion, JSON.stringify({ mcp: { cavelon: { type: "local", command: ["cavelon", "mcp"] } } }));
    plan = await planAgent(agent, {}, sb.env, installed, await loadSkills());
    expect(plan.changes[0]!.reason).toContain("multiple configuration files");
    expect((await checkAgent(agent, sb.env, undefined)).ok).toBe(false);
  });

  it("leaves inline-managed OpenCode configuration alone", async () => {
    const env = { ...sb.env, OPENCODE_CONFIG_CONTENT: '{"mcp":{}}' };
    const { agent, changes } = await setupClient("opencode", env);
    expect(changes[0]).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("OPENCODE_CONFIG_CONTENT") });
    expect(existsSync(agent.mcp.file)).toBe(false);
  });

  it("uses Pi's overridden user directory and keeps personally edited entries on removal", async () => {
    const env = { ...sb.env, PI_CODING_AGENT_DIR: path.join(sb.home, "private pi") };
    const { agent, record, skills } = await setupClient("pi-coding-agent", env);
    expect(agent.mcp.file).toBe(path.join(env.PI_CODING_AGENT_DIR, "mcp.json"));
    const check = await checkAgent(agent, env, record);
    expect(check.ok).toBe(true);
    expect(check.details.join("\n")).toContain("own terminal");
    const edited = JSON.stringify({ mcpServers: { cavelon: { ...installed, timeout: 75 } } });
    writeFileSync(agent.mcp.file, edited);
    const changes = await removeAgent(agent, record, env, skills, new Set());
    expect(changes[0]!.outcome).toBe("skipped");
    expect(read(agent.mcp.file)).toBe(edited);
  });

  it("does not write JSONC to Pi's strict JSON configuration", async () => {
    const agent = agentByName(setupAgents(sb.env), "pi")!;
    mkdirSync(path.dirname(agent.mcp.file), { recursive: true });
    const before = '{ // not supported by Pi\n "mcpServers": {} }';
    writeFileSync(agent.mcp.file, before);
    const plan = await planAgent(agent, {}, sb.env, installed, await loadSkills());
    expect(plan.changes[0]).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("plain JSON") });
    expect(read(agent.mcp.file)).toBe(before);
  });

  it.each(["opencode", "pi"])("does not shadow %s's personal user entry with project setup", async name => {
    const agent = agentByName(setupAgents(sb.env), name)!;
    mkdirSync(path.dirname(agent.mcp.file), { recursive: true });
    const personal = name === "pi" ? { mcpServers: { cavelon: { command: "personal", args: [] } } } : { mcp: { cavelon: { type: "local", command: ["personal"] } } };
    const before = JSON.stringify(personal);
    writeFileSync(agent.mcp.file, before);
    const server = await startFakeServer();
    try {
      const tenant = server.addTenant("example", "Example");
      await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
      const dir = path.join(sb.home, "solution");
      mkdirSync(dir);
      const result = await cli(sb, ["init", "--agents", name, "--json"], { cwd: dir });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("would be shadowed");
      expect(existsSync(path.join(dir, name === "pi" ? ".pi/mcp.json" : "opencode.json"))).toBe(false);
      expect(read(agent.mcp.file)).toBe(before);
    } finally { await server.close(); }
  });
});
