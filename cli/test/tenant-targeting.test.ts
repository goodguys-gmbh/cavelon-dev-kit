import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../src/commands/index.js";
import type { InStream, Io } from "../src/io.js";
import { createMcpServer } from "../src/mcp.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * Which tenant a command acts in, and who sees it: a tenant API key never
 * acts in its own tenant when the command names another; every preview names
 * the instance, the tenant and the mode; `use_tenant` over MCP chooses for
 * the session, never for the person; a cached slug holds for one credential
 * and a day, and is resolved again when the instance refuses its tenant.
 */

let server: FakeServer;
let sb: Sandbox;
let acme: string;
let beta: string;
let pat: string;
let dir: string;

const configOf = (box: Sandbox) =>
  JSON.parse(readFileSync(path.join(box.env.CAVELON_CONFIG_DIR!, "config.json"), "utf8")) as {
    instances: Record<string, { tenant?: string; tenant_id?: string; tenant_ids?: Record<string, string>; tenant_refs?: Record<string, { id: string; credential: string; resolved_at: string }> }>;
  };
/** The lookups of a tenant by name or slug: /meta/principal asked without a tenant. */
const lookups = () => server.state.requests.filter((r) => r.path === "/api/v1/meta/principal" && !r.headers["x-tenant-id"]);

beforeAll(async () => {
  server = await startFakeServer();
  acme = server.addTenant("acme", "Acme");
  beta = server.addTenant("beta", "Beta");
  sb = sandbox();
  pat = server.addToken({ kind: "pat", tenantIds: [acme, beta], defaultTenant: acme });
  await login(sb, server.url, pat, ["--tenant", "acme"]);
  for (const tenant of ["acme", "beta"]) await cli(sb, ["harness", "new", "support", "--name", "Support", "--tenant", tenant]);
  dir = path.join(sb.home, "solution");
  mkdirSync(dir, { recursive: true });
  expect((await cli(sb, ["init", "--instance", server.url, "--tenant", "acme", "--harness", "support"], { cwd: dir })).code).toBe(0);
  expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
  writeFileSync(path.join(dir, "env", "prod.yaml"), "tenant: beta\n");
});
beforeEach(() => {
  server.state.requests.length = 0;
  server.state.servePrincipal = true;
});
afterAll(async () => {
  sb.cleanup();
  await server.close();
});

