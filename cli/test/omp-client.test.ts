import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { agentByName, applyPlan, checkAgent, loadSkills, planAgent, removeAgent, setupAgents, type AgentRecord } from "../src/setup-agents.js";
import { nativeClient, resolveNativeMcp } from "../src/native-clients.js";
import { installPiExtension, type PiApi, type PiContext } from "../src/native-approval/pi-extension.js";
import { loadNativeRuntime } from "../src/native-approval/profile.js";
import { startFakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox;
beforeEach(() => { sb = sandbox(); });
afterEach(() => sb.cleanup());
const command = { command: "cavelon", args: ["mcp"] };

it("selects OMP independently from Pi and installs its native autoload extension", async () => {
  const agent = agentByName(setupAgents(sb.env), "omp")!;
  expect(agent?.name).toBe("omp");
  expect(agentByName(setupAgents(sb.env), "oh-my-pi")?.name).toBe("omp");
  expect(agentByName(setupAgents(sb.env), "pi")?.name).toBe("pi");
  const skills = await loadSkills();
  const record: AgentRecord = {};
  const plan = await planAgent(agent, {}, sb.env, command, skills);
  const changes = await applyPlan(plan, sb.env, command, skills, record);
  expect(changes.every(change => change.outcome === "done"), JSON.stringify(changes)).toBe(true);
  const dir = path.dirname(agent.skills);
  expect(JSON.parse(readFileSync(agent.mcp.file, "utf8")).mcpServers.cavelon).toEqual({ command: "cavelon", args: ["mcp"], enabled: false });
  expect(readFileSync(path.join(dir, "extensions", "cavelon.js"), "utf8")).toContain("omp-extension.mjs");
  expect(existsSync(path.join(dir, "settings.json"))).toBe(false);
  expect(existsSync(path.join(dir, "config.yml"))).toBe(false);
  expect(await loadNativeRuntime(path.join(dir, "cavelon", "profile.json"), "omp")).toMatchObject({ scope: "user", command });
  const rerun = await planAgent(agent, {}, sb.env, command, skills, process.platform, record);
  expect(rerun.changes.every(change => change.outcome === "unchanged")).toBe(true);
  expect((await checkAgent(agent, sb.env, record)).ok).toBe(true);
  await removeAgent(agent, record, sb.env, skills, new Set());
  expect(existsSync(agent.mcp.file)).toBe(false);
  expect(existsSync(path.join(dir, "extensions", "cavelon.js"))).toBe(false);
  expect(existsSync(path.join(dir, "cavelon"))).toBe(false);
});

it("creates project-native OMP files without touching another client's settings", async () => {
  const fake = await startFakeServer();
  try {
    const tenant = fake.addTenant("example", "Example");
    await login(sb, fake.url, fake.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
    const r = await cli(sb, ["init", "--agents", "omp"]);
  expect(r.code, r.stderr).toBe(0);
  expect(existsSync(path.join(sb.home, ".omp", "mcp.json"))).toBe(true);
  expect(existsSync(path.join(sb.home, ".omp", "extensions", "cavelon.js"))).toBe(true);
  expect(existsSync(path.join(sb.home, ".omp", "skills", "cavelon-loop", "SKILL.md"))).toBe(true);
  expect(existsSync(path.join(sb.home, ".pi"))).toBe(false);
  expect(await loadNativeRuntime(path.join(sb.home, ".omp", "cavelon", "profile.json"), "omp")).toMatchObject({ scope: "project", projectRoot: sb.home });
  } finally { await fake.close(); }
});

it.each(["linux", "darwin", "win32"] as const)("uses OMP's own default directory on %s", platform => {
  const client = nativeClient("omp")!;
  expect(client.user(sb.env, platform).skills).toBe(path.join(sb.home, ".omp", "agent", "skills"));
});

it("matches OMP's named profile and default override precedence", () => {
  const client = nativeClient("omp")!;
  const custom = path.join(sb.home, "custom-agent");
  expect(client.user({ ...sb.env, PI_CODING_AGENT_DIR: custom }).mcp.file).toBe(path.join(custom, "mcp.json"));
  expect(client.user({ ...sb.env, PI_CODING_AGENT_DIR: custom, OMP_PROFILE: "work" }).mcp.file).toBe(path.join(sb.home, ".omp", "profiles", "work", "agent", "mcp.json"));
  expect(client.user({ ...sb.env, OMP_PROFILE: "", PI_PROFILE: "legacy" }).skills).toBe(path.join(sb.home, ".omp", "agent", "skills"));
  expect(client.user({ ...sb.env, PI_CONFIG_DIR: ".custom-omp", PI_PROFILE: "legacy" }).skills).toBe(path.join(sb.home, ".custom-omp", "profiles", "legacy", "agent", "skills"));
});

it.each(["../outside", "CON", "with space", "ends."])("refuses invalid profile %s", async profile => {
  const config = nativeClient("omp")!.user({ ...sb.env, OMP_PROFILE: profile }).mcp;
  expect(await resolveNativeMcp(config)).toHaveProperty("error");
  expect(existsSync(config.file)).toBe(false);
});

it.each(["disabledServers", "enabledServers"])("preserves the person's %s policy", async policy => {
  const config = nativeClient("omp")!.user(sb.env).mcp;
  mkdirSync(path.dirname(config.file), { recursive: true });
  const before = JSON.stringify({ [policy]: ["cavelon"], mcpServers: { other: { command: "personal" } } });
  writeFileSync(config.file, before);
  expect(await resolveNativeMcp(config)).toMatchObject({ error: expect.stringContaining(policy) });
  expect(readFileSync(config.file, "utf8")).toBe(before);
});

it("preserves a compatible Cavelon entry instead of shadowing another client", async () => {
  const config = nativeClient("omp")!.user(sb.env).mcp;
  const compatible = path.join(sb.home, ".claude.json");
  writeFileSync(compatible, JSON.stringify({ mcpServers: { cavelon: command } }));
  expect(await resolveNativeMcp(config)).toMatchObject({ error: expect.stringContaining("compatible") });
  expect(existsSync(config.file)).toBe(false);
});

it("refuses duplicate native MCP files and preserves edited autoload ownership", async () => {
  const agent = agentByName(setupAgents(sb.env), "omp")!;
  mkdirSync(path.dirname(agent.mcp.file), { recursive: true });
  for (const name of ["mcp.json", ".mcp.json"]) writeFileSync(path.join(path.dirname(agent.mcp.file), name), JSON.stringify({ mcpServers: { cavelon: command } }));
  expect(await resolveNativeMcp(nativeClient("omp")!.user(sb.env).mcp)).toMatchObject({ error: expect.stringContaining("multiple") });
});

it("preserves personal YAML and an edited autoload entry during update and removal", async () => {
  const agent = agentByName(setupAgents(sb.env), "omp")!;
  const dir = path.dirname(agent.skills);
  mkdirSync(dir, { recursive: true });
  const settings = "# personal\ntheme: light\nextensions:\n  - ./personal.js\n";
  writeFileSync(path.join(dir, "config.yml"), settings);
  const skills = await loadSkills();
  const record: AgentRecord = {};
  await applyPlan(await planAgent(agent, {}, sb.env, command, skills), sb.env, command, skills, record);
  const autoload = path.join(dir, "extensions", "cavelon.js");
  writeFileSync(autoload, "// personal replacement\n");
  expect((await checkAgent(agent, sb.env, record)).ok).toBe(false);
  expect((await planAgent(agent, {}, sb.env, command, skills, process.platform, record)).changes[0]!.outcome).toBe("skipped");
  expect((await removeAgent(agent, record, sb.env, skills, new Set()))[0]!.outcome).toBe("skipped");
  expect(readFileSync(autoload, "utf8")).toBe("// personal replacement\n");
  expect(readFileSync(path.join(dir, "config.yml"), "utf8")).toBe(settings);
});

// Host context is simulated; this proves error propagation and never qualifies a person's UI.
it("registers OMP essential tool identities and reports protocol errors as errors", async () => {
  const events = new Map<string, (event: unknown, ctx: PiContext) => Promise<void>>();
  const tools = new Map<string, Parameters<PiApi["registerTool"]>[0]>();
  const api: PiApi = { on: (event, callback) => events.set(event, callback), getAllTools: () => [], registerTool: tool => { tools.set(tool.name, tool); } };
  installPiExtension(api, { scope: "user", version: "test", runtimeDir: sb.home, command: { command: process.execPath, args: [path.resolve("test/fixtures/native-mcp-host.mjs")] } }, "omp");
  const ctx: PiContext = { cwd: sb.home, hasUI: false, mode: "print", isProjectTrusted: () => true,
    ui: { confirm: async () => { throw new Error("No person UI is available."); } } };
  try {
    await events.get("session_start")!(undefined, ctx);
    const tool = tools.get("mcp__cavelon__read")!;
    expect(tool).toMatchObject({ loadMode: "essential", mcpServerName: "cavelon", mcpToolName: "read" });
    expect(await tool.execute("failure", { fail: true }, undefined, undefined, ctx)).toMatchObject({ isError: true });
    expect(await tool.execute("read", {}, undefined, undefined, ctx)).toMatchObject({ isError: false });
    const missingUI = await tools.get("mcp__cavelon__change")!.execute("change", { message: "Synthetic only" }, undefined, undefined, ctx);
    expect(missingUI).toMatchObject({ content: [{ text: "person-terminal" }] });
  } finally { await events.get("session_shutdown")!(undefined, ctx); }
});
