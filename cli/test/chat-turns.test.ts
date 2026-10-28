import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { COMMANDS } from "../src/commands/index.js";
import type { InStream } from "../src/io.js";
import { createMcpServer } from "../src/mcp.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { askingClient, cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * A chat turn as the instance ends it: one that is not answered in time goes
 * on and is found by its session, a status the response carries is shown, a
 * file is attached to the turn's conversation, and a draft is tried with
 * preview_draft. Each on an instance that publishes the field and one that
 * does not. Also the solution's settings.attached_documents in validate.
 */

let server: FakeServer;
let sb: Sandbox;
let tenant: string;
let dirCount = 0;

type ErrorBody = { error: { code: string; message: string; hint: string; exit_code?: number; details?: Record<string, unknown> } };
const solution = (slug: string) => server.state.harnesses.find((h) => h.tenant_id === tenant && h.slug === slug)!;
const chatPosts = () => server.state.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/chat");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A login of its own: the kit caches an instance's OpenAPI, so an older instance is played to a fresh cache. */
async function fresh(kind: "pat" | "key" = "pat"): Promise<Sandbox> {
  const box = sandbox();
  await login(box, server.url, server.addToken(kind === "pat" ? { kind, tenantIds: [tenant], defaultTenant: tenant } : { kind, tenantIds: [tenant] }));
  return box;
}

async function folder(box = sb): Promise<string> {
  const dir = path.join(box.home, `solution-${++dirCount}`);
  mkdirSync(dir, { recursive: true });
  const init = await cli(box, ["init", "--instance", server.url, "--tenant", tenant, "--harness", "support"], { cwd: dir });
  expect(init.code, init.stderr + init.stdout).toBe(0);
  return dir;
}

function mcpClient(dir: string) {
  const mcp = createMcpServer(
    {
      stdout: { write: () => true },
      stderr: { write: () => true },
      stdin: Readable.from([]) as unknown as InStream,
      env: sb.env,
      cwd: dir,
      now: () => new Date(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
    COMMANDS,
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = askingClient({});
  return {
    async call(name: string, args: Record<string, unknown>) {
      if (!client.transport) {
        await mcp.connect(serverSide);
        await client.connect(clientSide);
      }
      const result = await client.callTool({ name, arguments: args });
      return { isError: Boolean(result.isError), body: JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, any> };
    },
    close: () => client.close(),
  };
}

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, mayActivate: true }));
  await cli(sb, ["harness", "new", "support", "--name", "Support"]);
});

afterAll(async () => {
  sb.cleanup();
  await server.close();
});

beforeEach(() => {
  solution("support").status = "active";
  Object.assign(server.state, { chatDelayMs: 0, chatStatus: "completed", chatTurnFields: true, openapiWithout: [], packageSchemaEdit: null });
  server.state.chats.length = 0;
  server.state.chatFiles.length = 0;
  server.state.requests.length = 0;
});

