import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ErrorCatalog, PackageSchema } from "../src/contracts.js";
import { listOutsideIn, oracleQueryProblem } from "../src/database-queries.js";
import { operationAt, schemaErrors } from "../src/openapi.js";
import { COMMANDS } from "../src/commands/index.js";
import { inputSchema } from "../src/mcp.js";
import { checkPackage } from "../src/package-check.js";
import { CONTRACTS, openapiSnapshot, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * Oracle, the connector's fourth dialect: the published contracts name it,
 * `db connections create` and `db login-script` take it where the instance's
 * OpenAPI publishes it (and refuse it locally where an older instance does
 * not), and validate mirrors the instance's Oracle save-time refusals: PL/SQL,
 * DBMS_* and UTL_* packages, the URI types, database links and, in a write,
 * RETURNING, with q'…' literals read as text and a trailing semicolon
 * accepted. The other dialects keep their rules. The fake server stands in for
 * the instance (simulated): no database is contacted and no SQL runs.
 */

const read = (file: string) => readFileSync(file, "utf8");
const schema = JSON.parse(read(path.join(CONTRACTS, "meta-package-schema-v3.json"))) as PackageSchema;
const catalog = JSON.parse(read(path.join(CONTRACTS, "meta-error-catalog.json"))) as ErrorCatalog;

type Json = Record<string, any>;
type Found = { code: string; severity: string; path?: string; message: string };

const ORACLE_CODES = ["forbidden_keyword", "write_statement_refused"];

/** validate's findings for one query tool on an Oracle connection (or another dialect), in-process against the snapshot. */
function checked(sql: string, options: { dialect?: string; kind?: "read" | "write"; parameters?: Json[]; published?: PackageSchema } = {}): Found[] {
  const query: Json = {
    connection: { name: "erp-db", dialect: options.dialect ?? "oracle" },
    sql_text: sql,
    parameters: options.parameters ?? [{ name: "id", type: "integer", description: "Order number, e.g. 4711" }],
    ...(options.kind ? { kind: options.kind } : {}),
  };
  const manifest = { package_version: "v3", exported_at: "2026-10-09T09:00:00Z", source_tenant_id: "00000000-0000-4000-8000-0000000000aa", source_tenant_slug: "acme", scope: "agent_graph", secrets_included: false, capabilities: [] };
  const pkg = { manifest, tools: [{ slug: "order_status", name: "Order status", tool_type: "database_query", scope: "tenant_local", database_query: query }] };
  return checkPackage({ package: pkg, sources: {}, findings: [], empty: false }, { schema: options.published ?? schema, catalog }) as Found[];
}

const oracleFindings = (found: Found[]) => found.filter((f) => ORACLE_CODES.includes(f.code));

describe("the published contract", () => {
  it("names oracle in the dialect enums, the package schema and the catalog's refusals", () => {
    const doc = JSON.parse(openapiSnapshot());
    const enums = [
      operationAt(doc, "GET", "/api/v1/database-connectors/login-script")!.parameters!.find((p) => p.name === "dialect")!.schema!.enum,
      doc.components.schemas.DatabaseConnectionCreate.properties.dialect.enum,
      doc.components.schemas.DatabaseConnectionUpdate.properties.dialect.anyOf[0].enum,
      doc.components.schemas.DatabaseLoginScriptResponse.properties.dialect.enum,
    ];
    for (const values of enums) expect(values).toEqual(["postgresql", "mysql", "mssql", "oracle"]);
    const query = (schema.$defs as Json).PackageDatabaseQuery.properties;
    expect((schema.$defs as Json).PackageDatabaseConnectionRef.properties.dialect.description).toMatch(/mssql or oracle/);
    expect(query.sql_text.description).toMatch(/On an oracle connection also no PL\/SQL.*On oracle a write has no RETURNING\./s);
    const entry = (code: string) => catalog.api_error_codes.find((e) => e.code === code)!.message;
    expect(entry("forbidden_keyword")).toMatch(/on Oracle also a PL\/SQL block.*database link \(table@link\)/);
    expect(entry("write_statement_refused")).toMatch(/on Oracle also RETURNING, a DBMS_\* or UTL_\* package, PL\/SQL or a database link/);
  });
});

describe("validate mirrors the instance's Oracle refusals", () => {
  it.each([
    ["a PL/SQL declaration", "WITH FUNCTION twice(n NUMBER) RETURN NUMBER IS BEGIN RETURN n * 2 END SELECT twice(id) FROM orders WHERE id = :id", "FUNCTION is not allowed on Oracle"],
    ["a supplied package", "SELECT DBMS_RANDOM.VALUE, status FROM orders WHERE id = :id FETCH FIRST 5 ROWS ONLY", "may not call DBMS_RANDOM"],
    ["a network package", "SELECT UTL_HTTP.REQUEST('https://example.test') FROM orders WHERE id = :id", "may not call UTL_HTTP"],
    ["a package as a quoted identifier", 'SELECT "DBMS_LOCK".SLEEP(5) FROM orders WHERE id = :id', 'may not call "DBMS_LOCK"'],
    ["an URI type that fetches a URL", "SELECT HTTPURITYPE('https://example.test').GETCLOB() FROM orders WHERE id = :id", "HTTPURITYPE is not allowed on Oracle"],
    ["a database link", "SELECT status FROM orders@remote WHERE id = :id", "database link (table@link)"],
    ["a refusal before a trailing semicolon", "SELECT DBMS_RANDOM.VALUE FROM orders WHERE id = :id;", "may not call DBMS_RANDOM"],
  ])("warns of %s in a read (forbidden_keyword)", (_what, sql, said) => {
    const found = oracleFindings(checked(sql));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: "forbidden_keyword", severity: "warning", path: "tools[0].database_query.sql_text" });
    expect(found[0]!.message).toContain(said);
    expect(found[0]!.message).toMatch(/The instance refuses it when the query is saved \(forbidden_keyword\)\./);
  });

  it.each([
    ["RETURNING", "UPDATE orders SET status = 'cancelled' WHERE id = :id RETURNING status INTO :status", "may not hold RETURNING"],
    ["a supplied package", "UPDATE orders SET note = DBMS_RANDOM.STRING('x', 8) WHERE id = :id", "may not call DBMS_RANDOM"],
    ["a database link", "DELETE FROM orders@remote WHERE id = :id", "database link (table@link)"],
    ["transaction control", "UPDATE orders SET status = 'cancelled' WHERE id = :id AND COMMIT = 1", "may not hold COMMIT"],
  ])("warns of %s in a write (write_statement_refused)", (_what, sql, said) => {
    const parameters = [{ name: "id", type: "integer", description: "Order number, e.g. 4711" }, ...(sql.includes(":status") ? [{ name: "status", description: "Status" }] : [])];
    const found = oracleFindings(checked(sql, { kind: "write", parameters }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: "write_statement_refused", severity: "warning" });
    expect(found[0]!.message).toContain(said);
  });

  it.each([
    ["q'[…]' text", "SELECT q'[BEGIN DBMS_LOCK.SLEEP(1); orders@remote]' AS note, status FROM orders WHERE id = :id FETCH FIRST 1 ROWS ONLY"],
    ["q'{…}' text with a quote inside", "SELECT q'{It's UTL_FILE; COMMIT}' AS note FROM orders WHERE id = :id"],
    ["nq'!…!' text", "SELECT nq'!HTTPURITYPE @link!' AS note FROM orders WHERE id = :id"],
    ["plain string text", "SELECT 'BEGIN; DBMS_LOCK @link' AS note FROM orders WHERE id = :id"],
    ["comments", "SELECT status -- DBMS_LOCK.SLEEP and orders@remote\nFROM orders /* BEGIN */ WHERE id = :id"],
    ["a trailing semicolon", "SELECT status FROM orders WHERE id = :id FETCH FIRST 1 ROWS ONLY;"],
    ["a column named like a write word in a read", "SELECT returning FROM orders WHERE id = :id"],
  ])("finds nothing in %s", (_what, sql) => {
    expect(oracleFindings(checked(sql))).toEqual([]);
  });

  it("accepts a write whose quoted text holds the refused words, with a trailing semicolon", () => {
    expect(oracleFindings(checked("UPDATE orders SET note = q'[it's done; RETURNING via DBMS_X@link]' WHERE id = :id;", { kind: "write" }))).toEqual([]);
  });

  it("leaves to the instance SQL it refuses with another code first", () => {
    // multiple_statements, locking_clause, a common forbidden keyword, not_select and an unclosed q-literal.
    for (const sql of [
      "SELECT 1 FROM dual; SELECT DBMS_RANDOM.VALUE FROM orders WHERE id = :id",
      "SELECT DBMS_RANDOM.VALUE FROM orders WHERE id = :id FOR UPDATE",
      "SELECT DBMS_RANDOM.VALUE INTO x FROM orders WHERE id = :id",
      "BEGIN DBMS_LOCK.SLEEP(:id); END;",
      "SELECT q'[DBMS_RANDOM FROM orders WHERE id = :id",
    ]) expect(oracleFindings(checked(sql)), sql).toEqual([]);
  });

  it("reads q'…' literals as text for list placement", () => {
    const sql = "SELECT a FROM t WHERE note = q'[it's]' AND a = :skus";
    expect(listOutsideIn(sql, "oracle", ["skus"])).toBe("skus");
    expect(listOutsideIn("SELECT a FROM t WHERE note = q'[it's :skus]' AND a IN (:skus)", "oracle", ["skus"])).toBeUndefined();
  });
});

