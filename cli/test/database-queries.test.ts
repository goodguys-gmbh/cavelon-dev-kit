import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { bindNames } from "../src/database-queries.js";
import { queryErrorCode } from "../src/trace-view.js";
import { adminImport, seedQueryTool, type FakeQuery } from "./fake-database.js";
import { CONTRACTS, startFakeServer, traceFixture, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * A solution whose agent calls a saved database query as a tool: pull writes
 * the query into the package, validate checks it and names what an apply
 * would change, apply says before the preview that a token cannot change a
 * query and how to apply the rest, the db commands read the connections,
 * queries and runs, and trace shows the code a failed query call answered.
 */

let server: FakeServer;
let sb: Sandbox;
let tenant: string;
let seeded: ReturnType<typeof seedQueryTool>;
let dirCount = 0;

const read = (file: string) => readFileSync(file, "utf8");
const SNAPSHOT_OFFER = (JSON.parse(read(path.join(CONTRACTS, "meta-capabilities.json"))) as { database_connector: Record<string, unknown> }).database_connector;

type Tool = Record<string, any>;
type Found = { code: string; severity: string; file?: string; line?: number; path?: string; message: string; hint?: string };
type Validated = { valid: boolean; error_count: number; warning_count: number; findings: Found[] };

/** The connector on, as an instance that runs PostgreSQL queries publishes it; a token never may write queries. */
function connectorOn(): void {
  server.state.features.database_connector_enabled = true;
  server.state.capsPatch = { database_connector: { ...SNAPSHOT_OFFER, dialects: ["postgresql"], may_write_queries: false } };
}

/** A fresh cache, so a command reads the capabilities a test just changed. */
const fresh = () => ({ CAVELON_CACHE_DIR: path.join(sb.home, `cache-${randomUUID()}`) });

async function pulled(): Promise<string> {
  const dir = path.join(sb.home, `solution-${++dirCount}`);
  mkdirSync(dir, { recursive: true });
  const init = await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--harness", "support"], { cwd: dir });
  expect(init.code, init.stderr + init.stdout).toBe(0);
  const pull = await cli(sb, ["pull"], { cwd: dir });
  expect(pull.code, pull.stderr + pull.stdout).toBe(0);
  return dir;
}

const toolsFile = (dir: string) => path.join(dir, "package", "tools.yaml");

function editTool(dir: string, slug: string, change: (tool: Tool) => void): void {
  const tools = parse(read(toolsFile(dir))) as Tool[];
  change(tools.find((t) => t.slug === slug)!);
  writeFileSync(toolsFile(dir), stringify(tools));
}

async function validated(dir: string, extra: string[] = []): Promise<Validated> {
  return (await cli(sb, ["validate", "--json", ...extra], { cwd: dir })).json<Validated>();
}

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  sb = sandbox();
  // On before anything is cached: a test that switches it off reads with a fresh cache.
  connectorOn();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
  await cli(sb, ["harness", "new", "support", "--name", "Support"]);
  seeded = seedQueryTool(server.state.db, tenant);
  server.editConfig(tenant, (pkg) => {
    (pkg.tools as Tool[]).push(structuredClone(seeded.tool));
    const agent = (pkg.agents as Tool[])[0]!;
    agent.tool_assignments = [{ tool_slug: "order_status", config_overrides: { max_calls: 3 } }];
  });
});
afterAll(async () => {
  await server.close();
  sb.cleanup();
});
beforeEach(() => {
  connectorOn();
  server.state.db.mayTest = true;
});

describe("round trip", () => {
  it("pull writes the query into package/tools.yaml; fmt keeps it; validate passes; apply sends it and the unchanged query passes the gate", async () => {
    const dir = await pulled();
    const tool = (parse(read(toolsFile(dir))) as Tool[]).find((t) => t.slug === "order_status")!;
    expect(tool).toMatchObject({ tool_type: "database_query", database_query: { connection: { name: "shop-db", dialect: "postgresql" }, sql_text: seeded.query.sql_text } });
    expect(JSON.parse(read(path.join(dir, ".cavelon", "database-queries.json")))).toMatchObject({ by: "pull", tools: { order_status: { name: "Order status" } } });

    expect((await cli(sb, ["fmt"], { cwd: dir })).code).toBe(0);
    const formatted = (parse(read(toolsFile(dir))) as Tool[]).find((t) => t.slug === "order_status")!;
    expect(formatted.database_query).toMatchObject({ sql_text: seeded.query.sql_text, parameters: [{ name: "order_no" }, { name: "email", source: "end_user.email" }] });

    const result = await validated(dir);
    expect(result.error_count, JSON.stringify(result.findings)).toBe(0);
    expect(result.findings.filter((f) => f.code.startsWith("database_query"))).toEqual([]);

    const preview = await cli(sb, ["apply", "--json"], { cwd: dir, env: fresh() });
    expect(preview.code, preview.stdout + preview.stderr).toBe(0);
    const sent = server.state.requests.filter((r) => r.path === "/api/v1/agent-graph/import/preview").pop()!.body as { package: { tools: Tool[] } };
    expect(sent.package.tools.find((t) => t.slug === "order_status")!.database_query.sql_text).toBe(seeded.query.sql_text);
    expect(preview.json<{ database_queries: Record<string, unknown> }>().database_queries).toMatchObject({ tools: ["order_status"], changed: [], may_write_queries: false, connector_enabled: true });
  });
});

