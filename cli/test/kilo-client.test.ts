import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativeClient, resolveNativeMcp } from "../src/native-clients.js";
import { parseAgents, skillRootsFor } from "../src/agents.js";
import { agentByName, setupAgents, loadSkills, planAgent, applyPlan, serverCommand } from "../src/setup-agents.js";
import { planNativeInstallation } from "../src/native-install.js";
import { startKiloServer } from "../src/native-approval/kilo-server.js";
import { nativeEntryHash } from "../src/native-approval/profile.js";
import { KIT_VERSION } from "../src/version.js";
import { sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox;
beforeEach(() => { sb = sandbox(); });
afterEach(() => sb.cleanup());

describe("Kilo integration", () => {
  it("offers Kilo's own user MCP directory without reusing OpenCode's", () => {
    const agent = agentByName(setupAgents(sb.env), "kilocode");
    expect(agent, "Kilo is an explicit native setup target").toBeDefined();
    expect(agent!.mcp.file).toBe(path.join(path.join(sb.home, ".config"), "kilo", "kilo.json"));
    expect(agent!.skills).toBe(path.join(path.join(sb.home, ".config"), "kilo", "skills"));
  });

  it("selects native Kilo project settings and skills", () => {
    expect(nativeClient("kilo")?.project(sb.env)?.file).toBe("kilo.json");
    expect(skillRootsFor(parseAgents(["kilo"]))).toContain(".kilo/skills");
  });

  it("honors Kilo's XDG, extra-directory and explicit-file overrides independently", () => {
    const xdg = path.join(sb.home, "configuration");
    const extra = path.join(sb.home, "extra");
    const file = path.join(sb.home, "explicit.jsonc");
    const settings = nativeClient("kilo")!.user({ ...sb.env, XDG_CONFIG_HOME: `${xdg}\n`, KILO_CONFIG_DIR: extra, KILO_CONFIG: file });
    expect(settings.mcp.file).toBe(file);
    expect(settings.mcp.files).toContain(path.join(xdg, "kilo", "kilo.json"));
    expect(settings.mcp.files).toContain(path.join(extra, "kilo.jsonc"));
    expect(settings.skills).toBe(path.join(extra, "skills"));
    expect(settings.mcp.files).toContain(path.join(sb.home, ".kilocode", "kilo.json"));
  });

  it.each(["linux", "darwin", "win32"] as const)("installs the platform-aware process and bundled adapter on %s", async platform => {
    const agent = agentByName(setupAgents(sb.env, platform), "kilo")!;
    const command = await serverCommand({ ...sb.env, PATH: "" }, platform);
    const skills = await loadSkills();
    const plan = await planAgent(agent, {}, sb.env, command, skills, platform);
    expect(plan.changes[0]!.outcome, plan.changes[0]!.reason).toBe("planned");
    await applyPlan(plan, sb.env, command, skills, {});
    const entry = JSON.parse(readFileSync(agent.mcp.file, "utf8"));
    expect(entry.mcp.cavelon).toEqual({ type: "local", enabled: false, command: [command.command, ...command.args] });
    expect(entry.plugin).toContain("./cavelon/kilo-server-entry.mjs");
    expect(existsSync(path.join(path.dirname(agent.skills), "cavelon", "kilo-tui.mjs"))).toBe(true);
  });

  it("reads an existing JSONC owner while preserving compatible OpenCode files", async () => {
    const config = nativeClient("kilo")!.user(sb.env).mcp;
    mkdirSync(path.dirname(config.file), { recursive: true });
    const compatible = path.join(path.dirname(config.file), "opencode.jsonc");
    writeFileSync(compatible, '{ // Other client\n "model":"internal/model" }');
    expect(await resolveNativeMcp(config)).toMatchObject({ file: config.file, current: undefined });
    const owner = path.join(path.dirname(config.file), "kilo.jsonc");
    writeFileSync(owner, '{// Kilo\n "mcp":{"cavelon":{"type":"local","command":["personal"]}}}');
    expect(await resolveNativeMcp(config)).toMatchObject({ file: owner, current: { command: ["personal"] } });
    writeFileSync(compatible, '{"mcp":{"cavelon":{"type":"local","command":["cavelon","mcp"]}}}');
    expect(await resolveNativeMcp(config)).toMatchObject({ error: expect.stringContaining("preserved") });
    expect(readFileSync(compatible, "utf8")).toContain('"command":["cavelon","mcp"]');
  });

  it("refuses two effective Kilo entries rather than guessing which binding wins", async () => {
    const config = nativeClient("kilo")!.user(sb.env).mcp;
    mkdirSync(path.dirname(config.file), { recursive: true });
    for (const name of ["kilo.json", "kilo.jsonc"]) writeFileSync(path.join(path.dirname(config.file), name), '{"mcp":{"cavelon":{"type":"local","command":["personal"]}}}');
    expect(await resolveNativeMcp(config)).toMatchObject({ error: expect.stringContaining("multiple") });
  });

  it("refuses managed Cavelon settings and opaque MDM policies without writing another binding", async () => {
    const managed = path.join(sb.home, "managed");
    mkdirSync(managed);
    const config = nativeClient("kilo")!.user({ ...sb.env, KILO_TEST_MANAGED_CONFIG_DIR: managed }).mcp;
    writeFileSync(path.join(managed, "kilo.json"), '{"mcp":{"cavelon":{"enabled":false}}}');
    expect(await resolveNativeMcp(config)).toMatchObject({ error: expect.stringContaining("managed") });
    const opaque = path.join(sb.home, "policy.plist");
    writeFileSync(opaque, "synthetic opaque policy");
    expect(await resolveNativeMcp({ ...config, managedFiles: [], managedOpaqueFiles: [opaque] })).toMatchObject({ error: expect.stringContaining("managed preferences") });
    expect(existsSync(config.file)).toBe(false);
  });

  it("preserves an inherited project binding inside the repository boundary", async () => {
    const root = path.join(sb.home, "repo");
    const child = path.join(root, "solutions", "review");
    mkdirSync(child, { recursive: true });
    mkdirSync(path.join(root, ".git"));
    writeFileSync(path.join(root, "kilo.json"), '{"mcp":{"cavelon":{"type":"local","command":["personal"]}}}');
    const plan = await planNativeInstallation(nativeClient("kilo")!.project(sb.env)!, { command: "cavelon", args: ["mcp"] }, sb.env, { root: child });
    expect(plan).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("inherited") });
    expect(existsSync(path.join(child, "kilo.json"))).toBe(false);
  });

  it.each([{ KILO_CONFIG_CONTENT: "{}" }, { KILO_DISABLE_PROJECT_CONFIG: "true" }, { KILO_CONFIG_DIR: "managed-config" }])("diagnoses project settings disabled or overridden by %j", async overrides => {
    const config = nativeClient("kilo")!.project({ ...sb.env, ...overrides })!;
    expect(await resolveNativeMcp(config, sb.home)).toHaveProperty("error");
  });

  it.each([undefined, { type: "local", command: ["personal"], enabled: false }])("refuses a missing or different effective runtime entry before tool dispatch", async effective => {
    const expected = { type: "local", command: ["cavelon", "mcp"], enabled: false };
    const runtime = { scope: "user" as const, version: KIT_VERSION, runtimeDir: path.join(sb.home, "runtime"), command: { command: process.execPath, args: [path.resolve("test/fixtures/native-mcp-host.mjs")] }, entryHash: nativeEntryHash(expected) };
    const hooks = await startKiloServer({ directory: sb.home }, runtime);
    try {
      const config = { mcp: { cavelon: expected } };
      await hooks.config(config);
      config.mcp.cavelon = effective as typeof expected;
      await expect(hooks.tool.cavelon_read!.execute({}, { sessionID: "headless", abort: new AbortController().signal })).rejects.toThrow(/effective Cavelon configuration/);
      const output = { env: {} as Record<string, string> };
      await hooks["shell.env"]({}, output);
      expect(output.env.CAVELON_AGENT).toBe("1");
    } finally { await hooks.dispose(); }
  });
});
