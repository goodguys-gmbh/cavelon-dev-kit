import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Readable } from "node:stream";
import { afterAll, beforeAll, expect, it } from "vitest";
import { COMMANDS } from "../src/commands/index.js";
import type { InStream } from "../src/io.js";
import { createMcpServer } from "../src/mcp.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { askingClient, cli, login, sandbox, type Sandbox } from "./helpers.js";

let server: FakeServer, sb: Sandbox, tenant: string;
beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, mayActivate: true }));
  for (const slug of ["default", "support"]) {
    const result = await cli(sb, ["harness", "new", slug, "--name", slug]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
  }
});
afterAll(async () => { sb.cleanup(); await server.close(); });

// Protocol responses are simulated; this does not qualify a desktop client's UI.
it.each(["error", "cancel", "missing answer", "decline", "false"] as const)("handles elicitation %s without inventing approval or a person refusal", async answer => {
  const harness = server.state.harnesses.find(h => h.tenant_id === tenant && h.slug === "support")!;
  harness.status = "active";
  const mcp = createMcpServer({
    stdout: { write: () => true }, stderr: { write: () => true },
    stdin: Readable.from([]) as unknown as InStream, env: sb.env, cwd: sb.home,
    now: () => new Date(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  }, COMMANDS);
  const client = askingClient();
  client.setRequestHandler(ElicitRequestSchema, async () => {
    if (answer === "error") throw new Error("Client cannot show forms");
    if (answer === "cancel") return { action: "cancel" };
    if (answer === "missing answer") return { action: "accept", content: {} };
    if (answer === "decline") return { action: "decline" };
    return { action: "accept", content: { approve: false } };
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide); await client.connect(clientSide);
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: "deactivate", arguments: { harness: "support", ...args } });
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  };
  try {
    const preview = await call({});
    expect(preview.needs_person).toBe("client");
    server.state.requests.length = 0;
    const result = await call({ confirm: preview.confirm_token });
    if (answer === "decline" || answer === "false") {
      expect(result.error).toMatchObject({ code: "confirm_declined", details: { answer: "declined" } });
      expect(result.error.message).toContain("MCP client returned an explicit decline");
    } else {
      expect(result.error).toMatchObject({ code: "confirm_needs_person", details: {
        needs_person: "terminal", person_command: "cavelon deactivate --harness support --confirm",
      } });
      expect(result.error.message).not.toContain("person did not approve");
    }
    expect(server.state.requests.filter(r => r.method === "POST")).toEqual([]);
    expect(harness.status).toBe("active");
    if (answer === "error" || answer === "missing answer") expect((await call({})).needs_person).toBe("terminal");
  } finally { await client.close(); }
});
