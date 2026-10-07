import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type { ErrorCatalog, PackageSchema } from "../src/contracts.js";
import type { QueryBaseline } from "../src/database-queries.js";
import { catalogEntry, checkPackage } from "../src/package-check.js";
import { missingInventory } from "../src/package-references.js";
import { CONTRACTS, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

const read = (name: string) => JSON.parse(readFileSync(path.join(CONTRACTS, name), "utf8"));
const schema = read("meta-package-schema-v3.json") as PackageSchema;
const catalog = read("meta-error-catalog.json") as ErrorCatalog;
const inventory = { written_at: "2026-10-07T00:00:00Z", names: { tools: [] as string[] } };
const query = {
  connection: { name: "shop-db", dialect: "postgresql" },
  sql_text: "SELECT status FROM orders WHERE number = :order_no AND email = :email LIMIT 5",
  parameters: [
    { name: "order_no", type: "string", description: "Order number", max_length: 20 },
    { name: "email", source: "end_user.email", type: "string" },
  ],
  allows_anonymous: false,
};
const tool = { slug: "order_status", name: "Order status", tool_type: "database_query", scope: "tenant_local", database_query: query };
const call = () => ({
  slug: "lookup", node_type: "tool_call", harness_slug: "shop",
  config: { tool_slug: "order_status", tool_type: "database_query", input_schema: { type: "object", properties: { order_no: { type: "string" } }, required: ["order_no"], additionalProperties: false } },
});
const edge = (from: string, to: string, kind = "orchestration") => ({ from_node_ref: { kind, slug: from }, to_node_ref: { kind: "orchestration", slug: to }, edge_type: "pipeline", harness_slug: "shop" });
const pkg = () => ({ tools: [structuredClone(tool)], registry_entities: { orchestration_nodes: [call()] } });
const disk = (body: Record<string, unknown>) => ({ package: body, sources: {}, findings: [], empty: false });
const findings = (body: Record<string, unknown>, published = schema, baseline?: QueryBaseline) => checkPackage(disk(body), { schema: published, catalog, inventory, queryBaseline: baseline });
const queryFindings = (body: Record<string, unknown>, published = schema, baseline?: QueryBaseline) => findings(body, published, baseline).filter((f) => ["invalid_arguments", "identity_required", "tool_call_database_query_missing"].includes(f.code));

describe("workflow database query validation", () => {
  it("accepts a query node and the published success and failure contract", () => {
    expect(findings(pkg()).filter((f) => f.path?.startsWith("registry_entities"))).toEqual([]);
    const defs = schema.$defs as Record<string, any>;
    expect(defs.NodeConfig_tool_call["x-cavelon-output"].database_query).toEqual({ $ref: "#/$defs/DatabaseQueryNodeOutput" });
    expect(defs.DatabaseQueryNodeOutput.oneOf[0]).toMatchObject({ properties: { columns: { type: "array" }, rows: { items: { type: "array" } }, returned_rows: { type: "integer" }, truncated: { type: "boolean" }, note: { type: "string" } } });
    expect(defs.DatabaseQueryNodeOutput.oneOf[1].required).toEqual(["error", "message"]);
    expect(catalogEntry(catalog, "tool_call_database_query_missing")).toMatchObject({ kind: "api", area: "package", hint: expect.stringContaining("Add the query's tool") });
  });

  it("refuses unknown and identity argument names in the declared input, including required-only names", () => {
    const body = pkg();
    body.registry_entities.orchestration_nodes[0]!.config.input_schema.properties = { order_no: { type: "string" }, email: { type: "string" }, typo: { type: "string" } } as any;
    body.registry_entities.orchestration_nodes[0]!.config.input_schema.required.push("undeclared");
    const found = queryFindings(body);
    expect(found.map((f) => [f.code, f.severity, f.path])).toEqual([
      ["invalid_arguments", "error", "registry_entities.orchestration_nodes[0].config.input_schema.properties.email"],
      ["invalid_arguments", "error", "registry_entities.orchestration_nodes[0].config.input_schema.properties.typo"],
      ["invalid_arguments", "error", "registry_entities.orchestration_nodes[0].config.input_schema.required[1]"],
    ]);
    expect(found[0]!.message).toContain("identity parameter");
    expect(found[1]!.hint).toContain("Transform");
  });

  it("checks the incoming Transform's flat mapping instead of trusting an input_schema snapshot", () => {
    const body: any = pkg();
    body.registry_entities.orchestration_nodes.unshift({ slug: "arguments", node_type: "transform", harness_slug: "shop", config: { mode: "json_mapping", mapping: { order_no: "$.previous_output.number", email: "$.previous_output.email" } } });
    body.registry_entities.graph_edges = [edge("arguments", "lookup")];
    expect(queryFindings(body)).toEqual([expect.objectContaining({ code: "invalid_arguments", severity: "error", path: "registry_entities.orchestration_nodes[0].config.mapping.email" })]);
    delete body.registry_entities.orchestration_nodes[0].config.mapping.email;
    expect(queryFindings(body)).toEqual([]);
  });

  it("identifies the query without node metadata and leaves an edge's templated input to runtime", () => {
    const body: any = pkg();
    delete body.registry_entities.orchestration_nodes[0].config.tool_type;
    body.registry_entities.orchestration_nodes[0].config.input_schema.properties.email = { type: "string" };
    expect(queryFindings(body)).toEqual([expect.objectContaining({ code: "invalid_arguments" })]);
    delete body.registry_entities.orchestration_nodes[0].config.input_schema.properties.email;
    body.registry_entities.orchestration_nodes.unshift({ slug: "arguments", node_type: "transform", harness_slug: "shop", config: { mapping: { email: "$.previous_output.email" } } });
    body.registry_entities.graph_edges = [{ ...edge("arguments", "lookup"), config: { input_template: '{"order_no": "A-10023"}' } }];
    expect(queryFindings(body)).toEqual([]);
  });

  it("lets the selected tool's family override stale query metadata", () => {
    const body: any = pkg();
    body.tools[0].tool_type = "webhook";
    delete body.tools[0].database_query;
    expect(queryFindings(body)).toEqual([]);
  });

  it("names a missing query with the server code, defers to tenant inventory and asks for an unread tools list", () => {
    const body = pkg();
    body.tools = [];
    const found = queryFindings(body);
    expect(found).toEqual([expect.objectContaining({ code: "tool_call_database_query_missing", severity: "warning", path: "registry_entities.orchestration_nodes[0].config.tool_slug", hint: expect.stringContaining("Add the query's tool") })]);
    expect(checkPackage(disk(body), { schema, inventory: { ...inventory, names: { tools: ["order_status"] } } }).filter((f) => f.code === "tool_call_database_query_missing")).toEqual([]);
    expect(checkPackage(disk(body), { schema }).filter((f) => f.code === "tool_call_database_query_missing")).toEqual([]);
    expect(missingInventory(disk(body), undefined)).toEqual(["tools"]);
    expect(missingInventory(disk(body), inventory)).toEqual([]);
  });

  it.each(["schedule", "webhook", "email_received"])("warns for an identity-bound query reachable from a %s trigger", (trigger_type) => {
    const body: any = pkg();
    body.registry_entities.orchestration_nodes.unshift({ slug: "start", node_type: "trigger_start", harness_slug: "shop", config: { trigger_slug: "incoming" } });
    body.registry_entities.triggers = [{ slug: "incoming", trigger_type, harness_slug: "shop" }];
    body.registry_entities.graph_edges = [edge("start", "lookup")];
    expect(queryFindings(body)).toEqual([expect.objectContaining({ code: "identity_required", severity: "warning", path: "registry_entities.orchestration_nodes[1].config.tool_slug", message: expect.stringContaining("no signed-in Chat User") })]);
    body.tools[0].database_query.parameters = [body.tools[0].database_query.parameters[0]];
    body.tools[0].database_query.sql_text = "SELECT status FROM orders WHERE number = :order_no LIMIT 5";
    expect(queryFindings(body)).toHaveLength(1);
    body.tools[0].database_query.allows_anonymous = true;
    expect(queryFindings(body)).toEqual([]);
  });

  it("follows a trigger's agent entrypoint and graph paths, with cycles bounded", () => {
    const body: any = pkg();
    body.registry_entities.triggers = [{ slug: "incoming", trigger_type: "schedule", entrypoint_agent_slug: "intake", harness_slug: "shop" }];
    body.registry_entities.graph_edges = [edge("intake", "lookup", "agent"), edge("lookup", "lookup")];
    expect(queryFindings(body)).toHaveLength(1);
  });

  it("does not warn for chat-only, disconnected, inactive or another solution's trigger paths", () => {
    const body: any = pkg();
    body.registry_entities.orchestration_nodes.unshift({ slug: "start", node_type: "trigger_start", harness_slug: "shop", config: { trigger_slug: "incoming" } });
    body.registry_entities.graph_edges = [];
    expect(queryFindings(body)).toEqual([]);
    body.registry_entities.graph_edges = [{ ...edge("start", "lookup"), is_active: false }];
    expect(queryFindings(body)).toEqual([]);
    body.registry_entities.graph_edges = [{ ...edge("start", "lookup"), harness_slug: "other" }];
    expect(queryFindings(body)).toEqual([]);
    body.registry_entities.graph_edges = [edge("start", "lookup")];
    body.registry_entities.orchestration_nodes[0].is_active = false;
    expect(queryFindings(body)).toEqual([]);
  });

  it("uses a remembered query when the package only references it and keeps unknown fields", () => {
    const body: any = pkg();
    delete body.tools[0].database_query;
    body.tools[0].future_field = { keep: true };
    body.registry_entities.orchestration_nodes[0].config.input_schema.properties.email = { type: "string" };
    const before = structuredClone(body);
    expect(queryFindings(body, schema, { by: "pull", written_at: inventory.written_at, tools: { order_status: { database_query: query } } })).toEqual([expect.objectContaining({ code: "invalid_arguments" })]);
    expect(body).toEqual(before);
  });

  it("skips new query checks on older instances while preserving their published schema validation", () => {
    const older = structuredClone(schema);
    const defs = older.$defs as Record<string, any>;
    defs.NodeConfig_tool_call.properties.tool_type.enum = ["builtin", "webhook"];
    delete defs.NodeConfig_tool_call["x-cavelon-output"];
    const body: any = pkg();
    body.registry_entities.orchestration_nodes[0].config.input_schema.properties.email = { type: "string" };
    expect(queryFindings(body, older)).toEqual([]);
    body.tools = [];
    expect(missingInventory(disk(body), undefined, older)).toEqual([]);
    expect(findings(body, older).some((f) => f.code === "package_schema_invalid" && f.path?.endsWith("tool_type"))).toBe(true);
    const noQueries = structuredClone(schema);
    delete (noQueries.$defs as Record<string, any>).PackageTool.properties.database_query;
    expect(queryFindings(body, noQueries)).toEqual([]);
  });
});

describe("workflow database query commands", () => {
  let server: FakeServer;
  let sb: Sandbox;
  let root: string;
  beforeAll(async () => {
    server = await startFakeServer();
    const tenant = server.addTenant("acme", "Acme");
    sb = sandbox();
    await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
    root = path.join(sb.home, "workflow");
    mkdirSync(root);
    expect((await cli(sb, ["init", "--instance", server.url, "--tenant", tenant], { cwd: root })).code).toBe(0);
    mkdirSync(path.join(root, "package"), { recursive: true });
    writeFileSync(path.join(root, "package", "manifest.yaml"), stringify({ package_version: "v3", exported_at: "2026-10-07T00:00:00Z", source_tenant_id: tenant, source_tenant_slug: "acme" }));
    writeFileSync(path.join(root, "package", "registry_entities.yaml"), stringify(pkg().registry_entities));
  });
  afterAll(async () => { await server.close(); sb.cleanup(); });

  it("reads inventory for a node-only query reference, explains it and fails strict validation with file and line", async () => {
    const result = await cli(sb, ["validate", "--strict", "--json"], { cwd: root });
    expect(result.code).toBe(3);
    expect(result.json<any>()).toMatchObject({ blocking_count: 1, findings: [expect.objectContaining({ code: "tool_call_database_query_missing", file: "package/registry_entities.yaml", line: expect.any(Number) })] });
    expect(server.state.requests.some((r) => r.method === "GET" && r.path === "/api/v1/tools")).toBe(true);
    expect((await cli(sb, ["explain", "tool_call_database_query_missing", "--json"])).json()).toMatchObject({ code: "tool_call_database_query_missing", kind: "api" });
  });
});
