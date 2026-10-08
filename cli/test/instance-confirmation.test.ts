import { randomUUID } from "node:crypto";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../src/commands/index.js";
import { createContext } from "../src/context.js";
import type { CavelonError } from "../src/errors.js";
import { callStable } from "../src/invoke.js";
import type { Io, InStream } from "../src/io.js";
import { createMcpServer } from "../src/mcp.js";
import { startFakeServer, type FakeServer, type RecordedRequest } from "./fake-server.js";
import { askingClient, cli, login, sandbox, type PersonAtClient, type Sandbox } from "./helpers.js";

/**
 * The instance's request binding and the kit's separate human prompt: a personal access token's
 * guarded change carries a confirmation id the kit asks for only after the
 * person approved it, in their own terminal with --confirm or in the MCP
 * client's dialog, and sends with exactly that request. An instance that does
 * not publish `confirmations.enforced` is asked for nothing.
 */

let server: FakeServer;
let sb: Sandbox;
let tenant: string;

const AGENT = { CLAUDECODE: "1" };
const HEADER = "x-cavelon-confirmation";

const solution = (slug: string) => server.state.harnesses.find((h) => h.tenant_id === tenant && h.slug === slug)! as Record<string, any> & { id: string };
const asked = () => server.state.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/confirmations");
const sent = (method: string, path: string) => server.state.requests.filter((r) => r.method === method && r.path === path);
const deactivatePath = () => `/api/v1/harnesses/${solution("support").id}/deactivate`;

function mcpClient(person?: PersonAtClient) {
  const mcp = createMcpServer(io(), COMMANDS);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = askingClient({ person });
  return {
    asked: client.asked,
    async call(name: string, args: Record<string, unknown>) {
      if (!client.transport) {
        await mcp.connect(serverSide);
        await client.connect(clientSide);
      }
      const result = await client.callTool({ name, arguments: { tenant: "acme", ...args } });
      return { isError: Boolean(result.isError), body: JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, any> };
    },
    close: () => client.close(),
  };
}

function io(env: Record<string, string> = sb.env): Io {
  return {
    stdout: { write: () => true },
    stderr: { write: () => true },
    stdin: Readable.from([]) as unknown as InStream,
    env,
    cwd: sb.home,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** The request's position among those the instance received, to tell which came first. */
const at = (request: RecordedRequest) => server.state.requests.indexOf(request);

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  sb = sandbox();
  // Every command reads the capabilities and the OpenAPI as the instance publishes them now, as a test switches the offer.
  sb.env.CAVELON_CONTRACT_TTL_SECONDS = "0";
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, mayActivate: true }), ["--tenant", "acme"]);
  for (const [slug, name] of [["default", "Default"], ["support", "Support"]]) await cli(sb, ["harness", "new", slug!, "--name", name!]);
});

afterAll(async () => {
  sb.cleanup();
  await server.close();
});

beforeEach(() => {
  for (const h of server.state.harnesses) if (h.tenant_id === tenant) [h.status, h.is_default] = [h.slug === "default" || h.slug === "support" ? "active" : h.status, h.slug === "default"];
  server.state.lr.triggers.length = 0;
  server.state.confirmations = { enforced: true };
  server.state.confirmationTtlMs = 600_000;
  server.state.confirmationIds.clear();
  server.state.requests.length = 0;
});

