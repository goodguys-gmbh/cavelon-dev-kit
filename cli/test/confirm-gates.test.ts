import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../src/commands/index.js";
import type { InStream } from "../src/io.js";
import { createMcpServer } from "../src/mcp.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * The commands that change state outside a draft (a new tenant, a replaced
 * tenant variable, a loop run, the activation of a solution something already
 * reaches) preview first and change only with --confirm, as deactivate and
 * harness default do: in a person's terminal the flag, under a coding agent
 * and over MCP only the token of that very preview.
 */

let server: FakeServer;
let sb: Sandbox;
let platformSb: Sandbox;
let tenant: string;

const AGENT = { CLAUDECODE: "1" };
const TOKEN = /^[0-9a-f]{12}$/;

const posts = (path: string | RegExp) =>
  server.state.requests.filter((r) => r.method === "POST" && (typeof path === "string" ? r.path === path : path.test(r.path)));
const puts = (name: string) => server.state.requests.filter((r) => r.method === "PUT" && r.path === `/api/v1/variables/${name}`);
const harness = (slug: string) => server.state.harnesses.find((h) => h.tenant_id === tenant && h.slug === slug)! as Record<string, any>;

function addTrigger(slug: string, harnessId: string, isActive = true): void {
  server.state.lr.triggers.push({
    id: randomUUID(),
    tenant_id: tenant,
    slug,
    name: slug,
    harness_id: harnessId,
    trigger_type: "schedule",
    is_active: isActive,
    identity: { api_key_id: null, version: 1 },
    required_solutions: [],
    loop: { iterations: 1 },
  });
}

/** An MCP client on the person's stored token, as an agent's client is. */
async function mcpClient(home: Sandbox): Promise<{ call: (name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; body: Record<string, any> }>; close: () => Promise<void> }> {
  const mcp = createMcpServer(
    {
      stdout: { write: () => true },
      stderr: { write: () => true },
      stdin: Readable.from([]) as unknown as InStream,
      env: home.env,
      cwd: home.home,
      now: () => new Date(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
    COMMANDS,
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return {
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      return { isError: Boolean(result.isError), body: JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, any> };
    },
    close: () => client.close(),
  };
}

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  server.state.features = { ...server.state.features, masterloop_enabled: true };
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, mayActivate: true }));
  platformSb = sandbox();
  await login(platformSb, server.url, server.addToken({ kind: "pat", tenantIds: [], platform: true }));
});
afterAll(async () => {
  sb.cleanup();
  platformSb.cleanup();
  await server.close();
});
beforeEach(() => {
  server.state.requests.length = 0;
  server.state.failures = [];
  server.state.ready = true;
});