describe("the other dialects keep their rules", () => {
  it.each(["postgresql", "mysql", "mssql"])("%s gets no Oracle refusal", (dialect) => {
    expect(oracleFindings(checked("SELECT DBMS_RANDOM.VALUE, BEGIN FROM orders WHERE id = :id", { dialect }))).toEqual([]);
    expect(oracleFindings(checked("UPDATE orders SET status = 'x' WHERE id = :id RETURNING status", { dialect, kind: "write" }))).toEqual([]);
    expect(oracleQueryProblem("SELECT * FROM orders@remote", dialect, false)).toBeUndefined();
  });

  it("does not read q'…' as a literal outside Oracle", () => {
    // On PostgreSQL the quote after q opens a plain string, so the list placeholder after it is placed.
    expect(listOutsideIn("SELECT a FROM t WHERE note = q'[x]' AND a IN (:skus)", "postgresql", ["skus"])).toBeUndefined();
    expect(oracleQueryProblem("SELECT DBMS_RANDOM.VALUE FROM dual", undefined, false)).toBeUndefined();
  });

  it("still refuses an EXEC on oracle as not_select", () => {
    const found = checked("EXEC [dbo].[stock] @id = :id");
    expect(found.find((f) => f.code === "not_select")?.message).toMatch(/on oracle the instance refuses it \(not_select\)/);
    expect(oracleFindings(found)).toEqual([]);
  });

  it("checks an Oracle read on an instance whose schema has no write kind, and treats every query as a read", () => {
    const older = structuredClone(schema) as Json;
    delete older.$defs.PackageDatabaseQuery.properties.kind;
    expect(oracleFindings(checked("SELECT DBMS_RANDOM.VALUE FROM orders WHERE id = :id", { published: older as PackageSchema }))[0]?.code).toBe("forbidden_keyword");
    expect(oracleFindings(checked("UPDATE orders SET status = 'x' WHERE id = :id RETURNING status", { kind: "write", published: older as PackageSchema }))).toEqual([]);
  });
});