describe("in a person's own terminal", () => {
  it("asks for the id only once --confirm is given, bound to exactly the request, and sends it with that request once", async () => {
    const preview = await cli(sb, ["deactivate", "--harness", "support", "--json"]);
    expect(preview.code, preview.stderr).toBe(0);
    expect(asked()).toEqual([]);

    const done = await cli(sb, ["deactivate", "--harness", "support", "--confirm", "--json"]);
    expect(done.code, done.stderr).toBe(0);
    expect(solution("support").status).toBe("inactive");
    const [request] = asked();
    expect(request!.body).toEqual({ method: "POST", path: deactivatePath(), body: null });
    const [change] = sent("POST", deactivatePath());
    expect(at(request!)).toBeLessThan(at(change!));
    const id = change!.headers[HEADER] as string;
    expect(server.state.confirmationIds.get(id)).toMatchObject({ used: true, path: deactivatePath() });
    // No other request carried it.
    expect(server.state.requests.filter((r) => r.headers[HEADER])).toEqual([change]);
  });

  it("does the same for the default route and a variable's deletion", async () => {
    const support = solution("support").id;
    const routed = await cli(sb, ["harness", "default", "support", "--confirm", "--json"]);
    expect(routed.code, routed.stderr).toBe(0);
    expect(asked().map((r) => r.body)).toEqual([{ method: "POST", path: `/api/v1/harnesses/${support}/default`, body: null }]);
    expect(sent("POST", `/api/v1/harnesses/${support}/default`)[0]!.headers[HEADER]).toMatch(/^cfm_/);

    expect((await cli(sb, ["variables", "set", "region", "eu"])).code).toBe(0);
    server.state.requests.length = 0;
    const deleted = await cli(sb, ["variables", "delete", "region", "--confirm", "--json"]);
    expect(deleted.code, deleted.stderr).toBe(0);
    expect(asked().map((r) => r.body)).toEqual([{ method: "DELETE", path: "/api/v1/variables/region", body: null }]);
    expect(sent("DELETE", "/api/v1/variables/region")[0]!.headers[HEADER]).toMatch(/^cfm_/);
  });

  it("binds a trigger's execution identity with an id that names the key it binds", async () => {
    const support = solution("support").id;
    const trigger = { id: randomUUID(), tenant_id: tenant, slug: "nightly", name: "Nightly", harness_id: support, trigger_type: "schedule", is_active: false };
    server.state.lr.triggers.push({ ...trigger, identity: { api_key_id: null, version: 1 }, required_solutions: [] });
    const key = { id: randomUUID(), tenant_id: tenant, name: "loop-runner", key_prefix: "cbp_loop", is_active: true };
    server.state.lr.apiKeys.push(key as (typeof server.state.lr.apiKeys)[number]);
    const bound = await cli(sb, ["trigger", "identity", "nightly", "loop-runner", "--confirm", "--json"]);
    expect(bound.code, bound.stderr + bound.stdout).toBe(0);
    const path = `/api/v1/triggers/${trigger.id}/execution-identity`;
    const [request] = asked();
    expect(request!.body).toMatchObject({ method: "PUT", path, body: { api_key_id: key.id } });
    expect(request!.body).toEqual({ method: "PUT", path, body: sent("PUT", path)[0]!.body });
    expect(sent("PUT", path)[0]!.headers[HEADER]).toMatch(/^cfm_/);
  });

  it("asks for none where the change is not guarded: a draft that nothing reaches activates without one", async () => {
    solution("support").status = "draft";
    const activated = await cli(sb, ["activate", "--harness", "support", "--json"]);
    expect(activated.code, activated.stderr).toBe(0);
    expect(asked()).toEqual([]);
    expect(sent("POST", `/api/v1/harnesses/${solution("support").id}/activate`)[0]!.headers[HEADER]).toBeUndefined();
  });

  it("asks for one where an active trigger reaches the solution it activates", async () => {
    const support = solution("support");
    support.status = "draft";
    server.state.lr.triggers.push({
      id: randomUUID(), tenant_id: tenant, slug: "orders", name: "Orders", harness_id: support.id, trigger_type: "webhook", is_active: true,
      identity: { api_key_id: null, version: 1 }, required_solutions: [],
    });
    const activated = await cli(sb, ["activate", "--harness", "support", "--confirm", "--json"]);
    expect(activated.code, activated.stderr).toBe(0);
    expect(asked().map((r) => r.body)).toEqual([{ method: "POST", path: `/api/v1/harnesses/${support.id}/activate`, body: { force: false } }]);
    expect(support.status).toBe("active");
  });

  it("cavelon api: what the person typed goes, and an id is asked for only when the instance asks for one", async () => {
    const support = solution("support").id;
    const done = await cli(sb, ["api", "deactivate_harness", `harness_id=${support}`, "--json"]);
    expect(done.code, done.stderr).toBe(0);
    const [first, second] = sent("POST", deactivatePath());
    // The first went without one and the instance changed nothing (428); the second carries the id asked for in between.
    expect(first!.headers[HEADER]).toBeUndefined();
    expect(at(asked()[0]!)).toBeGreaterThan(at(first!));
    expect(at(asked()[0]!)).toBeLessThan(at(second!));
    expect(second!.headers[HEADER]).toMatch(/^cfm_/);
    expect(solution("support").status).toBe("inactive");
  });

  it("a tenant API key is never asked: the instance asks only a personal access token", async () => {
    const keyed = sandbox();
    try {
      await login(keyed, server.url, server.addToken({ kind: "key", tenantIds: [tenant] }));
      const done = await cli(keyed, ["deactivate", "--harness", "support", "--confirm", "--json"]);
      expect(done.code, done.stderr).toBe(0);
      expect(asked()).toEqual([]);
    } finally {
      keyed.cleanup();
    }
  });
});

