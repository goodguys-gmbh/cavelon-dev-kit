import { randomUUID } from "node:crypto";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../src/commands/index.js";
import type { InStream } from "../src/io.js";
import { createMcpServer } from "../src/mcp.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { askingClient, cli, login, sandbox, type Sandbox } from "./helpers.js";

let server: FakeServer;
let sb: Sandbox;
let tenant: string;

const AGENT = { CLAUDECODE: "1", SHELL: "/bin/sh" };
const activations = () => server.state.requests.filter((r) => r.method === "POST" && r.path.endsWith("/activate"));
const solution = () => server.state.harnesses.find((h) => h.tenant_id === tenant && h.slug === "candidate")!;
const confirmations = () => server.state.requests.filter((r) => r.path === "/api/v1/confirmations");
const replacement = { takes_default_route: true, takes_default_route_from: "previous", takes_default_route_from_name: "Previous" };
const assignment = { takes_default_route: true, takes_default_route_from: null, takes_default_route_from_name: null };
const noRouteChange = { takes_default_route: false, takes_default_route_from: null, takes_default_route_from_name: null };

async function mcpClient() {
  const mcp = createMcpServer({
    stdout: { write: () => true }, stderr: { write: () => true },
    stdin: Readable.from([]) as unknown as InStream, env: sb.env, cwd: sb.home,
    now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }, COMMANDS);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = askingClient();
  await mcp.connect(serverSide);
  await client.connect(clientSide);
  return {
    asked: client.asked,
    async call(args: Record<string, unknown>) {
      const result = await client.callTool({ name: "activate", arguments: { harness: "candidate", ...args } });
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, any>;
    },
    close: () => client.close(),
  };
}

beforeEach(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("example", "Example");
  sb = sandbox();
  sb.env.SHELL = "/bin/sh";
  sb.env.CAVELON_CONTRACT_TTL_SECONDS = "0";
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, mayActivate: true }));
  await cli(sb, ["harness", "new", "other"]);
  server.state.harnesses.find((h) => h.tenant_id === tenant && h.slug === "other")!.channel_count = 7;
  await cli(sb, ["harness", "new", "candidate", "--name", "Candidate"]);
  server.state.requests.length = 0;
});

afterEach(async () => {
  sb.cleanup();
  await server.close();
});

