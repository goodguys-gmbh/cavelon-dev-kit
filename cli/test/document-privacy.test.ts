import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../src/commands/index.js";
import type { OpenApiDoc, PackageSchema } from "../src/contracts.js";
import type { InStream, Io } from "../src/io.js";
import { createMcpServer } from "../src/mcp.js";
import { operationAt, schemaErrors } from "../src/openapi.js";
import { DEFAULT_LAYOUT, readPackage, writePackage } from "../src/package-files.js";
import { CONTRACTS, openapiSnapshot, samplePackage, startFakeServer, type FakeServer } from "./fake-server.js";
import { askingClient, cli, login, sandbox, type Sandbox } from "./helpers.js";

let server: FakeServer;
let sb: Sandbox;
let tenant: string;
let kb: string;
let document: string;

beforeEach(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme");
  kb = randomUUID();
  document = randomUUID();
  server.state.kbs.push({ id: kb, tenant_id: tenant, name: "Records" });
  server.state.documents.push({ id: document, tenant_id: tenant, kb_id: kb, filename: "record.pdf", size: 30, is_active: true, deleted: false, created_at: new Date().toISOString() });
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
});
afterEach(async () => { sb.cleanup(); await server.close(); });

describe("document privacy and table files", () => {
  it("keeps processing settings and the instance's read_document file parameter through package splitting and reading", async () => {
    const pkg = samplePackage();
    const config = { table_optimizer: false, export_tables_xlsx: true, privacy_document: "pseudonymize", privacy_outputs: "anonymize", privacy_model: randomUUID() };
    (pkg.knowledge_bases as Array<Record<string, unknown>>)[0]!.document_processing_config = config;
    const tool = { slug: "read_document", name: "Read document", tool_type: "builtin", builtin_key: "read_document", params_json_schema: { type: "object", properties: { document_id: { type: "string" }, file: { enum: ["redacted_pdf", "tables_xlsx", null] } } } };
    (pkg.tools as unknown[]).push(tool);
    const schema = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-package-schema-v3.json"), "utf8")) as PackageSchema;
    await writePackage(sb.home, DEFAULT_LAYOUT, pkg, schema);
    const read = await readPackage(sb.home, DEFAULT_LAYOUT);
    expect(read.findings).toEqual([]);
    expect(read.package.knowledge_bases).toMatchObject([{ document_processing_config: config }]);
    expect(read.package.tools).toContainEqual(tool);
  });

  it("lists held documents as needing a person, without releasing or indexing them", async () => {
    Object.assign(server.state.documents[0]!, { status: "held" });
    const result = await cli(sb, ["kb", "documents", "--kb", "Records", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.json()).toMatchObject({ items: [{ id: document, status: "held", needs_person: true }] });
    expect((await cli(sb, ["kb", "documents", "--kb", kb])).stdout).toContain("held");
    expect(server.state.requests.filter(r => r.path.endsWith("/release"))).toEqual([]);
  });

  it("round-trips every processing switch, false values, and the registry entry id through the published API", async () => {
    const config = { table_optimizer: false, export_tables_xlsx: true, privacy_document: "pseudonymize", privacy_outputs: "anonymize", privacy_model: randomUUID(), do_ocr: true };
    const updated = await cli(sb, ["api", "update_knowledge_base", `kb_id=${kb}`, "--body", JSON.stringify({ document_processing_config: config }), "--json"]);
    expect(updated.code, updated.stderr).toBe(0);
    expect(updated.json()).toMatchObject({ document_processing_config: config });
    const read = await cli(sb, ["api", "get_knowledge_base", `kb_id=${kb}`, "--json"]);
    expect(read.json()).toMatchObject({ document_processing_config: config });
    const cleared = await cli(sb, ["api", "update_knowledge_base", `kb_id=${kb}`, "--body", JSON.stringify({ document_processing_config: { ...config, privacy_model: null, export_tables_xlsx: false } }), "--json"]);
    expect(cleared.json()).toMatchObject({ document_processing_config: { privacy_model: null, export_tables_xlsx: false } });
  });

  it("preserves the instance's validation refusal instead of inventing a names-model credential", async () => {
    server.state.failures.push({ method: "PATCH", path: /knowledge-bases\//, status: 400, detail: "privacy_model must be an active, tenant-owned, non-OpenAI registry entry with a base_url" });
    const result = await cli(sb, ["api", "update_knowledge_base", `kb_id=${kb}`, "--body", '{"document_processing_config":{"privacy_model":"wrong-id"}}', "--json"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("privacy_model must be");
  });

  it("lists a document's file ids, permissions and privacy summary and saves a readable workbook byte for byte", async () => {
    const files = await cli(sb, ["kb", "files", document, "--kb", kb, "--json"]);
    expect(files.code, files.stderr).toBe(0);
    const data = files.json<{ files: Array<{ id: string; kind: string }> }>();
    expect(data).toMatchObject({ document_id: document, status: "ready", privacy: { clean: true } });
    const contract = JSON.parse(openapiSnapshot()) as OpenApiDoc;
    const schema = operationAt(contract, "GET", "/api/v1/knowledge-bases/{kb_id}/documents/{doc_id}/files")!.responses["200"]!.content!["application/json"]!.schema!;
    expect(schemaErrors(contract, schema, data)).toEqual([]);
    const workbook = data.files.find(f => f.kind === "tables_xlsx")!;
    const downloaded = await cli(sb, ["kb", "download", document, "--kb", kb, "--file", workbook.id, "--output", "tables.xlsx", "--json"]);
    expect(downloaded.code, downloaded.stderr).toBe(0);
    expect(readFileSync(path.join(sb.home, "tables.xlsx"))).toEqual(Buffer.from([0x50, 0x4b, 3, 4, 0, 255]));
    expect(downloaded.json()).toMatchObject({ file_id: workbook.id, kind: "tables_xlsx", written: "tables.xlsx" });
    const api = await cli(sb, ["api", "download_document_file", `kb_id=${kb}`, `doc_id=${document}`, `file_id=${workbook.id}`, "--output", "api.xlsx", "--json"]);
    expect(api.code, api.stderr).toBe(0);
    expect(readFileSync(path.join(sb.home, "api.xlsx"))).toEqual(readFileSync(path.join(sb.home, "tables.xlsx")));
  });

  it("reports held ingestion as needing a person and keeps an old replacement active", async () => {
    server.state.uploadReplace = "none";
    server.state.ingestedDocumentStatus = "held";
    sb.env.CAVELON_CONTRACT_TTL_SECONDS = "0";
    writeFileSync(path.join(sb.home, "record.pdf"), "%PDF-new");
    const result = await cli(sb, ["kb", "upload", "record.pdf", "--kb", kb, "--replace", "--confirm", "--wait", "--json"]);
    expect(result.code, result.stderr).toBe(5);
    expect(result.json()).toMatchObject({ documents: [{ status: "held" }], held_documents: [expect.any(String)], needs_person: expect.stringContaining("Admin"), existing: [{ document_id: document, outcome: "stays_active" }] });
    expect(server.state.documents[0]!.is_active).toBe(true);
    expect(server.state.requests.some(r => r.method === "PATCH" && r.path.endsWith("/documents/active"))).toBe(false);
  });

  it("exposes read-only MCP tools, confines saved files, and never elicits or sends a release", async () => {
    const io: Io = { stdout: { write: () => true }, stderr: { write: () => true }, stdin: Readable.from([]) as unknown as InStream, env: sb.env, cwd: sb.home, now: () => new Date(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const mcp = createMcpServer(io, COMMANDS);
    const client = askingClient();
    await mcp.connect(serverSide);
    await client.connect(clientSide);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, any>;
    };
    try {
      const { tools } = await client.listTools();
      for (const name of ["kb_documents", "kb_files", "kb_download"]) expect(tools.find(t => t.name === name)?.annotations?.readOnlyHint).toBe(true);
      const files = await call("kb_files", { document, kb });
      const workbook = files.files.find((f: { kind: string }) => f.kind === "tables_xlsx");
      expect(await call("kb_download", { document, kb, file: workbook.id, output: "mcp.xlsx" })).toMatchObject({ written: "mcp.xlsx", bytes: 6 });
      expect(await call("kb_download", { document, kb, output: "../outside.pdf" })).toMatchObject({ error: { code: "path_outside_solution" } });
      expect(await call("api", { operation: "release_held_document", params: [`kb_id=${kb}`, `doc_id=${document}`], confirm: true })).toMatchObject({ error: { code: "operation_for_a_person" } });
      expect(await call("api", { operation: "release_held_upload", params: [`file_id=${document}`], confirm: true })).toMatchObject({ error: { code: "operation_for_a_person" } });
      expect(client.asked).toEqual([]);
      expect(server.state.requests.some(r => r.path.endsWith("/release"))).toBe(false);
    } finally { await client.close(); await mcp.close(); }
  });

  it("leaves the report and vault with a dashboard person, even in YOLO", async () => {
    const files = (await cli(sb, ["kb", "files", document, "--kb", kb, "--json"])).json<{ files: Array<{ id: string; restricted: boolean }> }>().files;
    for (const file of files.filter(f => f.restricted)) {
      const before = server.state.requests.length;
      const result = await cli(sb, ["kb", "download", document, "--kb", kb, "--file", file.id, "--output", "restricted.json", "--yolo", "--json"]);
      expect(result.code).toBe(5);
      expect(result.json()).toMatchObject({ error: { code: "document_file_for_a_person" } });
      expect(server.state.requests.slice(before).some(r => r.path.endsWith(`/files/${file.id}`))).toBe(false);
      expect(existsSync(path.join(sb.home, "restricted.json"))).toBe(false);
    }
  });

  it("refuses held downloads and never overwrites an existing output file", async () => {
    Object.assign(server.state.documents[0]!, { status: "held" });
    const held = await cli(sb, ["kb", "download", document, "--kb", kb, "--output", "record.pdf", "--json"]);
    expect(held.code).toBe(5);
    expect(held.json()).toMatchObject({ error: { code: "held_for_privacy_review" } });
    Object.assign(server.state.documents[0]!, { status: "ready" });
    writeFileSync(path.join(sb.home, "record.pdf"), "customer file");
    const exists = await cli(sb, ["kb", "download", document, "--kb", kb, "--output", "record.pdf", "--json"]);
    expect(exists.code).not.toBe(0);
    expect(readFileSync(path.join(sb.home, "record.pdf"), "utf8")).toBe("customer file");
  });

  it("removes only its new output after a refused download and allows a later retry", async () => {
    server.state.failures.push({ method: "GET", path: /\/download$/, status: 500, detail: "Storage temporarily unavailable" });
    const args = ["kb", "download", document, "--kb", kb, "--output", "retry.pdf", "--json"];
    expect((await cli(sb, args)).code).not.toBe(0);
    expect(existsSync(path.join(sb.home, "retry.pdf"))).toBe(false);
    server.state.failures = [];
    expect((await cli(sb, args)).code).toBe(0);
    expect(readFileSync(path.join(sb.home, "retry.pdf"), "utf8")).toBe("%PDF-redacted");
  });

  it("uses the redacted default download and confines an agent's output to the solution", async () => {
    const result = await cli(sb, ["kb", "download", document, "--kb", kb, "--output", "record.pdf", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(readFileSync(path.join(sb.home, "record.pdf"), "utf8")).toBe("%PDF-redacted");
    const before = server.state.requests.length;
    const outside = await cli(sb, ["kb", "download", document, "--kb", kb, "--output", "../outside.pdf", "--json"], { env: { CAVELON_AGENT: "1" } });
    expect(outside.code).toBe(2);
    expect(outside.json()).toMatchObject({ error: { code: "path_outside_solution" } });
    expect(server.state.requests.slice(before).some(r => r.path.endsWith("/download"))).toBe(false);
  });

  it("reports missing file operations on an older instance without sending a speculative request", async () => {
    server.state.openapiWithout = ["GET /api/v1/knowledge-bases/{kb_id}/documents/{doc_id}/files"];
    sb.cleanup();
    sb = sandbox();
    await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
    const result = await cli(sb, ["kb", "files", document, "--kb", kb, "--json"]);
    expect(result.json()).toMatchObject({ error: { code: "operation_unavailable" } });
    expect(server.state.requests.some(r => r.path.endsWith("/files"))).toBe(false);
  });

  it.each(["pat", "key"] as const)("keeps both release operations dashboard-only in a person's own %s terminal too", async kind => {
    await login(sb, server.url, server.addToken({ kind, tenantIds: [tenant], defaultTenant: tenant }));
    for (const args of [
      ["release_held_document", `kb_id=${kb}`, `doc_id=${document}`],
      ["release_held_upload", `file_id=${document}`],
    ]) {
      const result = await cli(sb, ["api", ...args, "--json"]);
      expect(result.code).toBe(5);
      expect(result.json()).toMatchObject({ error: { code: "operation_for_a_person", hint: expect.stringContaining("Admin") } });
    }
    expect(server.state.requests.some(r => r.path.endsWith("/release"))).toBe(false);
  });

  it.each([
    ["release_held_document", () => [`kb_id=${kb}`, `doc_id=${document}`]],
    ["release_held_upload", () => [`file_id=${document}`]],
  ])("refuses %s for an agent before sending, with confirm or YOLO", async (operation, params) => {
    const result = await cli(sb, ["api", operation, ...params(), "--confirm", "--yolo", "--json"], { env: { CAVELON_AGENT: "1" } });
    expect(result.code).toBe(5);
    expect(result.json()).toMatchObject({ error: { code: "operation_for_a_person", hint: expect.stringContaining("Admin") } });
    expect(server.state.requests.some(r => r.path.endsWith("/release"))).toBe(false);
  });
});
