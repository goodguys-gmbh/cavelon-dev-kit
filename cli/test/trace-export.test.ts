import { createHash } from "node:crypto";
import { existsSync, readFileSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { COMMANDS } from "../src/commands/index.js";
import type { InStream, Io } from "../src/io.js";
import { createMcpServer } from "../src/mcp.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { askingClient, cli, login, sandbox, type Sandbox } from "./helpers.js";
let sb: Sandbox;
let server: FakeServer;
const route = "/api/v1/conversations/{conversation_id}/traces/{trace_id}/export";
const payload = '{\n  "trace": {"answer":"Grüße", "amount":1.00},\n  "manifest": {"schema":"chatflow.trace-export.v1", "signed":true, "trace_sha256":"recorded-by-instance", "signature":"server-only-hmac"}\n}\n';
const args = ["trace", "conversation-1", "--kind", "conversation", "--trace", "trace-1", "--export", "trace.json", "--json"];
const exporting = (output: string) => [...args.slice(0, -2), output, "--json"];
beforeEach(async () => {
  sb = sandbox(); sb.env.CAVELON_CONTRACT_TTL_SECONDS = "0"; server = await startFakeServer();
  const tenant = server.addTenant("acme");
  server.state.traceExports.set("conversation-1:trace-1", payload);
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
});
afterEach(async () => { sb.cleanup(); await server.close(); });
it("preserves export bytes and manifest without claiming signature verification", async () => {
  const result = await cli(sb, args);
  expect(result.code, result.stderr).toBe(0);
  expect(readFileSync(path.join(sb.home, "trace.json"))).toEqual(Buffer.from(payload));
  expect(result.json()).toMatchObject({ written: "trace.json", bytes: Buffer.byteLength(payload), file_sha256: createHash("sha256").update(payload).digest("hex"), manifest: JSON.parse(payload).manifest, signature_verified: false });
});
it.each(["missing-operation", "no-openapi"])("refuses %s without guessing or creating a file", async variant => {
  if (variant === "missing-operation") server.state.openapiWithout.push(`GET ${route}`);
  else server.state.serveOpenapi = false;
  const result = await cli(sb, args);
  expect(result.code).not.toBe(0); expect(result.stdout).toContain("operation_unavailable");
  expect(existsSync(path.join(sb.home, "trace.json"))).toBe(false);
  expect(server.state.requests.some(r => r.path.endsWith("/export"))).toBe(false);
});
it("preserves permission refusal and removes its own incomplete output", async () => {
  server.state.failures.push({ method: "GET", path: /\/traces\/.*\/export$/, status: 403, detail: "conversations.export required" });
  const result = await cli(sb, args);
  expect(result.code).not.toBe(0); expect(result.stdout).toContain("conversations.export required");
  expect(existsSync(path.join(sb.home, "trace.json"))).toBe(false);
});
it("requires explicit conversation and trace, rejects conflicting span", async () => {
  for (const tail of [["--export", "out.json"], ["--trace", "trace-1", "--export", "out.json"], ["--kind", "trigger", "--trace", "trace-1", "--export", "out.json"], ["--kind", "conversation", "--trace", "trace-1", "--span", "span-1", "--export", "out.json"]]) expect((await cli(sb, ["trace", "conversation-1", ...tail, "--json"])).code).not.toBe(0);
  expect(server.state.requests.some(r => r.path.includes("/traces/"))).toBe(false);
});
it("refuses existing files and confined paths before export", async () => {
  writeFileSync(path.join(sb.home, "trace.json"), "customer data");
  for (const output of ["trace.json", "../outside.json", "config/token.json"]) expect((await cli(sb, exporting(output))).code).not.toBe(0);
  expect(readFileSync(path.join(sb.home, "trace.json"), "utf8")).toBe("customer data");
  expect(server.state.requests.some(r => r.path.endsWith("/export"))).toBe(false);
});
it.skipIf(process.platform === "win32")("refuses a directory link outside the solution", async () => {
  const root = path.join(sb.home, "solution"); mkdirSync(root); symlinkSync(sb.home, path.join(root, "outside"), "dir");
  expect((await cli(sb, exporting("outside/escaped.json"), { cwd: root })).code).not.toBe(0);
  expect(existsSync(path.join(sb.home, "escaped.json"))).toBe(false);
});
it("removes malformed envelopes and preserves unsigned manifests", async () => {
  server.state.traceExports.set("conversation-1:trace-1", '{"trace":{},"manifest":null}');
  const result = await cli(sb, args);
  expect(result.code).not.toBe(0); expect(result.stdout).toContain("invalid_trace_export");
  expect(existsSync(path.join(sb.home, "trace.json"))).toBe(false);
  const unsigned = payload.replace('"signed":true', '"signed":false');
  server.state.traceExports.set("conversation-1:trace-1", unsigned);
  expect((await cli(sb, args)).json()).toMatchObject({ manifest: { signed: false }, signature_verified: false });
  expect(readFileSync(path.join(sb.home, "trace.json"), "utf8")).toBe(unsigned);
});
it("offers the same confined export through the read-only MCP trace tool", async () => {
  const io: Io = { stdout: { write: () => true }, stderr: { write: () => true }, stdin: Readable.from([]) as unknown as InStream, env: sb.env, cwd: sb.home, now: () => new Date(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = createMcpServer(io, COMMANDS); const client = askingClient();
  await mcp.connect(serverSide); await client.connect(clientSide);
  try {
    expect((await client.listTools()).tools.find(t => t.name === "trace")?.annotations?.readOnlyHint).toBe(true);
    const result = await client.callTool({ name: "trace", arguments: { run: "conversation-1", kind: "conversation", trace: "trace-1", export: "mcp.json" } });
    expect(result.isError).not.toBe(true); expect(readFileSync(path.join(sb.home, "mcp.json"), "utf8")).toBe(payload);
    expect((await client.callTool({ name: "trace", arguments: { run: "conversation-1", kind: "conversation", trace: "trace-1", export: "../escape.json" } })).isError).toBe(true);
  } finally { await client.close(); await mcp.close(); }
});