describe("validate", () => {
  it("checks the SQL's placeholders against the parameters, and each parameter, with the instance's codes, file and line", async () => {
    const dir = await pulled();
    editTool(dir, "order_status", (t) => {
      t.database_query.sql_text = "SELECT number FROM orders WHERE number = :order_no AND customer = :customer AND created::date > now() - interval '1 day' LIMIT 5";
      t.database_query.parameters = [
        { name: "order_no", type: "string", minimum: 1, description: "Order number" },
        { name: "email", source: "end_user.email", type: "integer" },
        { name: "days", type: "integer", minimum: 9, maximum: 1 },
      ];
      t.database_query.allows_anonymous = true;
    });
    const result = await validated(dir, ["--offline"]);
    const codes = result.findings.filter((f) => f.severity === "error").map((f) => f.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "bind_mismatch",
        "parameter_constraint_not_applicable",
        "parameter_context_not_string",
        "parameter_description_missing",
        "parameter_bounds_inverted",
        "anonymous_with_context_parameter",
      ]),
    );
    const bind = result.findings.find((f) => f.code === "bind_mismatch")!;
    expect(bind.message).toBe(
      'Query tool "order_status": The SQL and its parameters disagree; placeholders without a declared parameter: :customer; declared parameters the SQL never uses: days, email.',
    );
    expect(bind).toMatchObject({ file: "package/tools.yaml", path: expect.stringMatching(/sql_text$/) });
    expect(read(path.join(dir, bind.file!)).split("\n")[bind.line! - 1]).toMatch(/sql_text:/);
    // The instance's catalog explains its own codes.
    expect(bind.hint).toBe("Declare exactly one parameter per placeholder, and no parameter the SQL does not use.");
    expect(result.valid).toBe(false);
  });

  it("names a changed query, name or description as needing a superadmin, an edited derived field as ignored, and an assignment override as no change", async () => {
    const dir = await pulled();
    editTool(dir, "order_status", (t) => {
      t.description = "The status of an order.";
      t.database_query.max_rows = 10;
      t.params_json_schema = { type: "object", properties: {} };
    });
    const agents = path.join(dir, "package", "agents.yaml");
    writeFileSync(agents, read(agents).replace("max_calls: 3", "max_calls: 5\n        name: Look up an order"));
    const result = await validated(dir);
    const changed = result.findings.filter((f) => f.code === "database_query_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]!.message).toMatch(/^Query tool "order_status" changes its description, query \(database_query\) since the last pull: a query tool's own name and description belong to the query/);
    expect(changed[0]!.message).toMatch(/blocks it \(database_query_needs_superadmin\)\. An agent's or skill's override of the tool's name, description or max_calls is no query change\.$/);
    expect(changed[0]).toMatchObject({ severity: "warning", file: "package/tools.yaml" });
    expect(changed[0]!.hint).toMatch(/remove its database_query block/);
    const ignored = result.findings.find((f) => f.code === "database_query_fields_ignored")!;
    expect(ignored.message).toBe('Query tool "order_status" changes its params_json_schema; the instance derives it from the query\'s parameters and ignores the package\'s.');
    expect(result.error_count).toBe(0);
    expect((await cli(sb, ["validate", "--strict"], { cwd: dir })).code).toBe(3);
    expect((await cli(sb, ["explain", "database_query_changed", "--json"])).json()).toMatchObject({ code: "database_query_changed", kind: "kit" });
  });

  it("calls a query tool the last pull did not hold new, and a tool without its query no change", async () => {
    const dir = await pulled();
    const tools = parse(read(toolsFile(dir))) as Tool[];
    const copy = structuredClone(tools.find((t) => t.slug === "order_status")!);
    copy.slug = "order_count";
    tools.push(copy);
    delete tools.find((t) => t.slug === "order_status")!.database_query;
    writeFileSync(toolsFile(dir), stringify(tools));
    const changed = (await validated(dir)).findings.filter((f) => f.code === "database_query_changed");
    expect(changed.map((f) => f.message)).toEqual([expect.stringMatching(/^Query tool "order_count" is new since the last pull: creating a query needs a superadmin in the Admin/)]);
  });

  it("checks nothing of its own where the instance's schema has no database_query", async () => {
    const dir = await pulled();
    editTool(dir, "order_status", (t) => (t.database_query.sql_text = "SELECT :nothing"));
    server.state.packageSchemaEdit = (schema) => {
      delete (schema as unknown as { $defs: Record<string, any> }).$defs.PackageTool.properties.database_query;
    };
    try {
      const older = (await cli(sb, ["validate", "--json"], { cwd: dir, env: fresh() })).json<Validated>();
      expect(older.findings.filter((f) => f.code === "bind_mismatch" || f.code.startsWith("database_query"))).toEqual([]);
      expect(older.error_count).toBe(0);
    } finally {
      server.state.packageSchemaEdit = null;
    }
  });

  it("reads the placeholders the instance binds: a cast and an escaped colon bind nothing", () => {
    expect(bindNames("SELECT a::int, '\\:x', b FROM t WHERE c = :c AND d = :d AND e = :c")).toEqual(["c", "d"]);
    expect(bindNames("SELECT * FROM t WHERE name = :näme")).toEqual(["näme"]);
  });
});