describe("a turn that is not answered in time", () => {
  it("sends the first turn with a session the kit chose", async () => {
    const result = await cli(sb, ["chat", "Hi", "--harness", "support", "--json"]);
    expect(result.code, result.stdout).toBe(0);
    const sent = chatPosts()[0]!.body as { session_id: string };
    expect(sent.session_id).toMatch(UUID);
    expect(result.json<{ session_id: string }>().session_id).toBe(sent.session_id);
  });

  it("says the turn goes on, names its conversation and how to read it, and never says retry", async () => {
    server.state.chatDelayMs = 2_500;
    const result = await cli(sb, ["chat", "Hi", "--harness", "support", "--timeout", "500ms", "--json"]);
    expect(result.code, result.stdout).toBe(6);
    const { error } = result.json<ErrorBody>();
    const sent = chatPosts()[0]!.body as { session_id: string };
    const conversation = server.state.chatConversations.find((c) => c.session_id === sent.session_id)!;
    expect(error).toMatchObject({ code: "chat_turn_timeout", details: { sent: true, session_id: sent.session_id, conversation_id: conversation.id } });
    expect(error.message).toMatch(/goes on on the instance, which stores its answer; sending the message again would run it twice/);
    expect(error.hint).toContain(`cavelon api get_conversation --param conversation_id=${conversation.id}`);
    expect(error.hint).toContain(`cavelon chat <message> --session ${sent.session_id}`);
    expect(`${error.message} ${error.hint}`).not.toMatch(/retry/i);
    // The conversation the hint names is the one the instance reads back.
    const read = await cli(sb, ["api", "get_conversation", "-p", `conversation_id=${conversation.id}`, "--json"]);
    expect(read.code, read.stdout).toBe(0);
    const explained = await cli(sb, ["explain", "chat_turn_timeout", "--json"]);
    expect(explained.stdout).not.toMatch(/retry/i);
  });

  it("names the session to find it by where the instance does not list conversations", async () => {
    server.state.chatDelayMs = 2_500;
    server.state.openapiWithout = ["GET /api/v1/conversations"];
    const older = await fresh();
    const result = await cli(older, ["chat", "Hi", "--harness", "support", "--timeout", "500ms", "--json"]);
    older.cleanup();
    expect(result.code).toBe(6);
    const { error } = result.json<ErrorBody>();
    const sent = chatPosts()[0]!.body as { session_id: string };
    expect(error.details).not.toHaveProperty("conversation_id");
    expect(error.hint).toContain(`Find its conversation by session_id ${sent.session_id}`);
    // Quoted for the shell it runs in: '…' on POSIX, "…" on Windows.
    expect(error.hint).toMatch(/cavelon api get_conversation --param ['"]conversation_id=<conversation_id>['"]/);
  });

  it("over MCP, answers within the tool's wait with the same guidance", async () => {
    server.state.chatDelayMs = 2_500;
    const mcp = mcpClient(sb.home);
    try {
      const result = await mcp.call("chat", { message: "Hi", harness: "support", timeout: "500ms" });
      expect(result.isError).toBe(true);
      expect(result.body.error).toMatchObject({ code: "chat_turn_timeout", exit_code: 6 });
      expect(result.body.error.hint).toMatch(/`api \{"operation":"get_conversation","param":\["conversation_id=[0-9a-f-]{36}"\]\}`/);
    } finally {
      await mcp.close();
    }
  });
});

describe("the turn's status", () => {
  it("reads cancelled for a cancelled turn, exits 1, and never prints (no text)", async () => {
    server.state.chatStatus = "cancelled";
    const result = await cli(sb, ["chat", "Hi", "--harness", "support"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^Support \(support\) did not answer: the turn was cancelled\. The message is stored, without an answer\.\n\nsession:/);
    expect(result.stdout).not.toContain("(no text)");
    const json = await cli(sb, ["chat", "Hi", "--harness", "support", "--json"]);
    expect(json.json<{ status: string }>().status).toBe("cancelled");
  });

  it("shows waiting and blocked with the answer, and an answered turn as before", async () => {
    server.state.chatStatus = "blocked";
    const blocked = await cli(sb, ["chat", "Hi", "--harness", "support"]);
    expect(blocked.code).toBe(0);
    expect(blocked.stdout).toMatch(/^Support \(support\) blocked the turn \(status blocked\):\nSupport answers: Hi\n/);
    server.state.chatStatus = "waiting";
    expect((await cli(sb, ["chat", "Hi", "--harness", "support"])).stdout).toMatch(/^Support \(support\) is waiting \(status waiting\)/);
    server.state.chatStatus = "completed";
    expect((await cli(sb, ["chat", "Hi", "--harness", "support"])).stdout).toMatch(/^Support \(support\) answered:\nSupport answers: Hi\n/);
    // An older instance sends no status: an answered turn.
    server.state.chatTurnFields = false;
    const older = await fresh();
    expect((await cli(older, ["chat", "Hi", "--harness", "support"])).stdout).toMatch(/^Support \(support\) answered:\nSupport answers: Hi\n/);
  });
});

describe("a turn a recent instance reports with status null", () => {
  it("says the turn did not complete, shows the instance's message and the limit, and exits 1", async () => {
    server.state.chatStatus = null;
    const result = await cli(sb, ["chat", "Hi", "--harness", "support"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^Support \(support\) did not complete the turn \(status null\): it failed or was refused\. The instance says:\nToo many messages; try again in a minute\.\nlimit: \{"code":"RATE_LIMIT_EXCEEDED"/);
    const json = await cli(sb, ["chat", "Hi", "--harness", "support", "--json"]);
    expect(json.code).toBe(1);
    expect(json.json<Record<string, unknown>>()).toHaveProperty("status", null);
  });

  it("is told apart from an older instance, which sends no status for an answered turn", async () => {
    server.state.chatStatus = null;
    server.state.chatTurnFields = false;
    const older = await fresh();
    try {
      const result = await cli(older, ["chat", "Hi", "--harness", "support", "--json"]);
      expect(result.code, result.stdout).toBe(0);
      expect(result.json<Record<string, unknown>>()).not.toHaveProperty("status");
    } finally {
      older.cleanup();
    }
  });
});

describe("chat --file", () => {
  it("uploads each file to the turn's conversation by its session and names them in file_ids", async () => {
    const dir = await folder();
    writeFileSync(path.join(dir, "invoice.txt"), "Invoice 42");
    writeFileSync(path.join(dir, "terms.txt"), "Terms");
    const result = await cli(sb, ["chat", "What does it say?", "--file", "invoice.txt", "--file", "terms.txt"], { cwd: dir });
    expect(result.code, result.stderr + result.stdout).toBe(0);
    const sent = chatPosts()[0]!.body as { session_id: string; file_ids: string[] };
    expect(server.state.chatFiles).toEqual([
      expect.objectContaining({ filename: "invoice.txt", scope: "conversation", session_id: sent.session_id, size_bytes: 10 }),
      expect.objectContaining({ filename: "terms.txt", scope: "conversation", session_id: sent.session_id }),
    ]);
    expect(sent.file_ids).toEqual(server.state.chatFiles.map((f) => f.file_id));
    expect(result.stdout).toMatch(new RegExp(`^Attached invoice\\.txt \\(${server.state.chatFiles[0]!.file_id}, processing\\)\\.\\nAttached terms\\.txt`));
  });

  it("over MCP, refuses a file outside the solution folder before sending anything", async () => {
    const dir = await folder();
    writeFileSync(path.join(sb.home, "outside.txt"), "secret");
    const mcp = mcpClient(dir);
    try {
      const result = await mcp.call("chat", { message: "Hi", file: ["../outside.txt"] });
      expect(result.body.error).toMatchObject({ code: "path_outside_solution" });
    } finally {
      await mcp.close();
    }
    expect(server.state.requests.filter((r) => r.method === "POST")).toEqual([]);
  });

  it("says so, and sends nothing, on an instance without the chat file upload", async () => {
    const dir = await folder();
    writeFileSync(path.join(dir, "invoice.txt"), "Invoice 42");
    server.state.openapiWithout = ["POST /api/v1/chat/files"];
    const older = await fresh();
    const result = await cli(older, ["chat", "Hi", "--file", "invoice.txt", "--json"], { cwd: dir });
    older.cleanup();
    expect(result.code).toBe(1);
    expect(result.json<ErrorBody>().error.code).toBe("operation_unavailable");
    expect(server.state.requests.filter((r) => r.method === "POST")).toEqual([]);
  });
});

describe("chat --draft", () => {
  it("sends preview_draft to try the draft's settings on an active solution", async () => {
    const result = await cli(sb, ["chat", "Hi", "--harness", "support", "--draft", "--json"]);
    expect(result.code, result.stdout).toBe(0);
    expect(chatPosts()[0]!.body).toMatchObject({ preview_draft: true, harness_id: solution("support").id });
    expect(result.json<{ draft: boolean }>().draft).toBe(true);
  });

  it("is refused before sending on an instance without preview_draft, and for a tenant API key", async () => {
    server.state.chatTurnFields = false;
    const box = await fresh();
    const older = await cli(box, ["chat", "Hi", "--harness", "support", "--draft", "--json"]);
    box.cleanup();
    expect(older.code).toBe(1);
    expect(older.json<ErrorBody>().error).toMatchObject({ code: "operation_unavailable", details: { sent: false } });
    server.state.chatTurnFields = true;
    const keyed = await fresh("key");
    try {
      const refused = await cli(keyed, ["chat", "Hi", "--harness", "support", "--draft", "--json"]);
      expect(refused.code).toBe(7);
      expect(refused.json<ErrorBody>().error.message).toMatch(/^A tenant API key cannot chat with a solution's draft/);
    } finally {
      keyed.cleanup();
    }
    expect(chatPosts()).toEqual([]);
  });
});

describe("validate: settings.attached_documents", () => {
  type Found = { code: string; severity: string; path: string; message: string };

  async function validated(box: Sandbox, value: unknown): Promise<Found[]> {
    const dir = await folder(box);
    const pull = await cli(box, ["pull"], { cwd: dir });
    expect(pull.code, pull.stderr + pull.stdout).toBe(0);
    const file = path.join(dir, "package", "harnesses.yaml");
    const harnesses = parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
    harnesses[0]!.settings = { ...(harnesses[0]!.settings as object), attached_documents: value };
    writeFileSync(file, stringify(harnesses));
    const result = await cli(box, ["validate", "--offline", "--json"], { cwd: dir });
    return result.json<{ findings: Found[] }>().findings.filter((f) => f.path.includes("attached_documents"));
  }

  it("warns about a value the instance ignores or clamps, with the bounds the schema publishes", async () => {
    const found = await validated(sb, { wait_until_readable: "false", wait_seconds: 300 });
    expect(found).toEqual([
      expect.objectContaining({ code: "attached_documents_value_ignored", severity: "warning", message: expect.stringMatching(/^wait_until_readable is "false", not true or false: only false turns the wait off/) }),
      expect.objectContaining({ code: "attached_documents_wait_clamped", severity: "warning", message: expect.stringMatching(/^wait_seconds is 300, outside 0–120: .* waits 120 seconds instead\.$/) }),
    ]);
    const ignored = await validated(sb, { wait_seconds: "soon" });
    expect(ignored).toEqual([expect.objectContaining({ code: "attached_documents_value_ignored", message: expect.stringMatching(/the platform default/) })]);
    expect(await validated(sb, { wait_until_readable: false, wait_seconds: 30 })).toEqual([]);
  });

  it("is left out of a pulled or formatted solution that does not set it, and kept as written where it does", async () => {
    const dir = await folder();
    expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
    const file = path.join(dir, "package", "harnesses.yaml");
    expect(readFileSync(file, "utf8")).not.toContain("attached_documents");
    const harnesses = parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
    const settingsAfterFmt = async (settings: Record<string, unknown>) => {
      harnesses[0]!.settings = settings;
      writeFileSync(file, stringify(harnesses));
      const fmt = await cli(sb, ["fmt"], { cwd: dir });
      expect(fmt.code, fmt.stderr + fmt.stdout).toBe(0);
      return (parse(readFileSync(file, "utf8")) as Array<{ settings: Record<string, unknown> }>)[0]!.settings;
    };
    // Another key of the open map: the export would not add the setting, so fmt does not either.
    expect(await settingsAfterFmt({ answer_grounding: { mode: "strict" } })).toEqual({ answer_grounding: { mode: "strict" } });
    expect(await settingsAfterFmt({ attached_documents: { wait_seconds: 30 } })).toEqual({ attached_documents: { wait_until_readable: true, wait_seconds: 30 } });
  });

  it("says nothing where the instance's package schema does not describe the setting", async () => {
    // As an older instance publishes it: an open map that describes no key.
    server.state.packageSchemaEdit = (schema) => {
      const defs = (schema as unknown as { $defs: Record<string, { properties: Record<string, Record<string, unknown>> }> }).$defs;
      defs.PackageHarness!.properties.settings = { additionalProperties: true, title: "Settings", type: "object" };
    };
    const older = await fresh();
    try {
      expect(await validated(older, { wait_until_readable: "false", wait_seconds: 300 })).toEqual([]);
    } finally {
      older.cleanup();
    }
  });
});
