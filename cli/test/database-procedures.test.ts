import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { isProcedureCall, procedureCallProblem } from "../src/database-queries.js";
import type { FakeConnection, FakeQuery } from "./fake-database.js";
import { CONTRACTS, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * A SQL Server query that calls one stored procedure: validate warns of an
 * EXEC the instance would refuse, a procedure query round-trips through pull,
 * validate and apply, and each of the instance's procedure refusals reads
 * clearly in apply, explain and the db commands; an instance older than
 * stored-procedure queries publishes none of the new fields, and the kit says
 * nothing of them there.
 */

let server: FakeServer;
let sb: Sandbox;
let tenant: string;
let connection: FakeConnection;
let query: FakeQuery;
let dirCount = 0;

const read = (file: string) => readFileSync(file, "utf8");
const SNAPSHOT_OFFER = (JSON.parse(read(path.join(CONTRACTS, "meta-capabilities.json"))) as { database_connector: Record<string, unknown> }).database_connector;
const CATALOG = (JSON.parse(read(path.join(CONTRACTS, "meta-error-catalog.json"))) as { api_error_codes: Array<{ code: string; message: string; hint: string }> }).api_error_codes;
const PROCEDURE_CODES = ["procedure_call_form", "write_privileges_block_procedure", "procedure_definition_unreadable", "procedure_definition_writes"];
/** The refusals of a procedure query the instance checks against the connection: its login, and the procedure's definition. */
const CONNECTION_CODES = ["write_privileges_block_procedure", "procedure_definition_unreadable", "procedure_definition_writes"];
const SQL = "EXEC [inventory].[stock_level] @sku = :sku, @warehouse = :warehouse";

type Tool = Record<string, any>;
type Found = { code: string; severity: string; file?: string; line?: number; path?: string; message: string };
type Validated = { valid: boolean; error_count: number; warning_count: number; findings: Found[] };

const fresh = () => ({ CAVELON_CACHE_DIR: path.join(sb.home, `cache-${randomUUID()}`) });
const refusal = (code: string) => ({ code, message: CATALOG.find((e) => e.code === code)!.message });

async function pulled(): Promise<string> {
  const dir = path.join(sb.home, `solution-${++dirCount}`);
  mkdirSync(dir, { recursive: true });
  expect((await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--harness", "support"], { cwd: dir })).code).toBe(0);
  const pull = await cli(sb, ["pull"], { cwd: dir });
  expect(pull.code, pull.stderr + pull.stdout).toBe(0);
  return dir;
}

const toolsFile = (dir: string) => path.join(dir, "package", "tools.yaml");

function editTool(dir: string, change: (tool: Tool) => void): void {
  const tools = parse(read(toolsFile(dir))) as Tool[];
  change(tools.find((t) => t.slug === "stock_level")!);
  writeFileSync(toolsFile(dir), stringify(tools));
}

const validated = async (dir: string): Promise<Validated> => (await cli(sb, ["validate", "--json", "--offline"], { cwd: dir })).json<Validated>();

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("erp", "ERP");
  sb = sandbox();
  server.state.features.database_connector_enabled = true;
  server.state.capsPatch = { database_connector: { ...SNAPSHOT_OFFER, dialects: ["mssql"], may_write_queries: false } };
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
  await cli(sb, ["harness", "new", "support", "--name", "Support"]);
  connection = { id: randomUUID(), tenant_id: tenant, name: "erp-db", dialect: "mssql", last_test_outcome: "ok" };
  const parameters = [
    { name: "sku", source: "model", type: "string", description: "Article number, e.g. 4711", max_length: 20 },
    { name: "warehouse", source: "model", type: "string", description: "Warehouse code, e.g. HAM", max_length: 10 },
  ];
  query = {
    id: randomUUID(),
    tenant_id: tenant,
    connection_id: connection.id,
    slug: "stock_level",
    name: "Stock level",
    description: "Stock of one article in one warehouse.",
    sql_text: SQL,
    parameters,
    max_rows: 5,
    max_result_chars: 4000,
    allows_anonymous: false,
    version: 1,
    result: { columns: ["sku", "on_hand"], rows: [["4711", 12]] },
  };
  server.state.db.connections.push(connection);
  server.state.db.queries.push(query);
  server.editConfig(tenant, (pkg) => {
    (pkg.tools as Tool[]).push({
      slug: "stock_level",
      name: query.name,
      description: query.description,
      tool_type: "database_query",
      scope: "tenant_local",
      database_query: { connection: { name: "erp-db", dialect: "mssql" }, sql_text: SQL, parameters, max_rows: 5, max_result_chars: 4000, allows_anonymous: false },
    });
  });
});
afterAll(async () => {
  await server.close();
  sb.cleanup();
});
beforeEach(() => {
  server.state.db.procedureFields = true;
  delete connection.procedureCallRefusal;
  delete connection.procedureFindings;
  delete query.refusal;
  query.result = { columns: ["sku", "on_hand"], rows: [["4711", 12]] };
});

describe("the local check of an EXEC", () => {
  it("passes the one call form on SQL Server: an optional schema, brackets, @name = :placeholder arguments, a trailing semicolon", () => {
    for (const sql of [
      "EXEC dbo.stock_level @sku = :sku",
      "execute [inventory].[stock level] @sku=:sku, @warehouse = :warehouse;",
      "-- the stock\nEXEC stock_level",
      "/* a note */ EXEC [dbo].[x]]y] @a = :a",
    ]) {
      expect(procedureCallProblem(sql, "mssql"), sql).toBeUndefined();
    }
    expect(isProcedureCall(SQL, "mssql")).toBe(true);
    expect(isProcedureCall(SQL, "postgresql")).toBe(false);
    expect(isProcedureCall("SELECT 'EXEC x' AS t", "mssql")).toBe(false);
  });

  it("warns with procedure_call_form for every other EXEC on SQL Server, and names what is wrong", () => {
    const cases: Array<[string, RegExp]> = [
      ["EXEC dbo.stock_level @sku = 'A-1'", /The argument '@sku = 'A-1'' is not written @name = :placeholder\./],
      ["EXEC dbo.stock_level @sku = :sku OUTPUT", /'OUTPUT' follows an argument/],
      ["EXEC dbo.stock_level :sku", /The argument ':sku' is not written/],
      ["EXEC dbo.stock_level @sku = :sku,", /The arguments end with a comma\./],
      ["EXEC @rc = dbo.stock_level @sku = :sku", /@ is not a procedure name\./],
      ["EXEC ('SELECT 1')", /\( is not a procedure name\./],
      ["EXEC shop.dbo.stock_level", /at most a schema and its name/],
      ["EXEC sp_executesql @stmt = :stmt", /sp_executesql runs SQL text or code outside the database/],
      ["EXEC master.xp_cmdshell", /xp_cmdshell runs SQL text/],
      ["EXEC dbo.stock_level WITH RECOMPILE", /'WITH RECOMPILE' is not written @name = :placeholder/],
      ["EXEC", /EXEC names no procedure\./],
      ["(EXEC dbo.x)", /Nothing may stand before EXEC\./],
    ];
    for (const [sql, why] of cases) {
      const found = procedureCallProblem(sql, "mssql");
      expect(found, sql).toMatchObject({ code: "procedure_call_form", at: "sql_text" });
      expect(found!.message, sql).toMatch(why);
      expect(found!.message, sql).toMatch(/A stored-procedure query is exactly EXEC \[schema\]\.\[procedure\] @p1 = :p1, @p2 = :p2, every argument a :placeholder \(procedure_call_form\)\.$/);
    }
  });

  it("warns with not_select for an EXEC on another dialect, and leaves the rest to the instance", () => {
    expect(procedureCallProblem("EXEC stock_level @sku = :sku", "postgresql")).toMatchObject({ code: "not_select", message: expect.stringMatching(/only a query on a SQL Server \(mssql\) connection may do; on postgresql the instance refuses it/) });
    expect(procedureCallProblem("execute stock_level", "mysql")?.code).toBe("not_select");
    // Not an EXEC, no dialect, a second statement, an unclosed quote: the instance's own codes say it.
    for (const [sql, dialect] of [
      ["SELECT * FROM stock WHERE sku = :sku", "mssql"],
      ["SELECT 'EXEC x'", "mssql"],
      ["EXEC x @a = 1", undefined],
      ["EXEC x; EXEC y", "mssql"],
      ["EXEC [x @a = :a", "mssql"],
    ] as const) {
      expect(procedureCallProblem(sql, dialect), sql).toBeUndefined();
    }
  });
});

describe("a stored-procedure query in the package", () => {
  it("round-trips through pull, validate and apply", async () => {
    const dir = await pulled();
    const tool = (parse(read(toolsFile(dir))) as Tool[]).find((t) => t.slug === "stock_level")!;
    expect(tool.database_query).toMatchObject({ connection: { name: "erp-db", dialect: "mssql" }, sql_text: SQL });
    expect((await cli(sb, ["fmt"], { cwd: dir })).code).toBe(0);
    const result = await validated(dir);
    expect(result.findings.filter((f) => f.path?.includes("database_query")), JSON.stringify(result.findings)).toEqual([]);
    const preview = await cli(sb, ["apply", "--json"], { cwd: dir, env: fresh() });
    expect(preview.code, preview.stdout + preview.stderr).toBe(0);
    const sent = server.state.requests.filter((r) => r.path === "/api/v1/agent-graph/import/preview").pop()!.body as { package: { tools: Tool[] } };
    expect(sent.package.tools.find((t) => t.slug === "stock_level")!.database_query.sql_text).toBe(SQL);
    const id = preview.json<{ preview_id: string }>().preview_id;
    expect((await cli(sb, ["apply", "--confirm", id], { cwd: dir })).code).toBe(0);
  });

  it("validate warns, with the code, file and line, of an EXEC the instance would refuse; never an error", async () => {
    const dir = await pulled();
    editTool(dir, (t) => (t.database_query.sql_text = "EXEC [inventory].[stock_level] @sku = :sku, @warehouse = 'HAM'"));
    let result = await validated(dir);
    const form = result.findings.find((f) => f.code === "procedure_call_form")!;
    expect(form).toMatchObject({ severity: "warning", file: "package/tools.yaml", path: expect.stringMatching(/\.database_query\.sql_text$/) });
    expect(form.message).toMatch(/^Query tool "stock_level": The argument '@warehouse = 'HAM'' is not written @name = :placeholder\./);
    expect(read(path.join(dir, form.file!)).split("\n")[form.line! - 1]).toMatch(/sql_text:/);

    editTool(dir, (t) => {
      t.database_query.sql_text = SQL;
      t.database_query.connection.dialect = "postgresql";
    });
    result = await validated(dir);
    expect(result.findings.find((f) => f.code === "not_select")).toMatchObject({ severity: "warning", message: expect.stringMatching(/^Query tool "stock_level": the SQL calls a stored procedure \(EXEC\)/) });
    expect(result.findings.filter((f) => f.severity === "error" && f.path?.includes("database_query"))).toEqual([]);
  });

  it("apply shows each refusal of the connection's login or the procedure's definition with the instance's code, hint and explain", async () => {
    const dir = await pulled();
    editTool(dir, (t) => (t.database_query.max_rows = 10));
    for (const code of CONNECTION_CODES) {
      connection.procedureCallRefusal = refusal(code);
      const preview = await cli(sb, ["apply"], { cwd: dir, env: fresh() });
      expect(preview.code, code).toBe(3);
      expect(preview.stdout).toContain(`${code}  package/tools.yaml:`);
      expect(preview.stdout).toMatch(new RegExp(`Database query 'stock_level' cannot be saved: ${CATALOG.find((e) => e.code === code)!.message.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      expect(preview.stdout).toContain(`hint: ${CATALOG.find((e) => e.code === code)!.hint.slice(0, 60)}`);
      expect(preview.stdout).toContain(`more: cavelon explain ${code}`);
      const json = (await cli(sb, ["apply", "--json"], { cwd: dir, env: fresh() })).json<{ blocker_details: Array<Record<string, unknown>> }>();
      expect(json.blocker_details.find((b) => b.code === code)).toMatchObject({ path: expect.stringMatching(/\.database_query\.connection$/), file: "package/tools.yaml" });
    }
  });
});

describe("explain", () => {
  it.each(PROCEDURE_CODES)("explains %s from the instance's catalog", async (code) => {
    const explained = await cli(sb, ["explain", code, "--json"]);
    expect(explained.code, explained.stderr).toBe(0);
    const entry = explained.json<{ code: string; message: string; hint: string }>();
    expect(entry).toMatchObject({ code, message: CATALOG.find((e) => e.code === code)!.message });
    expect(`${entry.message} ${entry.hint}`).toMatch(/procedure/i);
  });

  it("says what changed for SQL Server in not_select and query_failed", async () => {
    expect((await cli(sb, ["explain", "not_select", "--json"])).json<{ hint: string }>().hint).toContain("EXEC [schema].[procedure] @p1 = :p1");
    expect((await cli(sb, ["explain", "query_failed", "--json"])).json<{ message: string }>().message).toContain("database_query.disabled_automatically");
  });
});

describe("db commands", () => {
  it("db connections names a connection where a stored-procedure query cannot be saved or run, with the code, and explains it", async () => {
    connection.procedureCallRefusal = refusal("write_privileges_block_procedure");
    const listed = await cli(sb, ["db", "connections"], { env: fresh() });
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toMatch(/^Stored-procedure queries \(EXEC\) cannot be saved or run on: erp-db \(write_privileges_block_procedure: A stored-procedure query \(EXEC\) runs only/m);
    expect(listed.stdout).toMatch(/cavelon explain <code> \(write_privileges_block_procedure\)/);
    const json = (await cli(sb, ["db", "connections", "--json"])).json<{ items: Array<Record<string, unknown>> }>();
    expect(json.items[0]).toMatchObject({ procedure_call_refusal: { code: "write_privileges_block_procedure" } });
  });

  it("db queries shows that a query calls a procedure, and why it cannot run now", async () => {
    let one = await cli(sb, ["db", "queries", "stock_level"]);
    expect(one.stdout).toMatch(/^It calls a stored procedure: the model gets its first result set\./m);
    expect(one.stdout).not.toMatch(/Not now on/);
    connection.procedureCallRefusal = refusal("procedure_definition_writes");
    one = await cli(sb, ["db", "queries", "stock_level"]);
    expect(one.stdout).toMatch(/^Not now on erp-db: procedure_definition_writes \(The definition of the stored procedure/m);
    expect(one.stdout).toMatch(/cavelon explain <code> \(procedure_definition_writes\)/);
  });

  it("db test lists the procedure findings of a passing test, warns, explains their codes and still exits 0", async () => {
    connection.procedureFindings = [
      { query_id: query.id, slug: "stock_level", code: "procedure_definition_writes", message: "The procedure [inventory].[stock_level] updates [dbo].[stock]." },
      { query_id: randomUUID(), slug: "open_orders", code: "procedure_definition_unreadable", message: "The login may not read the definition of [dbo].[open_orders]." },
    ];
    const tested = await cli(sb, ["db", "test", "erp-db"]);
    expect(tested.code, tested.stderr).toBe(0);
    expect(tested.stdout).toMatch(/test passed/);
    expect(tested.stdout).toMatch(/^Stored-procedure queries whose procedure no longer passes/m);
    expect(tested.stdout).toMatch(/^stock_level\s+procedure_definition_writes\s+The procedure \[inventory\]\.\[stock_level\] updates/m);
    expect(tested.stdout).toMatch(/cavelon explain <code> \(procedure_definition_writes, procedure_definition_unreadable\)/);
    expect(tested.stderr).toMatch(/the procedure of 2 stored-procedure queries \(stock_level, open_orders\) no longer passes the instance's check/);
    const json = (await cli(sb, ["db", "test", "erp-db", "--json"])).json<{ procedure_findings: unknown[] }>();
    expect(json.procedure_findings).toHaveLength(2);
    expect(json.procedure_findings[0]).toMatchObject({ slug: "stock_level", code: "procedure_definition_writes" });
  });

  it("db test-run shows the instance's notice, and exits 3 when the procedure ended the transaction", async () => {
    const notice = "The procedure ended the connector's transaction (a COMMIT or ROLLBACK inside it): its writes may be committed in the customer's database. The query was switched off.";
    query.result = { error_code: "query_failed", notice };
    const run = await cli(sb, ["db", "test-run", "stock_level", "--value", "sku=4711", "--value", "warehouse=HAM"]);
    expect(run.code).toBe(3);
    expect(run.stdout).toMatch(/^notice:\s+The procedure ended the connector's transaction/m);
    expect(run.stdout).toMatch(/cavelon explain <code> \(query_failed\)/);
    const json = (await cli(sb, ["db", "test-run", "stock_level", "--value", "sku=4711", "--value", "warehouse=HAM", "--json"])).json<{ notice: string }>();
    expect(json.notice).toBe(notice);
  });

  it.each(["database_connection_untested", ...CONNECTION_CODES])("db test-run names the instance's refusal %s, the step that lifts it and explain; exit 4", async (code) => {
    query.refusal = code === "database_connection_untested" ? { code, message: "Test this SQL Server connection before saving a stored-procedure query." } : refusal(code);
    const refused = await cli(sb, ["db", "test-run", "stock_level", "--value", "sku=4711", "--value", "warehouse=HAM", "--json"]);
    expect(refused.code).toBe(4);
    const error = refused.json<{ error: { code: string; message: string; hint: string } }>().error;
    expect(error.code).toBe(code);
    expect(error.message).toContain(query.refusal.message.slice(0, 40));
    expect(error.hint).toMatch(new RegExp(`\`cavelon explain ${code}\` says more\\.$`));
    if (code === "write_privileges_block_procedure" || code === "database_connection_untested") expect(error.hint).toContain("cavelon db test erp-db");
  });
});

describe("an instance older than stored-procedure queries", () => {
  it("publishes none of the new fields, and the db commands say nothing of them", async () => {
    server.state.db.procedureFields = false;
    connection.procedureCallRefusal = refusal("write_privileges_block_procedure");
    connection.procedureFindings = [{ query_id: query.id, slug: "stock_level", code: "procedure_definition_writes", message: "writes" }];
    query.result = { columns: ["sku", "on_hand"], rows: [["4711", 12]], notice: "unpublished" };
    const listed = await cli(sb, ["db", "connections", "--json"], { env: fresh() });
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.json<{ items: Array<Record<string, unknown>> }>().items[0]).not.toHaveProperty("procedure_call_refusal");
    expect((await cli(sb, ["db", "connections"])).stdout).not.toMatch(/Stored-procedure/);
    expect((await cli(sb, ["db", "queries", "stock_level"])).stdout).not.toMatch(/Not now on/);
    const tested = await cli(sb, ["db", "test", "erp-db"]);
    expect(tested.code).toBe(0);
    expect(tested.stdout + tested.stderr).not.toMatch(/no longer passes/);
    const run = await cli(sb, ["db", "test-run", "stock_level", "--value", "sku=4711", "--value", "warehouse=HAM"]);
    expect(run.code).toBe(0);
    expect(run.stdout).not.toMatch(/notice/);
  });
});
