import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentVariable, AGENT_VARIABLES } from "../src/agent-env.js";
import { splitConfirm } from "../src/commands/api.js";
import { COMMANDS } from "../src/commands/index.js";
import type { OpenApiDoc } from "../src/contracts.js";
import type { InStream, Io } from "../src/io.js";
import { createMcpServer } from "../src/mcp.js";
import { secretFields } from "../src/openapi.js";
import { modelRow, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * The guards of the MCP `api` tool, and `cavelon api` run by a coding agent:
 * an operation kept for a person is refused, a changing one needs a preview
 * and its confirmation, files stay in the solution folder, and a body field
 * the instance marks as a secret value is never sent. A person's terminal is
 * not guarded.
 */

const SECRET = { "x-cavelon-secret": true, writeOnly: true, type: "string" };

describe("the fields of a body the instance marks as a secret value", () => {
  const doc = {
    openapi: "3.1.0",
    paths: {},
    components: {
      schemas: {
        Credential: { type: "object", properties: { name: { type: "string" }, password: SECRET } },
        Connection: {
          type: "object",
          properties: {
            url: { type: "string" },
            api_key: { anyOf: [SECRET, { type: "null" }] },
            credential: { anyOf: [{ $ref: "#/components/schemas/Credential" }, { type: "null" }] },
            headers: { type: "array", items: { type: "object", properties: { name: { type: "string" }, value: SECRET } } },
            vault: { type: "object", additionalProperties: SECRET },
            settings: { type: "object", additionalProperties: true },
            next: { $ref: "#/components/schemas/Connection" },
          },
        },
      },
    },
  } as unknown as OpenApiDoc;
  const schema = { $ref: "#/components/schemas/Connection" };

  it("finds a marked field at the top, in a nested object, in an array and in a map of secrets", () => {
    expect(secretFields(doc, schema, { url: "https://crm", api_key: "k" })).toEqual(["api_key"]);
    expect(secretFields(doc, schema, { credential: { name: "crm", password: "p" } })).toEqual(["credential.password"]);
    expect(secretFields(doc, schema, { headers: [{ name: "a", value: "1" }, { name: "b" }, { name: "c", value: "3" }] })).toEqual([
      "headers[0].value",
      "headers[2].value",
    ]);
    expect(secretFields(doc, schema, { vault: { smtp: "s" } })).toEqual(["vault.smtp"]);
    // A schema that refers to itself is followed as far as the body goes.
    expect(secretFields(doc, schema, { next: { next: { api_key: "k" } } })).toEqual(["next.next.api_key"]);
  });

  it("passes unmarked fields, a marked field set to null, and a free-form map it cannot see into", () => {
    expect(secretFields(doc, schema, { url: "https://crm", credential: { name: "crm" }, headers: [{ name: "a" }] })).toEqual([]);
    expect(secretFields(doc, schema, { api_key: null, credential: null })).toEqual([]);
    expect(secretFields(doc, schema, { settings: { password: "typed into a map" } })).toEqual([]);
  });

  it("finds nothing in a document without the marker", () => {
    const plain = JSON.parse(JSON.stringify(doc).replaceAll('"x-cavelon-secret":true,', "")) as OpenApiDoc;
    expect(secretFields(plain, schema, { api_key: "k", credential: { password: "p" }, headers: [{ value: "v" }] })).toEqual([]);
  });
});

describe("whether a coding agent runs cavelon", () => {
  it.each(AGENT_VARIABLES.map((v) => [v.variable, v.agent]))("%s (%s) says so", (variable) => {
    expect(agentVariable({ PATH: "/usr/bin", [variable]: "1" })).toBe(variable);
  });

  it("not in a person's terminal, nor when a variable is empty, 0 or false", () => {
    expect(agentVariable({ PATH: "/usr/bin", TERM: "xterm-256color" })).toBeUndefined();
    expect(agentVariable({ CAVELON_AGENT: "0", CLAUDECODE: "", CURSOR_AGENT: "false" })).toBeUndefined();
  });

  it("names the agent's own variable before the shared AI_AGENT", () => {
    expect(agentVariable({ AI_AGENT: "github_copilot_vscode_agent", COPILOT_AGENT: "1" })).toBe("COPILOT_AGENT");
  });
});

describe("--confirm", () => {
  it("takes the next argument only when it is a token, so a person's bare --confirm keeps its parameter", () => {
    expect(splitConfirm(["op", "--confirm", "0123456789ab"])).toEqual(["op", "--confirm=0123456789ab"]);
    expect(splitConfirm(["op", "--confirm"])).toEqual(["op", "--confirm="]);
    expect(splitConfirm(["op", "--confirm", "name=region"])).toEqual(["op", "--confirm=", "name=region"]);
    expect(splitConfirm(["op", "--confirm", "--json"])).toEqual(["op", "--confirm=", "--json"]);
    expect(splitConfirm(["op", "--confirm=abc"])).toEqual(["op", "--confirm=abc"]);
  });
});

describe("cavelon api and the api tool, run by an agent and by a person", () => {
  let server: FakeServer;
  let tenant: string;
  let sb: Sandbox;
  let outside: string;
  const clients: Client[] = [];
  const AGENT = { CLAUDECODE: "1" };

  beforeAll(async () => {
    server = await startFakeServer();
    tenant = server.addTenant("acme", "Acme");
    const token = server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, email: "ada@example.com" });
    sb = sandbox();
    await login(sb, server.url, token);
    outside = mkdtempSync(path.join(os.tmpdir(), "cavelon-outside-"));
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    server.state.secretFields = {};
    server.state.models = [];
  });
  afterAll(async () => {
    sb.cleanup();
    rmSync(outside, { recursive: true, force: true });
    await server.close();
  });

  /** Sends since `before` that change something. */
  const changes = (before: number) => server.state.requests.slice(before).filter((r) => r.method !== "GET");

  /** A fresh cache per call, so the OpenAPI with this test's markers is read anew. */
  function fresh(): Record<string, string> {
    return { CAVELON_CACHE_DIR: mkdtempSync(path.join(sb.home, "cache-")) };
  }

  async function api(args: string[], env: Record<string, string> = {}) {
    return cli(sb, ["api", ...args, "--json"], { env: { ...fresh(), ...env } });
  }

  async function mcp(): Promise<Client> {
    const io: Io = {
      stdout: { write: () => true },
      stderr: { write: () => true },
      stdin: Readable.from([]) as unknown as InStream,
      env: { ...sb.env, ...fresh() },
      cwd: sb.home,
      now: () => new Date(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(io, COMMANDS).connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    clients.push(client);
    return client;
  }

  async function tool(client: Client, args: Record<string, unknown>) {
    const result = await client.callTool({ name: "api", arguments: args });
    return { isError: Boolean(result.isError), body: JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, any> };
  }

  describe("an operation the instance keeps for a person", () => {
    // The snapshot marks set_secret x-cavelon-person-only.
    const setSecret = ["set_secret", "name=smtp_password", "--body", '{"value":"chosen"}'];

    it("is refused under an agent, with or without --confirm, and says how a person runs it", async () => {
      const before = server.state.requests.length;
      for (const extra of [[], ["--confirm", "0123456789ab"]]) {
        const result = await api([...setSecret, ...extra], AGENT);
        expect(result.code).toBe(5);
        expect(result.json<{ error: Record<string, unknown> }>().error).toMatchObject({
          code: "operation_for_a_person",
          message: expect.stringMatching(/is for a person only, as the instance marks it .*cavelon api does not send it when a coding agent runs it \(CLAUDECODE is set\)/),
          hint: expect.stringMatching(/cavelon secrets set <name>.*A person's own terminal is not guarded: it does not set CLAUDECODE\./),
          details: { source: "instance", agent_variable: "CLAUDECODE" },
        });
      }
      expect(changes(before)).toEqual([]);
    });

    it("is sent from a person's terminal", async () => {
      const before = server.state.requests.length;
      expect((await api(setSecret)).code).toBe(0);
      expect(changes(before)).toEqual([expect.objectContaining({ method: "PUT", path: "/api/v1/secrets/smtp_password" })]);
    });
  });

  describe("a changing operation", () => {
    const setVariable = (value: string) => ["set_variable", "name=region", "--body", JSON.stringify({ value })];

    it("shows the request under an agent and sends exactly it only with its token", async () => {
      const before = server.state.requests.length;
      const preview = await api(setVariable("eu"), AGENT);
      expect(preview.code).toBe(0);
      const shown = preview.json<Record<string, any>>();
      expect(shown).toMatchObject({
        operation: "set_variable",
        method: "PUT",
        path: "/api/v1/variables/region",
        body: { value: "eu" },
        sent: false,
        confirm_token: expect.stringMatching(/^[0-9a-f]{12}$/),
        confirm: expect.stringMatching(/^Show the person this request, then run the same command again with --confirm [0-9a-f]{12}/),
      });
      // The text shows the person the request.
      const text = await cli(sb, ["api", ...setVariable("eu")], { env: { ...fresh(), ...AGENT } });
      expect(text.stdout).toMatch(/^Would send PUT \/api\/v1\/variables\/region\. Nothing was sent\.\nBody:\n\{\n {2}"value": "eu"\n\}\n/);
      expect(text.stdout).toContain(`--confirm ${shown.confirm_token}`);
      expect(changes(before)).toEqual([]);

      // A bare --confirm (exit 5: a person has to see the preview), another request's token, or the token for a changed body sends nothing.
      const bare = await api([...setVariable("eu"), "--confirm"], AGENT);
      expect(bare.code).toBe(5);
      expect(bare.json()).toMatchObject({ sent: false, token_required: true, confirm_token: shown.confirm_token });
      const changed = await api([...setVariable("us"), "--confirm", shown.confirm_token], AGENT);
      expect(changed.code).toBe(4);
      expect(changed.json()).toMatchObject({ sent: false, token_mismatch: true, body: { value: "us" } });
      expect(changes(before)).toEqual([]);

      const sent = await api([...setVariable("eu"), "--confirm", shown.confirm_token], AGENT);
      expect(sent.code).toBe(0);
      expect(changes(before)).toEqual([expect.objectContaining({ method: "PUT", path: "/api/v1/variables/region", body: { value: "eu" } })]);
    });

    it("binds the MCP tool's confirm to the same token as the shell's, for the same request", async () => {
      const shell = (await api(setVariable("fr"), AGENT)).json<{ confirm_token: string }>().confirm_token;
      const client = await mcp();
      try {
        const args = { operation: "set_variable", params: ["name=region"], body: JSON.stringify({ value: "fr" }) };
        const before = server.state.requests.length;
        const shown = await tool(client, args);
        expect(shown.body).toMatchObject({ sent: false, confirm_token: shell });
        expect(shown.body.confirm).toBe(`Show the person this, then call api again with the same arguments and confirm: "${shell}" to make exactly this change.`);
        expect((await tool(client, { ...args, confirm: "000000000000" })).body).toMatchObject({ sent: false, token_mismatch: true, exit_code: 4 });
        expect(changes(before)).toEqual([]);
        expect((await tool(client, { ...args, confirm: shell })).isError).toBe(false);
        expect(changes(before)).toEqual([expect.objectContaining({ method: "PUT", body: { value: "fr" } })]);
      } finally {
        await client.close();
      }
    });

    it("is sent at once from a person's terminal, with or without a bare --confirm", async () => {
      const before = server.state.requests.length;
      expect((await api(setVariable("eu"))).code).toBe(0);
      expect((await api(["set_variable", "--confirm", "name=region", "--body", '{"value":"de"}'])).code).toBe(0);
      expect(changes(before).map((r) => r.body)).toEqual([{ value: "eu" }, { value: "de" }]);
    });

    it("counts CAVELON_AGENT=1 as an agent, and CAVELON_AGENT=0 not", async () => {
      const before = server.state.requests.length;
      expect((await api(setVariable("eu"), { CAVELON_AGENT: "1" })).json()).toMatchObject({ sent: false });
      expect(changes(before)).toEqual([]);
      expect((await api(setVariable("eu"), { CAVELON_AGENT: "0" })).code).toBe(0);
      expect(changes(before)).toHaveLength(1);
    });
  });

  describe("a read-only operation", () => {
    it("is sent at once, under an agent and from a person's terminal", async () => {
      for (const env of [AGENT, {}]) {
        const before = server.state.requests.length;
        const result = await api(["list_variables"], env);
        expect(result.code).toBe(0);
        expect(server.state.requests.slice(before).some((r) => r.method === "GET" && r.path === "/api/v1/variables")).toBe(true);
      }
    });
  });

  describe("files", () => {
    it("stay inside the solution folder under an agent, for the body, an attachment and --output", async () => {
      const body = path.join(outside, "body.json");
      writeFileSync(body, '{"value":"eu"}');
      for (const args of [
        ["set_variable", "name=region", "--body", `@${body}`],
        ["list_variables", "--output", path.join(outside, "variables.json")],
      ]) {
        const result = await api(args, AGENT);
        expect(result.code).toBe(2);
        expect(result.json<{ error: Record<string, unknown> }>().error).toMatchObject({
          code: "path_outside_solution",
          message: expect.stringMatching(/run by a coding agent, cavelon reads and writes only there/),
        });
      }
    });

    it("may be anywhere from a person's terminal", async () => {
      const body = path.join(outside, "body.json");
      writeFileSync(body, '{"value":"eu"}');
      const before = server.state.requests.length;
      expect((await api(["set_variable", "name=region", "--body", `@${body}`])).code).toBe(0);
      expect(changes(before)).toHaveLength(1);
      const output = path.join(outside, "variables.json");
      expect((await api(["list_variables", "--output", output])).code).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8"))).toHaveProperty("items");
    });
  });

  describe("a body field the instance marks as a secret value", () => {
    const updateModel = (body: Record<string, unknown>) => ["update_model", `model_registry_id=${server.state.models[0]!.id}`, "--body", JSON.stringify(body)];
    // The snapshot marks ModelUpdateRequest.api_key, as a recent instance does.
    const mark = () => {
      server.state.models.push(modelRow(tenant, { model_id: "llama-70b", base_url: "http://vllm:8000/v1" }));
    };

    it("is refused over MCP before anything is sent, with or without confirm; an unmarked field passes", async () => {
      mark();
      const client = await mcp();
      const id = server.state.models[0]!.id;
      const before = server.state.requests.length;
      for (const confirm of [false, true]) {
        const refused = await tool(client, { operation: "update_model", params: [`model_registry_id=${id}`], body: '{"display_name":"Llama","api_key":"sk-agent"}', confirm });
        expect(refused.isError).toBe(true);
        expect(refused.body.error).toMatchObject({
          code: "secret_field_for_a_person",
          exit_code: 5,
          message: expect.stringMatching(/^The request to update_model sets "api_key", which the instance marks as a secret value \(x-cavelon-secret\); .*no tool sends it/),
          hint: expect.stringMatching(/cavelon secrets set <name>.*Admin/),
          details: { fields: ["api_key"] },
        });
        expect(JSON.stringify(refused.body)).not.toContain("sk-agent");
      }
      // Clearing the key carries no value.
      expect((await tool(client, { operation: "update_model", params: [`model_registry_id=${id}`], body: '{"api_key":null}' })).body).toMatchObject({ sent: false });
      const preview = await tool(client, { operation: "update_model", params: [`model_registry_id=${id}`], body: '{"display_name":"Llama"}' });
      expect(preview.body).toMatchObject({ sent: false, body: { display_name: "Llama" }, confirm_token: expect.stringMatching(/^[0-9a-f]{12}$/) });
      expect(changes(before)).toEqual([]);
      const confirm = preview.body.confirm_token as string;
      expect((await tool(client, { operation: "update_model", params: [`model_registry_id=${id}`], body: '{"display_name":"Llama"}', confirm })).isError).toBe(false);
      expect(changes(before)).toEqual([expect.objectContaining({ method: "PATCH", body: { display_name: "Llama" } })]);
    });

    it("is refused from an agent's shell and sent from a person's terminal", async () => {
      mark();
      const before = server.state.requests.length;
      const refused = await api(updateModel({ api_key: "sk-agent" }), AGENT);
      expect(refused.code).toBe(5);
      expect(refused.json<{ error: Record<string, unknown> }>().error).toMatchObject({
        code: "secret_field_for_a_person",
        message: expect.stringMatching(/cavelon api does not send it when a coding agent runs it \(CLAUDECODE is set\)/),
      });
      expect(changes(before)).toEqual([]);
      expect((await api(updateModel({ api_key: "sk-person" }))).code).toBe(0);
      expect(changes(before)).toEqual([expect.objectContaining({ method: "PATCH", body: { api_key: "sk-person" } })]);
    });

    it("is an ordinary field on an instance whose document marks none", async () => {
      server.state.secretFields = null;
      server.state.models.push(modelRow(tenant, { model_id: "llama-70b", base_url: "http://vllm:8000/v1" }));
      const client = await mcp();
      const preview = await tool(client, { operation: "update_model", params: [`model_registry_id=${server.state.models[0]!.id}`], body: '{"api_key":"sk"}' });
      expect(preview.isError).toBe(false);
      expect(preview.body).toMatchObject({ sent: false, body: { api_key: "sk" } });
    });
  });
});
