import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { COMMANDS } from "../src/commands/index.js";
import type { InStream, Io } from "../src/io.js";
import { createMcpServer } from "../src/mcp.js";
import { cavelonCommand, folderCommand, personCommand, printingFor } from "../src/printed.js";
import { currentShell, shellWord, useShell, type Shell } from "../src/shell.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { askingClient, cli, login, sandbox, type PersonAtClient, type Sandbox } from "./helpers.js";

let server: FakeServer;
let sb: Sandbox;
let root: string;
let tenant: string;
const directories = ["solutions/review", "solutions/assistant"];
const imports = () => server.state.requests.filter(r => r.method === "POST" && r.path === "/api/v1/agent-graph/import");

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  sb = sandbox();
  root = path.join(sb.home, "workspace with spaces");
  mkdirSync(root);
  sb.env.CAVELON_CONFIG_DIR = path.join(root, ".private", "config");
  sb.env.CAVELON_CACHE_DIR = path.join(root, ".private", "cache");
  sb.env.CAVELON_CONTRACT_TTL_SECONDS = "0";
  sb.env.CAVELON_SHELL = "posix";
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
  writeFileSync(path.join(root, "cavelon.yaml"), `instance: ${server.url}\ntenant: ${tenant}\n`);
  for (const directory of directories) {
    const cwd = path.join(root, directory);
    mkdirSync(cwd, { recursive: true });
    const harness = path.basename(directory);
    const init = await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--harness", harness], { cwd });
    expect(init.code, init.stdout + init.stderr).toBe(0);
    server.editConfig(tenant, pkg => { (pkg.agents as any[]).push({ ...(pkg.agents as any[])[0], slug: "obsolete", name: "Obsolete" }); });
    const pulled = await cli(sb, ["pull"], { cwd });
    expect(pulled.code, pulled.stdout + pulled.stderr).toBe(0);
    const file = path.join(cwd, "package", "agents.yaml");
    writeFileSync(file, stringify((parse(readFileSync(file, "utf8")) as any[]).filter(agent => agent.slug !== "obsolete")));
    server.state.configs.clear();
  }
});
beforeEach(() => {
  server.state.configs.clear();
  server.state.requests.length = 0;
  server.state.previewExtras = { summary: { creates: {}, updates: {}, deletes: { agents: 1 }, references: {} } };
  for (const directory of directories) rmSync(path.join(root, directory, ".cavelon", "previews"), { recursive: true, force: true });
});
afterAll(async () => { sb.cleanup(); await server.close(); });

