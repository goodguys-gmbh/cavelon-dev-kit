import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { agentByName, applyPlan, checkAgent, loadSkills, planAgent, removeAgent, setupAgents, type AgentRecord } from "../src/setup-agents.js";
import { readJsoncEntry } from "../src/jsonc-config.js";
import { cli, sandbox, type Sandbox } from "./helpers.js";
import { applyNativeInstallation, checkNativeInstallation, planNativeInstallation, removeNativeInstallation } from "../src/native-install.js";
import { nativeClient } from "../src/native-clients.js";
import { hasNativeProjectOwner, loadNativeRuntime } from "../src/native-approval/profile.js";
import { startOpenCodeServer } from "../src/native-approval/opencode-server.js";
import { writeFileAtomic } from "../src/fsutil.js";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { installPiExtension, type PiApi, type PiContext } from "../src/native-approval/pi-extension.js";
import { configDir } from "../src/paths.js";

let sb: Sandbox;
beforeEach(() => { sb = sandbox(); });
afterEach(() => sb.cleanup());
const command = { command: "cavelon", args: ["mcp"] };
const read = (file: string) => readFileSync(file, "utf8");

async function install(name: "opencode" | "pi") {
  const agent = agentByName(setupAgents(sb.env), name)!;
  const skills = await loadSkills();
  const record: AgentRecord = {};
  const plan = await planAgent(agent, {}, sb.env, command, skills);
  const changes = await applyPlan(plan, sb.env, command, skills, record);
  return { agent, skills, record, changes, dir: path.join(path.dirname(agent.skills), "cavelon") };
}

it.each(["opencode", "pi"] as const)("setup installs %s's bundled native adapter and disables only its Cavelon MCP duplicate", async name => {
  const p = await install(name);
  expect(p.changes.every(change => change.outcome === "done"), JSON.stringify(p.changes)).toBe(true);
  expect(readJsoncEntry(read(p.agent.mcp.file), [name === "opencode" ? "mcp" : "mcpServers", "cavelon"])).toMatchObject({ value: { enabled: false } });
  const settings = path.join(path.dirname(p.agent.skills), name === "pi" ? "settings.json" : "tui.json");
  const member = name === "pi" ? "./cavelon/pi-extension.mjs" : "./cavelon/opencode-tui-entry.mjs";
  expect(readJsoncEntry(read(settings), [name === "pi" ? "extensions" : "plugin"])).toMatchObject({ value: [member] });
  expect(existsSync(path.join(p.dir, "profile.json"))).toBe(true);
  expect(existsSync(path.join(p.dir, "installation.json"))).toBe(true);
  const rerun = await planAgent(p.agent, {}, sb.env, command, p.skills);
  expect(rerun.changes.every(change => change.outcome === "unchanged")).toBe(true);
  const check = await checkAgent(p.agent, sb.env, p.record);
  expect(check.ok, check.details.join("\n")).toBe(true);
  expect(check.servers).toEqual([command]);
  const removed = await removeAgent(p.agent, p.record, sb.env, p.skills, new Set());
  expect(removed.every(change => ["removed", "unchanged"].includes(change.outcome))).toBe(true);
  expect(existsSync(p.dir)).toBe(false);
  expect(existsSync(settings)).toBe(false);
  expect(p.record).toEqual({});
});

it.each(["opencode", "pi"] as const)("setup refuses an unowned %s native directory before changing MCP settings", async name => {
  const agent = agentByName(setupAgents(sb.env), name)!;
  const dir = path.join(path.dirname(agent.skills), "cavelon");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "personal.txt"), "personal integration");
  const plan = await planAgent(agent, {}, sb.env, command, await loadSkills());
  expect(plan.changes[0]).toMatchObject({ outcome: "skipped", reason: expect.stringMatching(/owned|belongs|personal/) });
  expect(existsSync(agent.mcp.file)).toBe(false);
  expect(read(path.join(dir, "personal.txt"))).toBe("personal integration");
});

it.each(["opencode", "pi"] as const)("%s refuses updates, checks and removal of edited native assets", async name => {
  const p = await install(name);
  const file = path.join(p.dir, name === "pi" ? "pi-extension.mjs" : "opencode-server.mjs");
  writeFileSync(file, read(file) + "\n// personal edit\n");
  const before = read(p.agent.mcp.file);
  const update = await planAgent(p.agent, {}, sb.env, command, p.skills, process.platform, p.record);
  expect(update.changes[0]).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("edited") });
  expect((await checkAgent(p.agent, sb.env, p.record)).ok).toBe(false);
  const removed = await removeAgent(p.agent, p.record, sb.env, p.skills, new Set());
  expect(removed[0]).toMatchObject({ outcome: "skipped" });
  expect(read(p.agent.mcp.file)).toBe(before);
  expect(p.record.native).toBeDefined();
  expect(read(file)).toContain("// personal edit");
});