describe("tenant create", () => {
  it("previews the tenant and creates it only with --confirm", async () => {
    const preview = await cli(platformSb, ["tenant", "create", "preview-co", "--name", "Preview Co", "--json"]);
    expect(preview.code, preview.stderr + preview.stdout).toBe(0);
    expect(preview.json()).toMatchObject({
      created: false,
      would: "create_tenant",
      tenant: { slug: "preview-co", name: "Preview Co", plan: null },
      confirm: "cavelon tenant create preview-co --name 'Preview Co' --confirm",
      target: { mode: "platform", tenant: null },
    });
    expect(posts("/api/v1/tenants")).toHaveLength(0);
    const text = await cli(platformSb, ["tenant", "create", "preview-co", "--name", "Preview Co"]);
    expect(text.stdout).toMatch(/Creating tenant Preview Co \(preview-co\) adds a tenant to the platform/);
    expect(text.stdout).toMatch(/Platform mode, outside any tenant/);
    expect(text.stdout).toMatch(/Nothing was created\. Show this to a person; with their yes: cavelon tenant create preview-co --name 'Preview Co' --confirm/);

    const created = await cli(platformSb, ["tenant", "create", "preview-co", "--name", "Preview Co", "--confirm", "--json"]);
    expect(created.code, created.stderr + created.stdout).toBe(0);
    expect(created.json()).toMatchObject({ slug: "preview-co", name: "Preview Co" });
    expect(posts("/api/v1/tenants")).toHaveLength(1);
  });

  it("under a coding agent, only the preview's token creates it", async () => {
    const bare = await cli(platformSb, ["tenant", "create", "agent-co", "--confirm", "--json"], { env: AGENT });
    expect(bare.code).toBe(5);
    expect(bare.json()).toMatchObject({ created: false, token_required: true, confirm_token: expect.stringMatching(TOKEN) });
    const token = bare.json<{ confirm_token: string }>().confirm_token;
    expect(bare.json<{ confirm: string }>().confirm).toBe(`cavelon tenant create agent-co --name agent-co --confirm ${token}`);
    // A token of another change (another name) creates nothing.
    const other = await cli(platformSb, ["tenant", "create", "agent-co", "--name", "Other", "--confirm", token, "--json"], { env: AGENT });
    expect(other.code).toBe(4);
    expect(other.json()).toMatchObject({ created: false, token_mismatch: true });
    expect(posts("/api/v1/tenants")).toHaveLength(0);

    const created = await cli(platformSb, ["tenant", "create", "agent-co", "--confirm", token, "--json"], { env: AGENT });
    expect(created.code, created.stderr + created.stdout).toBe(0);
    expect(posts("/api/v1/tenants")).toHaveLength(1);
  });

  it("over MCP, refuses true and creates with the preview's confirm_token", async () => {
    const mcp = await mcpClient(platformSb);
    try {
      const refused = await mcp.call("tenant_create", { slug: "mcp-co", confirm: true });
      expect(refused.body.error).toMatchObject({ code: "confirm_token_required", exit_code: 2 });
      const shown = await mcp.call("tenant_create", { slug: "mcp-co" });
      expect(shown.body).toMatchObject({ created: false, confirm_token: expect.stringMatching(TOKEN) });
      expect(shown.body.confirm).toMatch(/^Show the person this, then call tenant_create again with the same arguments and confirm: "[0-9a-f]{12}"/);
      expect(posts("/api/v1/tenants")).toHaveLength(0);
      const done = await mcp.call("tenant_create", { slug: "mcp-co", confirm: shown.body.confirm_token });
      expect(done.isError, JSON.stringify(done.body)).toBe(false);
      expect(done.body).toMatchObject({ slug: "mcp-co" });
      expect(posts("/api/v1/tenants")).toHaveLength(1);
    } finally {
      await mcp.close();
    }
  });
});

