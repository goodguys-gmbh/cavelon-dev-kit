import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rootCertificates } from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../src/commands/index.js";
import { operationAt, schemaErrors } from "../src/openapi.js";
import { seedQueryTool } from "./fake-database.js";
import { CONTRACTS, openapiSnapshot, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

let server: FakeServer;
let sb: Sandbox;
let tenant: string;
const route = "/api/v1/database-connectors/connections";
const createArgs = ["db", "connections", "create", "shop-db", "--dialect", "postgresql", "--host", "db.example.test", "--port", "5432", "--database-name", "shop", "--username", "reader"];
const fresh = () => ({ CAVELON_CACHE_DIR: path.join(sb.home, randomUUID()) });

beforeEach(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme");
  server.state.features.database_connector_enabled = true;
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, permissions: ["database_connectors.view", "database_connectors.manage"], needsAPerson: [{ method: "PUT", path: `${route}/{connection_id}/password`, reason: "Sets a database connection's password" }] }));
});
afterEach(async () => { await server.close(); sb.cleanup(); });

async function created() {
  const result = await cli(sb, [...createArgs, "--json"]);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  responseMatches("POST", route, "201", result.json<{ connection: unknown }>().connection);
  return result.json<{ connection: { id: string; password_set: boolean }; needs_a_person: unknown; next_step: string }>();
}

function responseMatches(method: string, template: string, status: string, data: unknown) {
  const doc = JSON.parse(openapiSnapshot());
  const schema = operationAt(doc, method, template)!.responses[status]!.content!["application/json"]!.schema!;
  expect(schemaErrors(doc, schema, data)).toEqual([]);
}

function sent(method: string, suffix = "") { return server.state.requests.filter(r => r.method === method && r.path === route + suffix); }

describe("connections from a managing token", () => {
  it("creates without a password, follows published defaults and returns the person-only Admin step", async () => {
    const result = await created();
    expect(result.connection.password_set).toBe(false);
    expect(result.needs_a_person).toMatchObject({ method: "PUT", path: `${route}/{connection_id}/password`, reason: "Sets a database connection's password" });
    expect(result.next_step).toMatch(/Admin.*Settings.*Databases/);
    const body = sent("POST")[0]!.body;
    expect(body).toEqual({ name: "shop-db", dialect: "postgresql", host: "db.example.test", port: 5432, database_name: "shop", username: "reader" });
    const doc = JSON.parse(openapiSnapshot());
    expect(schemaErrors(doc, operationAt(doc, "POST", route)!.requestBody!.content["application/json"]!.schema!, body)).toEqual([]);
  });

  it("patches only given fields, preserves the password state, and deletes after preview/confirm", async () => {
    const { connection } = await created();
    const changed = await cli(sb, ["db", "connections", "update", "SHOP-DB", "--name", "inventory-db", "--tls-mode", "require", "--enabled", "false", "--json"]);
    expect(changed.code, changed.stdout).toBe(0);
    responseMatches("PATCH", `${route}/{connection_id}`, "200", changed.json<{ connection: unknown }>().connection);
    expect(sent("PATCH", `/${connection.id}`)[0]!.body).toEqual({ name: "inventory-db", tls_mode: "require", is_enabled: false });
    const preview = await cli(sb, ["db", "connections", "delete", connection.id, "--json"]);
    expect(preview.json()).toMatchObject({ deleted: false });
    expect(sent("DELETE", `/${connection.id}`)).toEqual([]);
    const deletion = await cli(sb, ["db", "connections", "delete", "inventory-db", "--confirm", "--json"]);
    expect(deletion.code, deletion.stdout).toBe(0);
    expect(deletion.json()).toMatchObject({ deleted: true, id: connection.id });
  });

  it("refuses deleting a connection still used by queries and preserves target-change refusals", async () => {
    const { connection } = seedQueryTool(server.state.db, tenant);
    const update = await cli(sb, ["db", "connections", "update", connection.name, "--host", "other.example.test", "--json"]);
    expect(update.code).toBe(3);
    expect(update.json()).toMatchObject({ error: { code: "credential_required_for_target_change", hint: expect.stringMatching(/Admin/) } });
    const result = await cli(sb, ["db", "connections", "delete", connection.name, "--confirm", "--json"]);
    expect(result.code).toBe(4);
    expect(server.state.db.connections).toContain(connection);
  });

  it("allows uncredentialed target changes and validates fields against the instance before sending", async () => {
    const { connection } = await created();
    expect((await cli(sb, ["db", "connections", "update", connection.id, "--host", "new.example.test"])).code).toBe(0);
    const invalid = await cli(sb, [...createArgs.slice(0, 3), "other", ...createArgs.slice(4), "--port", "80", "--json"]);
    expect(invalid.code).toBe(3);
    expect(sent("POST")).toHaveLength(1);
    expect((await cli(sb, ["db", "connections", "update", connection.id, "--json"])).code).toBe(2);
  });

  it("takes no password/secret/write option, ignores environment passwords, never writes connection settings into a package", async () => {
    const secret = "sentinel-never-a-password";
    for (const flag of ["--password", "--password-file", "--password-stdin", "--allows-writes"]) {
      const result = await cli(sb, [...createArgs, flag, secret, "--json"]);
      expect(result.code).toBe(2);
      expect(result.stdout + result.stderr).not.toContain(secret);
    }
    const result = await cli(sb, [...createArgs, "--json"], { env: { CAVELON_DATABASE_PASSWORD: secret, PGPASSWORD: secret }, stdin: secret });
    expect(result.code, result.stdout).toBe(0);
    expect(result.stdout + result.stderr + JSON.stringify(sent("POST"))).not.toContain(secret);
    expect(result.stdout).not.toContain("ca_certificate_pem");
    const schema = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-package-schema-v3.json"), "utf8"));
    expect(schema.$defs.PackageDatabaseConnectionRef.properties).not.toHaveProperty("allows_writes");
  });

  it("shows allows_writes only as a published read-only value and preserves older responses without it", async () => {
    const { connection } = seedQueryTool(server.state.db, tenant);
    connection.fields = { allows_writes: true };
    const result = await cli(sb, ["db", "connections", "--json"]);
    expect(result.json<{ items: unknown[] }>().items[0]).toMatchObject({ allows_writes: true });
    expect((await cli(sb, ["db", "connections"])).stdout).toMatch(/allows_writes|dashboard/i);
    delete connection.fields.allows_writes;
    expect((await cli(sb, ["db", "connections", "--json"])).json<{ items: unknown[] }>().items[0]).not.toHaveProperty("allows_writes");
  });
});

