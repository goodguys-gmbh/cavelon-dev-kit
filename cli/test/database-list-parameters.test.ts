import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import type { ErrorCatalog, PackageSchema } from "../src/contracts.js";
import { listOutsideIn, schemaKnowsLists } from "../src/database-queries.js";
import { checkPackage } from "../src/package-check.js";
import { seedQueryTool, type FakeQuery } from "./fake-database.js";
import { CONTRACTS, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * A database query's list parameters (`list: true`, `max_items`), which the
 * instance binds one value per item in `IN (:name)`: they travel through pull,
 * fmt and apply unchanged; validate refuses what the instance refuses at save
 * time, with its codes; `db test-run` sends a list as a JSON array; a workflow
 * Tool Call node's declared input must carry an array; and an instance whose
 * schema has no `list` gets none of these checks. The fake server stands in
 * for the instance (simulated): no database and no model are involved.
 */

const read = (file: string) => readFileSync(file, "utf8");
const schema = JSON.parse(read(path.join(CONTRACTS, "meta-package-schema-v3.json"))) as PackageSchema;
const catalog = JSON.parse(read(path.join(CONTRACTS, "meta-error-catalog.json"))) as ErrorCatalog;
const SNAPSHOT_OFFER = (JSON.parse(read(path.join(CONTRACTS, "meta-capabilities.json"))) as { database_connector: Record<string, unknown> }).database_connector;

type Json = Record<string, any>;
type Found = { code: string; severity: string; path?: string; message: string; hint?: string };

const SKUS = { name: "skus", type: "string", list: true, max_items: 5, description: "Article numbers, e.g. X-1", max_length: 20 };
const LIST_SQL = "SELECT sku, qty FROM stock WHERE sku IN (:skus) LIMIT 50";

function listQuery(change: (query: Json) => void = () => {}): Json {
  const query: Json = { connection: { name: "shop-db", dialect: "postgresql" }, sql_text: LIST_SQL, parameters: [structuredClone(SKUS)], allows_anonymous: true };
  change(query);
  return query;
}

/** validate's findings for one query tool, in-process against the snapshot's schema and catalog. */
function checked(query: Json, published: PackageSchema = schema, extra: Json = {}): Found[] {
  const manifest = { package_version: "v3", exported_at: "2026-10-03T09:00:00Z", source_tenant_id: "00000000-0000-4000-8000-0000000000aa", source_tenant_slug: "acme", scope: "agent_graph", secrets_included: false, capabilities: [] };
  const pkg = { manifest, tools: [{ slug: "stock_of_skus", name: "Stock", tool_type: "database_query", scope: "tenant_local", database_query: query }], ...extra };
  return checkPackage({ package: pkg, sources: {}, findings: [], empty: false }, { schema: published, catalog }) as Found[];
}

/** The snapshot's schema as an instance without list parameters publishes it. */
function withoutLists(): PackageSchema {
  const older = structuredClone(schema) as Json;
  delete older.$defs.QueryParameter.properties.list;
  delete older.$defs.QueryParameter.properties.max_items;
  return older as PackageSchema;
}

describe("the published contract", () => {
  it("describes list and max_items on a query parameter and explains the five list codes", () => {
    const parameter = (schema.$defs as Json).QueryParameter.properties;
    expect(parameter.list.anyOf).toEqual([{ type: "boolean" }, { type: "null" }]);
    expect(parameter.max_items.anyOf[0]).toEqual({ maximum: 100, minimum: 1, type: "integer" });
    expect(schemaKnowsLists(schema)).toBe(true);
    expect(schemaKnowsLists(withoutLists())).toBe(false);
    const listed = catalog.api_error_codes.map((e) => e.code);
    for (const code of ["parameter_context_list", "parameter_list_type", "parameter_list_optional", "list_parameter_outside_in", "list_too_long_to_confirm"]) expect(listed).toContain(code);
  });
});

describe("validate", () => {
  it("passes a required list of string, integer, number or date, in IN or NOT IN, with or without max_items", () => {
    for (const type of ["string", "integer", "number", "date"]) {
      const query = listQuery((q) => {
        q.parameters = [{ name: "skus", type, list: true, description: "Values" }];
        q.sql_text = "SELECT sku FROM stock WHERE sku NOT IN ( /* the list */ :skus ) AND sku in (:skus) LIMIT 5";
      });
      expect(checked(query), type).toEqual([]);
    }
    expect(checked(listQuery())).toEqual([]);
  });

  it("refuses what the instance refuses at save time, by the instance's code and at the field", () => {
    const one = (change: (q: Json) => void) => checked(listQuery(change)).filter((f) => f.severity === "error");
    expect(one((q) => (q.parameters[0].type = "boolean")).map((f) => [f.code, f.path])).toEqual([["parameter_list_type", "tools[0].database_query.parameters[0].type"]]);
    expect(one((q) => (q.parameters[0].type = "datetime"))[0]!.code).toBe("parameter_list_type");
    expect(one((q) => (q.parameters[0].required = false)).map((f) => [f.code, f.path])).toEqual([["parameter_list_optional", "tools[0].database_query.parameters[0].required"]]);
    expect(one((q) => (q.parameters[0].list = false)).map((f) => [f.code, f.path])).toEqual([["parameter_constraint_not_applicable", "tools[0].database_query.parameters[0].max_items"]]);
    // The schema's own bound: at most 100.
    expect(one((q) => (q.parameters[0].max_items = 101)).length).toBeGreaterThan(0);
    const context = one((q) => {
      q.sql_text = "SELECT sku FROM stock WHERE sku IN (:skus) AND email = :email LIMIT 5";
      q.allows_anonymous = false;
      q.parameters.push({ name: "email", source: "end_user.email", type: "string", list: true });
    });
    expect(context.map((f) => [f.code, f.path])).toEqual([["parameter_context_list", "tools[0].database_query.parameters[1].list"]]);
    expect(context[0]!.hint).toBe("Remove list and max_items; the platform binds exactly one value from the verified identity.");
  });

  it("refuses a list placeholder anywhere but IN (:name) or NOT IN (:name), every use counted", () => {
    for (const sql of [
      "SELECT sku FROM stock WHERE sku = :skus LIMIT 5",
      "SELECT sku FROM stock WHERE sku IN (:skus, 'X-9') LIMIT 5",
      "SELECT sku FROM stock WHERE sku IN ((:skus)) LIMIT 5",
      "SELECT sku FROM stock WHERE sku IN (:skus) OR lower(sku) = :skus LIMIT 5",
      "SELECT sku FROM stock WHERE sku = ANY(:skus) LIMIT 5",
    ]) {
      const found = checked(listQuery((q) => (q.sql_text = sql))).filter((f) => f.code === "list_parameter_outside_in");
      expect(found.map((f) => [f.severity, f.path]), sql).toEqual([["error", "tools[0].database_query.sql_text"]]);
      expect(found[0]!.message).toBe('Query tool "stock_of_skus": The list parameter :skus may stand only as IN (:skus) or NOT IN (:skus).');
      expect(found[0]!.hint).toMatch(/^Write the list parameter as column IN \(:name\)/);
    }
    // A single value may stand anywhere, and a placeholder inside a literal is the instance's bind_in_literal, not this code.
    expect(checked(listQuery((q) => (q.parameters[0] = { name: "skus", type: "string", description: "One article" })), schema).map((f) => f.code)).toEqual([]);
    expect(listOutsideIn("SELECT 1 WHERE a IN (:skus) AND b = ':skus'", "postgresql", ["skus"])).toBeUndefined();
  });

  it("reads the SQL with the instance's tokenizer for each dialect", () => {
    // MySQL comments: "#" and "-- "; PostgreSQL: nested block comments and dollar-quoted strings; SQL Server: [identifiers].
    expect(listOutsideIn("SELECT a FROM t WHERE a IN # note\n(:skus) LIMIT 5", "mysql", ["skus"])).toBeUndefined();
    expect(listOutsideIn("SELECT a FROM t WHERE a IN -- note\n(:skus) LIMIT 5", "mysql", ["skus"])).toBeUndefined();
    expect(listOutsideIn("SELECT a FROM t WHERE a IN /* x /* y */ z */ (:skus) LIMIT 5", "postgresql", ["skus"])).toBeUndefined();
    expect(listOutsideIn("SELECT $$ = :skus $$, a FROM t WHERE a IN (:skus) LIMIT 5", "postgresql", ["skus"])).toBeUndefined();
    expect(listOutsideIn("SELECT TOP 5 [in] FROM t WHERE [in] = :skus", "mssql", ["skus"])).toBe("skus");
    expect(listOutsideIn("SELECT TOP 5 a FROM t WHERE a NOT IN (:skus)", "mssql", ["skus"])).toBeUndefined();
    // SQL the instance refuses with a code of its own first: the kit says nothing of the placement.
    expect(listOutsideIn("SELECT a FROM t WHERE a = :skus AND b = 'open", "postgresql", ["skus"])).toBeUndefined();
  });

  it("limits a write query that asks the person first to 20 list entries, the most its confirmation card shows", () => {
    const write = (confirm: boolean | undefined, maxItems?: number) =>
      checked(
        listQuery((q) => {
          q.kind = "write";
          q.sql_text = "UPDATE orders SET status = 'held' WHERE number IN (:skus)";
          if (confirm !== undefined) q.requires_confirmation = confirm;
          q.parameters[0].max_items = maxItems;
          if (maxItems === undefined) delete q.parameters[0].max_items;
        }),
      ).filter((f) => f.code === "list_too_long_to_confirm");
    const refused = write(undefined, 21);
    expect(refused.map((f) => [f.severity, f.path])).toEqual([["error", "tools[0].database_query.parameters[0].max_items"]]);
    expect(refused[0]!.hint).toMatch(/set max_items to 20 or less, or set requires_confirmation to false/);
    expect(write(true, 21)).toHaveLength(1);
    expect(write(true, 20)).toEqual([]);
    expect(write(true)).toEqual([]);
    expect(write(false, 100)).toEqual([]);
  });

  it("checks no list of its own on an instance whose schema has no list, and a single value as before", () => {
    const older = withoutLists();
    const listCodes = ["parameter_context_list", "parameter_list_type", "parameter_list_optional", "list_parameter_outside_in", "list_too_long_to_confirm"];
    const found = checked(listQuery((q) => (q.sql_text = "SELECT sku FROM stock WHERE sku = :skus LIMIT 5")), older);
    expect(found.filter((f) => listCodes.includes(f.code))).toEqual([]);
    // That instance's schema refuses the field itself.
    expect(found.some((f) => f.severity === "error")).toBe(true);
    const single = listQuery((q) => (q.parameters = [{ name: "skus", type: "boolean", required: false, description: "A flag" }]));
    single.sql_text = "SELECT sku FROM stock WHERE active = :skus LIMIT 5";
    expect(checked(single, older)).toEqual([]);
    expect(checked(single)).toEqual([]);
  });

  it("refuses a Tool Call node whose declared input cannot carry the list, or carries an array to a single value", () => {
    const node = (type: unknown, parameters: Json[] = [structuredClone(SKUS)]) => {
      const found = checked(listQuery((q) => (q.parameters = parameters)), schema, {
        registry_entities: { orchestration_nodes: [{ slug: "lookup", node_type: "tool_call", harness_slug: "shop", config: { tool_slug: "stock_of_skus", tool_type: "database_query", input_schema: { type: "object", properties: { skus: { type } }, required: ["skus"] } } }] },
      });
      return found.filter((f) => f.code === "invalid_arguments");
    };
    const scalar = node("string");
    expect(scalar.map((f) => [f.severity, f.path])).toEqual([["error", "registry_entities.orchestration_nodes[0].config.input_schema.properties.skus.type"]]);
    expect(scalar[0]!.message).toMatch(/takes a list there: a JSON array/);
    expect(scalar[0]!.hint).toMatch(/"type": "array"/);
    expect(node("array")).toEqual([]);
    expect(node(["array", "null"])).toEqual([]);
    expect(node(undefined)).toEqual([]);
    const single = [{ name: "skus", type: "string", description: "One article" }];
    expect(node("array", single)[0]!.message).toMatch(/takes a single value there, never an array/);
    expect(node("string", single)).toEqual([]);
  });
});

let server: FakeServer;
let sb: Sandbox;
let tenant: string;
let listed: FakeQuery;
let dirCount = 0;

const fresh = () => ({ CAVELON_CACHE_DIR: path.join(sb.home, `cache-${randomUUID()}`) });

describe("with an instance (simulated by the fake server)", () => {
  beforeAll(async () => {
    server = await startFakeServer();
    tenant = server.addTenant("acme", "Acme");
    sb = sandbox();
    server.state.features.database_connector_enabled = true;
    server.state.capsPatch = { database_connector: { ...SNAPSHOT_OFFER, dialects: ["postgresql"], may_write_queries: false } };
    await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, permissions: ["agents.view", "agents.edit", "harnesses.manage", "harnesses.view", "settings.view"] }));
    await cli(sb, ["harness", "new", "support", "--name", "Support"]);
    const seeded = seedQueryTool(server.state.db, tenant);
    listed = { ...seeded.query, id: randomUUID(), slug: "stock_of_skus", name: "Stock of articles", sql_text: LIST_SQL, parameters: [structuredClone(SKUS)], allows_anonymous: true };
    server.state.db.queries.push(listed);
    const tool = structuredClone(seeded.tool) as Json;
    Object.assign(tool, { slug: listed.slug, name: listed.name });
    tool.database_query = { ...tool.database_query, sql_text: LIST_SQL, parameters: [structuredClone(SKUS)], allows_anonymous: true };
    server.editConfig(tenant, (pkg) => (pkg.tools as Json[]).push(tool));
  });
  afterAll(async () => {
    await server.close();
    sb.cleanup();
  });
  beforeEach(() => {
    server.state.db.mayTest = true;
    server.state.db.testRuns.length = 0;
  });

  it("pull writes list and max_items into tools.yaml, fmt keeps them, validate passes and apply sends them unchanged", async () => {
    const dir = path.join(sb.home, `solution-${++dirCount}`);
    mkdirSync(dir, { recursive: true });
    expect((await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--harness", "support"], { cwd: dir })).code).toBe(0);
    expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
    const file = path.join(dir, "package", "tools.yaml");
    const parameters = () => (parse(read(file)) as Json[]).find((t) => t.slug === "stock_of_skus")!.database_query.parameters;
    expect(parameters()).toEqual([expect.objectContaining({ name: "skus", list: true, max_items: 5 })]);
    expect((await cli(sb, ["fmt"], { cwd: dir })).code).toBe(0);
    expect(parameters()).toEqual([expect.objectContaining({ name: "skus", list: true, max_items: 5 })]);
    const result = (await cli(sb, ["validate", "--json"], { cwd: dir })).json<{ error_count: number; findings: Found[] }>();
    expect(result.error_count, JSON.stringify(result.findings)).toBe(0);
    const preview = await cli(sb, ["apply", "--json"], { cwd: dir, env: fresh() });
    expect(preview.code, preview.stdout + preview.stderr).toBe(0);
    const sent = server.state.requests.filter((r) => r.path === "/api/v1/agent-graph/import/preview").pop()!.body as { package: { tools: Json[] } };
    expect(sent.package.tools.find((t) => t.slug === "stock_of_skus")!.database_query.parameters).toEqual([expect.objectContaining({ list: true, max_items: 5 })]);

    // A list moved out of IN is refused before anything is sent, with the instance's code and its explanation.
    const tools = parse(read(file)) as Json[];
    tools.find((t) => t.slug === "stock_of_skus")!.database_query.sql_text = "SELECT sku FROM stock WHERE sku = :skus LIMIT 5";
    writeFileSync(file, stringify(tools));
    const refused = (await cli(sb, ["validate", "--json"], { cwd: dir })).json<{ valid: boolean; findings: Found[] }>();
    expect(refused.valid).toBe(false);
    expect(refused.findings.find((f) => f.code === "list_parameter_outside_in")).toMatchObject({ severity: "error", hint: expect.stringContaining("NOT IN (:name)") });
  });

  it("shows a list parameter as a list of its type with its max_items", async () => {
    const one = await cli(sb, ["db", "queries", "stock_of_skus"]);
    expect(one.code, one.stderr).toBe(0);
    expect(one.stdout).toMatch(/^skus\s+model\s+list of string\s+yes\s+max_items 5, max_length 20/m);
  });

  it("test-runs a list as a JSON array, and refuses a value that is no array before sending, naming an item by position only", async () => {
    const ok = await cli(sb, ["db", "test-run", "stock_of_skus", "--value", 'skus=["X-1","X-2"]']);
    expect(ok.code, ok.stderr + ok.stdout).toBe(0);
    expect(server.state.db.testRuns[0]).toEqual({ query_id: listed.id, values: { skus: ["X-1", "X-2"] } });

    const sent = server.state.db.testRuns.length;
    for (const [raw, message] of [
      ["skus=X-1", /a list parameter takes a JSON array of string values/],
      ["skus=[]", /must hold at least 1 item/],
      ['skus=["1","2","3","4","5","6"]', /must hold at most 5 items/],
      ['skus=["X-1",7]', /item 2 is not a string/],
      ['skus=["X-1",null]', /item 2 is empty/],
    ] as const) {
      const refused = await cli(sb, ["db", "test-run", "stock_of_skus", "--value", raw, "--json"]);
      expect(refused.code, raw).toBe(2);
      const error = refused.json<{ error: { message: string; hint?: string } }>().error;
      expect(error.message, raw).toMatch(message);
      expect(error.message).not.toContain("X-1");
    }
    expect(server.state.db.testRuns.length).toBe(sent);
  });

  it("types each item of an integer list, and leaves a single value's text as it was", async () => {
    const numbers: FakeQuery = { ...listed, id: randomUUID(), slug: "by_ids", parameters: [{ name: "ids", type: "integer", list: true, description: "Order ids" }, { name: "note", type: "string", description: "Free text" }], sql_text: "SELECT id FROM orders WHERE id IN (:ids) AND note = :note LIMIT 5" };
    server.state.db.queries.push(numbers);
    try {
      const ok = await cli(sb, ["db", "test-run", "by_ids", "--value", "ids=[4711,4712]", "--value", 'note=["kept as text"]']);
      expect(ok.code, ok.stderr + ok.stdout).toBe(0);
      expect(server.state.db.testRuns[0]!.values).toEqual({ ids: [4711, 4712], note: '["kept as text"]' });
      const wrong = await cli(sb, ["db", "test-run", "by_ids", "--value", "ids=[4711,1.5]", "--value", "note=x", "--json"]);
      expect(wrong.json<{ error: { message: string } }>().error.message).toBe("--value ids: item 2 is not an integer.");
    } finally {
      server.state.db.queries = server.state.db.queries.filter((q) => q.id !== numbers.id);
    }
  });

  it("sends a list beyond what the kit checks and shows the instance's refusal, which names the position only (simulated)", async () => {
    // Without max_items in the query's answer, the kit leaves the count to the instance (20 by default).
    const unbounded: FakeQuery = { ...listed, id: randomUUID(), slug: "many", parameters: [{ name: "skus", type: "string", list: true, description: "Articles" }] };
    server.state.db.queries.push(unbounded);
    try {
      const values = JSON.stringify(Array.from({ length: 21 }, (_, i) => `X-${i}`));
      const refused = await cli(sb, ["db", "test-run", "many", "--value", `skus=${values}`, "--json"]);
      expect(refused.code).not.toBe(0);
      const error = refused.json<{ error: { code: string; message: string } }>().error;
      expect(error.code).toBe("invalid_arguments");
      expect(error.message).toMatch(/skus: must hold at most 20 items/);
      expect(error.message).not.toContain("X-1");
    } finally {
      server.state.db.queries = server.state.db.queries.filter((q) => q.id !== unbounded.id);
    }
  });

  it("keeps the scalar behavior for a query from an instance without lists", async () => {
    const older: FakeQuery = { ...listed, id: randomUUID(), slug: "older", parameters: [{ name: "skus", type: "string", description: "One article" }], sql_text: "SELECT sku FROM stock WHERE sku = :skus LIMIT 5" };
    server.state.db.queries.push(older);
    try {
      const ok = await cli(sb, ["db", "test-run", "older", "--value", 'skus=["X-1"]']);
      expect(ok.code, ok.stderr + ok.stdout).toBe(0);
      expect(server.state.db.testRuns[0]!.values).toEqual({ skus: '["X-1"]' });
    } finally {
      server.state.db.queries = server.state.db.queries.filter((q) => q.id !== older.id);
    }
  });

  it.each(["parameter_context_list", "parameter_list_type", "parameter_list_optional", "list_parameter_outside_in", "list_too_long_to_confirm"])("explains %s from the instance's catalog", async (code) => {
    const explained = await cli(sb, ["explain", code, "--json"]);
    expect(explained.code, explained.stdout).toBe(0);
    expect(explained.json()).toMatchObject({ code, kind: "api", docs: expect.stringContaining("database-connections") });
  });
});