async function session(person: PersonAtClient = "approves") {
  const io: Io = { stdout: { write: () => true }, stderr: { write: () => true }, stdin: Readable.from([]) as unknown as InStream, env: sb.env, cwd: root, now: () => new Date(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(io, COMMANDS).connect(serverSide);
  const client = askingClient({ person });
  await client.connect(clientSide);
  return {
    client,
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      return { isError: Boolean(result.isError), body: JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, any> };
    },
  };
}

it("root MCP confirms the exact deleting preview made in a child solution, with that solution's env", async () => {
  const cwd = path.join(root, directories[0]!);
  const preview = await cli(sb, ["apply", "--mode", "replace", "--env", "test", "--json"], { cwd, env: { CLAUDECODE: "1" } });
  expect(preview.code, preview.stdout + preview.stderr).toBe(0);
  const saved = preview.json<Record<string, any>>();
  const s = await session();
  try {
    const original = await s.call("apply", { confirm: saved.preview_id, env: "test", harness: "review" });
    expect(original.body.error.message).toContain("No env/test.yaml in this solution");
    expect(imports()).toEqual([]);
    const done = await s.call("apply", { solution_dir: directories[0], confirm: saved.preview_id, env: "test", harness: "review" });
    expect(done.isError, JSON.stringify(done.body)).toBe(false);
    expect(done.body).toMatchObject({ applied: true, preview_id: saved.preview_id });
    expect(s.client.asked).toHaveLength(1);
    expect(s.client.asked[0]).toContain("solution review");
    expect(imports()).toHaveLength(1);
    expect(imports()[0]!.body).toMatchObject({ preview_id: saved.preview_id, mode: "replace", harness_id: saved.harness.id });
  } finally { await s.client.close(); }
});

it.each(["declines", "cannot ask"] as const)("selected child import still requires the person's fresh answer: %s", async person => {
  const s = await session(person);
  try {
    const preview = await s.call("apply", { solution_dir: directories[0], mode: "replace", env: "test" });
    expect(preview.isError, JSON.stringify(preview.body)).toBe(false);
    expect(preview.body).toMatchObject({ show_to_person: true, needs_person: person === "declines" ? "client" : "terminal" });
    const result = await s.call("apply", { solution_dir: directories[0], confirm: preview.body.preview_id, env: "test" });
    expect(result.body.error.code).toBe(person === "declines" ? "confirm_declined" : "confirm_needs_person");
    expect(imports()).toEqual([]);
    if (person === "cannot ask") {
      // macOS /var and Windows short temp paths resolve to their real spelling.
      expect(result.body.error.details.person_command).toContain(`cd -- ${shellWord(await realpath(path.join(root, directories[0]!)))} && cavelon apply`);
    }
  } finally { await s.client.close(); }
});

it("a preview stays in its selected solution; another folder cannot confirm it", async () => {
  const s = await session();
  try {
    const preview = await s.call("apply", { solution_dir: directories[0], mode: "replace", env: "test" });
    expect(preview.isError, JSON.stringify(preview.body)).toBe(false);
    const other = await s.call("apply", { solution_dir: directories[1], confirm: preview.body.preview_id, env: "test" });
    expect(other.body.error.code).toBe("preview_unknown");
    expect(other.body.error.hint).toContain(`"solution_dir":"${directories[1]}"`);
    expect(s.client.asked).toEqual([]);
    expect(imports()).toEqual([]);
    const again = await s.call("apply", { solution_dir: directories[0], confirm: preview.body.preview_id, env: "test" });
    expect(again.body.applied).toBe(true);
  } finally { await s.client.close(); }
});

it("concurrent solution calls resolve their own files without changing the default workspace", async () => {
  const s = await session();
  try {
    const results = await Promise.all(directories.map(solution_dir => s.call("apply", { solution_dir, mode: "replace", env: "test" })));
    for (const [index, result] of results.entries()) {
      expect(result.isError, JSON.stringify(result.body)).toBe(false);
      expect(result.body.harness.slug).toBe(path.basename(directories[index]!));
    }
    expect(imports()).toEqual([]);
    // Selecting a child never changes the next call's default workspace.
    const unchanged = await s.call("apply", { env: "test" });
    expect(unchanged.body.error.message).toContain("No env/test.yaml in this solution");
  } finally { await s.client.close(); }
});

it("all tools advertise solution_dir independently of existing arguments", async () => {
  const s = await session();
  try {
    for (const tool of (await s.client.listTools()).tools) expect(tool.inputSchema.properties?.solution_dir, tool.name).toMatchObject({ type: "string" });
    const upload = (await s.client.listTools()).tools.find(tool => tool.name === "kb_upload")!;
    expect(upload.inputSchema.properties?.dir).toBeDefined();
  } finally { await s.client.close(); }
});

it.each(["../", ".private/config", ".private/cache", "missing", "cavelon.yaml", "", 42, null])("invalid or private selection %j sends no request", async solution_dir => {
  const s = await session();
  try {
    server.state.requests.length = 0;
    const result = await s.call("status", { solution_dir, offline: true });
    expect(result.isError).toBe(true);
    expect(result.body.error.code).not.toBe("internal_error");
    expect(server.state.requests).toEqual([]);
  } finally { await s.client.close(); }
});

it("a selected solution cannot read a sibling's files or escape through a symlink", async () => {
  const s = await session();
  try {
    const sibling = await s.call("api", { solution_dir: directories[0], operation: "set_variable", params: ["name=region"], body: "@../assistant/cavelon.yaml" });
    expect(sibling.body.error.code).toBe("path_outside_solution");
    expect(imports()).toEqual([]);
    if (process.platform !== "win32") {
      const link = path.join(root, "escape");
      symlinkSync(sb.home, link, "dir");
      const escaped = await s.call("status", { solution_dir: "escape", offline: true });
      expect(escaped.body.error.code).toBe("path_outside_solution");
      rmSync(link);
    }
  } finally { await s.client.close(); }
});

it.each(["posix", "powershell", "cmd"] as const)("selected-folder next steps and terminal fallback preserve their target in %s", shell => {
  const previous = currentShell();
  useShell(shell);
  try {
    const directory = path.join(root, "solutions", "review");
    const shown = printingFor({ mode: "mcp", commands: COMMANDS, solutionDir: directories[0], personCwd: directory }, () => ({
      tool: folderCommand("apply", "--env", "test", "--confirm", "pv_example"),
      hint: cavelonCommand("status"),
      person: personCommand("apply", "--env", "test", "--confirm", "pv_example"),
    }));
    expect(JSON.parse(shown.tool.slice("apply ".length))).toEqual({ env: "test", confirm: "pv_example", solution_dir: directories[0] });
    expect(JSON.parse(shown.hint.slice("status ".length))).toEqual({ solution_dir: directories[0] });
    const prefixes: Record<Shell, string> = { posix: `cd -- ${shellWord(directory)} && `, cmd: `cd /d ${shellWord(directory)} && `, powershell: `& { Set-Location -LiteralPath ${shellWord(directory)} -ErrorAction Stop; ` };
    expect(shown.person).toBe(`${prefixes[shell]}cavelon apply --env test --confirm pv_example${shell === "powershell" ? " }" : ""}`);
  } finally { useShell(previous); }
});
