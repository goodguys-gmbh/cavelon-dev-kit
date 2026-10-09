import path from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parseAgents, skillRootsFor } from "../src/agents.js";
import { agentByName, applyPlan, checkAgent, loadSkills, planAgent, removeAgent, serverCommand, setupAgents, type AgentRecord } from "../src/setup-agents.js";
import { startFakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox;
beforeEach(() => { sb = sandbox(); });
afterEach(() => sb.cleanup());
const installed = { command: "cavelon", args: ["mcp"] };
const read = (file: string) => readFileSync(file, "utf8");
async function install(env = sb.env) {
  const agent = agentByName(setupAgents(env), "cline")!;
  const skills = await loadSkills();
  const record: AgentRecord = {};
  const changes = await applyPlan(await planAgent(agent, {}, env, installed, skills), env, installed, skills, record);
  return { agent, skills, record, changes };
}

it("selects Cline's shared native MCP settings and global skills", () => {
  const agent = agentByName(setupAgents(sb.env), "cline")!;
  expect(agent, "Cline is a supported setup target").toBeDefined();
  expect(agent.mcp.file).toBe(path.join(sb.home, ".cline", "data", "settings", "cline_mcp_settings.json"));
  expect(agent.skills).toBe(path.join(sb.home, ".cline", "skills"));
});

it("initializes only Cline's actual project skill directory, without inventing a project MCP file", () => {
  const agents = parseAgents(["cline"]);
  expect(skillRootsFor(agents)).toContain(".cline/skills");
  expect(agents[0]!.mcp).toBeUndefined();
});

it("keeps trimmed config, data and exact MCP overrides independent", () => {
  const dir = path.join(sb.home, "Cline config ä");
  const data = path.join(sb.home, "state");
  const file = path.join(sb.home, "separate.json");
  const env = { ...sb.env, CLINE_DIR: ` ${dir} `, CLINE_DATA_DIR: ` ${data} `, CLINE_MCP_SETTINGS_PATH: ` ${file} ` };
  const agent = agentByName(setupAgents(env), "cline-vscode")!;
  expect(agent.mcp.file).toBe(file);
  expect(agent.skills).toBe(path.join(dir, "skills"));
  expect(agentByName(setupAgents({ ...env, CLINE_MCP_SETTINGS_PATH: " " }), "cline-cli")!.mcp.file).toBe(path.join(data, "settings", "cline_mcp_settings.json"));
  // Cline does not expand a tilde in these environment overrides.
  expect(agentByName(setupAgents({ ...sb.env, CLINE_DIR: "~/literal" }), "cline")!.skills).toBe(path.join("~/literal", "skills"));
});

it("uses Cline's trimmed HOME, profile and Windows drive fallback", () => {
  const home = path.join(sb.home, "profile");
  expect(agentByName(setupAgents({ HOME: ` ${home} ` }), "cline")!.skills).toBe(path.join(home, ".cline", "skills"));
  expect(agentByName(setupAgents({ HOME: " ~ ", USERPROFILE: ` ${home} ` }), "cline")!.skills).toBe(path.join(home, ".cline", "skills"));
  expect(agentByName(setupAgents({ HOME: " ", HOMEDRIVE: " C: ", HOMEPATH: " \\Users\\example " }), "cline")!.skills).toBe(path.join("C:\\Users\\example", ".cline", "skills"));
});

it.each(["linux", "darwin", "win32"] as const)("writes the platform-aware stdio command on %s", async platform => {
  const env = { ...sb.env, PATH: "", CLINE_DIR: path.join(sb.home, platform) };
  const agent = agentByName(setupAgents(env, platform), "cline")!;
  const command = await serverCommand(env, platform);
  const skills = await loadSkills();
  await applyPlan(await planAgent(agent, {}, env, command, skills, platform), env, command, skills, {});
  expect(JSON.parse(read(agent.mcp.file)).mcpServers.cavelon).toEqual({ type: "stdio", ...command });
});

it("preserves other settings, servers and modes through install, check, update and recorded-path removal", async () => {
  const env = { ...sb.env, CLINE_DIR: path.join(sb.home, "Cline config") };
  const target = agentByName(setupAgents(env), "cline")!;
  mkdirSync(path.dirname(target.mcp.file), { recursive: true });
  const other = { command: "other", args: [], env: { CUSTOM: "synthetic-keep" } };
  writeFileSync(target.mcp.file, JSON.stringify({ model: "internal/model", mcpServers: { other } }, null, 2));
  chmodSync(target.mcp.file, 0o640);
  const { agent, skills, record, changes } = await install(env);
  expect(changes.map(change => change.outcome)).toEqual(["done", "done"]);
  expect(record.native).toBeUndefined();
  expect((await checkAgent(agent, env, record)).ok).toBe(true);
  expect((await planAgent(agent, {}, env, installed, skills)).changes.every(change => change.outcome === "unchanged")).toBe(true);
  if (process.platform !== "win32") expect(statSync(agent.mcp.file).mode & 0o777).toBe(0o640);
  for (const skill of skills) expect(existsSync(path.join(agent.skills, skill.name, "SKILL.md"))).toBe(true);
  const newer = { command: "cmd", args: ["/c", "npx", "-y", "@cavelon/cli@0.2", "mcp"] };
  await applyPlan(await planAgent(agent, {}, env, newer, skills), env, newer, skills, record);
  expect(JSON.parse(read(agent.mcp.file)).mcpServers.cavelon).toEqual({ type: "stdio", ...newer });
  const moved = agentByName(setupAgents({ ...env, CLINE_DIR: path.join(sb.home, "later") }), "cline")!;
  await removeAgent(moved, record, env, skills, new Set());
  expect(JSON.parse(read(agent.mcp.file))).toEqual({ model: "internal/model", mcpServers: { other } });
  expect(existsSync(path.join(agent.skills, "cavelon-loop"))).toBe(false);
});

it.each([
  '{"mcpServers":{"cavelon":{"command":"personal","args":[]}}}',
  '{"mcpServers":{"cavelon":{"type":"stdio","command":"cavelon","args":["mcp"],"env":{"CUSTOM":"synthetic"}}}}',
  '{"mcpServers":{"cavelon":{"type":"stdio","command":"cavelon","args":["mcp"],"autoApprove":["apply"]}}}',
  '{// comment\n"mcpServers":{}}',
  '{"mcpServers":{},}',
  '{"mcpServers":{},"mcpServers":{}}',
])("leaves conflicting or invalid plain JSON untouched: %s", async before => {
  const target = agentByName(setupAgents(sb.env), "cline")!;
  mkdirSync(path.dirname(target.mcp.file), { recursive: true });
  writeFileSync(target.mcp.file, before);
  const { changes } = await install();
  expect(changes[0]!.outcome).toBe("skipped");
  expect(read(target.mcp.file)).toBe(before);
});

it("removes created settings and preserves later personal edits", async () => {
  const { agent, skills, record } = await install();
  await removeAgent(agent, record, sb.env, skills, new Set());
  expect(existsSync(agent.mcp.file)).toBe(false);
  const current = await install();
  const personal = JSON.stringify({ mcpServers: { cavelon: { type: "stdio", ...installed, disabled: true } } });
  writeFileSync(agent.mcp.file, personal);
  expect((await removeAgent(agent, current.record, sb.env, skills, new Set())).some(change => change.kind === "mcp" && change.outcome === "skipped")).toBe(true);
  expect(read(agent.mcp.file)).toBe(personal);
});

it("initializes and updates native project skills without a project MCP file", async () => {
  const server = await startFakeServer();
  try {
    const tenant = server.addTenant("example", "Example");
    await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
    const project = path.join(sb.home, "solution");
    mkdirSync(project);
    const result = await cli(sb, ["init", "--agents", "cline", "--json"], { cwd: project });
    expect(result.code, result.stderr).toBe(0);
    expect(existsSync(path.join(project, ".cline", "mcp.json"))).toBe(false);
    expect(existsSync(path.join(project, ".cline", "data"))).toBe(false);
    expect(result.stdout).toContain("cavelon setup --agents cline");
    const file = path.join(project, ".cline", "skills", "cavelon-loop", "SKILL.md");
    expect(existsSync(file)).toBe(true);
    writeFileSync(file, read(file) + "\nOld fixture text\n");
    expect((await cli(sb, ["init", "--update", "--json"], { cwd: project })).code).toBe(0);
    expect(read(file)).not.toContain("Old fixture text");
  } finally { await server.close(); }
});

it("guards login input and guarded changes in a CAVELON_AGENT launch", async () => {
  const server = await startFakeServer();
  try {
    const tenant = server.addTenant("example", "Example");
    await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, mayActivate: true }));
    server.state.harnesses.push({ id: "11111111-1111-4111-8111-111111111111", tenant_id: tenant, slug: "example", name: "Example", status: "active", is_default: false });
    const before = server.state.requests.length;
    const env = { ...sb.env, CAVELON_AGENT: "1" };
    expect((await cli(sb, ["login", "--instance", server.url, "--token-stdin", "--json"], { env, stdin: "synthetic-token" })).json()).toHaveProperty("error.code", "operation_for_a_person");
    expect(server.state.requests.slice(before)).toEqual([]);
    const change = await cli(sb, ["deactivate", "--harness", "example", "--confirm", "--json"], { env });
    expect(change.code).toBe(5);
    expect(change.json()).toMatchObject({ changed: false, needs_person: "terminal" });
    expect(server.state.requests.slice(before).filter(request => request.method !== "GET")).toEqual([]);
  } finally { await server.close(); }
});