describe("public CA certificate upload", () => {
  it("patches a valid public certificate bundle and returns metadata without the PEM", async () => {
    const { connection } = await created();
    const file = path.join(sb.home, "ca.pem");
    writeFileSync(file, `${rootCertificates[0]}\n${rootCertificates[1]}\n`);
    const result = await cli(sb, ["db", "connections", "ca", connection.id, file, "--json"]);
    expect(result.code, result.stdout).toBe(0);
    responseMatches("PATCH", `${route}/{connection_id}`, "200", result.json<{ connection: unknown }>().connection);
    expect(sent("PATCH", `/${connection.id}`)[0]!.body).toEqual({ ca_certificate_pem: readFileSync(file, "utf8") });
    expect(result.stdout).not.toContain("BEGIN CERTIFICATE");
  });

  it.each(["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "OPENSSH PRIVATE KEY"])("refuses %s before any upload, even after a certificate", async kind => {
    const { connection } = await created();
    const file = path.join(sb.home, "key.pem");
    writeFileSync(file, `${rootCertificates[0]}\n-----BEGIN ${kind}-----\nSENSITIVE_KEY_SENTINEL\n-----END ${kind}-----`);
    const result = await cli(sb, ["db", "connections", "ca", connection.id, file, "--json"]);
    expect(result.code).toBe(3);
    expect(result.stdout + result.stderr).not.toContain("SENSITIVE_KEY_SENTINEL");
    expect(sent("PATCH", `/${connection.id}`)).toEqual([]);
  });

  it.each(["not a certificate", "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----", "x".repeat(32769)])("refuses malformed or oversized input", async pem => {
    const { connection } = await created();
    const file = path.join(sb.home, "invalid.pem");
    writeFileSync(file, pem);
    expect((await cli(sb, ["db", "connections", "ca", connection.id, file, "--json"])).code).toBe(3);
    expect(sent("PATCH", `/${connection.id}`)).toEqual([]);
  });
});