describe("variables set", () => {
  it("creates a new variable at once and replaces another value only with --confirm", async () => {
    const created = await cli(sb, ["variables", "set", "gate_url", "https://a.example.com", "--json"]);
    expect(created.json()).toMatchObject({ created: true, changed: true });
    // The same value again changes nothing, so it needs no confirm.
    expect((await cli(sb, ["variables", "set", "gate_url", "https://a.example.com", "--json"])).json()).toMatchObject({ created: false, changed: false });

    server.state.requests.length = 0;
    const preview = await cli(sb, ["variables", "set", "gate_url", "https://b.example.com", "--json"]);
    expect(preview.code).toBe(0);
    expect(preview.json()).toMatchObject({
      changed: false,
      would: "replace",
      previous: "https://a.example.com",
      value: "https://b.example.com",
      confirm: "cavelon variables set gate_url https://b.example.com --confirm",
      target: { mode: "tenant", tenant: { id: tenant } },
    });
    expect(puts("gate_url")).toHaveLength(0);
    expect(server.state.values.get(tenant)!.variables.get("gate_url")).toBe("https://a.example.com");
    const text = await cli(sb, ["variables", "set", "gate_url", "https://b.example.com"]);
    expect(text.stdout).toMatch(/Variable gate_url: "https:\/\/a\.example\.com" → "https:\/\/b\.example\.com"\./);
    expect(text.stdout).toMatch(/tenant-wide: every solution of the tenant that names \{\{var:gate_url\}\}, active ones included/);

    const replaced = await cli(sb, ["variables", "set", "gate_url", "https://b.example.com", "--confirm", "--json"]);
    expect(replaced.json()).toMatchObject({ changed: true, previous: "https://a.example.com" });
    expect(server.state.values.get(tenant)!.variables.get("gate_url")).toBe("https://b.example.com");

    // From stdin, the confirm command reads it again.
    const piped = await cli(sb, ["variables", "set", "gate_url", "--stdin", "--json"], { stdin: "https://c.example.com\n" });
    expect(piped.json()).toMatchObject({ would: "replace", confirm: "cavelon variables set gate_url --stdin --confirm" });
  });

  it("under a coding agent and over MCP, only the preview's token replaces it", async () => {
    await cli(sb, ["variables", "set", "gate_region", "eu"]);
    const bare = await cli(sb, ["variables", "set", "gate_region", "us", "--confirm", "--json"], { env: AGENT });
    expect(bare.code).toBe(5);
    const token = bare.json<{ confirm_token: string }>().confirm_token;
    expect(bare.json<{ confirm: string }>().confirm).toBe(`cavelon variables set gate_region us --confirm ${token}`);
    // The token holds the value it showed: another value needs another preview.
    expect((await cli(sb, ["variables", "set", "gate_region", "ap", "--confirm", token, "--json"], { env: AGENT })).code).toBe(4);
    expect(server.state.values.get(tenant)!.variables.get("gate_region")).toBe("eu");
    expect((await cli(sb, ["variables", "set", "gate_region", "us", "--confirm", token, "--json"], { env: AGENT })).code).toBe(0);
    expect(server.state.values.get(tenant)!.variables.get("gate_region")).toBe("us");

    const mcp = await mcpClient(sb);
    try {
      expect((await mcp.call("variables_set", { name: "gate_region", value: "eu", confirm: true })).body.error).toMatchObject({ code: "confirm_token_required" });
      const shown = await mcp.call("variables_set", { name: "gate_region", value: "eu" });
      expect(shown.body).toMatchObject({ changed: false, previous: "us", value: "eu", confirm_token: expect.stringMatching(TOKEN) });
      expect(server.state.values.get(tenant)!.variables.get("gate_region")).toBe("us");
      const done = await mcp.call("variables_set", { name: "gate_region", value: "eu", confirm: shown.body.confirm_token });
      expect(done.body).toMatchObject({ changed: true, previous: "us" });
      expect(server.state.values.get(tenant)!.variables.get("gate_region")).toBe("eu");
      // A new variable needs none.
      expect((await mcp.call("variables_set", { name: "gate_new", value: "x" })).body).toMatchObject({ created: true });
    } finally {
      await mcp.close();
    }
  });
});

