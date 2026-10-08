import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const QUERY_SCHEMA = JSON.parse(readFileSync(new URL("../../contracts/cavelon/meta-package-schema-v3.json", import.meta.url), "utf8")).$defs.PackageDatabaseQuery.properties as Record<string, { default?: unknown }>;

/**
 * The fake instance's database connections, saved queries and their runs, and
 * the import's gate on query tools: a credential that may not write queries
 * gets a coded blocker for each query tool the import would create or change,
 * as the instance names it in `blocker_details`. Each route answers in the
 * shape the OpenAPI snapshot declares (checked in contract.test.ts). While
 * the connector is off, its routes answer 404, as the instance's do.
 */

export interface FakeConnection {
  id: string;
  tenant_id: string;
  name: string;
  dialect: string;
  last_test_outcome: string | null;
  /** Saved public connection fields; seeded connections retain the older defaults. */
  fields?: Record<string, unknown>;
  schemaResult?: Record<string, unknown>;
  /** The steps a test reports; a passing run of every step by default. */
  testSteps?: Array<{ name: string; status: string; code: string | null }>;
  /** The uploaded CA's certificates. */
  caCertificates?: FakeCaCertificate[];
  /** False plays an instance that publishes only the certificates' fingerprints. */
  caDetails?: false;
  /** Why its queries may not be enabled, as the instance says it (SQL Server with write privileges). */
  queryEnableRefusal?: { code: string; message: string };
  /** Why a stored-procedure query may not be saved or run on it, as the instance says it (SQL Server). */
  procedureCallRefusal?: { code: string; message: string };
  /** What a passing test lists: stored-procedure queries whose procedure no longer passes. */
  procedureFindings?: Array<{ query_id: string; slug: string; code: string; message: string }>;
}

export interface FakeCaCertificate {
  subject: string;
  issuer: string;
  not_before: string;
  not_after: string;
  sha256: string;
}

export interface FakeQuery {
  id: string;
  tenant_id: string;
  connection_id: string;
  slug: string;
  name: string;
  description: string;
  sql_text: string;
  parameters: Array<Record<string, unknown>>;
  max_rows: number;
  max_result_chars: number;
  allows_anonymous: boolean;
  version: number;
  is_enabled?: boolean;
  kind?: "read" | "write";
  max_affected_rows?: number;
  requires_confirmation?: boolean;
  max_calls?: number;
  /** What a test run returns: columns and rows, or an error code; a notice where the code alone does not say what happened. */
  result?: ({ columns: string[]; rows: unknown[][] } | { error_code: string }) & { notice?: string; outcome?: string; writeEvidence?: Record<string, unknown> };
  /** The instance's refusal of a test run before it starts (409), as a stored-procedure query gets it. */
  refusal?: { code: string; message: string };
}

export interface FakeQueryRun {
  id: string;
  query_id: string;
  connection_id: string;
  query_version: number;
  source: "agent" | "test";
  outcome: string;
  error_code: string | null;
  row_count: number | null;
  created_at: string;
  writeEvidence?: Record<string, unknown>;
}

export interface DatabaseState {
  connections: FakeConnection[];
  queries: FakeQuery[];
  runs: FakeQueryRun[];
  /** Whether the caller holds the Owner's database_connectors.test. */
  mayTest: boolean;
  /** What a test run was sent, last first. */
  testRuns: Array<{ query_id: string; values: Record<string, unknown> }>;
  /** Whether the caller holds database_connectors.view, which every read needs. */
  mayView: boolean;
  /** False plays an instance older than stored-procedure queries: no procedure_call_refusal, procedure_findings or notice. */
  procedureFields: boolean;
  /** False plays an older response without write-query fields. Fixtures supply write evidence explicitly. */
  writeFields: boolean;
  /** What GET /instance answers: the dialects this host runs and its network side. */
  instance: { runnable_dialects: string[]; network: { egress_ips: string[]; connections_per_process: number }; write_queries?: boolean; max_affected_rows_limit?: number; limits?: import("../src/database-limits.js").DatabaseTenantLimits };
}