describe("a tenant API key and the tenant a command names", () => {
  const keyEnv = (key: string) => ({ CAVELON_URL: server.url, CAVELON_TOKEN: key });

  it("CI: a key for acme with env/prod.yaml naming beta is refused, naming both, and nothing is previewed", async () => {
    const key = server.addToken({ kind: "key", tenantIds: [acme], tokenName: "ci" });
    const result = await cli(sb, ["apply", "--env", "prod", "--json"], { cwd: dir, env: keyEnv(key) });
    expect(result.code, result.stdout + result.stderr).toBe(2);
    const { error } = result.json<{ error: { code: string; message: string; details: Record<string, unknown> } }>();
    expect(error.code).toBe("tenant_mismatch");
    expect(error.message).toBe(`The tenant API key "ci" acts only in tenant Acme (acme, ${acme}), but env/prod.yaml names tenant "beta"; nothing was sent there.`);
    expect(error.details).toEqual({ named: { ref: "beta", from: "env/prod.yaml" }, key_tenant: { id: acme, name: "Acme", slug: "acme" } });
    expect(server.state.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("--tenant and CAVELON_TENANT are checked too, by id as by slug", async () => {
    const key = server.addToken({ kind: "key", tenantIds: [acme] });
    const byId = await cli(sb, ["harness", "list", "--tenant", beta, "--json"], { env: keyEnv(key) });
    expect(byId.code).toBe(2);
    expect(byId.json<{ error: { code: string; message: string } }>().error.message).toMatch(new RegExp(`but --tenant names tenant "${beta}"`));
    const byVariable = await cli(sb, ["harness", "list", "--json"], { env: { ...keyEnv(key), CAVELON_TENANT: "Beta" } });
    expect(byVariable.code).toBe(2);
    expect(byVariable.json<{ error: { code: string } }>().error.code).toBe("tenant_mismatch");
    expect(server.state.requests.filter((r) => r.path === "/api/v1/harnesses")).toEqual([]);
  });

  it("a key whose own tenant is named works, and its preview names that tenant", async () => {
    const key = server.addToken({ kind: "key", tenantIds: [acme] });
    const listed = await cli(sb, ["harness", "list", "--tenant", acme, "--json"], { env: keyEnv(key) });
    expect(listed.code, listed.stderr).toBe(0);
    const preview = await cli(sb, ["apply", "--json"], { cwd: dir, env: keyEnv(key) });
    expect(preview.code, preview.stdout + preview.stderr).toBe(0);
    expect(preview.json<{ target: unknown }>().target).toEqual({
      instance: server.url,
      tenant: { id: acme, name: "Acme", slug: "acme" },
      mode: "tenant",
      credential: "api_key",
      tenant_from: "cavelon.yaml",
    });
  });

  it("an instance that does not say which tenant a key is in: the command goes ahead and says it could not check", async () => {
    server.state.servePrincipal = false;
    const key = server.addToken({ kind: "key", tenantIds: [acme] });
    const result = await cli(sb, ["harness", "list", "--tenant", "beta"], { env: keyEnv(key) });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/this instance does not say which, so the kit cannot check that it is "beta" \(from --tenant\)/);
  });
});

describe("a preview names the instance, the tenant and the mode it acts on", () => {
  it("apply: the tenant --tenant names, in the text and in --json", async () => {
    const preview = await cli(sb, ["apply", "--env", "prod", "--tenant", "beta"], { cwd: dir });
    expect(preview.code, preview.stdout + preview.stderr).toBe(0);
    expect(preview.stdout).toContain(`\nacts on: ${server.url}, tenant Beta (beta, ${beta}) from --tenant, tenant mode\n`);
    const confirm = /Import exactly this: (.+)/.exec(preview.stdout)![1]!.split(" ").slice(1);
    const applied = await cli(sb, [...confirm, "--json"], { cwd: dir });
    expect(applied.code, applied.stdout + applied.stderr).toBe(0);
    expect(applied.json<{ target: { tenant: { id: string } } }>().target.tenant.id).toBe(beta);
  });

  it("a changing command, run by a person: the tenant cavelon use chose", async () => {
    const preview = await cli(sb, ["variables", "set", "region", "eu", "--json"]);
    expect(preview.code, preview.stderr).toBe(0);
    const deleted = await cli(sb, ["variables", "delete", "region"]);
    expect(deleted.stdout).toContain(`acts on: ${server.url}, tenant Acme (acme, ${acme}) from \`cavelon use\`, tenant mode\n`);
  });

  it("over MCP: the tenant an agent passed, and a Platform-mode token with no tenant chosen", async () => {
    const operator = sandbox();
    const ops = server.addToken({ kind: "pat", tenantIds: [], platform: true, globalRole: "superadmin", platformOnly: true });
    const agent = await mcpClient(sb);
    const platformAgent = await mcpClient(operator, { CAVELON_URL: server.url, CAVELON_TOKEN: ops });
    try {
      const limit = payload(await agent.callTool({ name: "limits_set", arguments: { key: "agent_max_turns", value: "7", tenant: "beta" } }));
      expect(limit.target).toEqual({
        instance: server.url,
        tenant: { id: beta, name: "Beta", slug: "beta" },
        mode: "tenant",
        credential: "personal_access_token",
        tenant_from: "the tenant argument",
      });
      const sent = payload(await platformAgent.callTool({ name: "api", arguments: { operation: "create_harness", body: '{"name": "X", "slug": "x"}' } }));
      expect(sent).toMatchObject({ sent: false, target: { instance: server.url, tenant: null, mode: "platform" } });
    } finally {
      await agent.close();
      await platformAgent.close();
      operator.cleanup();
    }
  });
});

describe("use_tenant over MCP chooses for the session, never for the person", () => {
  it("later tool calls act in the session's tenant; the person's stored tenant and terminal commands stay", async () => {
    const before = configOf(sb).instances[server.url]!;
    const agent = await mcpClient(sb);
    try {
      const chosen = payload(await agent.callTool({ name: "use_tenant", arguments: { tenant: "beta" } }));
      expect(chosen).toMatchObject({ scope: "session", tenant: { ref: "beta", id: beta } });
      expect(configOf(sb).instances[server.url]).toEqual(before);
      expect(payload(await agent.callTool({ name: "whoami", arguments: {} })).tenant).toMatchObject({ id: beta, source: "session" });
      const terminal = await cli(sb, ["whoami", "--json"]);
      expect(terminal.json<{ tenant: { id: string; source: string } }>().tenant).toMatchObject({ id: acme, source: "use" });

      const cleared = payload(await agent.callTool({ name: "use_tenant", arguments: { clear: true } }));
      expect(cleared).toMatchObject({ scope: "session", tenant: null });
      expect(configOf(sb).instances[server.url]).toEqual(before);
      expect(payload(await agent.callTool({ name: "whoami", arguments: {} })).tenant).toMatchObject({ id: acme, source: "use" });
    } finally {
      await agent.close();
    }
  });

  it("each MCP server keeps its own choice", async () => {
    const one = await mcpClient(sb);
    const two = await mcpClient(sb);
    try {
      await one.callTool({ name: "use_tenant", arguments: { tenant: "beta" } });
      expect(payload(await two.callTool({ name: "whoami", arguments: {} })).tenant).toMatchObject({ id: acme });
    } finally {
      await one.close();
      await two.close();
    }
  });
});

describe("the cache of resolved slugs", () => {
  it("holds for the credential that resolved it, never stores the token, and ignores the old cache", async () => {
    const own = sandbox();
    try {
      const first = server.addToken({ kind: "pat", tenantIds: [acme, beta], defaultTenant: acme });
      await login(own, server.url, first);
      // What an earlier release wrote: a slug pointing at another tenant, for any token.
      const config = configOf(own);
      config.instances[server.url]!.tenant_ids = { beta: acme };
      writeFileSync(path.join(own.env.CAVELON_CONFIG_DIR!, "config.json"), JSON.stringify(config));

      server.state.requests.length = 0;
      expect((await cli(own, ["harness", "list", "--tenant", "beta"])).code).toBe(0);
      expect(lookups().length).toBeGreaterThan(0);
      expect(server.state.requests.find((r) => r.path === "/api/v1/harnesses")!.headers["x-tenant-id"]).toBe(beta);
      const cached = configOf(own).instances[server.url]!;
      expect(cached.tenant_ids).toBeUndefined();
      expect(cached.tenant_refs!.beta).toMatchObject({ id: beta, credential: expect.stringMatching(/^[0-9a-f]{16}$/) });
      expect(readFileSync(path.join(own.env.CAVELON_CONFIG_DIR!, "config.json"), "utf8")).not.toContain(first.slice(6, 20));

      // The same token: from the cache.
      server.state.requests.length = 0;
      expect((await cli(own, ["harness", "list", "--tenant", "beta"])).code).toBe(0);
      expect(lookups()).toEqual([]);

      // Another token for the same instance resolves the slug again.
      await login(own, server.url, server.addToken({ kind: "pat", tenantIds: [acme, beta], defaultTenant: acme }));
      server.state.requests.length = 0;
      expect((await cli(own, ["harness", "list", "--tenant", "beta"])).code).toBe(0);
      expect(lookups().length).toBeGreaterThan(0);

      // A day later, too.
      server.state.requests.length = 0;
      const later = () => new Date(Date.now() + 25 * 60 * 60 * 1000);
      expect((await cli(own, ["harness", "list", "--tenant", "beta"], { now: later })).code).toBe(0);
      expect(lookups().length).toBeGreaterThan(0);
    } finally {
      own.cleanup();
    }
  });

  it("a reused slug: a read refused in the cached tenant resolves the slug again and reads the new one", async () => {
    const own = sandbox();
    try {
      const old = server.addTenant("gamma", "Gamma");
      const token = server.addToken({ kind: "pat", tenantIds: [acme, old], defaultTenant: acme });
      await login(own, server.url, token);
      expect((await cli(own, ["harness", "list", "--tenant", "gamma"])).code).toBe(0);
      expect(configOf(own).instances[server.url]!.tenant_refs!.gamma!.id).toBe(old);

      // The slug moves to a new tenant; the token no longer reaches the old one.
      server.state.tenants.find((t) => t.id === old)!.slug = "gamma-old";
      const fresh = server.addTenant("gamma", "Gamma");
      server.state.tokens.get(token)!.tenantIds = [acme, fresh];
      expect((await cli(own, ["harness", "new", "gamma-bot", "--name", "Gamma Bot", "--tenant", fresh])).code).toBe(0);

      server.state.requests.length = 0;
      const listed = await cli(own, ["harness", "list", "--tenant", "gamma", "--json"]);
      expect(listed.code, listed.stdout + listed.stderr).toBe(0);
      expect(JSON.stringify(listed.json())).toContain("gamma-bot");
      expect(server.state.requests.filter((r) => r.path === "/api/v1/harnesses").map((r) => r.headers["x-tenant-id"])).toEqual([old, fresh]);
      expect(configOf(own).instances[server.url]!.tenant_refs!.gamma!.id).toBe(fresh);
    } finally {
      own.cleanup();
    }
  });

  it("a change refused in the cached tenant is not sent again: the slug is resolved again and the command says so", async () => {
    const own = sandbox();
    try {
      const old = server.addTenant("delta", "Delta");
      const token = server.addToken({ kind: "pat", tenantIds: [acme, old], defaultTenant: acme });
      await login(own, server.url, token);
      expect((await cli(own, ["harness", "list", "--tenant", "delta"])).code).toBe(0);
      server.state.tenants.find((t) => t.id === old)!.slug = "delta-old";
      const fresh = server.addTenant("delta", "Delta");
      server.state.tokens.get(token)!.tenantIds = [acme, fresh];

      server.state.requests.length = 0;
      // The change is the command's first request in the tenant.
      const created = await cli(own, ["api", "create_harness", "--body", '{"name": "Delta Bot", "slug": "delta-bot"}', "--tenant", "delta", "--json"]);
      expect(created.code).toBe(4);
      expect(created.json<{ error: { code: string } }>().error.code).toBe("tenant_moved");
      expect(server.state.requests.filter((r) => r.method === "POST").map((r) => r.headers["x-tenant-id"])).toEqual([old]);
      expect(configOf(own).instances[server.url]!.tenant_refs!.delta!.id).toBe(fresh);
    } finally {
      own.cleanup();
    }
  });
});

/** An MCP client of its own server, as one agent session. */
async function mcpClient(box: Sandbox, env: Record<string, string> = {}): Promise<Client> {
  const io: Io = {
    stdout: { write: () => true },
    stderr: { write: () => true },
    stdin: Readable.from([]) as unknown as InStream,
    env: { ...box.env, ...env },
    cwd: box.home,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  const mcp = createMcpServer(io, COMMANDS);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text);
}
