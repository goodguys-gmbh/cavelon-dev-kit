import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import type { PackageSchema } from "../src/contracts.js";
import { checkPackage } from "../src/package-check.js";
import { ApiClient } from "../src/http.js";
import { schemaErrors } from "../src/openapi.js";
import { seedQueryTool } from "./fake-database.js";
import { CONTRACTS, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

const read = (name: string) => JSON.parse(readFileSync(path.join(CONTRACTS, name), "utf8"));
const schema = read("meta-package-schema-v3.json") as PackageSchema;
const openapi = read("openapi.json");
const codes = ["writes_not_allowed", "too_many_rows_affected", "write_outcome_unknown", "write_statement_refused", "write_procedure_definition_refused", "confirmation_unavailable", "tool_call_limit_reached", "key_needs_a_person"];
let server: FakeServer;
let sb: Sandbox;
let tenant: string;
let seeded: ReturnType<typeof seedQueryTool>;
let serial = 0;
const evidence = { kind: "write", dry_run: true, rolled_back: true, affected_rows: 1, committed: false };
const settings = { kind: "write", max_affected_rows: 1, requires_confirmation: true, max_calls: 1 };
const testPath = () => `/api/v1/database-connectors/queries/${seeded.query.id}/test-run`;
const sentRuns = () => server.state.requests.filter(r => r.method === "POST" && r.path === testPath());

beforeAll(async () => {
  server = await startFakeServer(); tenant = server.addTenant("test", "Test tenant"); sb = sandbox();
  sb.env.SHELL = "/bin/sh"; sb.env.CAVELON_CONTRACT_TTL_SECONDS = "0";
  server.state.features.database_connector_enabled = true;
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
  await cli(sb, ["harness", "new", "support", "--name", "Support"]);
});
afterAll(async () => { await server.close(); sb.cleanup(); });
beforeEach(() => {
  server.state.db.connections.length = 0; server.state.db.queries.length = 0; server.state.db.runs.length = 0;
  server.state.db.testRuns.length = 0; server.state.db.writeFields = true; server.state.db.mayView = true;
  server.state.failures = []; server.state.interruptions = []; server.state.requests.length = 0;
  seeded = seedQueryTool(server.state.db, tenant);
  Object.assign(seeded.query, settings, { sql_text: "UPDATE orders SET status = 'cancelled' WHERE number = :order_no AND email = :email" });
  seeded.query.result = { columns: [], rows: [], writeEvidence: evidence };
  seeded.connection.fields = { allows_writes: true };
  server.editConfig(tenant, pkg => {
    pkg.tools = (pkg.tools as Array<Record<string, unknown>>).filter(t => t.tool_type !== "database_query");
    (pkg.tools as unknown[]).push(structuredClone(seeded.tool));
  });
});
async function pulled(): Promise<string> {
  const cwd = path.join(sb.home, `write-${++serial}`); mkdirSync(cwd);
  expect((await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--harness", "support"], { cwd })).code).toBe(0);
  expect((await cli(sb, ["pull"], { cwd })).code).toBe(0); return cwd;
}
function edit(cwd: string, values: Record<string, unknown>): void {
  const file = path.join(cwd, "package/tools.yaml"); const tools = parse(readFileSync(file, "utf8")) as Array<Record<string, any>>;
  Object.assign(tools.find(t => t.slug === seeded.query.slug)!.database_query, values); writeFileSync(file, stringify(tools));
}
const testRun = (json = false) => cli(sb, ["db", "test-run", seeded.query.slug, "--value", "order_no=A-10023", "--value", "email=test@example.com", ...(json ? ["--json"] : [])]);

describe("published write query interfaces", () => {
  it("round-trips write fields through pull, fmt, validate and approved apply with an accurate approval reason", async () => {
    const cwd = await pulled(); expect((await cli(sb, ["fmt"], { cwd })).code).toBe(0);
    expect((await cli(sb, ["validate", "--json"], { cwd })).json<{error_count: number}>().error_count).toBe(0);
    edit(cwd, { max_affected_rows: 2, requires_confirmation: false, max_calls: 3 });
    const preview = (await cli(sb, ["apply", "--json"], { cwd })).json<Record<string, any>>();
    const stored = JSON.parse(readFileSync(path.join(cwd, ".cavelon/previews", preview.preview_id + ".json"), "utf8"));
    expect(stored.person_reason).toMatch(/can read or change rows/);
    expect(preview.database_queries.would_write).toEqual([{ slug: seeded.query.slug, action: "change" }]);
    expect((await cli(sb, ["apply", "--confirm", preview.preview_id, "--json"], { cwd })).code).toBe(0);
    expect(seeded.query).toMatchObject({ kind: "write", max_affected_rows: 2, requires_confirmation: false, max_calls: 3 });
    const imports = server.state.requests.filter(r => r.method === "POST" && r.path === "/api/v1/agent-graph/import");
    expect(imports).toHaveLength(1); expect(imports[0]!.headers["x-cavelon-confirmation"]).toMatch(/^cfm_/);
    const q = (imports[0]!.body as {package: {tools: Array<Record<string, any>>}}).package.tools.find(t => t.slug === seeded.query.slug)!.database_query;
    expect(q).toMatchObject({ kind: "write", max_affected_rows: 2, requires_confirmation: false, max_calls: 3 });
    expect(q.connection).toEqual({ name: seeded.connection.name, dialect: "postgresql" }); expect(JSON.stringify(q)).not.toContain("allows_writes");
    expect((await cli(sb, ["pull"], { cwd })).code).toBe(0);
    expect((await cli(sb, ["validate", "--json"], { cwd })).json<{findings: Array<{code: string}>}>().findings.filter(f => f.code === "database_query_changed")).toEqual([]);
  });
  it.each([false, true, undefined])("validate warns only for explicitly disabled writes: %s", async allows => {
    seeded.connection.fields = allows === undefined ? {} : { allows_writes: allows }; const cwd = await pulled();
    const result = await cli(sb, ["validate", "--json"], { cwd });
    const findings = result.json<{findings: Array<{code: string; severity: string; message: string; path: string}>}>().findings.filter(f => f.code === "writes_not_allowed");
    expect(findings).toHaveLength(allows === false ? 1 : 0);
    if (allows === false) expect(findings[0]).toMatchObject({ severity: "warning", path: expect.stringMatching(/^tools\[\d+\]\.database_query\.connection$/), message: expect.stringContaining("Admin") });
    server.state.requests.length = 0;
    const offline = await cli(sb, ["validate", "--offline", "--json"], { cwd });
    expect(offline.json<{findings: Array<{code: string}>}>().findings.filter(f => f.code === "writes_not_allowed")).toEqual([]); expect(server.state.requests).toEqual([]);
  });
  it("an unreadable connection list leaves permission unknown and says the check was skipped", async () => {
    const cwd = await pulled(); server.state.db.mayView = false; const result = await cli(sb, ["validate", "--json"], { cwd });
    expect(result.json<{findings: Array<{code: string}>}>().findings.filter(f => f.code === "writes_not_allowed")).toEqual([]); expect(result.stderr).toMatch(/write.*check.*skipped/i);
  });
  it.each([{ kind: "guess" }, { max_affected_rows: 0 }, { max_affected_rows: 101 }, { requires_confirmation: "yes" }, { max_calls: 0 }, { max_calls: 1001 }])("checks write fields against the schema: %j", async invalid => {
    const cwd = await pulled(); edit(cwd, invalid); expect((await cli(sb, ["validate", "--offline", "--json"], { cwd })).json<{error_count: number}>().error_count).toBeGreaterThan(0);
  });
  it("query details, list and instance show only published write settings", async () => {
    const full = await cli(sb, ["db", "queries", seeded.query.slug]);
    expect(full.stdout).toMatch(/kind:\s+write/); expect(full.stdout).toMatch(/max_affected_rows 1/); expect(full.stdout).toMatch(/requires_confirmation:\s+yes/); expect(full.stdout).toMatch(/max_calls:\s+1/);
    expect((await cli(sb, ["db", "queries"])).stdout).toContain("write");
    Object.assign(server.state.db.instance, { write_queries: true, max_affected_rows_limit: 100 }); const instance = await cli(sb, ["db", "instance"]);
    expect(instance.stdout).toMatch(/write_queries:\s+yes/); expect(instance.stdout).toMatch(/max_affected_rows_limit:\s+100/);
  });
  it("prints dry run, rollback and commit evidence and preserves the exact JSON", async () => {
    const result = await testRun(); expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/dry_run:\s+yes/); expect(result.stdout).toMatch(/rolled_back:\s+yes/); expect(result.stdout).toMatch(/affected_rows:\s+1/); expect(result.stdout).toMatch(/committed:\s+no/);
    const json = await testRun(true); expect(json.json()).toMatchObject(evidence);
    expect(schemaErrors(openapi, { $ref: "#/components/schemas/DatabaseQueryTestRunResponse" }, json.json())).toEqual([]);
    const runs = await cli(sb, ["db", "runs", seeded.query.slug]); expect(runs.stdout).toContain("AFFECTED_ROWS"); expect(runs.stdout).toContain("DRY_RUN");
    expect((await cli(sb, ["db", "runs", seeded.query.slug, "--json"])).json<{items: unknown[]}>().items[0]).toMatchObject({ kind: "write", dry_run: true, affected_rows: 1, committed: false });
  });
  it("omitted or null evidence stays unknown on a newer schema", async () => {
    seeded.query.result = { columns: [], rows: [], writeEvidence: { kind: "write", affected_rows: null, committed: null } }; const result = await testRun();
    expect(result.stdout).not.toMatch(/dry_run:|rolled_back:/); expect(result.stdout).toMatch(/affected_rows:\s+unknown/); expect(result.stdout).toMatch(/committed:\s+unknown/);
    const json = (await testRun(true)).json<Record<string, unknown>>(); expect(json.committed).toBeNull(); expect(json).not.toHaveProperty("dry_run");
  });
  it("older responses preserve read output without inventing query defaults or write flags", async () => {
    server.state.db.writeFields = false; seeded.connection.fields = {}; seeded.query.result = { columns: ["value"], rows: [[7]] };
    const result = await testRun(); expect(result.code).toBe(0); expect(result.stdout).toContain("7"); expect(result.stdout).not.toMatch(/dry_run:|rolled_back:|committed:|kind:/);
    expect((await cli(sb, ["db", "queries", seeded.query.slug])).stdout).not.toMatch(/kind:|max_affected_rows|requires_confirmation:|max_calls:/);
    expect((await cli(sb, ["db", "connections", "--json"])).json<{items: unknown[]}>().items[0]).not.toHaveProperty("allows_writes");
  });
  it.each(["writes_not_allowed", "confirmation_unavailable", "tool_call_limit_reached"])("preserves a %s refusal and sends once", async code => {
    seeded.query.refusal = { code, message: "The instance refused the call before it ran." }; const result = await testRun(true); expect(result.code).toBe(4);
    expect(result.json<{error: {code: string; hint: string}}>().error).toMatchObject({ code, hint: expect.stringContaining(`cavelon explain ${code}`) }); expect(sentRuns()).toHaveLength(1); expect(server.state.db.runs).toEqual([]);
  });
  it.each([
    { code: "too_many_rows_affected", outcome: "error", fields: { ...evidence, affected_rows: 2 } },
    { code: "write_outcome_unknown", outcome: "unknown", fields: { kind: "write", dry_run: false, rolled_back: false, affected_rows: 1, committed: null } },
  ])("reports $code and never retries", async ({ code, outcome, fields }) => {
    if (code === "write_outcome_unknown") {
      server.state.db.runs.push({ id: randomUUID(), query_id: seeded.query.id, connection_id: seeded.connection.id, query_version: 1, source: "agent", outcome, error_code: code, row_count: null, created_at: new Date().toISOString(), writeEvidence: { kind: fields.kind, dry_run: fields.dry_run, affected_rows: fields.affected_rows, committed: fields.committed } });
      const result = await cli(sb, ["db", "runs", seeded.query.slug]);
      expect(result.stdout).toContain(code); expect(result.stdout).toMatch(/Do not retry/); expect(result.stdout).toContain("unknown");
      expect(sentRuns()).toEqual([]);
    } else {
    seeded.query.result = { error_code: code, outcome, writeEvidence: fields }; const result = await testRun(); expect(result.code).toBe(3); expect(result.stdout).toContain(code); expect(result.stdout).toMatch(/rolled_back:\s+(yes|no)/);
    expect(sentRuns()).toHaveLength(1);
    }
    expect((await cli(sb, ["db", "runs", seeded.query.slug, "--json"])).json<{items: unknown[]}>().items[0]).toMatchObject({ outcome, error_code: code, kind: fields.kind, dry_run: fields.dry_run, affected_rows: fields.affected_rows, committed: fields.committed });
  });
  it("a broken write-test response sends once and warns against repeating an ambiguous result", async () => {
    server.state.interruptions = [{ method: "POST", path: /\/test-run$/, mode: "cut" }]; const result = await testRun(true); expect(result.code).toBe(8); expect(sentRuns()).toHaveLength(1); expect(result.json<{error: {hint: string}}>().error.hint).toContain("Do not retry");
  });
  it.each(["write_statement_refused", "write_procedure_definition_refused"])("retains save-time %s without retrying", async code => {
    const route = `/api/v1/database-connectors/queries/${seeded.query.id}`;
    server.state.failures = [{ method: "PATCH", path: /\/queries\/[^/]+$/, status: 422, code, detail: "The instance refused this statement." }];
    const result = await cli(sb, ["api", "update_database_query", `query_id=${seeded.query.id}`, "--body", JSON.stringify(settings), "--json"]);
    expect(result.json<{error: {code: string}}>().error.code).toBe(code); expect(server.state.requests.filter(r => r.method === "PATCH" && r.path === route)).toHaveLength(1);
  });
  it("write nodes warn when they cannot collect confirmation while retaining model-only argument checks", () => {
    const query = { ...((seeded.tool.database_query) as object), ...settings } as Record<string, unknown>;
    const body = { tools: [{ ...seeded.tool, database_query: query }], registry_entities: { orchestration_nodes: [{ slug: "write", node_type: "tool_call", config: { tool_slug: seeded.query.slug, tool_type: "database_query", input_schema: { properties: { email: { type: "string" } } } } }] } };
    const findings = (published = schema) => checkPackage({ package: body, sources: {}, findings: [], empty: false }, { schema: published });
    expect(findings().find(f => f.code === "confirmation_unavailable")).toMatchObject({ severity: "warning" }); expect(findings().find(f => f.code === "invalid_arguments")).toMatchObject({ severity: "error" });
    delete query.requires_confirmation; expect(findings().find(f => f.code === "confirmation_unavailable")).toBeDefined();
    query.requires_confirmation = false; expect(findings().find(f => f.code === "confirmation_unavailable")).toBeUndefined();
    const older = structuredClone(schema); delete ((older.$defs as Record<string, any>).PackageDatabaseQuery.properties).requires_confirmation;
    delete query.requires_confirmation; expect(findings(older).find(f => f.code === "confirmation_unavailable")).toBeUndefined();
  });
  it.each(codes)("explain uses the final catalog for %s", async code => {
    const entry = read("meta-error-catalog.json").api_error_codes.find((x: {code: string}) => x.code === code); expect(entry).toBeDefined();
    const result = await cli(sb, ["explain", code, "--json"]); expect(result.code).toBe(0); expect(JSON.stringify(result.json())).toContain(entry.message);
    if (code === "tool_call_limit_reached") {
      expect(entry.message).toContain("Tool Call node"); expect(entry.hint).toContain("max_calls");
    }
  });
  it.each(["allows-writes", "write-privileges-acknowledged", "password"])("connection commands accept no --%s field and send no update", async field => {
    const result = await cli(sb, ["db", "connections", "update", seeded.connection.name, `--${field}`, "--json"]);
    expect(result.code).toBe(2);
    expect(server.state.requests.filter(r => ["PATCH", "PUT"].includes(r.method))).toEqual([]);
  });
  it.each(["pat", "key"] as const)("preserves %s person-only password/write-enable refusals and principal guidance", async kind => {
    const template = "/api/v1/database-connectors/connections/{connection_id}";
    const needsAPerson = [
      { method: "PUT", path: `${template}/password`, reason: "Sets a database connection's password" },
      { method: "PUT", path: `${template}/writes`, reason: "Decides whether agents may write into a customer's database" },
    ];
    const token = server.addToken({ kind, tenantIds: [tenant], defaultTenant: tenant, scopes: ["admin"], needsAPerson });
    const client = new ApiClient({ url: server.url, token, tenantId: tenant });
    const code = kind === "key" ? "key_needs_a_person" : "person_only_operation";
    for (const field of ["password", "writes"]) {
      const route = `/api/v1/database-connectors/connections/${seeded.connection.id}/${field}`;
      server.state.failures = [{ method: "PUT", path: new RegExp(`/${field}$`), status: 403, code, detail: "A person runs this operation." }];
      await expect(client.request("PUT", route, { json: {} })).rejects.toMatchObject({ status: 403, code, hint: expect.stringContaining("Admin"), details: { needs_a_person: true } });
      expect(server.state.requests.filter(r => r.method === "PUT" && r.path === route)).toHaveLength(1);
    }
    expect(seeded.connection.fields).toEqual({ allows_writes: true });
  });
});