describe("login script and schema", () => {
  it("gets only the published read_only script, repeated egress IPs and saved connection inputs", async () => {
    const result = await cli(sb, ["db", "login-script", "mssql", "--database-name", "shop", "--username", "reader", "--schema", "sales", "--egress-ip", "203.0.113.10", "--egress-ip", "203.0.113.11", "--connection-limit", "40", "--require-tls", "false", "--json"]);
    expect(result.code, result.stdout).toBe(0);
    responseMatches("GET", "/api/v1/database-connectors/login-script", "200", result.json());
    expect(result.json()).toMatchObject({ dialect: "mssql", kind: "read_only", schema: "sales", connection_limit: 40, connection_limit_enforced: false, require_tls: false, egress_ips: ["203.0.113.10", "203.0.113.11"] });
    const { connection } = await created();
    const saved = await cli(sb, ["db", "login-script", "--connection", connection.id, "--json"]);
    expect(saved.code, saved.stdout).toBe(0);
    responseMatches("GET", `${route}/{connection_id}/login-script`, "200", saved.json());
    expect(saved.json()).toMatchObject({ dialect: "postgresql", database_name: "shop", username: "reader", kind: "read_only" });
    expect((await cli(sb, ["db", "login-script", "postgresql", "--kind", "write", "--json"])).code).toBe(2);
  });

  it("lists schemas and tables with columns read-only, paginates, and reports a scrubbed driver failure", async () => {
    const { connection } = await created();
    const list = await cli(sb, ["db", "schema", connection.id, "--json"]);
    expect(list.code, list.stdout).toBe(0);
    responseMatches("POST", `${route}/{connection_id}/schema`, "200", list.json());
    expect(list.json()).toMatchObject({ schemas: ["public"], error_code: null });
    const tables = await cli(sb, ["db", "schema", connection.id, "public", "--json"]);
    expect(tables.json()).toMatchObject({ schema: "public", tables: [{ name: "orders", columns: [{ name: "order_number" }] }] });
    responseMatches("POST", `${route}/{connection_id}/schema`, "200", tables.json());
    expect(sent("POST", `/${connection.id}/schema`).map(r => r.body)).toEqual([{}, { schema: "public" }]);
    server.state.db.connections[0]!.schemaResult = { schemas: ["public", "sales"], tables: [], truncated: true, error_code: null, driver_message: null, duration_ms: 10 };
    const page = (await cli(sb, ["db", "schema", connection.id, "--limit", "1", "--json"])).json();
    expect(page).toMatchObject({ schemas: ["public"], next_cursor: "1", truncated: true });
    server.state.db.connections[0]!.schemaResult = { schemas: [], tables: [], truncated: false, error_code: "auth_failed", driver_message: "No password is set: a person sets it in the Admin under Settings > Databases.", duration_ms: 10 };
    const failed = await cli(sb, ["db", "schema", connection.id]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toMatch(/auth_failed.*|Admin/);
    expect(COMMANDS.find(c => c.name === "db schema")?.readOnly).toBe(true);
  });
});

describe("gates and compatibility", () => {
  it.each(["pat", "key"] as const)("refuses an unmanageable %s principal for CRUD/CA/schema but permits a viewer's login script", async kind => {
    const { connection } = await created();
    await login(sb, server.url, server.addToken({ kind, tenantIds: [tenant], defaultTenant: tenant, scopes: ["admin"], permissions: ["database_connectors.view"] }));
    const file = path.join(sb.home, "ca.pem"); writeFileSync(file, rootCertificates[0]!);
    for (const args of [[...createArgs], ["db", "connections", "update", connection.id, "--name", "changed"], ["db", "connections", "delete", connection.id, "--confirm"], ["db", "connections", "ca", connection.id, file], ["db", "schema", connection.id]]) {
      const result = await cli(sb, [...args, "--json"]);
      expect(result.code, result.stdout).toBe(7);
      expect(result.json()).toMatchObject({ error: { hint: expect.stringMatching(/database_connectors.manage/) } });
    }
    expect((await cli(sb, ["db", "login-script", "postgresql", "--json"])).code).toBe(0);
  });

  it("keeps the server's gate authoritative when an older principal does not publish permissions", async () => {
    server.state.servePermissions = false; server.state.serveCredentialAccess = false;
    const result = await created();
    expect(result.next_step).toMatch(/Admin/);
    expect(result.needs_a_person).toBeNull();
  });

  it("reports missing new routes without sending and handles instances without OpenAPI", async () => {
    server.state.openapiWithout = [`POST ${route}`, "GET /api/v1/database-connectors/login-script"];
    for (const args of [createArgs, ["db", "login-script", "postgresql"]]) {
      const result = await cli(sb, [...args, "--json"], { env: fresh() });
      expect(result.code).toBe(1);
      expect(result.json()).toMatchObject({ error: { code: "operation_unavailable" } });
    }
    expect(sent("POST")).toEqual([]);
    server.state.serveOpenapi = false;
    expect((await cli(sb, [...createArgs, "--json"], { env: fresh() })).code).toBe(0);
  });

  it("respects an older instance's person-only management marker", async () => {
    server.state.personOnly = { [`POST ${route}`]: "Runs only for a superadmin in the Admin" };
    const result = await cli(sb, [...createArgs, "--json"], { env: fresh() });
    expect(result.code).toBe(5);
    expect(result.json()).toMatchObject({ error: { code: "operation_for_a_person", hint: expect.stringMatching(/Admin/) } });
    expect(sent("POST")).toEqual([]);
  });

  it("does not bypass missing update/delete/schema/saved-script routes on older instances", async () => {
    const { connection } = await created();
    server.state.openapiWithout = [`PATCH ${route}/{connection_id}`, `DELETE ${route}/{connection_id}`, `POST ${route}/{connection_id}/schema`, `GET ${route}/{connection_id}/login-script`];
    for (const args of [["db", "connections", "update", connection.id, "--name", "other"], ["db", "connections", "delete", connection.id, "--confirm"], ["db", "schema", connection.id], ["db", "login-script", "--connection", connection.id]]) {
      const result = await cli(sb, [...args, "--json"], { env: fresh() });
      expect(result.code, result.stdout).toBe(1);
      expect(result.json()).toMatchObject({ error: { code: "operation_unavailable" } });
    }
    expect(sent("PATCH", `/${connection.id}`)).toEqual([]);
    expect(sent("DELETE", `/${connection.id}`)).toEqual([]);
    expect(sent("POST", `/${connection.id}/schema`)).toEqual([]);
  });
});