describe("activation reach and published route effects", () => {
  it("activates from the list count when the single read leaves channel_count null", async () => {
    server.state.singleHarnessWithoutChannelCount = true;
    const result = await cli(sb, ["activate", "--harness", "candidate", "--json"], { env: AGENT });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.json()).toMatchObject({ activated: true });
    const readiness = server.state.requests.findIndex((r) => r.path.endsWith("/readiness"));
    const list = server.state.requests.findIndex((r) => r.path === "/api/v1/harnesses");
    const activation = server.state.requests.findIndex((r) => r.path.endsWith("/activate"));
    expect(list).toBeGreaterThan(readiness);
    expect(activation).toBeGreaterThan(list);
    expect(activations()).toHaveLength(1);
    expect(activations()[0]!.body).toEqual({ force: false });
  });

  it("uses a count published on a single read without reading the list before activation", async () => {
    const result = await cli(sb, ["activate", "--harness", String(solution().id), "--json"], { env: AGENT });
    expect(result.json()).toMatchObject({ activated: true, reach: { channels: 0, triggers: [] }, takes_default_route: false, took_default_route: false });
    const activation = server.state.requests.findIndex((r) => r.path.endsWith("/activate"));
    expect(server.state.requests.slice(0, activation).some((r) => r.path === "/api/v1/harnesses")).toBe(false);
    expect(confirmations()).toHaveLength(0);
  });

  it("previews reached solutions using the matching list row's count", async () => {
    server.state.singleHarnessWithoutChannelCount = true;
    solution().channel_count = 2;
    const preview = await cli(sb, ["activate", "--harness", String(solution().id), "--json"], { env: AGENT });
    expect(preview.json()).toMatchObject({ activated: false, reach: { channels: 2 }, needs_person: "terminal", takes_default_route: false });
    expect(activations()).toHaveLength(0);
  });

  it.each(["unreadable", "unsupported", "missing row", "missing count"])("keeps list reach unknown when the list is %s", async (kind) => {
    server.state.singleHarnessWithoutChannelCount = true;
    if (kind === "unreadable") server.state.failures = [{ method: "GET", path: /^\/api\/v1\/harnesses$/, status: 403 }];
    if (kind === "unsupported") server.state.openapiWithout = ["GET /api/v1/harnesses"];
    if (kind === "missing row") server.state.harnessListOmitIds = [String(solution().id)];
    if (kind === "missing count") server.state.harnessListWithoutChannelCount = true;
    const preview = await cli(sb, ["activate", "--harness", "candidate", "--json"], { env: AGENT });
    expect(preview.json()).toMatchObject({ activated: false, reach: { channels: null }, needs_person: "terminal" });
    expect(activations()).toHaveLength(0);
  });

  it.each(["older schema", "omitted response"])("requires a person for an unknown route effect with %s", async (kind) => {
    if (kind === "older schema") server.state.activationRouteFields = false;
    else server.state.readinessWithoutRouteEffect = true;
    const preview = await cli(sb, ["activate", "--harness", "candidate", "--json"], { env: AGENT });
    expect(preview.json()).toMatchObject({ activated: false, reach: { channels: 0, triggers: [] }, takes_default_route: null, needs_person: "terminal" });
    const text = await cli(sb, ["activate", "--harness", "candidate"]);
    expect(text.stdout).toContain("does not say whether activation takes the tenant's default chat and widget route");
    expect(activations()).toHaveLength(0);
    const mcp = await mcpClient();
    try {
      const shown = await mcp.call({});
      const refused = await cli(sb, ["activate", "--harness", "candidate", "--confirm", shown.confirm_token, "--json"], { env: AGENT });
      expect(refused.code).toBe(5);
      expect(refused.json()).toMatchObject({ error: { code: "confirm_needs_person" } });
      expect(confirmations()).toHaveLength(0);
      const done = await mcp.call({ confirm: shown.confirm_token });
      expect(done).toMatchObject({ activated: true, takes_default_route: null, took_default_route: kind === "older schema" ? null : false });
      expect(mcp.asked).toHaveLength(1);
    } finally { await mcp.close(); }
  });

  it("requires a person when an active trigger reaches a solution with no channels or takeover", async () => {
    server.state.lr.triggers.push({ id: randomUUID(), tenant_id: tenant, slug: "nightly", name: "Nightly", harness_id: String(solution().id),
      trigger_type: "schedule", is_active: true, identity: { api_key_id: null, version: 1 }, required_solutions: [], loop: { iterations: 1 } });
    const result = await cli(sb, ["activate", "--harness", "candidate", "--json"], { env: AGENT });
    expect(result.json()).toMatchObject({ activated: false, needs_person: "terminal", takes_default_route: false, reach: { triggers: [{ slug: "nightly" }] } });
    expect(activations()).toHaveLength(0);
  });

  it.each([replacement, assignment])("requires the person's yes for the published route effect %j, preserving the server nonce", async (effect) => {
    server.state.readinessRouteEffect = effect;
    const text = await cli(sb, ["activate", "--harness", "candidate"]);
    expect(text.stdout).toContain(effect.takes_default_route_from ? "would replace Previous (previous)" : "would assign the tenant's unassigned default route");
    expect(text.stdout).toContain("This preview reserves no route state");
    const shown = await cli(sb, ["activate", "--harness", "candidate", "--json"], { env: AGENT });
    expect(shown.json()).toMatchObject({ activated: false, ...effect, needs_person: "terminal" });
    expect(activations()).toHaveLength(0);
    expect(confirmations()).toHaveLength(0);
    const mcp = await mcpClient();
    try {
      const preview = await mcp.call({});
      expect(preview).toMatchObject({ activated: false, ...effect, needs_person: "client", confirm_token: expect.any(String) });
      const refused = await cli(sb, ["activate", "--harness", "candidate", "--confirm", preview.confirm_token, "--json"], { env: AGENT });
      expect(refused.code).toBe(5);
      expect(activations()).toHaveLength(0);
      const done = await mcp.call({ confirm: preview.confirm_token });
      expect(done).toMatchObject({ activated: true, took_default_route: true, took_default_route_from: effect.takes_default_route_from,
        took_default_route_from_name: effect.takes_default_route_from_name, default_route: { is_default: true } });
      expect(mcp.asked).toHaveLength(1);
      expect(confirmations()).toHaveLength(1);
      expect(activations()[0]!.headers["x-cavelon-confirmation"]).toEqual(expect.any(String));
      expect(activations()[0]!.body).toEqual({ force: false });
    } finally { await mcp.close(); }
  });

  it("binds the confirm token to the published preview's route effect", async () => {
    server.state.readinessRouteEffect = replacement;
    const mcp = await mcpClient();
    try {
      const preview = await mcp.call({});
      server.state.readinessRouteEffect = assignment;
      const changed = await mcp.call({ confirm: preview.confirm_token });
      expect(changed).toMatchObject({ activated: false, token_mismatch: true, exit_code: 4, ...assignment });
      expect(mcp.asked).toHaveLength(0);
      expect(activations()).toHaveLength(0);
    } finally { await mcp.close(); }
  });

  it.each([noRouteChange, assignment])("reports the actual effect when route state changes after preview to %j", async (actual) => {
    server.state.readinessRouteEffect = replacement;
    const mcp = await mcpClient();
    try {
      const preview = await mcp.call({});
      server.state.activationRouteEffect = actual;
      const done = await mcp.call({ confirm: preview.confirm_token });
      expect(done).toMatchObject({ activated: true, ...replacement, took_default_route: actual.takes_default_route,
        took_default_route_from: null, took_default_route_from_name: null });
      expect(done.harness).toMatchObject({ took_default_route: actual.takes_default_route });
      expect(mcp.asked).toHaveLength(1);
      expect(activations()).toHaveLength(1);
    } finally { await mcp.close(); }
  });

  it("leaves a new route effect to the server's confirmation check when the preview promised none", async () => {
    server.state.activationRouteEffect = assignment;
    const result = await cli(sb, ["activate", "--harness", "candidate", "--json"], { env: AGENT });
    expect(result.code).toBe(5);
    expect(result.json()).toMatchObject({ error: { code: "confirmation_required" } });
    expect(confirmations()).toHaveLength(0);
    expect(solution().status).toBe("draft");
  });

  it("reports route previews in status text and JSON without reserving or changing state", async () => {
    await cli(sb, ["init", "--instance", server.url, "--tenant", "example", "--harness", "candidate"]);
    server.state.readinessRouteEffect = assignment;
    const status = await cli(sb, ["status", "--json"]);
    expect(status.json()).toMatchObject({ solution: { state: assignment } });
    const text = await cli(sb, ["status"]);
    expect(text.stdout).toContain("would assign the tenant's unassigned default route");
    expect(text.stdout).toContain("This preview reserves no route state");
    expect(solution().status).toBe("draft");
    expect(activations()).toHaveLength(0);
  });

  it("reports success text from the actual route effect", async () => {
    server.state.readinessRouteEffect = replacement;
    server.state.activationRouteEffect = assignment;
    const done = await cli(sb, ["activate", "--harness", "candidate", "--confirm"]);
    expect(done.code, done.stdout + done.stderr).toBe(0);
    expect(done.stdout).toContain("Activation assigned the tenant's unassigned default route to Candidate (candidate)");
    expect(done.stdout).not.toContain("replaced Previous");
  });

  it("refuses agent force activation instead of sending it", async () => {
    const result = await cli(sb, ["activate", "--harness", "candidate", "--force", "--json"], { env: AGENT });
    expect(result.code).toBe(2);
    expect(activations()).toHaveLength(0);
  });
});