describe("connections and login scripts", () => {
  let server: FakeServer;
  let sb: Sandbox;
  const route = "/api/v1/database-connectors/connections";
  const create = ["db", "connections", "create", "erp-db", "--dialect", "oracle", "--host", "db.example.test", "--port", "2484", "--database-name", "ERPPDB", "--username", "cavelon_ro", "--json"];
  const fresh = () => ({ CAVELON_CACHE_DIR: path.join(sb.home, randomUUID()) });

  beforeEach(async () => {
    server = await startFakeServer();
    const tenant = server.addTenant("acme");
    server.state.features.database_connector_enabled = true;
    server.state.db.instance.runnable_dialects = ["mssql", "mysql", "oracle", "postgresql"];
    sb = sandbox();
    await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, permissions: ["database_connectors.view", "database_connectors.manage"] }));
  });
  afterEach(async () => { await server.close(); sb.cleanup(); });

  it("creates an Oracle connection the published schema accepts, and lists the dialect the instance runs", async () => {
    const result = await cli(sb, create, { env: fresh() });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const body = server.state.requests.filter((r) => r.method === "POST" && r.path === route)[0]!.body;
    expect(body).toMatchObject({ dialect: "oracle", port: 2484, database_name: "ERPPDB" });
    const doc = JSON.parse(openapiSnapshot());
    expect(schemaErrors(doc, operationAt(doc, "POST", route)!.requestBody!.content["application/json"]!.schema!, body)).toEqual([]);
    expect(schemaErrors(doc, operationAt(doc, "POST", route)!.responses["201"]!.content!["application/json"]!.schema!, result.json<Json>().connection)).toEqual([]);
    const instance = await cli(sb, ["db", "instance", "--json"], { env: fresh() });
    expect(instance.json<Json>().runnable_dialects).toContain("oracle");
  });

  it("prints the Oracle login script with the instance's schema placeholder and enforced limit", async () => {
    const result = await cli(sb, ["db", "login-script", "oracle", "--database-name", "ERPPDB", "--username", "cavelon_ro", "--json"], { env: fresh() });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const doc = JSON.parse(openapiSnapshot());
    expect(schemaErrors(doc, operationAt(doc, "GET", "/api/v1/database-connectors/login-script")!.responses["200"]!.content!["application/json"]!.schema!, result.json())).toEqual([]);
    expect(result.json()).toMatchObject({ dialect: "oracle", kind: "read_only", schema: "YOUR_SCHEMA", connection_limit_enforced: true });
    const sent = server.state.requests.find((r) => r.path === "/api/v1/database-connectors/login-script")!;
    expect(Object.fromEntries(sent.query)).toMatchObject({ dialect: "oracle", database_name: "ERPPDB", username: "cavelon_ro" });
    const text = await cli(sb, ["db", "login-script", "oracle", "--schema", "ERP"], { env: fresh() });
    expect(text.stdout).toMatch(/schema:\s+ERP/);
  });

  it("takes the dialect as --dialect too, once, and never beside --connection", async () => {
    const named = await cli(sb, ["db", "login-script", "--dialect", "oracle", "--database-name", "ERPPDB", "--json"], { env: fresh() });
    expect(named.code, named.stdout + named.stderr).toBe(0);
    expect(named.json()).toMatchObject({ dialect: "oracle", schema: "YOUR_SCHEMA" });
    const before = server.state.requests.length;
    for (const args of [["oracle", "--dialect", "oracle"], ["mysql", "--dialect", "oracle"], ["--dialect", "oracle", "--connection", "erp-db"], []]) {
      const refused = await cli(sb, ["db", "login-script", ...args, "--json"], { env: fresh() });
      expect(refused.code, args.join(" ")).toBe(2);
    }
    expect(server.state.requests.slice(before).filter((r) => r.path.includes("login-script"))).toEqual([]);
    // The MCP tool keeps its one dialect argument.
    const tool = inputSchema(COMMANDS.find((c) => c.name === "db login-script")!) as Json;
    expect(tool.properties.dialect.description).toMatch(/^Database dialect; omit only with connection/);
  });

  it("refuses oracle locally on an instance whose OpenAPI does not publish it, sending nothing", async () => {
    server.state.oracleDialect = false;
    const result = await cli(sb, create, { env: fresh() });
    expect(result.code).toBe(3);
    expect(result.stderr + result.stdout).toMatch(/dialect/);
    expect(server.state.requests.filter((r) => r.method === "POST" && r.path === route)).toEqual([]);
    expect((await cli(sb, [...create.slice(0, 5), "postgresql", ...create.slice(6)], { env: fresh() })).code).toBe(0);
  });
});
