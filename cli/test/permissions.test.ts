import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { accessOf, forbiddenHint, mayActivate, operationAccess } from "../src/access.js";
import { COMMANDS } from "../src/commands/index.js";
import { errorFromResponse } from "../src/http.js";
import type { InStream, Io } from "../src/io.js";
import { createMcpServer } from "../src/mcp.js";
import type { MetaPrincipal } from "../src/principal.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * The kit offers and suggests only what the credential may do, as the
 * instance's /meta/principal publishes it, and behaves as before where an
 * older instance does not say.
 */

let server: FakeServer;
let tenant: string;
let dirCount = 0;
const sandboxes: Sandbox[] = [];

/** An Observer's permissions: it reads, and changes nothing. */
const OBSERVER = ["agents.view", "harnesses.view", "knowledge_bases.view", "playground.use", "settings.view"];
/** A Builder's, without the settings ones that manage secrets and variables. */
const BUILDER = ["agents.edit", "agents.view", "harnesses.activate", "harnesses.manage", "harnesses.view", "knowledge_bases.manage_documents", "playground.use", "settings.view", "triggers.manage"];

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  const owner = await signedIn({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, mayActivate: true });
  await cli(owner, ["harness", "new", "support", "--name", "Support"]);
});
afterEach(() => {
  server.state.serveCredentialAccess = true;
  server.state.servePermissions = true;
});
afterAll(async () => {
  for (const sb of sandboxes) sb.cleanup();
  await server.close();
});

async function signedIn(info: Parameters<FakeServer["addToken"]>[0]): Promise<Sandbox> {
  const sb = sandbox();
  sandboxes.push(sb);
  await login(sb, server.url, server.addToken(info));
  return sb;
}

async function folder(sb: Sandbox): Promise<string> {
  const dir = path.join(sb.home, `solution-${++dirCount}`);
  mkdirSync(dir, { recursive: true });
  const init = await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--harness", "support"], { cwd: dir });
  expect(init.code, init.stderr).toBe(0);
  const pull = await cli(sb, ["pull"], { cwd: dir });
  expect(pull.code, pull.stderr).toBe(0);
  return dir;
}

async function mcpFor(sb: Sandbox): Promise<{ client: Client; changed: () => number; close(): Promise<void> }> {
  const io: Io = {
    stdout: { write: () => true },
    stderr: { write: () => true },
    stdin: Readable.from([]) as unknown as InStream,
    env: sb.env,
    cwd: sb.home,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  const mcp = createMcpServer(io, COMMANDS);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  let changes = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    changes++;
  });
  await client.connect(clientSide);
  return { client, changed: () => changes, close: () => client.close() };
}

function principal(extra: Partial<MetaPrincipal>): MetaPrincipal {
  return {
    kind: "personal_access_token",
    user: { id: "u", email: "dev@example.com" },
    token: { id: "t", name: "laptop", prefix: "cvpat_x", expires_at: "2099-01-01T00:00:00Z", ceiling_role: "tenant_builder", platform_mode_allowed: false, may_activate: false },
    api_key: null,
    tenant_id: "00000000-0000-4000-8000-000000000001",
    mode: "tenant",
    ...extra,
  };
}

