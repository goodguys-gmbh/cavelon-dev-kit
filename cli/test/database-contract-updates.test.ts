import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedQueryTool } from "./fake-database.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

let server: FakeServer;
let sb: Sandbox;
let tenant: string;
const connections = "/api/v1/database-connectors/connections";
const route = `${connections}/{connection_id}`;
const create = ["db", "connections", "create", "shop", "--dialect", "postgresql", "--host", "db.example.test", "--port", "5432", "--database-name", "shop", "--username", "reader"];
beforeEach(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme");
  server.state.features.database_connector_enabled = true;
  server.state.serveConditionalPersonAccess = true;
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant,
    permissions: ["database_connectors.view", "database_connectors.manage", "database_connectors.test"],
    needsAPersonWhen: [{ operation: null, method: "PATCH", path: route, reason: "Any ca_certificate_pem change or a weaker tls_mode needs a person in the Admin." }],
  }));
});
afterEach(async () => { await server.close(); sb.cleanup(); });

describe("current database contracts", () => {
  it.each(["password", "kerberos_keytab", "ssh_private_key"])("never sends the secret field %s, including in a person's terminal", async field => {
    const { connection } = seedQueryTool(server.state.db, tenant);
    const sentinel = "PRIVATE_VALUE_MUST_NOT_APPEAR";
    for (const agent of [undefined, "1"]) {
      const result = await cli(sb, ["api", "update_database_connection", `connection_id=${connection.id}`, "--body", JSON.stringify({ [field]: sentinel }), "--json"],
        { env: { CAVELON_AGENT: agent, CAVELON_CACHE_DIR: path.join(sb.home, randomUUID()) } });
      expect(result.code, result.stdout).toBe(5);
      expect(result.stdout + result.stderr).not.toContain(sentinel);
      expect(server.state.requests.filter(r => r.method === "PATCH" && r.path === `${connections}/${connection.id}`)).toEqual([]);
    }
  });

  it("refuses the published person-only CA change before reading the file or sending", async () => {
    const { connection } = seedQueryTool(server.state.db, tenant);
    const result = await cli(sb, ["db", "connections", "ca", connection.id, "missing.pem", "--json"]);
    expect(result.code, result.stdout).toBe(5);
    expect(result.json()).toMatchObject({ error: { code: "operation_for_a_person", hint: expect.stringMatching(/Admin.*CA certificate/) } });
    expect(server.state.requests.filter(r => r.method === "PATCH")).toEqual([]);
  });

  it("round-trips public Kerberos settings and gives the keytab Admin step", async () => {
    const result = await cli(sb, [...create, "--auth-method", "kerberos", "--kerberos-realm", "CORP.EXAMPLE.COM", "--kerberos-principal", "svc_reader", "--kerberos-kdc", "kdc.example.test", "--json"]);
    expect(result.code, result.stdout).toBe(0);
    expect(server.state.requests.find(r => r.method === "POST" && r.path === connections)?.body).toMatchObject({
      auth_method: "kerberos", kerberos_realm: "CORP.EXAMPLE.COM", kerberos_principal: "svc_reader", kerberos_kdcs: [{ host: "kdc.example.test", port: 88 }],
    });
    expect(result.json()).toMatchObject({ next_step: expect.stringMatching(/keytab.*Admin|Admin.*keytab/) });
  });

  it("sends only public SSH settings, requires the fingerprint, and never takes a private key", async () => {
    const args = [...create, "--ssh-host", "bastion.example.test", "--ssh-username", "forwarder"];
    expect((await cli(sb, [...args, "--json"])).code).toBe(2);
    const result = await cli(sb, [...args, "--ssh-host-key-fingerprint", `SHA256:${"a".repeat(43)}`, "--json"]);
    expect(result.code, result.stdout).toBe(0);
    expect(server.state.requests.find(r => r.method === "POST" && r.path === connections)?.body).toMatchObject({ ssh_tunnel: {
      host: "bastion.example.test", port: 22, username: "forwarder", host_key_fingerprint: `SHA256:${"a".repeat(43)}`,
    } });
    expect(result.json()).toMatchObject({ next_step: expect.stringMatching(/SSH.*Admin|Admin.*SSH/) });
    const refused = await cli(sb, [...create, "--ssh-private-key", "PRIVATE_SENTINEL", "--json"]);
    expect(refused.code).toBe(2);
    expect(refused.stdout + refused.stderr).not.toContain("PRIVATE_SENTINEL");
  });

  it("shows the exact bastion authorized_keys_entry returned by the instance", async () => {
    const { connection } = seedQueryTool(server.state.db, tenant);
    const entry = 'restrict,command="/bin/false",permitopen="db.example.test:5432",permitlisten="localhost:0" ssh-ed25519 AAAATEST';
    connection.fields = { ssh_tunnel: { host: "bastion.example.test", port: 22, username: "forwarder", host_key_fingerprint: `SHA256:${"a".repeat(43)}`, private_key_set: true, authorized_keys_entry: entry } };
    expect((await cli(sb, ["db", "connections"])).stdout).toContain(entry);
  });

  it("round-trips listener redirects explicitly", async () => {
    const result = await cli(sb, [...create, "--dialect", "mssql", "--follows-redirects", "true", "--json"]);
    expect(result.code, result.stdout).toBe(0);
    expect(server.state.requests.find(r => r.method === "POST" && r.path === connections)?.body).toMatchObject({ follows_redirects: true });
  });

  it("shows private targets and SSH/Kerberos offers without inventing older fields", async () => {
    server.state.db.instance.network.private_targets = [{ cidr: "10.20.30.0/24", ports: [5432, 22, 88], source: "operator", usable: true }];
    server.state.db.instance.kerberos_dialects = ["postgresql", "mssql"]; server.state.db.instance.ssh_tunnels = true;
    const result = await cli(sb, ["db", "instance"]);
    expect(result.stdout).toContain("10.20.30.0/24"); expect(result.stdout).toContain("kerberos_dialects"); expect(result.stdout).toContain("ssh_tunnels");
    delete server.state.db.instance.network.private_targets; delete server.state.db.instance.kerberos_dialects; delete server.state.db.instance.ssh_tunnels;
    const older = (await cli(sb, ["db", "instance", "--json"])).json<Record<string, unknown>>();
    expect(older).not.toHaveProperty("kerberos_dialects"); expect(older).not.toHaveProperty("ssh_tunnels");
    expect(older.network).not.toHaveProperty("private_targets");
  });

  it("shows detected engine, SSH step and policy/redirect evidence", async () => {
    const { connection } = seedQueryTool(server.state.db, tenant);
    connection.testSteps = [{ name: "policy", status: "ok", code: null, detail: { private_target_id: "tenant-range" } },
      { name: "ssh", status: "ok", code: null }, { name: "server_version", status: "ok", code: null, detail: { engine: "cockroachdb" } },
      { name: "login", status: "ok", code: null, detail: { redirects: [{ target_class: "private" }] } }];
    const result = await cli(sb, ["db", "test", connection.id]);
    expect(result.code, result.stdout).toBe(0);
    for (const value of ["ssh", "cockroachdb", "tenant-range", "REDIRECTS", "private"]) expect(result.stdout).toContain(value);
  });

  it("refuses published TLS weakening but permits tightening and unrelated changes", async () => {
    const { connection } = seedQueryTool(server.state.db, tenant);
    expect((await cli(sb, ["db", "connections", "update", connection.id, "--tls-mode", "require", "--json"])).code).toBe(5);
    expect(server.state.requests.filter(r => r.method === "PATCH")).toEqual([]);
    connection.fields = { tls_mode: "require" };
    expect((await cli(sb, ["db", "connections", "update", connection.id, "--tls-mode", "verify_full", "--json"])).code).toBe(0);
    expect((await cli(sb, ["db", "connections", "update", connection.id, "--statement-timeout-ms", "3000", "--json"])).code).toBe(0);
  });

  it("keeps confirmation-unavailable guidance consistent with unconfirmed-write restrictions", async () => {
    const result = await cli(sb, ["explain", "confirmation_unavailable", "--json"]);
    expect(result.code, result.stdout).toBe(0);
    expect(result.json()).toMatchObject({ hint: expect.stringContaining("latest Approval decision"), instance_hint: expect.any(String) });
    expect((await cli(sb, ["explain", "private_target_refused"])).stdout).toContain("overlaps_another_tenant");
  });
});