describe("over MCP and in a coding agent's shell", () => {
  it("asks for the id only after the person approved in the client, and never for a preview", async () => {
    const mcp = mcpClient("approves");
    try {
      const preview = await mcp.call("deactivate", { harness: "support" });
      expect(preview.body.confirm_token).toMatch(/^[0-9a-f]{12}$/);
      expect(asked()).toEqual([]);
      const done = await mcp.call("deactivate", { harness: "support", confirm: preview.body.confirm_token });
      expect(done.isError, JSON.stringify(done.body)).toBe(false);
      expect(mcp.asked).toHaveLength(1);
      expect(asked().map((r) => r.body)).toEqual([{ method: "POST", path: deactivatePath(), body: null }]);
      expect(sent("POST", deactivatePath())[0]!.headers[HEADER]).toMatch(/^cfm_/);
    } finally {
      await mcp.close();
    }
  });

  it("asks for none when the person declines, or when the client cannot ask them", async () => {
    for (const person of ["declines", "cannot ask"] as const) {
      const mcp = mcpClient(person);
      try {
        const token = (await mcp.call("deactivate", { harness: "support" })).body.confirm_token as string | undefined;
        const refused = await mcp.call("deactivate", { harness: "support", ...(token ? { confirm: token } : { confirm: "000000000000" }) });
        expect(refused.isError || refused.body.exit_code !== undefined, person).toBe(true);
      } finally {
        await mcp.close();
      }
      expect(asked(), person).toEqual([]);
      expect(sent("POST", deactivatePath()), person).toEqual([]);
      expect(solution("support").status).toBe("active");
    }
  });

  it("an agent's shell gets no id, even with the preview's token: the person confirms in their own terminal", async () => {
    const preview = await cli(sb, ["deactivate", "--harness", "support", "--json"], { env: AGENT });
    const refused = await cli(sb, ["deactivate", "--harness", "support", "--confirm", "--json"], { env: AGENT });
    expect(refused.code).toBe(5);
    expect(preview.json<{ confirm_token?: string }>().confirm_token).toBeUndefined();
    expect(asked()).toEqual([]);
    expect(sent("POST", deactivatePath())).toEqual([]);
  });

  it("api over MCP: a marked operation's preview says so, and after the person's yes the id goes with exactly that request", async () => {
    const mcp = mcpClient("approves");
    try {
      const support = solution("support").id;
      const preview = await mcp.call("api", { operation: "deactivate_harness", params: [`harness_id=${support}`] });
      expect(preview.body.instance_confirmation).toMatch(/^When the solution is active/);
      expect(asked()).toEqual([]);
      const done = await mcp.call("api", { operation: "deactivate_harness", params: [`harness_id=${support}`], confirm: preview.body.confirm_token });
      expect(done.isError, JSON.stringify(done.body)).toBe(false);
      expect(asked().map((r) => r.body)).toEqual([{ method: "POST", path: deactivatePath(), body: null }]);
      // Asked for up front: the change went once, with the id.
      expect(sent("POST", deactivatePath()).map((r) => typeof r.headers[HEADER])).toEqual(["string"]);
    } finally {
      await mcp.close();
    }
  });
});