export function databaseState(): DatabaseState {
  return {
    connections: [],
    queries: [],
    runs: [],
    mayTest: true,
    testRuns: [],
    mayView: true,
    procedureFields: true,
    writeFields: true,
    instance: { runnable_dialects: ["mssql", "mysql", "postgresql"], network: { egress_ips: ["203.0.113.10", "203.0.113.11"], connections_per_process: 5 } },
  };
}

export interface DatabaseRoute {
  method: string;
  path: string;
  url: URL;
  json: unknown;
  tenantId: string;
  /** features.database_connector_enabled as the capabilities publish it. */
  enabled: boolean;
  /** The server checks effective permissions independently of what /meta/principal publishes. */
  mayManage?: boolean;
  send: (status: number, body: unknown) => void;
}

const STEPS = ["dns", "policy", "tcp", "tls", "login", "select_1", "server_version", "write_privileges"];
const at = () => new Date().toISOString();

function connectionView(state: DatabaseState, c: FakeConnection) {
  const certificates = c.caCertificates ?? [];
  return {
    id: c.id,
    name: c.name,
    dialect: c.dialect,
    host: "db.example.test",
    port: 5432,
    database_name: "shop",
    username: "reader",
    password_set: true,
    password_changed_at: "2026-10-01T08:00:00Z",
    tls_mode: "verify_full",
    ca_certificate_pem: certificates.length ? "-----BEGIN CERTIFICATE-----\nMIIB…\n-----END CERTIFICATE-----\n" : null,
    ca_certificate_sha256: certificates.map((cert) => cert.sha256),
    ...(c.caDetails === false ? {} : { ca_certificates: certificates }),
    statement_timeout_ms: 5000,
    is_enabled: true,
    config_version: 1,
    last_test_at: c.last_test_outcome ? "2026-10-01T08:05:00Z" : null,
    last_test_outcome: c.last_test_outcome,
    last_test_detail: null,
    write_privileges_acknowledged: false,
    query_enable_refusal: c.queryEnableRefusal ?? null,
    ...(state.procedureFields ? { procedure_call_refusal: c.procedureCallRefusal ?? null } : {}),
    query_count: state.queries.filter((q) => q.connection_id === c.id).length,
    created_by_user_id: null,
    updated_by_user_id: null,
    created_at: "2026-10-01T08:00:00Z",
    updated_at: "2026-10-01T08:00:00Z",
    ...c.fields,
  };
}

function queryView(state: DatabaseState, q: FakeQuery) {
  const connection = state.connections.find((c) => c.id === q.connection_id);
  const model = q.parameters.filter((p) => (p.source ?? "model") === "model");
  return {
    id: q.id,
    connection_id: q.connection_id,
    connection_name: connection?.name ?? "",
    tool_definition_id: q.id,
    slug: q.slug,
    name: q.name,
    description: q.description,
    sql_text: q.sql_text,
    parameters: q.parameters,
    params_json_schema: {
      type: "object",
      properties: Object.fromEntries(model.map((p) => [p.name, { type: p.type ?? "string" }])),
      required: model.filter((p) => p.required !== false).map((p) => p.name),
      additionalProperties: false,
    },
    max_rows: q.max_rows,
    max_result_chars: q.max_result_chars,
    allows_anonymous: q.allows_anonymous,
    is_enabled: q.is_enabled ?? true,
    version: q.version,
    ...(state.writeFields ? queryWriteFields(q) : {}),
    created_by_user_id: null,
    updated_by_user_id: null,
    created_at: "2026-10-01T08:00:00Z",
    updated_at: "2026-10-01T08:00:00Z",
  };
}

function runView(r: FakeQueryRun) {
  return {
    id: r.id,
    query_id: r.query_id,
    connection_id: r.connection_id,
    query_version: r.query_version,
    source: r.source,
    agent_run_id: null,
    conversation_id: null,
    end_user_id: null,
    actor_user_id: null,
    outcome: r.outcome,
    error_code: r.error_code,
    duration_ms: 12,
    row_count: r.row_count,
    truncated: false,
    result_chars: r.row_count === null ? null : 120,
    created_at: r.created_at,
    ...r.writeEvidence,
  };
}