describe("apply", () => {
  it("says before the preview that this token may not change the query and that it stops the whole import, then shows the blocker with its file and the step in the Admin", async () => {
    const dir = await pulled();
    editTool(dir, "order_status", (t) => (t.database_query.max_rows = 10));
    const preview = await cli(sb, ["apply"], { cwd: dir, env: fresh() });
    expect(preview.code, preview.stdout).toBe(3);
    expect(preview.stderr).toMatch(/This apply would create or change the database query "order_status", which this credential may not do \(may_write_queries is false\)/);
    expect(preview.stderr).toMatch(/one blocked query stops the whole import\. A superadmin in Tenant mode, signed in to the Admin/);
    expect(preview.stdout).toMatch(/database_query_needs_superadmin/);
    expect(preview.stdout).toMatch(/package\/tools\.yaml:\d+/);
    expect(preview.stdout).toMatch(/hint: A database query the import would create or change stops the whole import: nothing is applied while one blocks\./);
    expect(preview.stdout).toMatch(/remove its database_query block \(the tool then keeps the instance's query, name and description\)/);

    const json = (await cli(sb, ["apply", "--json"], { cwd: dir, env: fresh() })).json<Record<string, any>>();
    expect(json.database_queries.changed).toEqual([{ slug: "order_status", created: false, fields: ["database_query"] }]);
    expect(json.blocker_details[0]).toMatchObject({ code: "database_query_needs_superadmin", path: "tools[1].database_query", file: "package/tools.yaml" });
    expect(json.database_query_hint).toMatch(/in package\/tools\.yaml/);
  });

  it("applies the rest once the changed query's database_query block is gone, and keeps the query remembered as the instance holds it", async () => {
    const dir = await pulled();
    editTool(dir, "order_status", (t) => {
      delete t.database_query;
      t.name = "Order status (renamed)";
    });
    const agents = path.join(dir, "package", "agents.yaml");
    writeFileSync(agents, read(agents).replace("Answer from the handbook.", "Answer from the handbook and the order database."));
    const preview = await cli(sb, ["apply", "--json"], { cwd: dir, env: fresh() });
    expect(preview.code, preview.stdout).toBe(0);
    const id = preview.json<{ preview_id: string }>().preview_id;
    expect((await cli(sb, ["apply", "--confirm", id], { cwd: dir })).code).toBe(0);
    const remembered = JSON.parse(read(path.join(dir, ".cavelon", "database-queries.json")));
    expect(remembered).toMatchObject({ by: "apply", tools: { order_status: { name: "Order status", database_query: { sql_text: seeded.query.sql_text } } } });
  });

  it("warns when the connector is off or the instance runs another dialect", async () => {
    const dir = await pulled();
    server.state.features.database_connector_enabled = false;
    let preview = await cli(sb, ["apply"], { cwd: dir, env: fresh() });
    expect(preview.stderr).toMatch(/this instance has the database connector switched off \(DATABASE_CONNECTOR_ENABLED\): the import may carry them, but no agent gets a database tool/);
    connectorOn();
    server.state.capsPatch = { database_connector: { ...SNAPSHOT_OFFER, dialects: ["mysql"], may_write_queries: false } };
    preview = await cli(sb, ["apply"], { cwd: dir, env: fresh() });
    expect(preview.stderr).toMatch(/This instance runs only mysql queries; "order_status" names another dialect/);
    // A SQL Server query: fine where the instance runs mssql, warned where it runs only the others.
    editTool(dir, "order_status", (t) => (t.database_query.connection.dialect = "mssql"));
    server.state.capsPatch = { database_connector: { ...SNAPSHOT_OFFER, dialects: ["mssql", "mysql", "postgresql"], may_write_queries: false } };
    preview = await cli(sb, ["apply"], { cwd: dir, env: fresh() });
    expect(preview.stderr).not.toMatch(/names another dialect/);
    server.state.capsPatch = { database_connector: { ...SNAPSHOT_OFFER, dialects: ["mysql", "postgresql"], may_write_queries: false } };
    preview = await cli(sb, ["apply"], { cwd: dir, env: fresh() });
    expect(preview.stderr).toMatch(/This instance runs only mysql, postgresql queries; "order_status" names another dialect/);
    connectorOn();
  });

  it("says nothing of queries on an instance that publishes neither the switch nor the offer", async () => {
    const dir = await pulled();
    delete server.state.features.database_connector_enabled;
    server.state.capsPatch = { database_connector: undefined, features: undefined };
    const caps = JSON.parse(read(path.join(CONTRACTS, "meta-capabilities.json")));
    delete caps.features.database_connector_enabled;
    server.state.capsPatch = { database_connector: undefined, features: caps.features };
    editTool(dir, "order_status", (t) => (t.database_query.max_rows = 10));
    const preview = await cli(sb, ["apply", "--json"], { cwd: dir, env: fresh() });
    const data = preview.json<{ warnings: string[]; database_queries: Record<string, unknown> }>();
    expect(data.warnings.filter((w) => /database/.test(w))).toEqual([]);
    expect(data.database_queries).toMatchObject({ connector_enabled: null, may_write_queries: null });
  });
});

describe("db commands", () => {
  it("list the connections, the queries and one query in full; never a password", async () => {
    const connections = await cli(sb, ["db", "connections"], { env: fresh() });
    expect(connections.code, connections.stderr).toBe(0);
    expect(connections.stdout).toMatch(/^shop-db\s+postgresql\s+db\.example\.test:5432\/shop\s+verify_full\s+yes\s+ok/m);
    expect(connections.stdout).not.toMatch(/password/i);
    const queries = await cli(sb, ["db", "queries", "--connection", "shop-db"]);
    expect(queries.stdout).toMatch(/^order_status\s+Order status\s+shop-db\s+order_no, email \(end_user\.email\)\s+5\s+no\s+yes\s+1$/m);
    const listed = (await cli(sb, ["db", "queries", "--json"])).json<{ items: Array<Record<string, unknown>> }>();
    expect(listed.items[0]).not.toHaveProperty("sql_text");
    const one = await cli(sb, ["db", "queries", "order_status"]);
    expect(one.stdout).toContain(seeded.query.sql_text);
    expect(one.stdout).toMatch(/^email\s+end_user\.email\s+string\s+yes/m);
    expect(one.stdout).toMatch(/Its runs \(no values, no rows\): cavelon db runs order_status/);
  });

  it("says the dialects the instance runs and the egress addresses a database's firewall lets in", async () => {
    const shown = await cli(sb, ["db", "instance"], { env: fresh() });
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toMatch(/^dialects:\s+mssql, mysql, postgresql$/m);
    expect(shown.stdout).toMatch(/^egress_ips:\s+203\.0\.113\.10, 203\.0\.113\.11$/m);
    expect(shown.stdout).toMatch(/Allow 203\.0\.113\.10, 203\.0\.113\.11 through the database's firewall, on the database's port/);
    expect(shown.stdout).toMatch(/opens at most 5 connections per database connection/);
    const json = (await cli(sb, ["db", "instance", "--json"])).json<Record<string, unknown>>();
    expect(json).toMatchObject({ published: true, runnable_dialects: ["mssql", "mysql", "postgresql"], network: { egress_ips: ["203.0.113.10", "203.0.113.11"], connections_per_process: 5 } });
    expect(json.firewall).toMatch(/^Allow 203\.0\.113\.10/);
    const before = server.state.db.instance;
    server.state.db.instance = { runnable_dialects: ["postgresql"], network: { egress_ips: [], connections_per_process: 1 } };
    try {
      const unnamed = await cli(sb, ["db", "instance"]);
      expect(unnamed.stdout).toMatch(/^egress_ips:\s+none named$/m);
      expect(unnamed.stdout).toMatch(/has named no addresses it connects from, so it does not say what to allowlist: ask the operator/);
    } finally {
      server.state.db.instance = before;
    }
  });

  it("db instance falls back to the capabilities' dialects on an instance without the route", async () => {
    server.state.openapiWithout = ["GET /api/v1/database-connectors/instance"];
    try {
      const older = await cli(sb, ["db", "instance", "--json"], { env: fresh() });
      expect(older.code, older.stderr).toBe(0);
      expect(older.json()).toEqual({ published: false, runnable_dialects: ["postgresql"], network: null });
      const text = await cli(sb, ["db", "instance"], { env: fresh() });
      expect(text.stdout).toMatch(/does not publish which addresses it connects to databases from[\s\S]*Dialects it runs: postgresql/);
    } finally {
      server.state.openapiWithout = [];
    }
  });

  it("names the view permission when the token's role may not read the connector", async () => {
    server.state.db.mayView = false;
    try {
      for (const args of [["db", "instance"], ["db", "connections"]]) {
        const refused = await cli(sb, [...args, "--json"], { env: fresh() });
        expect(refused.code, args.join(" ")).not.toBe(0);
        expect(refused.json<{ error: { hint: string } }>().error.hint).toMatch(/^Reading the database connector needs database_connectors\.view/);
      }
    } finally {
      server.state.db.mayView = true;
    }
  });

  it("shows each connection's CA certificates and warns of one that expires within 30 days or has expired", async () => {
    const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
    seeded.connection.caCertificates = [
      { subject: "CN=Shop Root CA", issuer: "CN=Shop Root CA", not_before: "2026-01-01T00:00:00Z", not_after: inDays(400), sha256: "AA:BB" },
      { subject: "CN=Shop Intermediate", issuer: "CN=Shop Root CA", not_before: "2026-01-01T00:00:00Z", not_after: inDays(12.5), sha256: "CC:DD" },
    ];
    try {
      const listed = await cli(sb, ["db", "connections"], { env: fresh() });
      expect(listed.code, listed.stderr).toBe(0);
      expect(listed.stdout).toMatch(/^CA certificates:$/m);
      expect(listed.stdout).toContain(`shop-db: CN=Shop Root CA, valid until ${inDays(400).slice(0, 10)}`);
      expect(listed.stderr).toMatch(/The CA certificate "CN=Shop Intermediate" of the database connection "shop-db" expires on \S+ \(in 12 days\): from then its TLS check fails/);
      expect(listed.stderr).not.toMatch(/Shop Root CA" of/);
      seeded.connection.caCertificates[1]!.not_after = inDays(-3);
      const json = (await cli(sb, ["db", "connections", "--json"])).json<{ items: Array<Record<string, unknown>>; warnings: string[] }>();
      expect(json.items[0]!.ca_certificates).toHaveLength(2);
      expect(json.items[0]).not.toHaveProperty("ca_certificate_pem");
      expect(json.warnings).toEqual([expect.stringMatching(/"CN=Shop Intermediate" of the database connection "shop-db" expired on .*cavelon db test shop-db$/)]);
      // An instance that publishes only the fingerprints: the CA is named as set, nothing is warned.
      seeded.connection.caDetails = false;
      const older = await cli(sb, ["db", "connections"]);
      expect(older.stdout).toMatch(/^shop-db: a CA is set \(2 certificates\); this instance does not publish their subject or expiry$/m);
      expect(older.stderr).not.toMatch(/CA certificate/);
    } finally {
      delete seeded.connection.caCertificates;
      delete seeded.connection.caDetails;
    }
  });

  it("names a connection whose queries cannot be enabled, with the instance's code, and explains it", async () => {
    seeded.connection.queryEnableRefusal = {
      code: "write_privileges_unacknowledged",
      message: "The connection's last test found that its login can write, and SQL Server has no read-only transaction.",
    };
    try {
      const listed = await cli(sb, ["db", "connections"], { env: fresh() });
      expect(listed.stdout).toMatch(/^Queries cannot be enabled on: shop-db \(write_privileges_unacknowledged: The connection's last test found/m);
      expect(listed.stdout).toMatch(/cavelon explain <code> \(write_privileges_unacknowledged\)/);
      const json = (await cli(sb, ["db", "connections", "--json"])).json<{ items: Array<Record<string, unknown>> }>();
      expect(json.items[0]).toMatchObject({ write_privileges_acknowledged: false, query_enable_refusal: { code: "write_privileges_unacknowledged" } });
    } finally {
      delete seeded.connection.queryEnableRefusal;
    }
    const explained = await cli(sb, ["explain", "write_privileges_unacknowledged", "--json"]);
    expect(explained.code, explained.stderr).toBe(0);
    expect(explained.json<{ code: string; message: string; hint: string }>()).toMatchObject({
      code: "write_privileges_unacknowledged",
      message: expect.stringContaining("SQL Server"),
      hint: expect.stringContaining("a superadmin acknowledges"),
    });
  });

  it("tests a connection, and exits 3 with the failed step's code when a step fails", async () => {
    const passed = await cli(sb, ["db", "test", "shop-db"]);
    expect(passed.code, passed.stderr).toBe(0);
    expect(passed.stdout).toMatch(/Connection "shop-db" \(postgresql\): test passed/);
    seeded.connection.testSteps = [
      { name: "dns", status: "ok", code: null },
      { name: "policy", status: "failed", code: "non_public_address" },
    ];
    try {
      const failed = await cli(sb, ["db", "test", "shop-db", "--json"]);
      expect(failed.code).toBe(3);
      expect(failed.json()).toMatchObject({ outcome: "non_public_address", connection: { name: "shop-db" } });
      expect((await cli(sb, ["db", "test", "shop-db"])).stdout).toMatch(/What a code means: cavelon explain <code> \(non_public_address\)/);
    } finally {
      delete seeded.connection.testSteps;
      seeded.connection.last_test_outcome = "ok";
    }
  });

  it("test-runs a saved query with typed values, identity parameters included, and shows what the model sees", async () => {
    const result = await cli(sb, ["db", "test-run", "order_status", "--value", "order_no=A-10023", "--value", "email=ada@example.com"]);
    expect(result.code, result.stderr).toBe(0);
    expect(server.state.db.testRuns[0]).toEqual({ query_id: seeded.query.id, values: { order_no: "A-10023", email: "ada@example.com" } });
    expect(result.stdout).toMatch(/^What the model sees:$/m);
    expect(result.stdout).toMatch(/^A-10023\s+shipped$/m);
    // The run left evidence: counts and the source, never the values.
    const runs = await cli(sb, ["db", "runs", "order_status", "--json"]);
    const items = runs.json<{ items: Array<Record<string, unknown>> }>().items;
    expect(items[0]).toMatchObject({ source: "test", outcome: "ok", row_count: 1 });
    expect(JSON.stringify(items)).not.toContain("ada@example.com");
  });

  it("types a value by its parameter, refuses an unknown one, and exits 3 with the code of a failed run", async () => {
    const typedQuery: FakeQuery = { ...seeded.query, id: randomUUID(), slug: "recent_orders", parameters: [{ name: "days", type: "integer", description: "How many days back" }, { name: "open", type: "boolean", description: "Only open ones" }] };
    server.state.db.queries.push(typedQuery);
    try {
      expect((await cli(sb, ["db", "test-run", "recent_orders", "--value", "days=7", "--value", "open=true"])).code).toBe(0);
      expect(server.state.db.testRuns[0]!.values).toEqual({ days: 7, open: true });
      const wrong = await cli(sb, ["db", "test-run", "recent_orders", "--value", "days=seven", "--json"]);
      expect(wrong.code).toBe(2);
      const unknown = await cli(sb, ["db", "test-run", "recent_orders", "--value", "weeks=1", "--json"]);
      expect(unknown.json<{ error: { message: string; hint: string } }>().error).toMatchObject({ message: 'recent_orders has no parameter "weeks".', hint: expect.stringMatching(/^Its parameters: days \(model, integer\), open \(model, boolean\)\.$/) });
      typedQuery.result = { error_code: "timeout" };
      const failed = await cli(sb, ["db", "test-run", "recent_orders", "--value", "days=7", "--value", "open=false"]);
      expect(failed.code).toBe(3);
      expect(failed.stdout).toMatch(/outcome:\s+error \(timeout\)/);
      expect(failed.stdout).toMatch(/cavelon explain <code> \(timeout\)/);
    } finally {
      server.state.db.queries = server.state.db.queries.filter((q) => q.id !== typedQuery.id);
    }
  });

  it("says that the Owner runs the checks when the token's role may not", async () => {
    server.state.db.mayTest = false;
    const refused = await cli(sb, ["db", "test", "shop-db", "--json"]);
    expect(refused.code).not.toBe(0);
    expect(refused.json<{ error: { hint: string } }>().error.hint).toMatch(/^A connection test needs the tenant Owner's permission \(database_connectors\.test\)/);
  });

  it("names an unknown connection or query, and refuses while the connector is off or the instance has no such route", async () => {
    const missing = await cli(sb, ["db", "runs", "nope", "--json"]);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe("database_query_not_found");
    expect((await cli(sb, ["db", "test", "nope", "--json"])).json<{ error: { code: string } }>().error.code).toBe("database_connection_not_found");
    server.state.features.database_connector_enabled = false;
    const off = await cli(sb, ["db", "connections", "--json"], { env: fresh() });
    expect(off.code).toBe(1);
    expect(off.json<{ error: { code: string; hint: string } }>().error).toMatchObject({ code: "database_connector_disabled", hint: expect.stringContaining("DATABASE_CONNECTOR_ENABLED") });
    connectorOn();
    server.state.openapiWithout = ["GET /api/v1/database-connectors/connections"];
    try {
      const older = await cli(sb, ["db", "connections", "--json"], { env: fresh() });
      expect(older.json<{ error: { code: string } }>().error.code).toBe("operation_unavailable");
    } finally {
      server.state.openapiWithout = [];
    }
  });
});

/** A conversation's trace whose query tool answered the model with identity_required. */
function queryTrace(conversation: string) {
  const trace = traceFixture(randomUUID(), conversation, { failedSearch: false });
  const span = trace.spans[2] as Record<string, unknown>;
  Object.assign(span, {
    name: "order_status",
    tool_name: "order_status",
    tool_type: "database_query",
    status: "completed",
    input_json: { order_no: "A-10023" },
    output_json: {
      output_preview: JSON.stringify({ error: "identity_required", message: "Ask the user to sign in first; this answer needs their identity." }),
      output_data: { preview: "…", length: 90 },
    },
    error_json: null,
  });
  return trace;
}

describe("trace", () => {
  it("shows the code a query call answered with, suggests that span, and explains it", async () => {
    const conversation = randomUUID();
    const trace = queryTrace(conversation);
    server.state.traces.set(`conversation:${conversation}`, [trace]);
    const listed = await cli(sb, ["trace", conversation, "--kind", "conversation", "--trace", trace.id]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toMatch(/^3\s+tool\s+order_status\s+completed\s+identity_required\s+30\s/m);
    expect(listed.stdout).toMatch(/One span in full \(the one that failed\), by the span_id in its row: cavelon trace .* --span .*-span-3/);
    const span = await cli(sb, ["trace", conversation, "--kind", "conversation", "--trace", trace.id, "--span", `${trace.id}-span-3`]);
    expect(span.stdout).toMatch(/"order_no": "A-10023"/);
    expect(span.stdout).toMatch(/The query answered the model with identity_required\. What it means: cavelon explain identity_required/);
    const json = (await cli(sb, ["trace", conversation, "--kind", "conversation", "--trace", trace.id, "--json"])).json<{ spans: { items: Array<Record<string, unknown>> } }>();
    expect(json.spans.items[2]).toMatchObject({ tool_type: "database_query", error_code: "identity_required" });
  });

  it("reads the code only from a query tool's answer", () => {
    const answer = { output_preview: '{"error":"timeout","message":"x"}' };
    expect(queryErrorCode({ tool_type: "database_query", output_json: answer })).toBe("timeout");
    expect(queryErrorCode({ tool_type: "webhook", output_json: answer })).toBeNull();
    expect(queryErrorCode({ tool_type: "database_query", output_json: { output_preview: '{"columns":["a"],"rows":[[1]]}' } })).toBeNull();
    expect(queryErrorCode({ tool_type: "database_query", output_json: JSON.stringify(answer) })).toBe("timeout");
  });
});

describe("the flow with a database query", () => {
  it("pull, edit, validate, apply (the step in the Admin), apply again, test, trace", async () => {
    const dir = await pulled();
    // Edit: the query also returns the shipping date, and a suite checks the agent calls it.
    editTool(dir, "order_status", (t) => (t.database_query.sql_text = t.database_query.sql_text.replace("SELECT number, status", "SELECT number, status, shipped_at")));
    mkdirSync(path.join(dir, "tests"), { recursive: true });
    writeFileSync(
      path.join(dir, "tests", "orders.yaml"),
      stringify({
        name: "Orders",
        harness_slug: "support",
        test_cases: [{ name: "Order status", steps: [{ user_message: "Where is order A-10023?", evaluation_criteria: [{ type: "tool_called", value: "order_status" }] }] }],
      }),
    );
    const checked = await validated(dir);
    expect(checked.error_count, JSON.stringify(checked.findings)).toBe(0);
    expect(checked.findings.map((f) => f.code)).toContain("database_query_changed");

    // A token's apply stops at the query, with the step in the Admin.
    const blocked = await cli(sb, ["apply", "--json"], { cwd: dir, env: fresh() });
    expect(blocked.code).toBe(3);
    const hint = blocked.json<{ blocker_details: Array<{ code: string; hint: string }> }>().blocker_details[0]!.hint;
    expect(hint).toMatch(/imports the same package from the solution's Agents page \(Import JSON\)/);

    // A superadmin imports it in the Admin; then the token's apply passes.
    const sentPackage = (server.state.requests.filter((r) => r.path === "/api/v1/agent-graph/import/preview").pop()!.body as { package: Record<string, unknown> }).package;
    adminImport(server.state.db, tenant, sentPackage);
    const preview = await cli(sb, ["apply", "--json"], { cwd: dir, env: fresh() });
    expect(preview.code, preview.stdout).toBe(0);
    expect((await cli(sb, ["apply", "--confirm", preview.json<{ preview_id: string }>().preview_id], { cwd: dir })).code).toBe(0);
    expect((await validated(dir)).findings.filter((f) => f.code.startsWith("database_query"))).toEqual([]);

    // Test: the suite runs; its case answered in a conversation whose query call needed a signed-in visitor.
    const harness = server.state.harnesses.find((h) => h.tenant_id === tenant && h.slug === "support")!;
    server.state.suites.push({ id: randomUUID(), tenant_id: tenant, name: "Orders", harness_id: harness.id, archived_at: null });
    const conversation = randomUUID();
    const trace = queryTrace(conversation);
    server.state.traces.set(`conversation:${conversation}`, [trace]);
    server.state.runSummary = { passed: 0, failed: 1, pass_rate: 0 };
    server.state.runResults = [{ name: "Order status", status: "fail", conversation_id: conversation }];
    try {
      const run = await cli(sb, ["test", "run", "--suite", "Orders", "--wait"], { cwd: dir });
      expect(run.code).toBe(1);
      const runId = /Look closer: cavelon trace (\S+)/.exec(run.stdout)![1]!;
      expect((await cli(sb, ["trace", runId], { cwd: dir })).stdout).toContain(conversation);
      const spans = await cli(sb, ["trace", conversation, "--kind", "conversation", "--trace", trace.id], { cwd: dir });
      expect(spans.stdout).toMatch(/order_status\s+completed\s+identity_required/);
    } finally {
      server.state.runSummary = { passed: 2, failed: 0, pass_rate: 1 };
      server.state.runResults = null;
    }
  });
});

describe("skills", () => {
  it("say how to declare, set up and test a query tool, and point to a docs page the instance lists", async () => {
    const { bundledSkills } = await import("../src/agents.js");
    const skills = await bundledSkills();
    const text = (name: string) => skills.find((s) => s.name === name)!.files.find((f) => f.path === "SKILL.md")!.content;
    expect(text("cavelon-authoring")).toMatch(/## Database query tools[\s\S]*source: end_user\.email[\s\S]*allows_anonymous/);
    expect(text("cavelon-authoring")).toContain("cavelon docs get administration/database-connectors");
    expect(text("cavelon-loop")).toMatch(/Database connections are set up by a person[\s\S]*same connection name in every tenant and environment/);
    expect(text("cavelon-loop")).toMatch(/`cavelon db instance` says which\s+dialects this instance runs and the addresses it connects from/);
    expect(text("cavelon-loop")).toMatch(/A database query your package creates or changes stops the whole\s+apply/);
    expect(text("cavelon-testing")).toMatch(/## Database query tools[\s\S]*test database[\s\S]*cavelon db test-run/);
    expect(read(path.join(CONTRACTS, "docs", "llms.txt"))).toContain("/api/v1/docs/administration/database-connectors.md)");
  });
});
