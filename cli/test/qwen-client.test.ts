import path from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentVariable } from "../src/agent-env.js";
import { parseAgents, skillRootsFor } from "../src/agents.js";
import { agentByName, applyPlan, checkAgent, loadSkills, planAgent, removeAgent, serverCommand, setupAgents, type AgentRecord } from "../src/setup-agents.js";
import { readJsoncEntry } from "../src/jsonc-config.js";
import { resolveNativeMcp } from "../src/native-clients.js";
import { startFakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox;
beforeEach(() => { sb = sandbox(); });
afterEach(() => sb.cleanup());
const installed = { command: "cavelon", args: ["mcp"] };
const read = (file: string) => readFileSync(file, "utf8");

async function install(env = sb.env) {
  const agent = agentByName(setupAgents(env), "qwen")!;
  const skills = await loadSkills();
  const record: AgentRecord = {};
  const plan = await planAgent(agent, {}, env, installed, skills);
  const changes = await applyPlan(plan, env, installed, skills, record);
  return { agent, skills, record, changes };
}

describe("Qwen Code integration", () => {
  it("selects native user/project settings and skills, including its direct home override", () => {
    const home = path.resolve("fixture-home");
    const agent = agentByName(setupAgents({ HOME: home }), "qwen-code");
    expect(agent, "Qwen Code is an explicit setup target").toBeDefined();
    expect(agent!.mcp.file).toBe(path.join(home, ".qwen", "settings.json"));
    const custom = path.join(home, "custom Qwen");
    expect(agentByName(setupAgents({ HOME: home, QWEN_HOME: custom }), "qwen")!.mcp.file).toBe(path.join(custom, "settings.json"));
    expect(skillRootsFor(parseAgents(["qwen"]))).toContain(".qwen/skills");
  });

  it("recognizes the marker set by Qwen's released shell execution service", () => {
    expect(agentVariable({ QWEN_CODE: "1" })).toBe("QWEN_CODE");
    expect(agentVariable({ QWEN_CODE: "0" })).toBeUndefined();
  });

  it("honors tilde/relative config homes and the separate runtime output directory", () => {
    const tilde = agentByName(setupAgents({ ...sb.env, QWEN_HOME: "~/Qwen config", QWEN_RUNTIME_DIR: path.join(sb.home, "runtime") }), "qwen")!;
    expect(tilde.mcp.file).toBe(path.join(sb.home, "Qwen config", "settings.json"));
    expect(agentByName(setupAgents({ ...sb.env, QWEN_HOME: "relative-qwen" }), "qwen")!.mcp.file).toBe(path.resolve("relative-qwen/settings.json"));
  });

  it.each(["linux", "darwin", "win32"] as const)("uses the platform-aware installed or registry process on %s", async platform => {
    const env = { ...sb.env, PATH: "", QWEN_HOME: path.join(sb.home, platform) };
    const agent = agentByName(setupAgents(env, platform), "qwen")!;
    const command = await serverCommand(env, platform);
    const plan = await planAgent(agent, {}, env, command, await loadSkills(), platform);
    await applyPlan(plan, env, command, await loadSkills(), {});
    expect(readJsoncEntry(read(agent.mcp.file), ["mcpServers", "cavelon"])).toMatchObject({ value: command });
    expect(existsSync(path.join(env.QWEN_HOME, "cavelon"))).toBe(false);
  });

  it("updates, checks and removes only its entry and marked skills while keeping comments, modes and personal environment", async () => {
    const dir = path.join(sb.home, "Qwen config ä");
    const env = { ...sb.env, QWEN_HOME: dir };
    mkdirSync(dir);
    const file = path.join(dir, "settings.json");
    const before = '{\r\n  // internal model\r\n  "model": {"name":"internal/model"},\r\n  "mcpServers":{"other":{"command":"other","args":[],"env":{"CUSTOM":"synthetic-keep"}}}\r\n}\r\n';
    writeFileSync(file, before);
    chmodSync(file, 0o640);
    const { agent, skills, record, changes } = await install(env);
    expect(changes.map(change => change.outcome)).toEqual(["done", "done"]);
    expect(record).toMatchObject({ mcp: { file, created: false, kept: 1 }, skills: { dir: path.join(dir, "skills") } });
    expect(record.native).toBeUndefined();
    expect(read(file)).toContain('// internal model\r\n  "model": {"name":"internal/model"}');
    expect(read(file)).toContain('"env":{"CUSTOM":"synthetic-keep"}');
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o640);
    expect((await planAgent(agent, {}, env, installed, skills)).changes.every(change => change.outcome === "unchanged")).toBe(true);
    expect(await checkAgent(agent, env, record)).toMatchObject({ ok: true, servers: [installed] });
    for (const skill of skills) expect(existsSync(path.join(agent.skills, skill.name, "SKILL.md"))).toBe(true);
    const newer = { command: "cmd", args: ["/c", "npx", "-y", "@cavelon/cli@0.1", "mcp"] };
    const update = await planAgent(agent, {}, env, newer, skills);
    await applyPlan(update, env, newer, skills, record);
    expect(readJsoncEntry(read(file), ["mcpServers", "cavelon"])).toMatchObject({ value: newer });
    const movedAgent = agentByName(setupAgents({ ...env, QWEN_HOME: path.join(sb.home, "later") }), "qwen")!;
    await removeAgent(movedAgent, record, env, skills, new Set());
    expect(readJsoncEntry(read(file), ["mcpServers", "cavelon"])).toMatchObject({ value: undefined });
    expect(read(file)).toContain('"env":{"CUSTOM":"synthetic-keep"}');
    expect(existsSync(path.join(agent.skills, "cavelon-loop"))).toBe(false);
  });

  it("removes newly created settings but preserves a personally edited entry", async () => {
    const { agent, skills, record } = await install();
    await removeAgent(agent, record, sb.env, skills, new Set());
    expect(existsSync(agent.mcp.file)).toBe(false);
    const current = await install();
    const personal = JSON.stringify({ mcpServers: { cavelon: { ...installed, env: { PRIVATE: "synthetic-personal" } } } });
    writeFileSync(agent.mcp.file, personal);
    const changes = await removeAgent(agent, current.record, sb.env, skills, new Set());
    expect(changes.some(change => change.kind === "mcp" && change.outcome === "skipped")).toBe(true);
    expect(read(agent.mcp.file)).toBe(personal);
  });

  it.each([
    '{"mcpServers":{"cavelon":{"command":"personal","args":[]}}}',
    '{"mcpServers":{"cavelon":{"command":"cavelon","args":["mcp"],"trust":true}}}',
    '{"model":"internal",}',
    '{"mcpServers":{},"mcpServers":{}}',
  ])("preserves conflicting or invalid settings without guessing: %s", async before => {
    const agent = agentByName(setupAgents(sb.env), "qwen")!;
    mkdirSync(path.dirname(agent.mcp.file), { recursive: true });
    writeFileSync(agent.mcp.file, before);
    const { changes } = await install();
    expect(changes[0]!.outcome).toBe("skipped");
    expect(read(agent.mcp.file)).toBe(before);
  });

  it.each([
    { mcpServers: { cavelon: installed } },
    { mcp: { allowed: ["another-server"] } },
    { mcp: { excluded: ["cav?l*"] } },
  ])("respects managed settings and MCP restrictions: %j", async policy => {
    const operator = path.join(sb.home, "operator.json");
    writeFileSync(operator, JSON.stringify(policy));
    const env = { ...sb.env, QWEN_CODE_SYSTEM_SETTINGS_PATH: operator };
    const { agent, changes } = await install(env);
    expect(changes[0]!.outcome).toBe("skipped");
    expect(existsSync(agent.mcp.file)).toBe(false);
    expect(read(operator)).toBe(JSON.stringify(policy));
    expect((await checkAgent(agent, env)).ok).toBe(false);
  });

  it("permits an operator allow-list that explicitly matches Cavelon", async () => {
    const operator = path.join(sb.home, "operator.json");
    writeFileSync(operator, '{"mcp":{"allowed":["cav?l*"],"excluded":["other*"]}}');
    const env = { ...sb.env, QWEN_CODE_SYSTEM_SETTINGS_PATH: operator };
    const { agent } = await install(env);
    expect((await checkAgent(agent, env)).ok).toBe(true);
  });

  it("does not shadow a personal user server with a project entry", async () => {
    const dir = path.join(sb.home, ".qwen");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "settings.json"), '{"mcpServers":{"cavelon":{"command":"personal","args":[]}}}');
    const target = parseAgents(["qwen"])[0]!.mcp!;
    expect(target.format).toBe("native");
    if (target.format !== "native") throw new Error("Expected native config");
    const client = agentByName(setupAgents(sb.env), "qwen")!;
    const config = { ...target, shadowFiles: [client.mcp.file] };
    const selected = await resolveNativeMcp(config, path.join(sb.home, "project"));
    expect(selected).toHaveProperty("error", expect.stringContaining("personal Cavelon server"));
  });

  it("initializes native project skills and MCP settings, then updates without a plugin or lost comments", async () => {
    const server = await startFakeServer();
    try {
      const tenant = server.addTenant("example", "Example");
      await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
      const project = path.join(sb.home, "solution");
      mkdirSync(path.join(project, ".qwen"), { recursive: true });
      const file = path.join(project, ".qwen", "settings.json");
      writeFileSync(file, '{\n// project model\n"model":{"name":"internal/model"}\n}\n');
      const result = await cli(sb, ["init", "--agents", "qwen-code", "--json"], { cwd: project });
      expect(result.code, result.stderr).toBe(0);
      expect(readJsoncEntry(read(file), ["mcpServers", "cavelon"])).toMatchObject({ value: { command: expect.any(String), args: expect.any(Array) } });
      expect(read(file)).toContain("// project model");
      expect(existsSync(path.join(project, ".qwen", "skills", "cavelon-loop", "SKILL.md"))).toBe(true);
      expect(existsSync(path.join(project, ".qwen", "cavelon"))).toBe(false);
      expect(result.stdout).toContain("person's own terminal");
      expect((await cli(sb, ["init", "--update", "--json"], { cwd: project })).code).toBe(0);
      expect(read(file)).toContain("// project model");
    } finally { await server.close(); }
  });
  
  it("guards login and a guarded change in a Qwen shell before any request", async () => {
    const server = await startFakeServer();
    try {
      const tenant = server.addTenant("example", "Example");
      await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
      const before = server.state.requests.length;
      const env = { ...sb.env, QWEN_CODE: "1" };
      expect((await cli(sb, ["login", "--instance", server.url, "--token-stdin", "--json"], { env, stdin: "synthetic-token" })).json()).toHaveProperty("error.code", "operation_for_a_person");
      const change = await cli(sb, ["deactivate", "--harness", "example", "--confirm", "--json"], { env });
      expect(change.json()).toHaveProperty("error.code", "confirm_needs_person");
      expect(server.state.requests.slice(before)).toEqual([]);
    } finally { await server.close(); }
  });
});