describe("what the instance publishes about a credential", () => {
  it("a recent instance's permissions hold for every kind; an older one's for a person's token only, with may_activate for activation", () => {
    const recentKey = accessOf(
      principal({ kind: "api_key", token: null, api_key: { id: "k", name: "kb", prefix: "cbp_x", scopes: ["knowledge_base"], expires_at: null, harness_ids: null }, permissions: ["knowledge_bases.manage_documents"], needs_a_person: [] }),
    );
    expect(recentKey?.permissions).toEqual(["knowledge_bases.manage_documents"]);
    expect(operationAccess(recentKey, "POST /api/v1/knowledge-bases/{kb_id}/documents/upload").allowed).toBe(true);
    expect(operationAccess(recentKey, "POST /api/v1/harnesses/{harness_id}/activate")).toEqual({ allowed: false, missing: ["harnesses.manage", "harnesses.activate"] });
    expect(mayActivate(recentKey)).toBe(false);

    // An older instance: a key's permissions are not what its routes accept, so nothing is said up front.
    const olderKey = accessOf(principal({ kind: "api_key", token: null, api_key: { id: "k", name: "kb", prefix: "cbp_x", scopes: ["knowledge_base"], expires_at: null, harness_ids: null }, permissions: [] }));
    expect(olderKey?.permissions).toBeNull();
    expect(operationAccess(olderKey, "POST /api/v1/knowledge-bases/{kb_id}/documents/upload").allowed).toBeNull();
    expect(mayActivate(olderKey)).toBeNull();

    // An older instance's token: may_activate stands for harnesses.activate.
    const olderToken = (may: boolean) => accessOf(principal({ permissions: ["harnesses.manage"], token: { ...principal({}).token!, may_activate: may } }));
    expect(mayActivate(olderToken(true))).toBe(true);
    expect(mayActivate(olderToken(false))).toBe(false);
    // No permissions published at all: the token's own word.
    expect(mayActivate(accessOf(principal({ token: { ...principal({}).token!, may_activate: true } })))).toBe(true);
    expect(mayActivate(undefined)).toBeNull();

    // needs_a_person wins over the permissions.
    const person = accessOf(principal({ permissions: ["agents.edit"], needs_a_person: [{ operation: "import", method: "POST", path: "/api/v1/agent-graph/import", reason: "Runs only for a person" }] }));
    expect(operationAccess(person, "POST /api/v1/agent-graph/import")).toEqual({ allowed: false, person: "Runs only for a person" });
  });
});

describe("whoami and status show the permissions and scopes", () => {
  it("a token's permissions, whether it may activate and set variables, and the acting tenant's name from the principal", async () => {
    const builder = await signedIn({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, permissions: BUILDER, tokenName: "builder" });
    const data = (await cli(builder, ["whoami", "--json"])).json<{ credential: Record<string, unknown>; tenant: Record<string, unknown> }>();
    expect(data.credential).toMatchObject({ kind: "personal_access_token", permissions: [...BUILDER].sort(), may_activate: true, may_set_variables: false, scopes: null, needs_a_person: [] });
    expect(data.tenant).toMatchObject({ id: tenant, name: "Acme", slug: "acme" });
    const text = (await cli(builder, ["whoami"])).stdout;
    expect(text).toMatch(/^permissions:\s+agents\.edit, agents\.view, harnesses\.activate, /m);
    expect(text).toMatch(/^may set variables:\s+no \(a tenant Owner sets them, in the Admin or with their own token\)$/m);
    expect(text).not.toMatch(/^scopes:/m);
  });

  it("an API key's scopes and permissions, and the operations a person runs instead", async () => {
    const key = await signedIn({ kind: "key", tenantIds: [tenant], tokenName: "uploader", scopes: ["knowledge_base"] });
    const data = (await cli(key, ["whoami", "--json"])).json<{ credential: Record<string, unknown> }>();
    expect(data.credential).toMatchObject({
      kind: "api_key",
      scopes: ["knowledge_base"],
      permissions: ["knowledge_bases.manage", "knowledge_bases.manage_documents", "knowledge_bases.view"],
      may_activate: false,
      may_set_variables: false,
      needs_a_person: expect.arrayContaining([expect.objectContaining({ method: "POST", path: "/api/v1/agent-graph/import" })]),
    });
    const text = (await cli(key, ["whoami"])).stdout;
    expect(text).toMatch(/^scopes:\s+knowledge_base$/m);
    expect(text).toMatch(/^needs a person:\s+3 operations a person runs, not this credential:\n {2}POST \/api\/v1\/agent-graph\/import/m);

    const status = await cli(key, ["status", "--json"]);
    expect(status.json<{ credential: Record<string, unknown> }>().credential).toMatchObject({
      scopes: ["knowledge_base"],
      permissions: ["knowledge_bases.manage", "knowledge_bases.manage_documents", "knowledge_bases.view"],
      may_activate: false,
      needs_a_person: 3,
    });
    expect((await cli(key, ["status"])).stdout).toMatch(/^scopes:\s+knowledge_base$/m);
  });

  it("an older instance: a key's scopes, its permissions not published, and no line that guesses", async () => {
    server.state.serveCredentialAccess = false;
    const key = await signedIn({ kind: "key", tenantIds: [tenant], tokenName: "uploader", scopes: ["knowledge_base"] });
    const data = (await cli(key, ["whoami", "--json"])).json<{ credential: Record<string, unknown> }>();
    expect(data.credential).toMatchObject({ scopes: ["knowledge_base"], permissions: null, may_activate: null, may_set_variables: null, needs_a_person: null });
    const text = (await cli(key, ["whoami"])).stdout;
    expect(text).toMatch(/^permissions:\s+not published for this credential by this instance$/m);
    expect(text).not.toMatch(/may activate|may set variables|needs a person/);
    // A token there: may_activate says it.
    const token = await signedIn({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, mayActivate: true });
    expect((await cli(token, ["whoami", "--json"])).json<{ credential: Record<string, unknown> }>().credential).toMatchObject({ may_activate: true, needs_a_person: null });
    server.state.servePermissions = false;
    expect((await cli(token, ["whoami", "--json"])).json<{ credential: Record<string, unknown> }>().credential).toMatchObject({ may_activate: true, permissions: null });
  });
});

