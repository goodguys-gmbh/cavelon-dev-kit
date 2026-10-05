import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { keptForPerson } from "../src/commands/api.js";
import { COMMANDS } from "../src/commands/index.js";
import type { InStream, Io } from "../src/io.js";
import { createMcpServer } from "../src/mcp.js";
import type { Operation } from "../src/openapi.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

function op(method: string, path: string, personOnly?: Operation["personOnly"]): Operation {
  return {
    operationId: `${method} ${path}`,
    alias: `${method} ${path}`,
    method,
    path,
    tags: [],
    parameters: [],
    responses: {},
    readOnly: method === "GET",
    ...(personOnly ? { personOnly } : {}),
  };
}

describe("the operations api keeps for a person over MCP, on an instance that marks none", () => {
  it.each([
    ["PUT", "/api/v1/secrets/{name}", "changes a secret"],
    ["DELETE", "/api/v1/secrets/{name}", "changes a secret"],
    ["POST", "/api/v1/webhooks/{id}/rotate-secret", "changes a secret"],
    ["POST", "/api/v1/personal-access-tokens", "creates or revokes a credential"],
    ["DELETE", "/api/v1/tenants/{tenant_id}/personal-access-tokens/{token_id}", "creates or revokes a credential"],
    ["POST", "/api/v1/tenants/{tenant_id}/api-keys", "creates or revokes a credential"],
    ["DELETE", "/api/v1/tenants/{tenant_id}/api-keys/{key_id}", "creates or revokes a credential"],
    ["POST", "/api/v1/auth/password", "creates or revokes a credential"],
    ["POST", "/api/v1/approvals/{approval_id}/decide", "decides an approval"],
    ["POST", "/api/v1/approvals/{approval_id}/cancel", "decides an approval"],
    ["POST", "/api/v1/runs/{run_id}/approve", "decides an approval"],
  ])("%s %s %s", (method, path, does) => {
    const operation = op(method, path);
    expect(keptForPerson(operation, [operation])).toMatchObject({ source: "kit", reason: does });
  });

  it.each([
    ["GET", "/api/v1/secrets"],
    ["GET", "/api/v1/tenants/{tenant_id}/api-keys"],
    ["PUT", "/api/v1/variables/{name}"],
    ["POST", "/api/v1/knowledge-bases/{kb_id}/documents/upload"],
    ["PUT", "/api/v1/triggers/{trigger_id}/execution-identity"],
    ["POST", "/api/v1/harnesses"],
    // A path parameter's name is not a word of the path.
    ["PATCH", "/api/v1/things/{secret_ref}"],
  ])("leaves %s %s to confirm", (method, path) => {
    const operation = op(method, path);
    expect(keptForPerson(operation, [operation])).toBeUndefined();
  });
});

describe("the operations api keeps for a person over MCP, on an instance that marks them", () => {
  const secret = op("PUT", "/api/v1/secrets/{name}", { marked: true, reason: "Sets or deletes a secret value" });
  const unmarkedSecret = op("DELETE", "/api/v1/secrets/{name}", { marked: false });
  const report = op("GET", "/api/v1/reports/{id}/download", { marked: true });
  const tokens = op("POST", "/api/v1/personal-access-tokens");
  const variable = op("PUT", "/api/v1/variables/{name}");
  const all = [secret, unmarkedSecret, report, tokens, variable];

  it("refuses exactly the marked operations, with the instance's reason", () => {
    expect(keptForPerson(secret, all)).toEqual({
      source: "instance",
      reason: "Sets or deletes a secret value",
      hint: expect.stringMatching(/cavelon secrets set <name>/),
    });
    // A read-only operation the instance marks is refused too; without a reason, the hint names the CLI.
    expect(keptForPerson(report, all)).toEqual({ source: "instance", hint: expect.stringMatching(/cavelon api GET \/api\/v1\/reports/) });
  });

  it("no longer reads the path's words", () => {
    expect(keptForPerson(unmarkedSecret, all)).toBeUndefined();
    expect(keptForPerson(tokens, all)).toBeUndefined();
    expect(keptForPerson(variable, all)).toBeUndefined();
  });
});

