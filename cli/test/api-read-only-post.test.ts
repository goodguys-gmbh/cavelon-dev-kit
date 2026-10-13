import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { OpenApiDoc } from "../src/contracts.js";
import { COMMANDS } from "../src/commands/index.js";
import type { InStream } from "../src/io.js";
import { createMcpServer } from "../src/mcp.js";
import { operations } from "../src/openapi.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { askingClient, cli, login, sandbox } from "./helpers.js";

const route = "/api/v1/knowledge-bases/{kb_id}/search";
const searchOperation = (marker: unknown, extra = {}) => ({
  operationId: "search_knowledge_base_api_v1_knowledge_bases__kb_id__search_post",
  "x-cavelon-read-only": marker,
  parameters: [{ name: "kb_id", in: "path", required: true, schema: { type: "string" } }],
  requestBody: { required: true, content: { "application/json": { schema: {
    type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false,
  } } } },
  responses: { "200": { description: "Ranked chunks" } }, ...extra,
});

it.each([undefined, false, "true", true])("classifies only an explicit read-only POST marker (%s)", marker => {
  const doc = { paths: { [route]: { post: searchOperation(marker) } } } as unknown as OpenApiDoc;
  expect(operations(doc)[0]!.readOnly).toBe(marker === true);
});

it.each([{ "x-cavelon-confirmation": "required" }, { "x-cavelon-person-only": true }])("keeps explicit instance guards over a read-only hint (%s)", guard => {
  const doc = { paths: { [route]: { post: searchOperation(true, guard) } } } as unknown as OpenApiDoc;
  expect(operations(doc)[0]!.readOnly).toBe(false);
});

let fake: FakeServer, proxy: http.Server, url: string, tenant: string, searches = 0;
beforeAll(async () => {
  fake = await startFakeServer(); tenant = fake.addTenant("acme", "Acme");
  proxy = http.createServer(async (req, res) => {
    const pathname = new URL(req.url!, "http://localhost").pathname;
    if (req.method === "POST" && pathname === "/api/v1/knowledge-bases/notes/search") {
      searches++; req.resume(); res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ chunks: [], query: "hello" })); return;
    }
    const body: Buffer[] = [];
    for await (const chunk of req) body.push(Buffer.from(chunk));
    const upstream = await fetch(fake.url + req.url, {
      method: req.method, headers: req.headers as Record<string, string>,
      ...(body.length ? { body: Buffer.concat(body) } : {}),
    });
    res.statusCode = upstream.status; res.setHeader("content-type", "application/json");
    if (pathname === "/openapi.json" || pathname === "/api/v1/openapi.json") {
      const doc = await upstream.json() as any;
      doc.paths[route] = { post: searchOperation(true) }; res.end(JSON.stringify(doc));
    } else res.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => proxy.close(() => resolve())); await fake.close(); });

it("describes and executes a published read-only POST through CLI and MCP without approval, while refusing stale confirms", async () => {
  const sb = sandbox();
  const client = askingClient();
  try {
    await login(sb, url, fake.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
    const described = await cli(sb, ["api", "describe", "search_knowledge_base", "--json"]);
    expect(described.code, described.stdout).toBe(0);
    expect(described.json()).toMatchObject({ read_only: true });
    const args = ["api", "search_knowledge_base", "kb_id=notes", "--body", '{"query":"hello"}', "--json"];
    const done = await cli(sb, args, { env: { CLAUDECODE: "1" } });
    expect(done.code, done.stdout).toBe(0);
    expect(done.json()).toMatchObject({ chunks: [], query: "hello" });
    const mcp = createMcpServer({
      stdout: { write: () => true }, stderr: { write: () => true },
      stdin: Readable.from([]) as unknown as InStream, env: sb.env, cwd: sb.home,
      now: () => new Date(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    }, COMMANDS);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide); await client.connect(clientSide);
    const input = { operation: "search_knowledge_base", params: ["kb_id=notes"], body: '{"query":"hello"}' };
    const result = await client.callTool({ name: "api", arguments: input });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ chunks: [] });
    expect(client.asked).toEqual([]); expect(searches).toBe(2);
    const stale = await client.callTool({ name: "api", arguments: { ...input, confirm: "000000000000" } });
    expect(JSON.parse((stale.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ token_mismatch: true, sent: false });
    expect(searches).toBe(2);
  } finally { await client.close(); sb.cleanup(); }
});