describe("a 428 from the instance", () => {
  it("confirmation_invalid (an expired id) changes nothing, exits 5 and says to run the command again", async () => {
    server.state.confirmationTtlMs = 0;
    const refused = await cli(sb, ["deactivate", "--harness", "support", "--confirm", "--json"]);
    expect(refused.code).toBe(5);
    const error = refused.json<{ error: Record<string, any> }>().error;
    expect(error).toMatchObject({ code: "confirmation_invalid", status: 428, details: { reason: "expired", confirmation_sent: true } });
    expect(error.message).toMatch(/Nothing was changed\.$/);
    expect(error.hint).toMatch(/^Run the command again: it previews the change, and once the person approves it cavelon asks the instance for a new confirmation/);
    expect(solution("support").status).toBe("active");
    // Sent once with the id; never again without the person.
    expect(sent("POST", deactivatePath())).toHaveLength(1);
  });

  it("confirmation_required without the person's yes: no id is asked for, the change is not sent again, and it says who confirms", async () => {
    const ctx = createContext(io(), { json: true });
    const error = await callStable(ctx, "POST", "/api/v1/harnesses/{harness_id}/deactivate", "deactivating solutions", {
      params: { harness_id: [solution("support").id] },
    }).then(
      () => undefined,
      (e: unknown) => e as CavelonError,
    );
    expect(error).toMatchObject({ code: "confirmation_required", exitCode: 5, status: 428, details: { confirmation_sent: false } });
    expect(error!.hint).toMatch(/The person runs the command in their own terminal with --confirm/);
    expect(asked()).toEqual([]);
    expect(sent("POST", deactivatePath())).toHaveLength(1);
    expect(solution("support").status).toBe("active");
  });

  it("explain knows both codes, with what cavelon does about them", async () => {
    for (const code of ["confirmation_required", "confirmation_invalid"]) {
      const explained = await cli(sb, ["explain", code, "--json"]);
      expect(explained.code, explained.stderr).toBe(0);
      const data = explained.json<Record<string, string>>();
      expect(data).toMatchObject({ code, area: "confirmation" });
      expect(data.kit_hint).toMatch(/^Only after the person approved the change does cavelon ask the instance for this confirmation/);
      expect((await cli(sb, ["explain", code])).stdout).toMatch(/with cavelon/);
    }
  });
});

describe("an instance that does not enforce it", () => {
  it("publishes enforced: false: no id is asked for, and the change goes", async () => {
    server.state.confirmations = { enforced: false };
    const done = await cli(sb, ["deactivate", "--harness", "support", "--confirm", "--json"]);
    expect(done.code, done.stderr).toBe(0);
    expect(asked()).toEqual([]);
    expect(sent("POST", deactivatePath())[0]!.headers[HEADER]).toBeUndefined();
  });

  it("an older instance publishes no confirmations, marks no operation and has no route: nothing is asked for", async () => {
    server.state.confirmations = null;
    const described = await cli(sb, ["api", "describe", "deactivate_harness", "--json"]);
    expect(described.json<{ confirmation: unknown }>().confirmation).toBeNull();
    const done = await cli(sb, ["deactivate", "--harness", "support", "--confirm", "--json"]);
    expect(done.code, done.stderr).toBe(0);
    expect(asked()).toEqual([]);
    expect(sent("POST", deactivatePath())[0]!.headers[HEADER]).toBeUndefined();
    expect(solution("support").status).toBe("inactive");
  });

  it("api describe names a marked operation where the instance marks it", async () => {
    const described = await cli(sb, ["api", "describe", "deactivate_harness"]);
    expect(described.stdout).toMatch(/Bound confirmation required \(x-cavelon-confirmation\): When the solution is active/);
  });
});