describe("api over MCP with the instance's person-only marker", () => {
  let server: FakeServer;
  let tenant: string;
  let token: string;
  const open: Array<{ client: Client; sb: Sandbox }> = [];

  beforeAll(async () => {
    server = await startFakeServer();
    tenant = server.addTenant("acme", "Acme");
    token = server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, email: "ada@example.com" });
  });
  afterEach(async () => {
    for (const { client, sb } of open.splice(0)) {
      await client.close();
      sb.cleanup();
    }
    server.state.personOnly = {};
  });
  afterAll(async () => {
    await server.close();
  });

  /** An agent's MCP client in a fresh sandbox, so the OpenAPI is read anew. */
  async function agent(): Promise<{ client: Client; sb: Sandbox }> {
    const sb = sandbox();
    await login(sb, server.url, token);
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
    await client.connect(clientSide);
    open.push({ client, sb });
    return { client, sb };
  }

  async function call(client: Client, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, any> }> {
    const result = await client.callTool({ name: "api", arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return { isError: Boolean(result.isError), body: JSON.parse(content[0]!.text) };
  }

  const changes = (before: number) => server.state.requests.slice(before).filter((r) => r.method !== "GET");

  it("refuses the operations the instance marks, with its reason, and only those", async () => {
    // The snapshot marks setting and deleting a secret; this instance also marks a variable and the secrets list.
    server.state.personOnly = { "PUT /api/v1/variables/{name}": "Writes a value only a person may write", "GET /api/v1/secrets": "Reads what only a person reads" };
    const { client } = await agent();
    const before = server.state.requests.length;
    for (const confirm of [false, true]) {
      const secret = await call(client, { operation: "set_secret", params: ["name=smtp_password"], body: '{"value":"agent-chosen"}', confirm });
      expect(secret.isError).toBe(true);
      expect(secret.body.error).toMatchObject({
        code: "operation_for_a_person",
        exit_code: 5,
        message: expect.stringMatching(/^set_secret \(PUT \/api\/v1\/secrets\/\{name\}\) is for a person only, as the instance marks it \(Sets or deletes a secret value\)/),
        hint: expect.stringMatching(/cavelon secrets set <name>/),
        details: { source: "instance", reason: "Sets or deletes a secret value" },
      });
      const variable = await call(client, { operation: "set_variable", params: ["name=region"], body: '{"value":"eu"}', confirm });
      expect(variable.body.error).toMatchObject({ code: "operation_for_a_person", details: { source: "instance", reason: "Writes a value only a person may write" } });
    }
    const list = await call(client, { operation: "list_secrets" });
    expect(list.body.error).toMatchObject({ code: "operation_for_a_person", details: { reason: "Reads what only a person reads" } });
    expect(changes(before)).toEqual([]);
  });

  it("no longer refuses by the path's words once the instance marks any operation", async () => {
    server.state.personOnly = { "DELETE /api/v1/secrets/{name}": false };
    const { client } = await agent();
    const before = server.state.requests.length;
    // Unmarked, deleting a secret is an ordinary changing operation: a preview, sent only with confirm.
    const preview = await call(client, { operation: "delete_secret", params: ["name=smtp_password"] });
    expect(preview.isError).toBe(false);
    expect(preview.body).toMatchObject({ method: "DELETE", path: "/api/v1/secrets/smtp_password", sent: false });
    expect(changes(before)).toEqual([]);
    expect((await call(client, { operation: "set_secret", params: ["name=smtp_password"], body: '{"value":"x"}' })).body.error).toMatchObject({
      details: { source: "instance" },
    });
  });

  it("refuses by the path's words on an instance without the marker", async () => {
    server.state.personOnly = null;
    const { client, sb } = await agent();
    expect((await cli(sb, ["secrets", "set", "smtp_password"], { stdin: "person-chosen" })).code).toBe(0);
    const before = server.state.requests.length;
    for (const call_ of [
      { operation: "set_secret", params: ["name=smtp_password"], body: '{"value":"agent-chosen"}', confirm: true },
      { operation: "delete_secret", params: ["name=smtp_password"], confirm: true },
    ]) {
      const refused = await call(client, call_);
      expect(refused.body.error).toMatchObject({
        code: "operation_for_a_person",
        message: expect.stringMatching(/changes a secret; that stays with a person/),
        details: { source: "kit", reason: "changes a secret" },
      });
    }
    // A read-only operation is never refused there, and the CLI is a person: it sends at once.
    expect((await call(client, { operation: "list_secrets" })).isError).toBe(false);
    expect(changes(before)).toEqual([]);
    expect((await cli(sb, ["api", "delete_secret", "name=smtp_password", "--json"])).code).toBe(0);
  });
});
