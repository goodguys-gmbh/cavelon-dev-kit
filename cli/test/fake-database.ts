import { randomUUID } from "node:crypto";

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
  /** The steps a test reports; a passing run of every step by default. */
  testSteps?: Array<{ name: string; status: string; code: string | null }>;
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
  /** What a test run returns: columns and rows, or an error code. */
  result?: { columns: string[]; rows: unknown[][] } | { error_code: string };
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
}

export interface DatabaseState {
  connections: FakeConnection[];
  queries: FakeQuery[];
  runs: FakeQueryRun[];
  /** Whether the caller holds the Owner's database_connectors.test. */
  mayTest: boolean;
  /** What a test run was sent, last first. */
  testRuns: Array<{ query_id: string; values: Record<string, unknown> }>;
}

export function databaseState(): DatabaseState {
  return { connections: [], queries: [], runs: [], mayTest: true, testRuns: [] };
}

export interface DatabaseRoute {
  method: string;
  path: string;
  url: URL;
  json: unknown;
  tenantId: string;
  /** features.database_connector_enabled as the capabilities publish it. */
  enabled: boolean;
  send: (status: number, body: unknown) => void;
}

const STEPS = ["dns", "policy", "tcp", "tls", "login", "select_1", "server_version", "write_privileges"];
const at = () => new Date().toISOString();

function connectionView(state: DatabaseState, c: FakeConnection) {
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
    ca_certificate_pem: null,
    ca_certificate_sha256: [],
    statement_timeout_ms: 5000,
    is_enabled: true,
    config_version: 1,
    last_test_at: c.last_test_outcome ? "2026-10-01T08:05:00Z" : null,
    last_test_outcome: c.last_test_outcome,
    last_test_detail: null,
    query_count: state.queries.filter((q) => q.connection_id === c.id).length,
    created_by_user_id: null,
    updated_by_user_id: null,
    created_at: "2026-10-01T08:00:00Z",
    updated_at: "2026-10-01T08:00:00Z",
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
    is_enabled: true,
    version: q.version,
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
  };
}

export function handleDatabase(state: DatabaseState, rc: DatabaseRoute): boolean {
  if (!rc.path.startsWith("/api/v1/database-connectors/")) return false;
  if (!rc.enabled) {
    rc.send(404, { detail: "Not Found" });
    return true;
  }
  const own = <T extends { tenant_id: string }>(list: T[]) => list.filter((x) => x.tenant_id === rc.tenantId);
  if (rc.path === "/api/v1/database-connectors/connections" && rc.method === "GET") {
    rc.send(200, own(state.connections).map((c) => connectionView(state, c)));
    return true;
  }
  let m = /^\/api\/v1\/database-connectors\/connections\/([^/]+)(\/test)?$/.exec(rc.path);
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
    if (m[2] && rc.method === "POST") {
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
      state.testRuns.unshift({ query_id: query.id, values });
      const result = query.result ?? { columns: ["number", "status"], rows: [["A-10023", "shipped"]] };
      const failed = "error_code" in result;
      const run: FakeQueryRun = {
        id: randomUUID(),
        query_id: query.id,
        connection_id: query.connection_id,
        query_version: query.version,
        source: "test",
        outcome: failed ? "error" : "ok",
        error_code: failed ? result.error_code : null,
        row_count: failed ? null : result.rows.length,
        created_at: at(),
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
        params_json_schema: queryView(state, query).params_json_schema,
      });
      return true;
    }
  }
  rc.send(404, { detail: "Not Found" });
  return true;
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

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
    (definition.allows_anonymous ?? false) === query.allows_anonymous
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
    if (!state.connections.some((c) => c.tenant_id === tenantId && c.name === connection.name)) {
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
        message: `This import would ${existing ? "change" : "create"} the database query '${slug}', which only a superadmin in Tenant mode can do, in the Admin.`,
        path: `tools[${index}].database_query`,
        hint: hint("database_query_needs_superadmin"),
      });
    }
  });
  return out;
}

/** A superadmin imports the package in the Admin: the tenant's queries become the package's. */
export function adminImport(state: DatabaseState, tenantId: string, pkg: Record<string, unknown>): void {
  for (const tool of Array.isArray(pkg.tools) ? pkg.tools : []) {
    if (!isObject(tool) || tool.tool_type !== "database_query" || !isObject(tool.database_query)) continue;
    const definition = tool.database_query;
    const connection = state.connections.find((c) => c.tenant_id === tenantId && isObject(definition.connection) && c.name === definition.connection.name);
    if (!connection) throw new Error(`no connection for ${String(tool.slug)}`);
    const existing = state.queries.find((q) => q.tenant_id === tenantId && q.slug === tool.slug);
    const fields = {
      name: String(tool.name),
      description: String(tool.description ?? tool.name),
      connection_id: connection.id,
      sql_text: String(definition.sql_text),
      parameters: (definition.parameters as Array<Record<string, unknown>>) ?? [],
      max_rows: Number(definition.max_rows ?? 50),
      max_result_chars: Number(definition.max_result_chars ?? 8000),
      allows_anonymous: definition.allows_anonymous === true,
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
    };
  }
}