export function handleDatabase(state: DatabaseState, rc: DatabaseRoute): boolean {
  if (!rc.path.startsWith("/api/v1/database-connectors/")) return false;
  if (!rc.enabled) {
    rc.send(404, { detail: "Not Found" });
    return true;
  }
  const own = <T extends { tenant_id: string }>(list: T[]) => list.filter((x) => x.tenant_id === rc.tenantId);
  if (!state.mayView && rc.method === "GET") {
    rc.send(403, { detail: "Permission denied: database_connectors.view" });
    return true;
  }
  if (rc.path === "/api/v1/database-connectors/instance" && rc.method === "GET") {
    rc.send(200, state.instance);
    return true;
  }
  const connectionBody = (rc.json ?? {}) as Record<string, unknown>;
  const connectionChange = rc.path === "/api/v1/database-connectors/connections" && rc.method === "POST";
  const managed = connectionChange || (rc.path.startsWith("/api/v1/database-connectors/connections/") && (rc.method === "PATCH" || rc.method === "DELETE" || rc.path.endsWith("/schema")));
  if (managed && rc.mayManage === false) {
    rc.send(403, { detail: "Missing permissions: database_connectors.manage" });
    return true;
  }
  if (managed && "password" in connectionBody) {
    rc.send(403, { detail: { code: "person_only_operation", message: "A person sets the database password in the Admin." } });
    return true;
  }
  if (connectionChange) {
    if (own(state.connections).some(c => c.name === connectionBody.name)) {
      rc.send(409, { detail: "A database connection with this name already exists" });
      return true;
    }
    const created: FakeConnection = {
      id: randomUUID(), tenant_id: rc.tenantId, name: String(connectionBody.name), dialect: String(connectionBody.dialect), last_test_outcome: null,
      fields: { ...connectionBody, password_set: false },
    };
    state.connections.push(created);
    rc.send(201, connectionView(state, created));
    return true;
  }
  const loginPath = rc.path === "/api/v1/database-connectors/login-script";
  const savedLogin = /^\/api\/v1\/database-connectors\/connections\/([^/]+)\/login-script$/.exec(rc.path);
  if ((loginPath || savedLogin) && rc.method === "GET") {
    const saved = savedLogin ? own(state.connections).find(c => c.id === savedLogin[1]) : undefined;
    if (savedLogin && !saved) { rc.send(404, { detail: "Database connection not found" }); return true; }
    const dialect = saved?.dialect ?? rc.url.searchParams.get("dialect");
    rc.send(200, {
      dialect, kind: "read_only", database_name: saved?.fields?.database_name ?? rc.url.searchParams.get("database_name") ?? "your_database",
      username: saved?.fields?.username ?? rc.url.searchParams.get("username") ?? "cavelon_reader", schema: rc.url.searchParams.get("schema"),
      egress_ips: rc.url.searchParams.has("egress_ips") ? rc.url.searchParams.getAll("egress_ips") : state.instance.network.egress_ips,
      connection_limit: Number(rc.url.searchParams.get("connection_limit") ?? 20), connection_limit_enforced: dialect !== "mssql",
      require_tls: saved ? saved.fields?.tls_mode !== "disable" : rc.url.searchParams.get("require_tls") !== "false",
      script: "-- Public read-only login template; the DBA replaces the password locally.\nSELECT 1;",
    });
    return true;
  }
  if (rc.path === "/api/v1/database-connectors/connections" && rc.method === "GET") {
    rc.send(200, own(state.connections).map((c) => connectionView(state, c)));
    return true;
  }
  let m = /^\/api\/v1\/database-connectors\/connections\/([^/]+)(\/test|\/schema)?$/.exec(rc.path);
  if (m) {
    const connection = own(state.connections).find((c) => c.id === m![1]);
    if (!connection) {
      rc.send(404, { detail: "Database connection not found" });
      return true;
    }
    if (!m[2] && rc.method === "GET") {
      rc.send(200, connectionView(state, connection));
      return true;
    }
    if (!m[2] && rc.method === "PATCH") {
      const before = connectionView(state, connection);
      const changedTarget = ["host", "port", "dialect"].filter(k => k in connectionBody && connectionBody[k] !== (before as Record<string, unknown>)[k]);
      if (before.password_set && changedTarget.length) {
        rc.send(422, { detail: { code: "credential_required_for_target_change", message: "A person changes this target with its password in the Admin.", fields: changedTarget } });
        return true;
      }
      connection.fields = { ...connection.fields, ...connectionBody, config_version: Number(before.config_version) + 1 };
      if (connectionBody.name) connection.name = String(connectionBody.name);
      if (connectionBody.dialect) connection.dialect = String(connectionBody.dialect);
      rc.send(200, connectionView(state, connection));
      return true;
    }
    if (!m[2] && rc.method === "DELETE") {
      if (state.queries.some(q => q.connection_id === connection.id)) { rc.send(409, { detail: "Queries still use the connection" }); return true; }
      state.connections.splice(state.connections.indexOf(connection), 1);
      rc.send(204, null);
      return true;
    }
    if (m[2] === "/schema" && rc.method === "POST") {
      const schema = connectionBody.schema;
      rc.send(200, connection.schemaResult ?? {
        schema: schema ?? null, schemas: schema ? [] : ["public"],
        tables: schema ? [{ name: "orders", kind: "table", columns: [{ name: "order_number", data_type: "text", nullable: false }], columns_truncated: false }] : [],
        truncated: false, error_code: null, driver_message: null, duration_ms: 10,
      });
      return true;
    }
    if (m[2] === "/test" && rc.method === "POST") {
      if (!state.mayTest) {
        rc.send(403, { detail: "Permission denied: database_connectors.test" });
        return true;
      }
      const steps = (connection.testSteps ?? STEPS.map((name) => ({ name, status: "ok", code: null }))).map((s) => ({ ...s, detail: {}, driver_message: null }));
      const failed = steps.find((s) => s.status !== "ok" && s.status !== "skipped");
      connection.last_test_outcome = failed?.code ?? "ok";
      rc.send(200, {
        outcome: connection.last_test_outcome,
        steps,
        server_version: failed ? null : "PostgreSQL 16.4",
        write_privileges: failed ? null : { can_write: false },
        config_version: 1,
        duration_ms: 87,
        tested_at: at(),
        ...(state.procedureFields ? { procedure_findings: failed ? [] : (connection.procedureFindings ?? []) } : {}),
      });
      return true;
    }
  }
  if (rc.path === "/api/v1/database-connectors/queries" && rc.method === "GET") {
    const connectionId = rc.url.searchParams.get("connection_id");
    rc.send(
      200,
      own(state.queries)
        .filter((q) => !connectionId || q.connection_id === connectionId)
        .map((q) => queryView(state, q)),
    );
    return true;
  }
  if (rc.path === "/api/v1/database-connectors/queries" && rc.method === "POST") {
    const body = rc.json as Partial<FakeQuery>;
    const query: FakeQuery = {
      id: randomUUID(), tenant_id: rc.tenantId, connection_id: String(body.connection_id),
      slug: String(body.slug), name: String(body.name), description: body.description ?? "",
      sql_text: String(body.sql_text), parameters: body.parameters ?? [], max_rows: body.max_rows ?? 50,
      max_result_chars: body.max_result_chars ?? 8000, allows_anonymous: body.allows_anonymous ?? false,
      is_enabled: body.is_enabled ?? true, version: 1,
      ...queryWriteFields(body),
    };
    state.queries.push(query);
    rc.send(201, queryView(state, query));
    return true;
  }
  m = /^\/api\/v1\/database-connectors\/queries\/([^/]+)(\/runs|\/test-run)?$/.exec(rc.path);
  if (m) {
    const query = own(state.queries).find((q) => q.id === m![1]);
    if (!query) {
      rc.send(404, { detail: "Database query not found" });
      return true;
    }
    if (!m[2] && rc.method === "GET") {
      rc.send(200, queryView(state, query));
      return true;
    }
    if (!m[2] && rc.method === "PATCH") {
      Object.assign(query, rc.json, { version: query.version + 1 });
      rc.send(200, queryView(state, query));
      return true;
    }
    if (!m[2] && rc.method === "DELETE") {
      state.queries.splice(state.queries.indexOf(query), 1);
      rc.send(200, { id: query.id, tool_definition_id: query.id, removed_references: {} });
      return true;
    }
    if (m[2] === "/runs" && rc.method === "GET") {
      const limit = Number(rc.url.searchParams.get("limit") ?? 50);
      const offset = Number(rc.url.searchParams.get("offset") ?? 0);
      const runs = state.runs.filter((r) => r.query_id === query.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
      rc.send(200, { items: runs.slice(offset, offset + limit).map(runView), next_offset: offset + limit < runs.length ? offset + limit : null });
      return true;
    }
    if (m[2] === "/test-run" && rc.method === "POST") {
      if (!state.mayTest) {
        rc.send(403, { detail: "Permission denied: database_connectors.test" });
        return true;
      }
      const values = ((rc.json as { values?: Record<string, unknown> } | undefined)?.values ?? {}) as Record<string, unknown>;
      const names = query.parameters.map((p) => String(p.name));
      const unknown = Object.keys(values).find((k) => !names.includes(k));
      const missing = query.parameters.find((p) => p.required !== false && values[String(p.name)] === undefined);
      if (unknown || missing) {
        const parameter = unknown ?? String(missing!.name);
        rc.send(422, { detail: { code: "invalid_arguments", parameter, message: `${parameter}: ${unknown ? "is not a parameter of this query" : "is required"}` } });
        return true;
      }
      if (query.refusal) {
        rc.send(409, { detail: query.refusal });
        return true;
      }
      state.testRuns.unshift({ query_id: query.id, values });
      const result = query.result ?? { columns: ["number", "status"], rows: [["A-10023", "shipped"]] };
      const failed = "error_code" in result;
      const run: FakeQueryRun = {
        id: randomUUID(),
        query_id: query.id,
        connection_id: query.connection_id,
        query_version: query.version,
        source: "test",
        outcome: result.outcome ?? (failed ? "error" : "ok"),
        error_code: failed ? result.error_code : null,
        row_count: failed ? null : result.rows.length,
        created_at: at(),
        writeEvidence: state.writeFields && result.writeEvidence ? Object.fromEntries(Object.entries(result.writeEvidence).filter(([key]) => key !== "rolled_back")) : undefined,
      };
      state.runs.push(run);
      rc.send(200, {
        outcome: run.outcome,
        error_code: run.error_code,
        sqlstate: null,
        model_text: failed
          ? JSON.stringify({ error: result.error_code, message: "The query could not run." })
          : JSON.stringify({ columns: result.columns, rows: result.rows, row_count: result.rows.length }),
        columns: failed ? [] : result.columns,
        rows: failed ? [] : result.rows,
        row_count: run.row_count ?? 0,
        returned_rows: run.row_count ?? 0,
        truncated: false,
        result_chars: failed ? null : 80,
        duration_ms: 15,
        run_id: run.id,
        ...(state.procedureFields ? { notice: result.notice ?? null } : {}),
        params_json_schema: queryView(state, query).params_json_schema,
        ...(state.writeFields ? result.writeEvidence : {}),
      });
      return true;
    }
  }
  rc.send(404, { detail: "Not Found" });
  return true;
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Explicit query settings, without simulating the server's kind-dependent defaults or runtime. */
function queryWriteFields(q: object): Record<string, unknown> {
  return Object.fromEntries(["kind", "max_affected_rows", "requires_confirmation", "max_calls"].flatMap(key => {
    const value = (q as Record<string, unknown>)[key];
    return value === undefined ? [] : [[key, value]];
  }));
}

/** A package query's parameters as the instance stores them: every field, the defaults filled in. */
function stored(parameters: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(parameters) ? parameters.filter(isObject) : []).map((p) => ({
    name: p.name,
    source: p.source ?? "model",
    type: p.type ?? "string",
    description: p.description ?? "",
    required: p.required ?? true,
    max_length: p.max_length ?? ((p.type ?? "string") === "string" && (p.source ?? "model") === "model" ? 200 : null),
    pattern: p.pattern ?? null,
    enum: p.enum ?? null,
    minimum: p.minimum ?? null,
    maximum: p.maximum ?? null,
  }));
}

/** Whether a package's query tool equals the tenant's saved query, as the import compares them. */
function matches(state: DatabaseState, tool: Record<string, unknown>, query: FakeQuery): boolean {
  const definition = tool.database_query as Record<string, unknown>;
  const connection = isObject(definition.connection) ? definition.connection : {};
  const target = state.connections.find((c) => c.id === query.connection_id);
  return (
    tool.name === query.name &&
    (tool.description ?? null) === query.description &&
    connection.name === target?.name &&
    definition.sql_text === query.sql_text &&
    JSON.stringify(stored(definition.parameters)) === JSON.stringify(stored(query.parameters)) &&
    (definition.max_rows ?? 50) === query.max_rows &&
    (definition.max_result_chars ?? 8000) === query.max_result_chars &&
    (definition.allows_anonymous ?? false) === query.allows_anonymous &&
    ["kind", "max_affected_rows", "requires_confirmation", "max_calls"].every(key =>
      (definition[key] ?? QUERY_SCHEMA[key]?.default) === (queryWriteFields(query)[key] ?? QUERY_SCHEMA[key]?.default))
  );
}

export interface QueryBlocker {
  code: string;
  message: string;
  path: string;
  hint: string;
}

/**
 * The preview's blockers for a package's query tools: a connection the tenant
 * lacks, and, for a credential that may not write queries, each query the
 * import would create or change. A tool without its query refers to the
 * tenant's as it is.
 */
export function queryBlockers(state: DatabaseState, tenantId: string, pkg: Record<string, unknown>, mayWrite: boolean, hint: (code: string) => string): QueryBlocker[] {
  const tools = Array.isArray(pkg.tools) ? pkg.tools : [];
  const out: QueryBlocker[] = [];
  tools.forEach((tool, index) => {
    if (!isObject(tool) || tool.tool_type !== "database_query" || !isObject(tool.database_query)) return;
    const slug = String(tool.slug);
    const existing = state.queries.find((q) => q.tenant_id === tenantId && q.slug === slug);
    if (existing && matches(state, tool, existing)) return;
    const connection = isObject(tool.database_query.connection) ? tool.database_query.connection : {};
    const target = state.connections.find((c) => c.tenant_id === tenantId && c.name === connection.name);
    // A stored-procedure call the target's connection may not take: its login, or the procedure's definition.
    const sql = typeof tool.database_query.sql_text === "string" ? tool.database_query.sql_text : "";
    if (target?.procedureCallRefusal && target.dialect === "mssql" && /^\s*EXEC(UTE)?\s/i.test(sql)) {
      out.push({
        code: target.procedureCallRefusal.code,
        message: `Database query '${slug}' cannot be saved: ${target.procedureCallRefusal.message}`,
        path: `tools[${index}].database_query.connection`,
        hint: hint(target.procedureCallRefusal.code),
      });
    }
    if (!target) {
      out.push({
        code: "database_connection_missing",
        message: `Database query '${slug}' needs the database connection '${String(connection.name)}' (${String(connection.dialect)}).`,
        path: `tools[${index}].database_query.connection`,
        hint: hint("database_connection_missing"),
      });
    }
    if (!mayWrite) {
      out.push({
        code: "database_query_needs_superadmin",
        message: `This import would ${existing ? "change" : "create"} the database query '${slug}', which needs database_connectors.manage in this tenant (the tenant Owner or a superadmin in Tenant mode).`,
        path: `tools[${index}].database_query`,
        hint: hint("database_query_needs_superadmin"),
      });
    }
  });
  return out;
}

/** The query writes a preview publishes; an unchanged definition or a tool referring to the saved query writes none. */
export function queryWrites(state: DatabaseState, tenantId: string, pkg: Record<string, unknown>): Array<{ slug: string; action: string }> {
  return (Array.isArray(pkg.tools) ? pkg.tools : []).flatMap((tool) => {
    if (!isObject(tool) || tool.tool_type !== "database_query" || !isObject(tool.database_query)) return [];
    const existing = state.queries.find((q) => q.tenant_id === tenantId && q.slug === tool.slug);
    return existing && matches(state, tool, existing) ? [] : [{ slug: String(tool.slug), action: existing ? "change" : "create" }];
  });
}

/** A caller holding the manage gate imports: the tenant's queries become the package's. */
export function adminImport(state: DatabaseState, tenantId: string, pkg: Record<string, unknown>): void {
  for (const tool of Array.isArray(pkg.tools) ? pkg.tools : []) {
    if (!isObject(tool) || tool.tool_type !== "database_query" || !isObject(tool.database_query)) continue;
    const definition = tool.database_query;
    const connection = state.connections.find((c) => c.tenant_id === tenantId && isObject(definition.connection) && c.name === definition.connection.name);
    if (!connection) throw new Error(`no connection for ${String(tool.slug)}`);
    const existing = state.queries.find((q) => q.tenant_id === tenantId && q.slug === tool.slug);
    if (existing && matches(state, tool, existing)) continue;
    const fields = {
      name: String(tool.name),
      description: String(tool.description ?? tool.name),
      connection_id: connection.id,
      sql_text: String(definition.sql_text),
      parameters: (definition.parameters as Array<Record<string, unknown>>) ?? [],
      max_rows: Number(definition.max_rows ?? 50),
      max_result_chars: Number(definition.max_result_chars ?? 8000),
      allows_anonymous: definition.allows_anonymous === true,
      ...queryWriteFields(definition),
    };
    if (existing) Object.assign(existing, fields, { version: existing.version + 1 });
    else state.queries.push({ id: randomUUID(), tenant_id: tenantId, slug: String(tool.slug), version: 1, ...fields });
  }
}

/** A tenant with one tested connection and one saved query, and the query tool its package carries. */
export function seedQueryTool(state: DatabaseState, tenantId: string): { connection: FakeConnection; query: FakeQuery; tool: Record<string, unknown> } {
  const connection: FakeConnection = { id: randomUUID(), tenant_id: tenantId, name: "shop-db", dialect: "postgresql", last_test_outcome: "ok" };
  const parameters = [
    { name: "order_no", source: "model", type: "string", description: "Order number as printed on the confirmation, e.g. A-10023", max_length: 20 },
    { name: "email", source: "end_user.email", type: "string" },
  ];
  const query: FakeQuery = {
    id: randomUUID(),
    tenant_id: tenantId,
    connection_id: connection.id,
    slug: "order_status",
    name: "Order status",
    description: "Status and shipping date of one of the signed-in visitor's orders, by order number.",
    sql_text: "SELECT number, status FROM orders WHERE number = :order_no AND email = :email LIMIT 5",
    parameters,
    max_rows: 5,
    max_result_chars: 4000,
    allows_anonymous: false,
    version: 1,
  };
  state.connections.push(connection);
  state.queries.push(query);
  const tool = {
    slug: query.slug,
    name: query.name,
    description: query.description,
    tool_type: "database_query",
    scope: "tenant_local",
    params_json_schema: { type: "object", properties: { order_no: { type: "string", maxLength: 20 } }, required: ["order_no"], additionalProperties: false },
    database_query: {
      connection: { name: connection.name, dialect: connection.dialect },
      sql_text: query.sql_text,
      parameters,
      max_rows: query.max_rows,
      max_result_chars: query.max_result_chars,
      allows_anonymous: false,
    },
  };
  return { connection, query, tool };
}

/** What an export writes onto a query tool: the tenant's saved query, as the instance reads it from its tables. */
export function exportQueries(state: DatabaseState, tenantId: string, pkg: Record<string, unknown>): void {
  for (const tool of Array.isArray(pkg.tools) ? pkg.tools : []) {
    if (!isObject(tool) || tool.tool_type !== "database_query") continue;
    const query = state.queries.find((q) => q.tenant_id === tenantId && q.slug === tool.slug);
    const connection = query && state.connections.find((c) => c.id === query.connection_id);
    if (!query || !connection) continue;
    tool.name = query.name;
    tool.description = query.description;
    tool.database_query = {
      connection: { name: connection.name, dialect: connection.dialect },
      sql_text: query.sql_text,
      parameters: query.parameters,
      max_rows: query.max_rows,
      max_result_chars: query.max_result_chars,
      allows_anonymous: query.allows_anonymous,
      ...(state.writeFields ? queryWriteFields(query) : {}),
    };
  }
}