describe("the MCP server marks the tools the credential may not use", () => {
  it("an Observer's token: the changing tools say so before any call; the read-only ones do not", async () => {
    const observer = await signedIn({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, permissions: OBSERVER, tokenName: "observer" });
    const mcp = await mcpFor(observer);
    try {
      const { tools } = await mcp.client.listTools();
      const description = (name: string) => tools.find((t) => t.name === name)!.description!;
      expect(description("activate")).toMatch(/^Not for this credential: the token "observer" may not send POST \/api\/v1\/harnesses\/\{harness_id\}\/activate \(it needs harnesses\.manage and harnesses\.activate, which it does not hold\)\. A person whose role holds harnesses\.manage and harnesses\.activate does it, in the Admin or with their own token \(this token acts at most as tenant_admin\)\. Do not call it to find out; tell the person\.\n/);
      for (const name of ["apply", "deactivate", "harness_default", "harness_new", "kb_upload", "variables_set", "loop_start", "trigger_identity", "models_set_limit"]) {
        expect(description(name), name).toMatch(/^Not for this credential: /);
      }
      // Read-only tools, and one an Observer may use, are listed as they are.
      for (const name of ["whoami", "status", "harness_list", "api_list", "test_run", "chat"]) expect(description(name), name).not.toMatch(/Not for this credential/);
    } finally {
      await mcp.close();
    }
  });

  it("a knowledge_base key: kb_upload stays, apply is a person's, the rest need a scope", async () => {
    const key = await signedIn({ kind: "key", tenantIds: [tenant], tokenName: "uploader", scopes: ["knowledge_base"] });
    const mcp = await mcpFor(key);
    try {
      const { tools } = await mcp.client.listTools();
      const description = (name: string) => tools.find((t) => t.name === name)!.description!;
      expect(description("kb_upload")).not.toMatch(/Not for this credential/);
      expect(description("apply")).toMatch(/^Not for this credential: the API key "uploader" may not send POST \/api\/v1\/agent-graph\/import \(a person runs it\)\. A person does it, in the Admin or with their own token: the instance says "Runs only for a person/);
      expect(description("activate")).toMatch(/An API key's scopes grant its permissions, and this one's \(knowledge_base\) hold no harnesses\.manage and harnesses\.activate/);
    } finally {
      await mcp.close();
    }
  });

  it("an older instance, or one that cannot be asked, lists the tools unmarked", async () => {
    server.state.serveCredentialAccess = false;
    const key = await signedIn({ kind: "key", tenantIds: [tenant], scopes: ["knowledge_base"] });
    const mcp = await mcpFor(key);
    try {
      const { tools } = await mcp.client.listTools();
      expect(tools.filter((t) => /Not for this credential/.test(t.description ?? ""))).toEqual([]);
    } finally {
      await mcp.close();
    }
    const nowhere = sandbox();
    sandboxes.push(nowhere);
    const offline = await mcpFor(nowhere);
    try {
      expect((await offline.client.listTools()).tools.some((t) => /Not for this credential/.test(t.description ?? ""))).toBe(false);
    } finally {
      await offline.close();
    }
  });

  it("choosing another tenant tells the client to list the tools again", async () => {
    const owner = await signedIn({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, mayActivate: true });
    const mcp = await mcpFor(owner);
    try {
      const chosen = await mcp.client.callTool({ name: "use_tenant", arguments: { tenant: "acme" } });
      expect(chosen.isError).toBeFalsy();
      await new Promise((r) => setTimeout(r, 20));
      expect(mcp.changed()).toBe(1);
    } finally {
      await mcp.close();
    }
  });
});

describe("api list marks what the credential may not send", () => {
  it("marks, and with --usable leaves out, the operations a person runs or whose permission it lacks", async () => {
    const key = await signedIn({ kind: "key", tenantIds: [tenant], tokenName: "uploader", scopes: ["knowledge_base"] });
    type Page = { items: Array<{ method: string; path: string; may_send: boolean | null; needs_a_person: string | null; needs: string[] | null }>; total: number; credential_published: boolean };
    const page = (await cli(key, ["api", "list", "--limit", "0", "--json"])).json<Page>();
    expect(page.credential_published).toBe(true);
    const item = (method: string, p: string) => page.items.find((i) => i.method === method && i.path === p)!;
    expect(item("POST", "/api/v1/agent-graph/import")).toMatchObject({ may_send: false, needs_a_person: "Runs only for a person: a dashboard session or a personal access token" });
    expect(item("PUT", "/api/v1/secrets/{name}")).toMatchObject({ may_send: false, needs_a_person: "Sets or deletes a secret value" });
    expect(item("POST", "/api/v1/harnesses/{harness_id}/deactivate")).toMatchObject({ may_send: false, needs: ["harnesses.manage"] });
    expect(item("POST", "/api/v1/knowledge-bases/{kb_id}/documents/upload")).toMatchObject({ may_send: true });
    // One the kit knows nothing about: the instance decides.
    expect(item("GET", "/api/v1/harnesses")).toMatchObject({ may_send: null });
    const text = (await cli(key, ["api", "list", "--search", "agent-graph"])).stdout;
    expect(text).toMatch(/a person/);
    expect(text).toMatch(/--usable leaves them out/);
    const usable = (await cli(key, ["api", "list", "--limit", "0", "--usable", "--json"])).json<Page>();
    expect(usable.total).toBe(page.total - page.items.filter((i) => i.may_send === false).length);
    expect(usable.items.some((i) => i.may_send === false)).toBe(false);
  });

  it("an older instance marks nothing", async () => {
    server.state.serveCredentialAccess = false;
    const key = await signedIn({ kind: "key", tenantIds: [tenant], scopes: ["knowledge_base"] });
    const page = (await cli(key, ["api", "list", "--limit", "0", "--json"])).json<{ items: Array<{ may_send: boolean | null }> }>();
    expect(page.items.every((i) => i.may_send === null)).toBe(true);
  });
});

describe("hints suggest activating only to a credential that may", () => {
  it("a token without may activate hears who activates, not the command it would be refused", async () => {
    const token = await signedIn({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, mayActivate: false });
    const refused = await cli(token, ["harness", "default", "support"]);
    expect(refused.code).toBe(4);
    expect(refused.stderr).toMatch(/Only an active solution can be the default, and to activate it a person who may activate does it, in the Admin \(this credential may not\)\./);
    expect(refused.stderr).not.toMatch(/cavelon activate/);
    const dir = await folder(token);
    const status = await cli(token, ["status"], { cwd: dir });
    expect(status.stdout).toMatch(/^default route:\s+no: .+ only an active solution can be the default, and to activate it a person who may activate does it/m);
    expect(status.stdout).not.toMatch(/cavelon activate/);
  });

  it("one that may, on a recent or an older instance, is given the command", async () => {
    const token = await signedIn({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, mayActivate: true });
    expect((await cli(token, ["harness", "default", "support"])).stderr).toMatch(/cavelon activate --harness support --make-default/);
    server.state.serveCredentialAccess = false;
    expect((await cli(token, ["harness", "default", "support"])).stderr).toMatch(/cavelon activate --harness support --make-default/);
  });
});

describe("a 403 names what the credential lacks, by its kind", () => {
  const refused = (body: unknown, credential: Parameters<typeof forbiddenHint>[1]) =>
    errorFromResponse(403, body, "POST /api/v1/harnesses/abc/deactivate", undefined, { method: "POST", path: "/api/v1/harnesses/abc/deactivate", credential });

  it("a token: its role lacks the permission the refusal names, capped by its ceiling; never a key's scopes", () => {
    const access = accessOf(principal({ permissions: OBSERVER, needs_a_person: [] }));
    const error = refused({ detail: "Missing permissions: harnesses.manage" }, { kind: "personal_access_token", access, method: "POST", path: "/api/v1/harnesses/abc/deactivate" });
    expect(error.hint).toBe(
      "This token's role in the tenant lacks harnesses.manage. A token acts with the lesser of its owner's role and its ceiling (tenant_builder). A person whose role holds it does this, in the Admin or with their own token. `cavelon whoami` shows what it may do.",
    );
    expect(error.details).toEqual({ credential: "personal_access_token", permissions: ["harnesses.manage"] });
    // "one of" names the alternatives.
    expect(refused({ detail: "Missing one of permissions: settings.manage, settings.secrets.manage" }, { kind: "personal_access_token", method: "PUT", path: "/api/v1/variables/x" }).hint).toMatch(
      /lacks settings\.manage or settings\.secrets\.manage\. A token acts at most with its ceiling role\./,
    );
  });

  it("a refusal that names nothing: what the principal and the operation say", () => {
    const access = accessOf(principal({ permissions: OBSERVER, needs_a_person: [] }));
    expect(refused({ detail: "Forbidden" }, { kind: "personal_access_token", access, method: "POST", path: "/api/v1/harnesses/abc/deactivate" }).hint).toMatch(/^This token's role in the tenant lacks harnesses\.manage\./);
    // Unknown to the principal: what the operation needs, not what the token lacks.
    expect(refused({ detail: "Forbidden" }, { kind: "personal_access_token", method: "POST", path: "/api/v1/harnesses/abc/deactivate" }).hint).toMatch(/^This needs harnesses\.manage\./);
    // Activation for a token created without it.
    const noActivate = accessOf(principal({ permissions: ["harnesses.manage"], needs_a_person: [] }));
    expect(refused({ detail: "Forbidden" }, { kind: "personal_access_token", access: noActivate, method: "POST", path: "/api/v1/harnesses/abc/activate" }).hint).toMatch(/^The token was created without "may activate"\./);
    // Nothing known: the old advice, without a ceiling for a key.
    expect(refused({ detail: "Forbidden" }, { kind: "personal_access_token", method: "GET", path: "/api/v1/somewhere" }).hint).toMatch(/^The token does not reach this\. Check the tenant and the token's role\./);
  });

  it("an API key: its scopes, never a ceiling; the scope a refusal names", () => {
    const access = accessOf(principal({ kind: "api_key", token: null, api_key: { id: "k", name: "ci", prefix: "cbp_x", scopes: ["chat"], expires_at: null, harness_ids: null }, permissions: [], needs_a_person: [] }));
    const error = refused({ detail: "Forbidden" }, { kind: "api_key", access, method: "POST", path: "/api/v1/harnesses/abc/deactivate" });
    expect(error.hint).toMatch(/^An API key acts only with what its scopes grant, and this one lacks a scope that grants harnesses\.manage\. Its scopes: chat\. A tenant administrator issues a key that may \(Settings → API keys\), or a person does this with their own token\./);
    expect(error.hint).not.toMatch(/ceiling/);
    const scoped = refused({ detail: "API key missing required scope: admin" }, { kind: "api_key", method: "POST", path: "/api/v1/harnesses/abc/deactivate" });
    expect(scoped.hint).toMatch(/this one lacks the scope admin\./);
    expect(scoped.details).toEqual({ credential: "api_key", scope: "admin" });
  });

  it("an operation a person runs: the instance's reason", async () => {
    const key = await signedIn({ kind: "key", tenantIds: [tenant], tokenName: "ci", scopes: ["admin"] });
    const dir = await folder(key);
    const preview = await cli(key, ["apply", "--json"], { cwd: dir });
    const id = preview.json<{ preview_id?: string }>().preview_id;
    expect(id, preview.stdout + preview.stderr).toBeTruthy();
    const result = await cli(key, ["apply", "--confirm", id!, "--json"], { cwd: dir });
    expect(result.code).toBe(7);
    const error = result.json<{ error: { hint: string; details: Record<string, unknown> } }>().error;
    expect(error.hint).toBe("A person does this, not a token or an API key (the instance says: Runs only for a person: a dashboard session or a personal access token): in the Admin, or as a session of their own.");
    expect(error.details).toMatchObject({ credential: "api_key", needs_a_person: true });
  });
});
