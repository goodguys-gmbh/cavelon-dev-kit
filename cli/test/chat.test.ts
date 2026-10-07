import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { COMMANDS } from "../src/commands/index.js";
import type { InStream } from "../src/io.js";
import { createMcpServer } from "../src/mcp.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { askingClient, cli, login, sandbox, type PersonAtClient, type Sandbox } from "./helpers.js";

/**
 * Trying a solution that is not the tenant's default route, taking an active
 * one out of service, and init creating the solution it is given (but never
 * as an MCP tool).
 */

let server: FakeServer;
let sb: Sandbox;
let tenant: string;
let dirCount = 0;

const solution = (slug: string) => server.state.harnesses.find((h) => h.tenant_id === tenant && h.slug === slug)!;

async function initSolution(harness = "support"): Promise<string> {
  const dir = path.join(sb.home, `solution-${++dirCount}`);
  mkdirSync(dir, { recursive: true });
  const result = await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--harness", harness], { cwd: dir });
  expect(result.code, result.stderr + result.stdout).toBe(0);
  return dir;
}

function mcpClient(dir: string, env = sb.env, person?: PersonAtClient) {
  const mcp = createMcpServer(
    {
      stdout: { write: () => true },
      stderr: { write: () => true },
      stdin: Readable.from([]) as unknown as InStream,
      env,
      cwd: dir,
      now: () => new Date(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
    COMMANDS,
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = askingClient({ person });
  return {
    asked: client.asked,
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
  for (const [slug, name] of [["default", "Default"], ["support", "Support"]]) await cli(sb, ["harness", "new", slug!, "--name", name!]);
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  for (const h of server.state.harnesses) if (h.tenant_id === tenant) [h.status, h.is_default] = [h.slug === "default" ? "active" : h.status, h.slug === "default"];
  server.state.chats.length = 0;
  server.state.openapiWithout = [];
});

describe("chat", () => {
  it("answers with the solution it names, a draft too for a person, and continues by session", async () => {
    const result = await cli(sb, ["chat", "When are you open?", "--harness", "Support"]);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`^Support \\(support\\) answered:\\nSupport answers: When are you open\\?\\n\\nsession: +(\\S+) {3}continue with: cavelon chat <message> --session \\1\\nconversation_id: +(\\S+) {3}its traces: cavelon trace \\2 --kind conversation\\n$`));
    expect(server.state.chats).toEqual([{ harness_id: solution("support").id, message: "When are you open?", session_id: expect.any(String) }]);

    const first = await cli(sb, ["chat", "Hello", "--harness", "support", "--json"]);
    const data = first.json<{ harness: { slug: string; status: string }; response: string; session_id: string; conversation_id: string; next: { continue: string; trace: string } }>();
    expect(data).toMatchObject({ harness: { slug: "support", status: "draft" }, response: "Support answers: Hello" });
    const next = await cli(sb, ["chat", "And on Saturdays?", "--harness", "support", "--session", data.session_id, "--json"]);
    expect(next.json<{ session_id: string }>().session_id).toBe(data.session_id);
    const sent = server.state.requests.filter((r) => r.path === "/api/v1/chat").pop()!.body;
    // Not streamed, and no source: the instance records a person's turn on a draft as a Playground run.
    expect(sent).toEqual({ message: "And on Saturdays?", stream: false, harness_id: solution("support").id, session_id: data.session_id });
  });

  it("takes the folder's solution, else the tenant's default route, and says what to do when nothing answers there", async () => {
    const dir = await initSolution();
    await cli(sb, ["chat", "Hi"], { cwd: dir });
    expect(server.state.chats.pop()!.harness_id).toBe(solution("support").id);

    const outside = await cli(sb, ["chat", "Hi", "--json"]);
    expect(outside.json<{ harness: unknown; response: string }>()).toMatchObject({ harness: null, response: "Default answers: Hi" });
    expect(server.state.requests.filter((r) => r.path === "/api/v1/chat").pop()!.body).not.toHaveProperty("harness_id");

    solution("default").status = "draft";
    const notLive = await cli(sb, ["chat", "Hi", "--json"]);
    expect(notLive.code).toBe(4);
    expect(notLive.json<{ error: { hint: string } }>().error.hint).toMatch(/^Nothing answers on the tenant's default route yet: name a solution with --harness/);

    const missing = await cli(sb, ["chat", "Hi", "--harness", "suport", "--json"]);
    expect(missing.code).toBe(1);
    expect(missing.json<{ error: { code: string; hint: string } }>().error).toMatchObject({ code: "solution_not_found", hint: expect.stringContaining("cavelon chat <message> --harness support") });
  });

  it("a draft refuses a tenant API key, with the reason", async () => {
    const keyed = sandbox();
    await login(keyed, server.url, server.addToken({ kind: "key", tenantIds: [tenant] }));
    const refused = await cli(keyed, ["chat", "Hi", "--harness", "support", "--json"]);
    expect(refused.code).toBe(4);
    expect(refused.json<{ error: { hint: string } }>().error.hint).toMatch(/Support \(support\) is draft: a draft answers only a person's token/);
  });
});

describe("deactivate", () => {
  it("previews, deactivates only with --confirm (status inactive), and leaves an inactive one alone", async () => {
    solution("support").status = "active";
    const preview = await cli(sb, ["deactivate", "--harness", "support"]);
    expect(preview.code, preview.stderr).toBe(0);
    expect(preview.stdout).toMatch(/^Deactivating Support \(support\) sets it inactive and takes it out of live traffic/);
    expect(preview.stdout).toContain("Show this to a person; with their yes: cavelon deactivate --harness support --confirm");
    expect(solution("support").status).toBe("active");

    const done = await cli(sb, ["deactivate", "--harness", "support", "--confirm", "--json"]);
    expect(done.code, done.stdout).toBe(0);
    expect(done.json()).toMatchObject({ changed: true, harness: { slug: "support", status: "inactive" } });
    expect(solution("support").status).toBe("inactive");

    const again = await cli(sb, ["deactivate", "--harness", "support", "--json"]);
    expect(again.json()).toMatchObject({ changed: false, harness: { status: "inactive" } });
  });

  it("in a coding agent's shell, never deactivates: the person confirms in their own terminal", async () => {
    solution("support").status = "active";
    const agent = { env: { CLAUDECODE: "1" } };
    const bare = await cli(sb, ["deactivate", "--harness", "support", "--confirm", "--json"], agent);
    expect(bare.code).toBe(5);
    const shown = bare.json<Record<string, unknown>>();
    expect(shown).toMatchObject({
      changed: false,
      needs_person: "terminal",
      confirm: "cavelon deactivate --harness support --confirm (the person runs it in their own terminal: a coding agent cannot confirm this change)",
    });
    expect(shown.confirm_token).toBeUndefined();
    // The token an MCP preview hands out does not get an agent's shell past the person either.
    const mcp = mcpClient(sb.home);
    const token = (await mcp.call("deactivate", { harness: "support" })).body.confirm_token as string;
    await mcp.close();
    const refused = await cli(sb, ["deactivate", "--harness", "support", "--confirm", token, "--json"], agent);
    expect(refused.code).toBe(5);
    expect(refused.json<{ error: Record<string, unknown> }>().error).toMatchObject({
      code: "confirm_needs_person",
      details: { person_command: "cavelon deactivate --harness support --confirm" },
    });
    expect(solution("support").status).toBe("active");
    const person = await cli(sb, ["deactivate", "--harness", "support", "--confirm", "--json"]);
    expect(person.code, person.stdout).toBe(0);
    expect(solution("support").status).toBe("inactive");
  });

  it("refuses the tenant's default route before sending anything", async () => {
    server.state.requests.length = 0;
    const refused = await cli(sb, ["deactivate", "--harness", "default", "--confirm", "--json"]);
    expect(refused.code).toBe(5);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe("default_route_deactivate");
    expect(server.state.requests.filter((r) => r.method === "POST")).toEqual([]);
    expect(solution("default").status).toBe("active");
  });

  it("says so on an instance that publishes no deactivate route", async () => {
    server.state.openapiWithout = ["POST /api/v1/harnesses/{harness_id}/deactivate"];
    const older = sandbox();
    await login(older, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
    solution("support").status = "active";
    const result = await cli(older, ["deactivate", "--harness", "support", "--confirm", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json<{ error: { code: string; hint: string } }>().error).toMatchObject({ code: "operation_unavailable", hint: expect.stringMatching(/^A person deactivates it in the Admin/) });
    expect(solution("support").status).toBe("active");
  });

  it("over MCP, confirms only with its own preview's confirm_token and the person's yes in the client", async () => {
    solution("support").status = "active";
    const mcp = mcpClient(sb.home);
    try {
      const bare = await mcp.call("deactivate", { harness: "support", confirm: true });
      expect(bare.body.error).toMatchObject({ code: "confirm_token_required" });
      const shown = await mcp.call("deactivate", { harness: "support" });
      expect(shown.body).toMatchObject({ changed: false, needs_person: "client", confirm_token: expect.stringMatching(/^[0-9a-f]{12}$/) });
      expect(mcp.asked).toEqual([]);
      expect(solution("support").status).toBe("active");
      const done = await mcp.call("deactivate", { harness: "support", confirm: shown.body.confirm_token });
      expect(done.body).toMatchObject({ changed: true });
      expect(mcp.asked).toEqual([expect.stringMatching(/^Deactivate Support \(support\): it goes inactive and out of live traffic\.\n.*acme/)]);
      expect(solution("support").status).toBe("inactive");
    } finally {
      await mcp.close();
    }
  });

  it("over MCP, changes nothing when the person declines, or when the client cannot ask them", async () => {
    solution("support").status = "active";
    const declines = mcpClient(sb.home, sb.env, "declines");
    try {
      const token = (await declines.call("deactivate", { harness: "support" })).body.confirm_token;
      const refused = await declines.call("deactivate", { harness: "support", confirm: token });
      expect(refused.isError).toBe(true);
      expect(refused.body.error).toMatchObject({ code: "confirm_declined", details: { answer: "declined" } });
      expect(declines.asked).toHaveLength(1);
      expect(solution("support").status).toBe("active");
    } finally {
      await declines.close();
    }
    const cannot = mcpClient(sb.home, sb.env, "cannot ask");
    try {
      const shown = await cannot.call("deactivate", { harness: "support" });
      expect(shown.body).toMatchObject({ needs_person: "terminal", confirm: expect.stringMatching(/^cavelon deactivate --harness support --confirm \(the person runs it in their own terminal/) });
      // An agent that works the token out is refused all the same, and told the person's command.
      const declined = mcpClient(sb.home);
      const token = (await declined.call("deactivate", { harness: "support" })).body.confirm_token;
      await declined.close();
      const refused = await cannot.call("deactivate", { harness: "support", confirm: token });
      expect(refused.body.error).toMatchObject({ code: "confirm_needs_person", exit_code: 5, details: { person_command: "cavelon deactivate --harness support --confirm" } });
      expect(solution("support").status).toBe("active");
    } finally {
      await cannot.close();
    }
  });
});

describe("init creates the solution it is given", () => {
  it("as the MCP tool it never creates one, and names the call that does", async () => {
    const dir = path.join(sb.home, `solution-${++dirCount}`);
    mkdirSync(dir, { recursive: true });
    const mcp = mcpClient(dir);
    try {
      const result = await mcp.call("init", { tenant, harness: "Order Status" });
      expect(result.isError, JSON.stringify(result.body)).toBe(false);
      // Tool calls, in the order that works: the draft, its manifest, the files, the preview.
      expect(result.body.next.slice(0, 4)).toEqual([
        'Solution order-status is not on the instance yet: create it as a draft with harness_new {"slug":"order-status","name":"Order Status"}.',
        "Bring the draft into package/ (its manifest): pull {}",
        "Write the package files in package/, then: validate {}",
        'Preview it on the instance: apply {"env":"test"}',
      ]);
      expect(server.state.harnesses.find((h) => h.slug === "order-status")).toBeUndefined();
      expect(parse(readFileSync(path.join(dir, "cavelon.yaml"), "utf8"))).toMatchObject({ harness: "order-status" });
    } finally {
      await mcp.close();
    }
  });
});

describe("printed commands keep the tenant given on the command line", () => {
  it("in a miss's hint, and in the init that a command outside a solution folder names", async () => {
    const other = server.addTenant("globex", "Globex");
    const box = sandbox();
    try {
      // The stored login points at acme; the commands name globex.
      await login(box, server.url, server.addToken({ kind: "pat", tenantIds: [tenant, other], defaultTenant: tenant }));
      await cli(box, ["harness", "new", "orders", "--name", "Orders", "--tenant", "globex"]);
      const miss = await cli(box, ["deactivate", "--harness", "order", "--tenant", "globex", "--json"]);
      expect(miss.code).toBe(1);
      const hint = miss.json<{ error: { hint: string } }>().error.hint;
      expect(hint).toContain("cavelon deactivate --harness orders --tenant globex");
      expect(hint).toContain("`cavelon harness new <slug> --name <name> --tenant globex` creates one as a draft.");

      const outside = await cli(box, ["pull", "--tenant", "globex", "--harness", "orders", "--json"], { cwd: box.home });
      expect(outside.code).toBe(2);
      expect(outside.json<{ error: { code: string; hint: string } }>().error).toMatchObject({
        code: "no_solution",
        hint: expect.stringContaining("cavelon init --harness orders --tenant globex, then run this command again"),
      });
      // From the stored login's tenant nothing needs adding.
      const plain = await cli(box, ["pull", "--json"], { cwd: box.home });
      expect(plain.json<{ error: { hint: string } }>().error.hint).not.toContain("--tenant");
    } finally {
      box.cleanup();
    }
  });
});
