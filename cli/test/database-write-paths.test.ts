import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ErrorCatalog, PackageSchema } from "../src/contracts.js";
import { checkPackage } from "../src/package-check.js";
import { checkQueryTools } from "../src/database-queries.js";
import { CONTRACTS } from "./fake-server.js";

const schema = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-package-schema-v3.json"), "utf8")) as PackageSchema;
const catalog = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-error-catalog.json"), "utf8")) as ErrorCatalog;
const disk = (body: Record<string, unknown>) => ({ package: body, sources: {}, findings: [], empty: false });
const tool = () => ({ slug: "write_order", name: "Write order", tool_type: "database_query", database_query: {
  connection: { name: "shop", dialect: "postgresql" }, kind: "write", requires_confirmation: false,
  sql_text: "UPDATE orders SET status = 'done' WHERE id = :id", parameters: [{ name: "id", type: "integer", description: "Order id" }], allows_anonymous: true,
} });
const node = (slug: string, node_type: string, config: Record<string, unknown> = {}) => ({ slug, node_type, config, harness_slug: "shop" });
const edge = (from: string, to: string, fromKind = "orchestration", toKind = "orchestration") => ({
  from_node_ref: { kind: fromKind, slug: from }, to_node_ref: { kind: toKind, slug: to }, harness_slug: "shop", edge_type: "pipeline",
});
const body = (): Record<string, any> => ({ tools: [tool()], agents: [], registry_entities: { orchestration_nodes: [node("start", "chat_start"), node("write", "tool_call", { tool_slug: "write_order" })], graph_edges: [edge("start", "write")], triggers: [] } });
const warnings = (pkg: Record<string, unknown>, published = catalog) => checkPackage(disk(pkg), { schema, catalog: published }).filter(f => f.code === "write_needs_confirmation");

describe("write paths without query confirmation", () => {
  it("warns without blocking on a chat path and keeps older instances unchanged", () => {
    expect(warnings(body())).toEqual([expect.objectContaining({ severity: "warning", path: "registry_entities.orchestration_nodes[1].config.tool_slug" })]);
    const older = structuredClone(catalog); older.api_error_codes = older.api_error_codes.filter(e => e.code !== "write_needs_confirmation");
    expect(warnings(body(), older)).toEqual([]);
  });

  it("accepts an Approval after the last agent stage, but warns if an agent or bypass follows it", () => {
    const pkg = body(); const r = pkg.registry_entities;
    r.orchestration_nodes.push(node("decision", "approval"));
    r.graph_edges = [edge("start", "decision"), edge("decision", "write")];
    expect(warnings(pkg)).toEqual([]);
    pkg.agents.push({ slug: "model", harness_slug: "shop" });
    r.graph_edges = [edge("start", "decision"), edge("decision", "model", "orchestration", "agent"), edge("model", "write", "agent")];
    expect(warnings(pkg)).toHaveLength(1);
    r.orchestration_nodes.push(node("final-decision", "approval"));
    r.graph_edges.pop(); r.graph_edges.push(edge("model", "final-decision", "agent"), edge("final-decision", "write"));
    expect(warnings(pkg)).toEqual([]);
    r.graph_edges.push(edge("start", "write"));
    expect(warnings(pkg)).toHaveLength(1);
  });

  it.each([["schedule", {}, 0], ["webhook", { auth_mode: "secret_header" }, 0], ["webhook", { auth_mode: "none" }, 1], ["email_received", {}, 1], ["channel", {}, 1], ["calendar_event_received", {}, 1]])("checks a %s trigger according to its published start", (trigger_type, config, count) => {
    const pkg = body(); pkg.registry_entities.triggers = [{ slug: "delivery", harness_slug: "shop", trigger_type, config }];
    pkg.registry_entities.orchestration_nodes[0] = node("start", "trigger_start", { trigger_slug: "delivery" });
    expect(warnings(pkg)).toHaveLength(count as number);
  });

  it("never treats Approval as permission for an agent query, including a skill and handoff", () => {
    const pkg = body(); pkg.agents = [{ slug: "first", harness_slug: "shop", handoffs: [{ to_agent_slug: "second" }] },
      { slug: "second", harness_slug: "shop", skill_assignments: [{ skill_slug: "orders" }] }];
    pkg.skills = [{ slug: "orders", tool_assignments: [{ tool_slug: "write_order" }] }];
    pkg.registry_entities.orchestration_nodes.push(node("decision", "approval"));
    pkg.registry_entities.graph_edges = [edge("start", "decision"), edge("decision", "first", "orchestration", "agent")];
    expect(warnings(pkg)).toEqual([expect.objectContaining({ path: "agents[1].tool_assignments", message: expect.stringContaining("cannot use the Approval-node exception") })]);
  });

  it("does not credit a later rejected/default branch, and bounds graph cycles", () => {
    const pkg = body(); pkg.registry_entities.orchestration_nodes.push(node("decision", "approval"));
    pkg.registry_entities.graph_edges = [edge("start", "decision"), { ...edge("decision", "write"), edge_type: "condition", config: { default: true } }, edge("write", "start")];
    expect(warnings(pkg)).toHaveLength(1);
  });

  it("ignores inactive starts and edges in another solution", () => {
    const pkg = body(); pkg.registry_entities.graph_edges[0].harness_slug = "other";
    expect(warnings(pkg)).toEqual([]);
    pkg.registry_entities.graph_edges[0].harness_slug = "shop"; pkg.registry_entities.orchestration_nodes[0].is_active = false;
    expect(warnings(pkg)).toEqual([]);
  });
});

describe("Citus SQL validation", () => {
  const checks = (sql: string, kind = "read") => {
    const t = tool(); t.database_query.sql_text = sql; t.database_query.kind = kind;
    return checkQueryTools(disk({ tools: [t] }), schema, undefined).filter(f => ["forbidden_keyword", "write_statement_refused"].includes(f.code));
  };
  it.each(["SELECT run_command_on_workers('SELECT 1')", "SELECT pg_catalog.citus_add_node('worker', 5432)", 'SELECT "citus_internal"."any_call"()', 'SELECT "CITUS_ADD_NODE"(\'worker\', 5432)', "SELECT citus_internal_delete()"])("warns about the instance's refusal of %s", sql => {
    expect(checks(sql)).toEqual([expect.objectContaining({ code: "forbidden_keyword", severity: "warning" })]);
  });
  it.each(["SELECT citus_version()", "SELECT citus_table_size('orders')", "SELECT app.citus_add_node('worker', 5432)", "SELECT 'citus_add_node()'", "SELECT $$run_command_on_workers()$$", "WITH citus_add_node(id) AS (SELECT 1) SELECT id FROM citus_add_node", "SELECT 1 AS citus_add_node(id)"])("leaves read-only calls and non-calls alone: %s", sql => {
    expect(checks(sql)).toEqual([]);
  });
  it("uses the write refusal code for a Citus call in a write", () => {
    expect(checks("UPDATE orders SET status = citus_internal_touch() WHERE id = :id", "write")).toEqual([expect.objectContaining({ code: "write_statement_refused" })]);
  });
});