describe("the fake instance's confirmations", () => {
  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, token = pat) {
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tenant, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: (await response.text().then((t) => (t ? JSON.parse(t) : null))) as Record<string, any> };
  }
  async function issue(method: string, path: string, body?: unknown): Promise<string> {
    const issued = await call("POST", "/api/v1/confirmations", { method, path, body: body ?? null });
    expect(issued.status).toBe(201);
    return issued.data.confirmation_id as string;
  }
  let pat: string;
  beforeAll(() => {
    pat = server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, mayActivate: true });
  });

  it("binds an id to the method, path and body, uses it once, and lets it expire", async () => {
    const other = solution("default").id;
    const missing = await call("POST", deactivatePath());
    expect(missing).toMatchObject({ status: 428, data: { code: "confirmation_required", confirmations: "/api/v1/confirmations", header: "X-Cavelon-Confirmation" } });
    // Another solution's change.
    solution("default").is_default = false;
    const id = await issue("POST", `/api/v1/harnesses/${other}/deactivate`);
    expect(await call("POST", deactivatePath(), undefined, { "X-Cavelon-Confirmation": id })).toMatchObject({ status: 428, data: { reason: "other_change" } });
    // The same change once; then it is used.
    const own = await issue("POST", deactivatePath());
    expect((await call("POST", deactivatePath(), undefined, { "X-Cavelon-Confirmation": own })).status).toBe(200);
    solution("support").status = "active";
    expect(await call("POST", deactivatePath(), undefined, { "X-Cavelon-Confirmation": own })).toMatchObject({ status: 428, data: { reason: "used" } });
    expect(await call("POST", deactivatePath(), undefined, { "X-Cavelon-Confirmation": "cfm_unknown" })).toMatchObject({ status: 428, data: { reason: "unknown" } });
    server.state.confirmationTtlMs = 0;
    const late = await issue("POST", deactivatePath());
    expect(await call("POST", deactivatePath(), undefined, { "X-Cavelon-Confirmation": late })).toMatchObject({ status: 428, data: { reason: "expired" } });
    expect(solution("support").status).toBe("active");
  });

  it("reads a body by its content: key order does not matter, a different value does", async () => {
    expect((await call("PUT", "/api/v1/variables/zone", { value: "a" })).status).toBe(200);
    const trigger = { id: randomUUID(), tenant_id: tenant, slug: "t1", name: "T1", harness_id: solution("support").id, trigger_type: "schedule", is_active: false };
    const key = { id: randomUUID(), tenant_id: tenant, name: "k1", key_prefix: "cbp_k1", is_active: true };
    server.state.lr.triggers.push({ ...trigger, identity: { api_key_id: null, version: 1 }, required_solutions: [] });
    server.state.lr.apiKeys.push(key as (typeof server.state.lr.apiKeys)[number]);
    const path = `/api/v1/triggers/${trigger.id}/execution-identity`;
    const id = await issue("PUT", path, { expected_version: 1, api_key_id: key.id });
    const other = await issue("PUT", path, { api_key_id: null, expected_version: 1 });
    expect(await call("PUT", path, { api_key_id: key.id, expected_version: 1 }, { "X-Cavelon-Confirmation": other })).toMatchObject({ status: 428, data: { reason: "other_change" } });
    expect((await call("PUT", path, { api_key_id: key.id, expected_version: 1 }, { "X-Cavelon-Confirmation": id })).status).toBe(200);
  });

  it("leaves an id unused when the change fails for another reason", async () => {
    solution("support").is_default = false;
    solution("support").status = "draft";
    const path = `/api/v1/harnesses/${solution("support").id}/default`;
    const id = await issue("POST", path);
    expect((await call("POST", path, undefined, { "X-Cavelon-Confirmation": id })).status).toBe(409);
    solution("support").status = "active";
    expect((await call("POST", path, undefined, { "X-Cavelon-Confirmation": id })).status).toBe(200);
  });

  it("refuses an id for an API key and for an operation it does not mark, and asks a key for none", async () => {
    const key = server.addToken({ kind: "key", tenantIds: [tenant] });
    expect(await call("POST", "/api/v1/confirmations", { method: "POST", path: deactivatePath() }, {}, key)).toMatchObject({ status: 400, data: { code: "confirmation_needs_a_token" } });
    expect(await call("POST", "/api/v1/confirmations", { method: "POST", path: "/api/v1/harnesses" })).toMatchObject({ status: 422, data: { code: "confirmation_not_needed" } });
    expect((await call("POST", deactivatePath(), undefined, {}, key)).status).toBe(200);
  });
});