it("preserves personal JSONC settings, plugins, MCP servers, CRLF and file permissions through update and removal", async () => {
  const agent = agentByName(setupAgents(sb.env), "opencode")!;
  const dir = path.dirname(agent.skills);
  mkdirSync(dir, { recursive: true });
  const mcpFile = path.join(dir, "opencode.jsonc");
  const tuiFile = path.join(dir, "tui.jsonc");
  const mcp = '{\r\n// personal MCP\r\n"mcp":{"other":{"command":["other"],"environment":{"SENTINEL":"synthetic-private-value"}}},"plugin":["personal-server"]\r\n}\r\n';
  const tui = '{\r\n// personal UI\r\n"theme":"personal","plugin":["personal-tui",]\r\n}\r\n';
  writeFileSync(mcpFile, mcp);
  writeFileSync(tuiFile, tui);
  chmodSync(mcpFile, 0o640);
  const p = await install("opencode");
  expect(read(mcpFile)).toContain('// personal MCP\r\n');
  expect(read(tuiFile)).toContain('"theme":"personal"');
  for (const file of ["profile.json", "installation.json"]) expect(read(path.join(p.dir, file))).not.toContain("synthetic-private-value");
  if (process.platform !== "win32") expect(statSync(mcpFile).mode & 0o777).toBe(0o640);
  const rerun = await planAgent(p.agent, {}, sb.env, command, p.skills);
  expect(rerun.changes[0]!.outcome).toBe("unchanged");
  await removeAgent(p.agent, p.record, sb.env, p.skills, new Set());
  expect(readJsoncEntry(read(mcpFile), ["mcp", "other"])).toMatchObject({ value: { environment: { SENTINEL: "synthetic-private-value" } } });
  expect(readJsoncEntry(read(mcpFile), ["plugin"])).toMatchObject({ value: ["personal-server"] });
  expect(readJsoncEntry(read(tuiFile), ["plugin"])).toMatchObject({ value: ["personal-tui"] });
  expect(read(mcpFile)).toContain('// personal MCP\r\n');
  expect(read(tuiFile)).toContain('// personal UI\r\n');
});

it("preserves edited plugin references and does not remove the assets they may still need", async () => {
  const p = await install("pi");
  const settings = path.join(path.dirname(p.dir), "settings.json");
  writeFileSync(settings, '{"extensions":["./cavelon/pi-extension.mjs?personal"]}');
  const before = read(p.agent.mcp.file);
  expect((await checkNativeInstallation(p.dir)).reason).toMatch(/reference/);
  expect((await removeNativeInstallation(p.dir)).removed).toBe(false);
  expect(read(p.agent.mcp.file)).toBe(before);
  expect(existsSync(path.join(p.dir, "pi-extension.mjs"))).toBe(true);
});

it.each(["absolute", "file-url"] as const)("refuses an additional %s alias of the owned native plugin", async kind => {
  const p = await install("pi");
  const file = path.join(p.dir, "pi-extension.mjs");
  const settings = path.join(path.dirname(p.dir), "settings.json");
  const alias = kind === "absolute" ? file : pathToFileURL(file).href;
  writeFileSync(settings, JSON.stringify({ extensions: ["./cavelon/pi-extension.mjs", alias] }));
  expect((await planNativeInstallation(nativeClient("pi")!.user(sb.env).mcp, command, sb.env)).reason).toMatch(/reference/);
  expect((await checkNativeInstallation(p.dir)).reason).toMatch(/reference/);
  expect((await removeNativeInstallation(p.dir)).removed).toBe(false);
  expect(existsSync(file)).toBe(true);
});

it("rejects a changed config after planning and rolls back the assets it wrote", async () => {
  const agent = agentByName(setupAgents(sb.env), "opencode")!;
  const plan = await planNativeInstallation(nativeClient("opencode")!.user(sb.env).mcp, command, sb.env);
  mkdirSync(path.dirname(agent.mcp.file), { recursive: true });
  const personal = '{"model":"personal-after-plan"}';
  writeFileSync(agent.mcp.file, personal);
  await expect(applyNativeInstallation(plan)).rejects.toThrow(/changed after planning/);
  expect(read(agent.mcp.file)).toBe(personal);
  expect(existsSync(plan.directory)).toBe(false);
});

