import path from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parse } from "yaml";
import { parseAgents } from "../src/agents.js";
import { agentByName, applyPlan, checkAgent, loadSkills, planAgent, removeAgent, serverCommand, setupAgents, type AgentRecord } from "../src/setup-agents.js";
import { startFakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox;
beforeEach(() => { sb = sandbox(); });
afterEach(() => sb.cleanup());
const installed = { command: "cavelon", args: ["mcp"] };
const read = (file: string) => readFileSync(file, "utf8");
const envFor = () => ({ ...sb.env, GOOSE_PATH_ROOT: path.join(sb.home, "Goose config ä") });
async function install(env = envFor()) {
  const agent = agentByName(setupAgents(env), "goose")!;
  const skills = await loadSkills();
  const record: AgentRecord = {};
  const changes = await applyPlan(await planAgent(agent, {}, env, installed, skills), env, installed, skills, record);
  return { agent, skills, record, changes };
}

it("selects Goose's actual user YAML configuration and native skill directory", () => {
  const agent = agentByName(setupAgents({ HOME: "/synthetic/home", GOOSE_PATH_ROOT: "/synthetic/goose" }), "goose");
  expect(agent, "Goose is a supported setup target").toBeDefined();
  expect(agent!.mcp.file).toBe(path.join("/synthetic/goose", "config", "config.yaml"));
  expect(agent!.skills).toBe(path.join("/synthetic/goose", "config", "skills"));
});

it.each(["linux", "darwin"] as const)("matches native XDG and ignores relative path overrides on %s", platform => {
  const dir = path.join(sb.home, "config");
  const agent = agentByName(setupAgents({ ...sb.env, XDG_CONFIG_HOME: dir, GOOSE_PATH_ROOT: "relative/root" }, platform), "goose-cli")!;
  expect(agent.mcp.file).toBe(path.join(dir, "goose", "config.yaml"));
  expect(agentByName(setupAgents({ ...sb.env, XDG_CONFIG_HOME: "relative" }, platform), "goose")!.mcp.file).toBe(path.join(sb.home, ".config", "goose", "config.yaml"));
});

it("uses the native Windows author/app/config directory", () => {
  const roaming = path.join(sb.home, "roaming");
  const agent = agentByName(setupAgents({ ...sb.env, APPDATA: roaming }, "win32"), "goose")!;
  expect(agent.mcp.file).toBe(path.join(roaming, "Block", "goose", "config", "config.yaml"));
});

it.each(["linux", "darwin", "win32"] as const)("writes the platform-aware Goose cmd/args entry on %s", async platform => {
  const env = { ...envFor(), PATH: "" };
  const agent = agentByName(setupAgents(env, platform), "goose")!;
  const command = await serverCommand(env, platform);
  const skills = await loadSkills();
  await applyPlan(await planAgent(agent, {}, env, command, skills, platform), env, command, skills, {});
  expect(parse(read(agent.mcp.file)).extensions.cavelon).toEqual({ type: "stdio", name: "cavelon", enabled: true, cmd: command.command, args: command.args });
});

it("preserves YAML comments, personal settings, extensions and modes through the complete setup lifecycle", async () => {
  const env = envFor();
  const agent = agentByName(setupAgents(env), "goose")!;
  mkdirSync(path.dirname(agent.mcp.file), { recursive: true });
  const before = "# provider notes\nactive_provider: 'internal' # keep\nextensions:\n  other: {type: stdio, name: other, enabled: true, cmd: other, args: []}\n";
  writeFileSync(agent.mcp.file, before);
  chmodSync(agent.mcp.file, 0o640);
  const { record, changes, skills } = await install(env);
  expect(changes.map(change => change.outcome)).toEqual(["done", "done"]);
  expect((await checkAgent(agent, env, record)).ok).toBe(true);
  expect((await planAgent(agent, {}, env, installed, skills)).changes.every(change => change.outcome === "unchanged")).toBe(true);
  if (process.platform !== "win32") expect(statSync(agent.mcp.file).mode & 0o777).toBe(0o640);
  expect(record.native).toBeUndefined();
  for (const skill of skills) expect(existsSync(path.join(agent.skills, skill.name, "SKILL.md"))).toBe(true);
  const newer = { command: "cmd", args: ["/c", "npx", "-y", "@cavelon/cli@0.2", "mcp"] };
  await applyPlan(await planAgent(agent, {}, env, newer, skills), env, newer, skills, record);
  expect(parse(read(agent.mcp.file)).extensions.cavelon.cmd).toBe("cmd");
  const moved = agentByName(setupAgents({ ...env, GOOSE_PATH_ROOT: path.join(sb.home, "later") }), "goose")!;
  await removeAgent(moved, record, env, skills, new Set());
  expect(read(agent.mcp.file)).toBe(before);
  expect(existsSync(path.join(agent.skills, "cavelon-loop"))).toBe(false);
});

it.each([
  "extensions: {cavelon: {type: stdio, name: cavelon, enabled: false, cmd: cavelon, args: [mcp]}}\n",
  "extensions: {cavelon: {type: stdio, name: cavelon, enabled: true, cmd: cavelon, args: [mcp], envs: {CUSTOM: synthetic}}}\n",
  "extensions: {Cavelon: {type: stdio, enabled: true, cmd: personal, args: []}}\n",
  "extensions: {other: {type: stdio, name: Cavelon, enabled: true, cmd: personal, args: []}}\n",
  "extensions: {cavelon: {type: stdio, name: other, enabled: true, cmd: personal, args: []}}\n",
  "GOOSE_ALLOWLIST: https://example.invalid/extensions\n",
  "extensions: {}\nextensions: {}\n",
])("preserves personal, disabled, competing or ambiguous settings: %s", async before => {
  const env = envFor();
  const agent = agentByName(setupAgents(env), "goose")!;
  mkdirSync(path.dirname(agent.mcp.file), { recursive: true });
  writeFileSync(agent.mcp.file, before);
  expect((await install(env)).changes[0]!.outcome).toBe("skipped");
  expect(read(agent.mcp.file)).toBe(before);
});

it("refuses to override an additional configuration's binding, including an owned-looking one", async () => {
  const extra = path.join(sb.home, "operator.yaml");
  const before = "extensions: {cavelon: {type: stdio, name: cavelon, enabled: true, cmd: cavelon, args: [mcp]}}\n";
  writeFileSync(extra, before);
  const env = { ...envFor(), GOOSE_ADDITIONAL_CONFIG_FILES: extra };
  const { agent, changes } = await install(env);
  expect(changes[0]!.outcome).toBe("skipped");
  expect(changes[0]!.reason).toContain("operator");
  expect(existsSync(agent.mcp.file)).toBe(false);
  expect(read(extra)).toBe(before);
});

it("refuses empty additional paths and an active environment allowlist", async () => {
  for (const override of [{ GOOSE_ADDITIONAL_CONFIG_FILES: "" }, { GOOSE_ALLOWLIST: "https://example.invalid/extensions" }]) {
    const env = { ...envFor(), ...override };
    expect((await install(env)).changes[0]!.outcome).toBe("skipped");
  }
});

it("removes only created settings and retains later personal changes", async () => {
  const first = await install();
  await removeAgent(first.agent, first.record, envFor(), first.skills, new Set());
  expect(existsSync(first.agent.mcp.file)).toBe(false);
  const next = await install();
  const before = read(next.agent.mcp.file).replace('"enabled": true', '"enabled": false');
  writeFileSync(next.agent.mcp.file, before);
  expect((await checkAgent(next.agent, envFor(), next.record)).ok).toBe(false);
  expect((await removeAgent(next.agent, next.record, envFor(), next.skills, new Set()))[0]!.outcome).toBe("skipped");
  expect(read(next.agent.mcp.file)).toBe(before);
});

it("guards Goose's session-marked shell before login input or guarded writes", async () => {
  const server = await startFakeServer();
  try {
    const tenant = server.addTenant("example", "Example");
    await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, mayActivate: true }));
    server.state.harnesses.push({ id: "11111111-1111-4111-8111-111111111111", tenant_id: tenant, slug: "example", name: "Example", status: "active", is_default: false });
    const before = server.state.requests.length;
    const env = { ...sb.env, AGENT_SESSION_ID: "synthetic-goose-session" };
    expect((await cli(sb, ["login", "--instance", server.url, "--token-stdin", "--json"], { env, stdin: "synthetic-token" })).json()).toHaveProperty("error.code", "operation_for_a_person");
    expect(server.state.requests.slice(before)).toEqual([]);
    expect((await cli(sb, ["deactivate", "--harness", "example", "--confirm", "--json"], { env })).json()).toMatchObject({ changed: false, needs_person: "terminal" });
    expect(server.state.requests.slice(before).filter(request => request.method !== "GET")).toEqual([]);
  } finally { await server.close(); }
});

it("initializes and updates project-native skills with no invented Goose MCP file", async () => {
  const server = await startFakeServer();
  try {
    const tenant = server.addTenant("example", "Example");
    await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
    const project = path.join(sb.home, "solution");
    mkdirSync(project);
    const result = await cli(sb, ["init", "--agents", "goose", "--json"], { cwd: project });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("cavelon setup --agents goose");
    expect(existsSync(path.join(project, ".goose", "config.yaml"))).toBe(false);
    expect(existsSync(path.join(project, "config.yaml"))).toBe(false);
    const file = path.join(project, ".agents", "skills", "cavelon-loop", "SKILL.md");
    expect(existsSync(file)).toBe(true);
    writeFileSync(file, read(file) + "\nOld fixture text\n");
    expect((await cli(sb, ["init", "--update", "--json"], { cwd: project })).code).toBe(0);
    expect(read(file)).not.toContain("Old fixture text");
  } finally { await server.close(); }
});

it("initializes Goose skills without inventing project MCP configuration", () => {
  const target = parseAgents(["goose"])[0]!;
  expect(target.mcp).toBeUndefined();
});
