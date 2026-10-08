import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync, mkdirSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { nativeEntryHash, loadNativeRuntime, nativeRuntimeDirectory } from "../src/native-approval/profile.js";
import { previewPages } from "../src/native-approval/preview-pages.js";
import type { OpenCodeTui } from "../src/native-approval/opencode-tui.js";
import type { PiApi, PiContext } from "../src/native-approval/pi-extension.js";
import { KIT_VERSION } from "../src/version.js";

// Dialogs in this suite are simulated. Actual person UI qualification is separate.
let root: string;
let assets: string;
let buildScript: string;
beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "cavelon-native-test-"));
  assets = path.join(root, "standalone-assets");
  // Other suites consume dist/ during setup; deterministic build checks use a private copy.
  const cli = path.join(root, "build", "cli");
  mkdirSync(path.join(cli, "scripts"), { recursive: true });
  cpSync(path.resolve("src"), path.join(cli, "src"), { recursive: true });
  cpSync(path.resolve("package.json"), path.join(cli, "package.json"));
  cpSync(path.resolve("../LICENSE"), path.join(root, "build", "LICENSE"));
  buildScript = path.join(cli, "scripts", "build-native-assets.mjs");
  cpSync(path.resolve("scripts/build-native-assets.mjs"), buildScript);
  symlinkSync(path.resolve("node_modules"), path.join(cli, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  execFileSync(process.execPath, [buildScript], { timeout: 30_000 });
  cpSync(path.join(cli, "dist", "native-assets"), assets, { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
const nativeImport = (name: string) => import(pathToFileURL(path.join(assets, name + ".mjs")).href);
const command = () => ({ command: process.execPath, args: [path.resolve("test/fixtures/native-mcp-host.mjs")] });

it("refuses an output-path argument before removing any personal file", () => {
  const personal = path.join(root, "personal-build-directory");
  mkdirSync(personal);
  const sentinel = path.join(personal, "keep.txt");
  writeFileSync(sentinel, "personal file");
  expect(() => execFileSync(process.execPath, [buildScript, personal], { timeout: 30_000, stdio: "pipe" })).toThrow();
  expect(readFileSync(sentinel, "utf8")).toBe("personal file");
});

it("ships deterministic self-contained native entry points with pinned dependency licenses", async () => {
  const other = path.join(root, "second-render");
  execFileSync(process.execPath, [buildScript], { timeout: 30_000 });
  cpSync(path.resolve(path.dirname(buildScript), "../dist/native-assets"), other, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(assets, "manifest.json"), "utf8"));
  expect(manifest).toMatchObject({ format: 1, version: KIT_VERSION, entries: { opencode: ["opencode-server.mjs", "opencode-tui.mjs"], pi: ["pi-extension.mjs"] } });
  expect(readdirSync(assets).sort()).toEqual(readdirSync(other).sort());
  for (const file of readdirSync(assets)) expect(readFileSync(path.join(assets, file))).toEqual(readFileSync(path.join(other, file)));
  for (const file of manifest.files) {
    const bytes = readFileSync(path.join(assets, file.path));
    expect(bytes).toHaveLength(file.size);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
  }
  expect(manifest.files.map((file: any) => file.path)).toEqual(expect.arrayContaining(["MCP-SDK-LICENSE", "TYPEBOX-LICENSE", "ZOD-LICENSE", "JSONC-LICENSE"]));
  const server = await nativeImport("opencode-server");
  const tui = await nativeImport("opencode-tui");
  const pi = await nativeImport("pi-extension");
  expect(server.default.server).toBeTypeOf("function");
  expect(server.default.tui).toBeUndefined();
  expect(tui.default.tui).toBeTypeOf("function");
  expect(tui.default.server).toBeUndefined();
  expect(pi.default).toBeTypeOf("function");
  await expect(server.default.server({ directory: root }, {})).rejects.toThrow("profile");
}, 60_000);

it("binds a profile to its disabled Cavelon entry without copying environment values", async () => {
  const file = path.join(root, "opencode.jsonc");
  const profile = path.join(root, "profile.json");
  const entry = { type: "local", command: ["cavelon", "mcp"], enabled: false, environment: { CAVELON_CONFIG_DIR: "synthetic-config" } };
  writeFileSync(file, JSON.stringify({ mcp: { cavelon: entry, unrelated: { command: ["other"], enabled: true } } }));
  const binding = { client: "opencode", version: KIT_VERSION, configFile: file, entryHash: nativeEntryHash(entry), scope: "user" };
  writeFileSync(profile, JSON.stringify(binding));
  expect(readFileSync(profile, "utf8")).not.toContain("synthetic-config");
  expect((await loadNativeRuntime(profile, "opencode")).command).toMatchObject({ command: "cavelon", args: ["mcp"], env: { CAVELON_CONFIG_DIR: "synthetic-config" } });
  expect(nativeEntryHash({ b: 2, a: 1 })).toBe(nativeEntryHash({ a: 1, b: 2 }));
  writeFileSync(file, JSON.stringify({ mcp: { cavelon: { ...entry, enabled: true } } }));
  await expect(loadNativeRuntime(profile, "opencode")).rejects.toThrow("changed");
  writeFileSync(profile, JSON.stringify({ ...binding, entryHash: nativeEntryHash({ ...entry, enabled: true }) }));
  await expect(loadNativeRuntime(profile, "opencode")).rejects.toThrow("duplicate");
  await expect(loadNativeRuntime(profile, "pi")).rejects.toThrow("Invalid");
});

it("keeps every character of long Unicode previews visible and refuses tiny terminals", () => {
  const text = "Grüße東京🐳".repeat(1800);
  const pages = previewPages(text, 80, 24);
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.join("").replaceAll("\n", "")).toBe(text);
  expect(() => previewPages(text, 20, 10)).toThrow("Enlarge");
  const deep = path.join(root, "deep".repeat(500), "profile.json");
  if (process.platform !== "win32") expect(Buffer.byteLength(nativeRuntimeDirectory(deep))).toBeLessThan(80);
  expect(nativeRuntimeDirectory(deep)).not.toBe(nativeRuntimeDirectory(deep + "-other"));
});

it("the bundled OpenCode pair routes namespaced tools to fresh dialogs and preserves headless refusal", async () => {
  const serverModule = await nativeImport("opencode-server");
  const tuiModule = await nativeImport("opencode-tui");
  let session = "synthetic-session";
  let dialog = false;
  let answer = false;
  let closeDialog: (() => void) | undefined;
  const messages: string[] = [];
  const api: OpenCodeTui = {
    route: { get current() { return { name: "session", params: { sessionID: session } }; } },
    state: { path: { directory: root } }, renderer: { width: 120, height: 50 }, lifecycle: { onDispose: () => undefined },
    ui: {
      DialogAlert(props) { messages.push(props.message); queueMicrotask(() => { props.onConfirm(); api.ui.dialog.clear(); }); },
      DialogConfirm(props) { messages.push(props.message); queueMicrotask(() => { if (answer) props.onConfirm(); else props.onCancel(); api.ui.dialog.clear(); }); },
      dialog: {
        get open() { return dialog; },
        replace(render, close) { closeDialog?.(); dialog = true; closeDialog = close; render(); },
        clear() { dialog = false; const close = closeDialog; closeDialog = undefined; close?.(); }, setSize() {},
      },
    },
  };
  const options = { command: command(), version: KIT_VERSION, scope: "user", runtimeDir: nativeRuntimeDirectory(path.join(root, "opencode-profile.json")) };
  const tui = await tuiModule.startOpenCodeTui(api, options);
  const server = await serverModule.startOpenCodeServer({ directory: root }, options);
  const context = { sessionID: session, abort: new AbortController().signal };
  try {
    expect(Object.keys(server.tool)).toEqual(["cavelon_read", "cavelon_change"]);
    expect(JSON.parse((await server.tool.cavelon_read.execute({}, context)).output).content[0].text).toBe("Grüße 東京 🐳");
    const change = (message: string) => server.tool.cavelon_change.execute({ message }, context).then((result: any) => JSON.parse(result.output).content[0].text);
    expect(await change("synthetic exact change 1")).toBe("declined");
    answer = true;
    expect(await change("synthetic exact change 2")).toBe("approved");
    expect(messages).toEqual(["synthetic exact change 1", "synthetic exact change 2"]);
    const long = "Long SQL preview 東京🐳 ".repeat(600);
    expect(await change(long)).toBe("approved");
    const pages = messages.slice(2, -1);
    expect(pages.join("").replaceAll("\n", "")).toBe(long);
    expect(messages.at(-1)).toContain("all");
    session = "other-session";
    expect(await change("headless change")).toBe("person-terminal");
    expect(messages.at(-1)).toContain("all");
  } finally { await server.dispose(); await tui.close(); }
});

it("the bundled Pi extension uses the current TUI, preserves RPC refusal and refuses duplicate Cavelon tools", async () => {
  const module = await nativeImport("pi-extension");
  const handlers = new Map<string, (event: unknown, ctx: PiContext) => Promise<void>>();
  const tools = new Map<string, any>();
  const messages: string[] = [];
  let answer = false;
  const pi: PiApi = { on(event, callback) { handlers.set(event, callback); }, getAllTools() { return [...tools.keys()].map(name => ({ name })); }, registerTool(tool) { tools.set(tool.name, tool); } };
  const ctx: PiContext = { cwd: root, hasUI: true, mode: "tui", isProjectTrusted: () => true,
    ui: { async confirm(_title, message) { messages.push(message); return answer; } } };
  module.installPiExtension(pi, { command: command(), version: KIT_VERSION, scope: "user" });
  await handlers.get("session_start")!({}, ctx);
  const call = (message: string, current = ctx) => tools.get("mcp__cavelon__change").execute("id", { message }, undefined, undefined, current);
  try {
    expect((await call("change 1")).content[0].text).toBe("declined");
    answer = true;
    expect((await call("change 2")).content[0].text).toBe("approved");
    await handlers.get("session_start")!({}, { ...ctx, mode: "rpc" });
    expect((await call("rpc change", { ...ctx, mode: "rpc" })).content[0].text).toBe("person-terminal");
    expect(messages).toEqual(["change 1", "change 2"]);
  } finally { await handlers.get("session_shutdown")!({}, ctx); }
  const conflicting = new Map<string, (event: unknown, ctx: PiContext) => Promise<void>>();
  module.installPiExtension({ ...pi, on(event: string, callback: any) { conflicting.set(event, callback); } }, { command: command(), version: KIT_VERSION, scope: "user" });
  await expect(conflicting.get("session_start")!({}, ctx)).rejects.toThrow("already exist");
});

it("Pi's packaged default resolves its adjacent profile without a dependency directory", async () => {
  const isolated = path.join(root, "pi-packaged");
  cpSync(assets, isolated, { recursive: true });
  const config = path.join(root, "pi-mcp.json");
  const entry = { ...command(), enabled: false };
  writeFileSync(config, JSON.stringify({ mcpServers: { cavelon: entry } }));
  writeFileSync(path.join(isolated, "profile.json"), JSON.stringify({ client: "pi", version: KIT_VERSION, configFile: config, entryHash: nativeEntryHash(entry), scope: "user" }));
  const module = await import(pathToFileURL(path.join(isolated, "pi-extension.mjs")).href);
  const events: string[] = [];
  await module.default({ on(name: string) { events.push(name); } });
  expect(events).toEqual(["session_start", "session_shutdown"]);
});

it("OpenCode's packaged defaults load a portable adjacent profile and retain headless refusal", async () => {
  const isolated = path.join(root, "opencode-packaged");
  cpSync(assets, isolated, { recursive: true });
  const entry = { type: "local", command: [command().command, ...command().args], enabled: false };
  writeFileSync(path.join(isolated, "opencode.json"), JSON.stringify({ mcp: { cavelon: entry } }));
  writeFileSync(path.join(isolated, "profile.json"), JSON.stringify({ format: 2, client: "opencode", version: KIT_VERSION,
    configFile: "opencode.json", entryHash: nativeEntryHash(entry), scope: "project", projectRoot: "." }));
  const serverModule = await import(pathToFileURL(path.join(isolated, "opencode-server.mjs")).href);
  const tuiModule = await import(pathToFileURL(path.join(isolated, "opencode-tui.mjs")).href);
  const disposers: Array<() => Promise<void>> = [];
  const api: OpenCodeTui = { route: { current: { name: "home" } }, state: { path: { directory: isolated } },
    renderer: { width: 80, height: 24 }, lifecycle: { onDispose(callback) { disposers.push(callback); } },
    ui: { DialogAlert() { throw new Error("Unexpected dialog"); }, DialogConfirm() { throw new Error("Unexpected dialog"); },
      dialog: { open: false, replace() { throw new Error("Unexpected dialog"); }, clear() {}, setSize() {} } } };
  const server = await serverModule.default.server({ directory: isolated }, undefined);
  try {
    const context = { sessionID: "headless", abort: new AbortController().signal };
    const read = await server.tool.cavelon_read.execute({}, context);
    expect(JSON.parse(read.output).content[0].text).toBe("Grüße 東京 🐳");
    const change = await server.tool.cavelon_change.execute({ message: "synthetic change" }, context);
    expect(JSON.parse(change.output).content[0].text).toBe("person-terminal");
    await tuiModule.default.tui(api, undefined);
    await expect(serverModule.default.server({ directory: root }, undefined)).rejects.toThrow(/matching project/);
    await expect(tuiModule.default.tui({ ...api, state: { path: { directory: root } } }, undefined)).rejects.toThrow(/matching project/);
  } finally { await server.dispose(); for (const dispose of disposers) await dispose(); }
});