it("rolls back a failed config write even when the writer failed after replacing the file", async () => {
  const config = nativeClient("pi")!.user(sb.env).mcp;
  mkdirSync(path.dirname(config.file), { recursive: true });
  const before = '{"mcpServers":{"other":{"command":"other","args":[]}}}';
  writeFileSync(config.file, before);
  const plan = await planNativeInstallation(config, command, sb.env);
  await expect(applyNativeInstallation(plan, async (file, content, mode, dirMode) => {
    await writeFileAtomic(file, content, mode, dirMode);
    if (file.endsWith("settings.json")) throw new Error("synthetic write failure");
  })).rejects.toThrow("synthetic write failure");
  expect(read(config.file)).toBe(before);
  expect(existsSync(path.join(path.dirname(config.file), "settings.json"))).toBe(false);
  expect(existsSync(plan.directory)).toBe(false);
});

it("a second installer cannot remove the first installer's in-progress assets", async () => {
  const config = nativeClient("pi")!.user(sb.env).mcp;
  const plan = await planNativeInstallation(config, command, sb.env);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const first = applyNativeInstallation(plan, async (file, content, mode, dirMode) => {
    started();
    await gate;
    await writeFileAtomic(file, content, mode, dirMode);
  });
  await ready;
  try {
    await expect(applyNativeInstallation(plan)).rejects.toThrow(/lock/);
  } finally { release(); }
  await first;
  expect((await checkNativeInstallation(plan.directory)).command).toEqual(command);
  expect(existsSync(plan.directory + ".lock")).toBe(false);
});

it("updates an older owned native installation without duplicating personal or Cavelon references", async () => {
  const p = await install("pi");
  const manifestFile = path.join(p.dir, "installation.json");
  const manifest = JSON.parse(read(manifestFile));
  const profileFile = path.join(p.dir, "profile.json");
  const older = JSON.stringify({ ...JSON.parse(read(profileFile)), version: "0.1.14" }, null, 2) + "\n";
  writeFileSync(profileFile, older);
  manifest.version = "0.1.14";
  manifest.files["profile.json"] = createHash("sha256").update(older).digest("hex");
  writeFileSync(manifestFile, JSON.stringify(manifest));
  const settings = path.join(path.dirname(p.dir), "settings.json");
  const before = read(settings);
  const plan = await planAgent(p.agent, {}, sb.env, command, p.skills, process.platform, p.record);
  expect(plan.changes[0]).toMatchObject({ outcome: "planned" });
  await applyPlan(plan, sb.env, command, p.skills, p.record);
  expect(JSON.parse(read(profileFile)).version).not.toBe("0.1.14");
  expect(read(settings)).toBe(before);
  expect((await checkNativeInstallation(p.dir)).command).toEqual(command);
});

it.each(["opencode", "pi"] as const)("%s project install remains valid after moving the clone and removes only recorded files", async name => {
  const root = path.join(sb.home, "project with spaces");
  mkdirSync(root);
  const config = nativeClient(name)!.project(sb.env)!;
  const plan = await planNativeInstallation(config, command, sb.env, { root });
  expect(plan.outcome, plan.reason).toBe("planned");
  await applyNativeInstallation(plan);
  expect(JSON.parse(read(path.join(plan.directory, "profile.json")))).toMatchObject({ format: 2, projectRoot: "../.." });
  const moved = path.join(sb.home, "moved 東京 project");
  renameSync(root, moved);
  const directory = path.join(moved, name === "pi" ? ".pi" : ".opencode", "cavelon");
  const runtime = await loadNativeRuntime(path.join(directory, "profile.json"), name);
  expect(runtime.projectRoot).toBe(await import("node:fs/promises").then(fs => fs.realpath(moved)));
  expect((await planNativeInstallation(config, command, sb.env, { root: moved })).outcome).toBe("unchanged");
  expect((await checkNativeInstallation(directory)).command).toEqual(command);
  writeFileSync(path.join(directory, "personal.txt"), "keep");
  expect((await removeNativeInstallation(directory)).removed).toBe(true);
  expect(read(path.join(directory, "personal.txt"))).toBe("keep");
  expect(existsSync(path.join(directory, "profile.json"))).toBe(false);
});

