import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, sandbox, type Sandbox } from "./helpers.js";

let server: FakeServer;
let sb: Sandbox;
let tenant: string;
let token: string;
let sequence = 0;
const directoryLink = (target: string, link: string) => symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
const args = ["init", "--harness", "support", "--json"];
const run = (cwd: string, command: string[]) => cli(sb, command, { cwd, env: { CAVELON_TOKEN: token, CAVELON_URL: server.url, CAVELON_TENANT: tenant, CAVELON_AGENT: "1" } });
const folder = (label: string) => {
  const dir = path.join(sb.home, `${label}-${++sequence}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const initialized = async () => {
  const root = folder("solution");
  const result = await run(root, args);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  return root;
};
const refuse = (result: Awaited<ReturnType<typeof run>>) => {
  expect(result.code, result.stdout + result.stderr).toBe(2);
  expect(result.json()).toMatchObject({ error: { code: "path_outside_solution" } });
};

beforeAll(async () => {
  sb = sandbox();
  server = await startFakeServer();
  tenant = server.addTenant("boundary", "Boundary");
  token = server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant });
  expect((await run(sb.home, ["harness", "new", "support", "--json"])).code).toBe(0);
});
beforeEach(() => { server.state.requests.length = 0; });
afterAll(async () => { sb.cleanup(); await server.close(); });

describe("solution-owned destinations", () => {
  it.each(["package", "tests", ".cavelon", "env", ".agents/skills", ".codex"])("init refuses an outside %s directory before creating files or a draft", async (name) => {
    const root = folder("fresh");
    const outside = folder("outside");
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    directoryLink(outside, path.join(root, name));
    refuse(await run(root, ["init", "--harness", `fresh-${sequence}`, "--new", "--agents", "codex", "--json"]));
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(path.join(root, "cavelon.yaml"))).toBe(false);
    expect(server.state.requests.filter(r => r.method !== "GET")).toEqual([]);
  });

  it.each(["package", "tests", ".cavelon"])("pull refuses a linked %s directory, including not-yet-existing output files", async (name) => {
    const root = await initialized();
    const outside = folder("outside");
    const sentinel = path.join(outside, "obsolete.yaml");
    writeFileSync(sentinel, "must stay\n");
    rmSync(path.join(root, name), { recursive: true, force: true });
    directoryLink(outside, path.join(root, name));
    refuse(await run(root, ["pull", "--force", "--json"]));
    expect(readdirSync(outside)).toEqual(["obsolete.yaml"]);
    expect(readFileSync(sentinel, "utf8")).toBe("must stay\n");
  });

  it.skipIf(process.platform === "win32").each(["pull.json", "inventory.json", "database-queries.json", "previews/foreign.json"])("refuses an individual linked state file (%s) before any remote request", async (name) => {
    const root = await initialized();
    const outside = folder("outside");
    const file = path.join(outside, "state.json");
    writeFileSync(file, '{"sentinel":"outside"}\n');
    const link = path.join(root, ".cavelon", name);
    mkdirSync(path.dirname(link), { recursive: true });
    rmSync(link, { force: true });
    symlinkSync(file, link);
    server.state.requests.length = 0;
    refuse(await run(root, ["apply", "--env", "test", "--json"]));
    expect(server.state.requests).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe('{"sentinel":"outside"}\n');
  });

  it.skipIf(process.platform === "win32")("init --update refuses a linked instruction file without editing its marked block", async () => {
    const root = await initialized();
    const outside = folder("outside");
    const file = path.join(outside, "AGENTS.md");
    writeFileSync(file, "<!-- cavelon:begin -->\nold\n<!-- cavelon:end -->\n");
    rmSync(path.join(root, "AGENTS.md"));
    symlinkSync(file, path.join(root, "AGENTS.md"));
    refuse(await run(root, ["init", "--update", "--json"]));
    expect(readFileSync(file, "utf8")).toContain("\nold\n");
  });

  it.skipIf(process.platform === "win32")("refuses a manifest linked outside the solution", async () => {
    const root = await initialized();
    const outside = folder("outside");
    const manifest = path.join(outside, "cavelon.yaml");
    writeFileSync(manifest, readFileSync(path.join(root, "cavelon.yaml")));
    rmSync(path.join(root, "cavelon.yaml"));
    symlinkSync(manifest, path.join(root, "cavelon.yaml"));
    server.state.requests.length = 0;
    refuse(await run(root, ["status", "--json"]));
    expect(server.state.requests).toEqual([]);
  });

  it.skipIf(process.platform === "win32").each(["package/agents.yaml", "env/test.yaml"])("never reads a %s link into a private kit directory inside the workspace", async name => {
    const root = await initialized();
    const config = path.join(root, ".private", "config");
    mkdirSync(config, { recursive: true });
    const privateFile = path.join(config, "synthetic.yaml");
    writeFileSync(privateFile, "synthetic-secret-sentinel\n");
    rmSync(path.join(root, name), { force: true });
    symlinkSync(privateFile, path.join(root, name));
    server.state.requests.length = 0;
    const command = name.startsWith("env/") ? ["apply", "--env", "test", "--json"] : ["validate", "--json"];
    const result = await cli(sb, command, { cwd: root, env: { CAVELON_TOKEN: token, CAVELON_URL: server.url, CAVELON_TENANT: tenant, CAVELON_CONFIG_DIR: config, CAVELON_AGENT: "1" } });
    expect(result.code, result.stdout + result.stderr).toBe(2);
    expect(result.json()).toMatchObject({ error: { code: "path_in_kit_directory" } });
    expect(result.stdout + result.stderr).not.toContain("synthetic-secret-sentinel");
    expect(server.state.requests).toEqual([]);
  });

  it("keeps directory links whose missing output children stay inside the solution", async () => {
    const root = folder("internal");
    mkdirSync(path.join(root, "shared"));
    directoryLink(path.join(root, "shared"), path.join(root, "package"));
    expect((await run(root, args)).code).toBe(0);
    const result = await run(root, ["pull", "--json"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(existsSync(path.join(root, "shared", "agents.yaml"))).toBe(true);
  });
});