describe("loop start", () => {
  beforeAll(async () => {
    await cli(sb, ["harness", "new", "loop-draft", "--name", "Loop Draft"]);
    addTrigger("gate-loop", harness("loop-draft").id);
  });

  it("previews the trigger, its solution and the payload, and starts a run only with --confirm", async () => {
    const preview = await cli(sb, ["loop", "start", "gate-loop", "--input", '{"n": 1}', "--json"]);
    expect(preview.code, preview.stderr + preview.stdout).toBe(0);
    expect(preview.json()).toMatchObject({
      started: false,
      would: "start_run",
      trigger: { slug: "gate-loop", type: "schedule", is_active: true },
      solution: { slug: "loop-draft", status: "draft" },
      payload: { n: 1 },
      confirm: `cavelon loop start gate-loop --input '{"n": 1}' --confirm`,
    });
    expect(posts(/\/triggers\/[^/]+\/run$/)).toHaveLength(0);
    const text = await cli(sb, ["loop", "start", "gate-loop"]);
    expect(text.stdout).toMatch(/starts a run that acts as you, runs on its own and spends the tenant's model budget/);
    expect(text.stdout).toMatch(/Solution: Loop Draft \(loop-draft\), draft\./);
    expect(text.stdout).toMatch(/Nothing was started\./);

    const started = await cli(sb, ["loop", "start", "gate-loop", "--input", '{"n": 1}', "--confirm", "--json"]);
    expect(started.code, started.stderr + started.stdout).toBe(0);
    expect(started.json()).toMatchObject({ run_id: expect.any(String) });
    expect(posts(/\/triggers\/[^/]+\/run$/)).toHaveLength(1);
    expect(posts(/\/triggers\/[^/]+\/run$/)[0]!.body).toEqual({ payload: { n: 1 } });
  });

  it("under a coding agent and over MCP, only the preview's token starts it", async () => {
    const bare = await cli(sb, ["loop", "start", "gate-loop", "--confirm", "--json"], { env: AGENT });
    expect(bare.code).toBe(5);
    const token = bare.json<{ confirm_token: string }>().confirm_token;
    expect(bare.json<{ confirm: string }>().confirm).toBe(`cavelon loop start gate-loop --confirm ${token}`);
    // Another payload is another run.
    expect((await cli(sb, ["loop", "start", "gate-loop", "--input", '{"n": 2}', "--confirm", token, "--json"], { env: AGENT })).code).toBe(4);
    expect(posts(/\/triggers\/[^/]+\/run$/)).toHaveLength(0);
    expect((await cli(sb, ["loop", "start", "gate-loop", "--confirm", token, "--json"], { env: AGENT })).code).toBe(0);
    expect(posts(/\/triggers\/[^/]+\/run$/)).toHaveLength(1);

    const mcp = await mcpClient(sb);
    try {
      expect((await mcp.call("loop_start", { trigger: "gate-loop", confirm: true })).body.error).toMatchObject({ code: "confirm_token_required" });
      const shown = await mcp.call("loop_start", { trigger: "gate-loop" });
      expect(shown.body).toMatchObject({ started: false, confirm_token: expect.stringMatching(TOKEN) });
      expect(posts(/\/triggers\/[^/]+\/run$/)).toHaveLength(1);
      const done = await mcp.call("loop_start", { trigger: "gate-loop", confirm: shown.body.confirm_token });
      expect(done.body).toMatchObject({ run_id: expect.any(String), operation_id: expect.any(String) });
      expect(posts(/\/triggers\/[^/]+\/run$/)).toHaveLength(2);
    } finally {
      await mcp.close();
    }
  });
});

describe("activate", () => {
  const activations = () => posts(/\/harnesses\/[^/]+\/activate$/);

  it("activates a draft nothing reaches at once, as before", async () => {
    await cli(sb, ["harness", "new", "unreached"]);
    addTrigger("off-trigger", harness("unreached").id, false);
    const done = await cli(sb, ["activate", "--harness", "unreached", "--json"]);
    expect(done.code, done.stderr + done.stdout).toBe(0);
    // An inactive trigger starts nothing, so it does not count.
    expect(done.json()).toMatchObject({ activated: true });
    expect(activations()).toHaveLength(1);
  });

  it("previews a solution a channel or an active trigger reaches, and activates it only with --confirm", async () => {
    await cli(sb, ["harness", "new", "reached", "--name", "Reached"]);
    harness("reached").channel_count = 2;
    addTrigger("nightly", harness("reached").id);
    const preview = await cli(sb, ["activate", "--harness", "reached", "--json"]);
    expect(preview.code, preview.stderr + preview.stdout).toBe(0);
    expect(preview.json()).toMatchObject({
      activated: false,
      would: "activate",
      reach: { channels: 2, triggers: [{ slug: "nightly", type: "schedule" }] },
      confirm: "cavelon activate --harness reached --confirm",
    });
    expect(activations()).toHaveLength(0);
    expect(harness("reached").status).toBe("draft");
    const text = await cli(sb, ["activate", "--harness", "reached"]);
    expect(text.stdout).toMatch(/Activating Reached \(reached\) puts it live for what reaches it: 2 channels; the active trigger nightly \(schedule\)\./);
    expect(text.stdout).toMatch(/Nothing was activated\. Show this to a person; with their yes: cavelon activate --harness reached --confirm/);

    const done = await cli(sb, ["activate", "--harness", "reached", "--confirm", "--json"]);
    expect(done.code, done.stderr + done.stdout).toBe(0);
    expect(done.json()).toMatchObject({ activated: true, reach: { channels: 2 } });
    expect(harness("reached").status).toBe("active");
  });

  it("previews where the instance does not say what reaches the solution", async () => {
    await cli(sb, ["harness", "new", "unsaid"]);
    delete harness("unsaid").channel_count;
    const noCount = await cli(sb, ["activate", "--harness", "unsaid"]);
    expect(noCount.stdout).toMatch(/does not say whether a channel reaches it \(no channel_count\), so the activation waits for a confirm/);
    expect(activations()).toHaveLength(0);

    harness("unsaid").channel_count = 0;
    server.state.failures = [{ method: "GET", path: /\/api\/v1\/triggers$/, status: 403 }];
    const noTriggers = await cli(sb, ["activate", "--harness", "unsaid", "--json"]);
    expect(noTriggers.json()).toMatchObject({ activated: false, reach: { channels: 0, triggers: null } });
    expect(activations()).toHaveLength(0);
    expect((await cli(sb, ["activate", "--harness", "unsaid", "--confirm", "--json"])).json()).toMatchObject({ activated: true });
  });

  it("under a coding agent, refuses a bare --confirm before it activates, and takes the preview's token", async () => {
    await cli(sb, ["harness", "new", "agent-reached"]);
    harness("agent-reached").channel_count = 1;
    const bare = await cli(sb, ["activate", "--harness", "agent-reached", "--confirm", "--json"], { env: AGENT });
    expect(bare.code).toBe(5);
    expect(bare.json<{ error: { code: string } }>().error.code).toBe("confirm_token_required");
    expect(activations()).toHaveLength(0);
    const shown = await cli(sb, ["activate", "--harness", "agent-reached", "--json"], { env: AGENT });
    const token = shown.json<{ confirm_token: string }>().confirm_token;
    expect(shown.json<{ confirm: string }>().confirm).toBe(`cavelon activate --harness agent-reached --confirm ${token}`);
    // A channel added since the preview is another change.
    harness("agent-reached").channel_count = 2;
    expect((await cli(sb, ["activate", "--harness", "agent-reached", "--confirm", token, "--json"], { env: AGENT })).code).toBe(4);
    expect(activations()).toHaveLength(0);
    harness("agent-reached").channel_count = 1;
    expect((await cli(sb, ["activate", "--harness", "agent-reached", "--confirm", token, "--json"], { env: AGENT })).code).toBe(0);
    expect(harness("agent-reached").status).toBe("active");
  });

  it("over MCP, one token from the preview activates it and, with make_default, changes the default route", async () => {
    await cli(sb, ["harness", "new", "mcp-reached"]);
    harness("mcp-reached").channel_count = 1;
    const mcp = await mcpClient(sb);
    try {
      expect((await mcp.call("activate", { harness: "mcp-reached", confirm: true })).body.error).toMatchObject({ code: "confirm_token_required" });
      const shown = await mcp.call("activate", { harness: "mcp-reached", make_default: true });
      expect(shown.body).toMatchObject({ activated: false, default_route: { known: true }, confirm_token: expect.stringMatching(TOKEN) });
      expect(activations()).toHaveLength(0);
      // A token of the activation alone is not this change's.
      const alone = await mcp.call("activate", { harness: "mcp-reached" });
      expect((await mcp.call("activate", { harness: "mcp-reached", make_default: true, confirm: alone.body.confirm_token })).body).toMatchObject({ token_mismatch: true, exit_code: 4 });
      expect(activations()).toHaveLength(0);

      const done = await mcp.call("activate", { harness: "mcp-reached", make_default: true, confirm: shown.body.confirm_token });
      expect(done.body).toMatchObject({ activated: true, default_route: { is_default: true, changed: true } });
      expect(harness("mcp-reached")).toMatchObject({ status: "active", is_default: true });
    } finally {
      await mcp.close();
    }
  });
});