it.each(["opencode", "pi"] as const)("%s reuses verified user integration and gives a pre-existing project native adapter precedence", async name => {
  const p = await install(name);
  const root = path.join(sb.home, "project");
  mkdirSync(root);
  const config = nativeClient(name)!.project(sb.env)!;
  expect(await planNativeInstallation(config, command, sb.env, { root })).toMatchObject({ outcome: "unchanged", reason: expect.stringContaining("user native") });
  const file = path.join(root, config.file);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ [config.keys[0]!]: { cavelon: name === "pi" ? command : { type: "local", command: ["cavelon", "mcp"] } } }));
  const project = await planNativeInstallation(config, command, sb.env, { root });
  expect(project.outcome, project.reason).toBe("planned");
  await applyNativeInstallation(project);
  const user = await loadNativeRuntime(path.join(p.dir, "profile.json"), name);
  expect(await hasNativeProjectOwner(user, name, root)).toBe(true);
  expect((await checkNativeInstallation(p.dir)).command).toEqual(command);
  if (name === "opencode") {
    const hooks = await startOpenCodeServer({ directory: root }, { ...user, command: { command: "must-not-start", args: [] } });
    expect(hooks.tool).toEqual({});
    await hooks.dispose();
  } else {
    const events = new Map<string, (event: unknown, ctx: PiContext) => Promise<void>>();
    const registered: string[] = [];
    const api: PiApi = { on: (event, callback) => events.set(event, callback), getAllTools: () => [], registerTool: tool => { registered.push(tool.name); } };
    installPiExtension(api, { ...user, command: { command: "must-not-start", args: [] } });
    const ctx: PiContext = { cwd: root, hasUI: true, mode: "tui", isProjectTrusted: () => true,
      ui: { confirm: async () => { throw new Error("No dialog should be opened by the yielding user adapter."); } } };
    await events.get("session_start")!(undefined, ctx);
    expect(registered).toEqual([]);
    await events.get("session_shutdown")!(undefined, ctx);
  }
});

it("setup recovers the user ownership pointer without exposing personal configuration in JSON", async () => {
  const config = nativeClient("pi")!.user(sb.env).mcp;
  mkdirSync(path.dirname(config.file), { recursive: true });
  const secret = "synthetic-private-config-sentinel";
  writeFileSync(config.file, JSON.stringify({ mcpServers: { other: { command: "other", args: [], env: { EXAMPLE: secret } } } }));
  const p = await install("pi");
  const result = await cli(sb, ["setup", "--agents", "pi", "--yes", "--json"], { env: { PATH: "", CAVELON_URL: undefined, CAVELON_TOKEN: undefined } });
  expect(result.code, result.stderr + result.stdout).toBe(0);
  expect(result.stdout).not.toContain(secret);
  expect(JSON.parse(read(path.join(configDir(sb.env), "setup.json"))).agents.pi.native).toEqual({ directory: p.dir });
  expect(read(config.file)).toContain(secret);
});

it("invalid Pi settings and MCP configuration errors do not expose their contents", async () => {
  const config = nativeClient("pi")!.user(sb.env).mcp;
  mkdirSync(path.dirname(config.file), { recursive: true });
  const settings = path.join(path.dirname(config.file), "settings.json");
  const secret = "synthetic-private-invalid-value";
  writeFileSync(settings, secret);
  const plan = await planNativeInstallation(config, command, sb.env);
  expect(plan.reason).toMatch(/plain JSON/);
  expect(plan.reason).not.toContain(secret);
  expect(existsSync(config.file)).toBe(false);
  writeFileSync(settings, "{}");
  const p = await install("pi");
  writeFileSync(config.file, secret);
  try {
    await loadNativeRuntime(path.join(p.dir, "profile.json"), "pi");
    throw new Error("The invalid MCP configuration was accepted.");
  } catch (error) {
    expect(String(error)).toMatch(/plain JSON/);
    expect(String(error)).not.toContain(secret);
  }
});

it("respects an explicit OpenCode TUI path independently of the MCP config path and a person's disabled plugin", async () => {
  const env = { ...sb.env, OPENCODE_CONFIG: path.join(sb.home, "mcp.jsonc"), OPENCODE_TUI_CONFIG: path.join(sb.home, "ui", "custom.jsonc") };
  const config = nativeClient("opencode")!.user(env).mcp;
  const plan = await planNativeInstallation(config, command, env);
  await applyNativeInstallation(plan);
  expect(readJsoncEntry(read(env.OPENCODE_TUI_CONFIG), ["plugin"])).toMatchObject({ value: [expect.stringContaining("opencode-tui-entry.mjs")] });
  const before = read(config.file);
  writeFileSync(env.OPENCODE_TUI_CONFIG, JSON.stringify({ plugin: (readJsoncEntry(read(env.OPENCODE_TUI_CONFIG), ["plugin"]) as { value: unknown }).value, plugin_enabled: { "cavelon.native-approval.user": false } }));
  expect((await planNativeInstallation(config, command, env)).reason).toMatch(/turned off/);
  expect((await checkNativeInstallation(plan.directory)).reason).toMatch(/turned off/);
  expect(read(config.file)).toBe(before);
  expect((await removeNativeInstallation(plan.directory)).removed).toBe(true);
  expect(read(env.OPENCODE_TUI_CONFIG)).toContain('"cavelon.native-approval.user":false');
});
