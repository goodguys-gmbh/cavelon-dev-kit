import { CURSOR_OPTION, intOption, LIMIT_OPTION, listOption, pageOf, positional, stringOption, type CommandSpec, type Context } from "../command.js";
import { CavelonError, ExitCode, usageError } from "../errors.js";
import { connectorOffer } from "../database-queries.js";
import { requireFeature } from "../features.js";
import { clip, keyValues, moreHint, table } from "../format.js";
import { callStable } from "../invoke.js";
import { cavelonCommand, fill } from "../printed.js";
import { isUuid } from "../session.js";

/**
 * `cavelon db`: what the instance offers for database connections (its
 * dialects and the addresses it connects from), the tenant's connections,
 * saved queries and their runs, as a token may read them, and the two checks
 * the tenant Owner may run with a token: a connection test and a test run of
 * a saved query. Who creates
 * or changes a connection or a query is a superadmin in the Admin; a pull
 * writes the queries into the package. Nothing here prints a password: the
 * instance never returns one.
 */

interface Connection {
  id: string;
  name: string;
  dialect: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  password_set: boolean;
  password_changed_at: string;
  tls_mode: string;
  ca_certificate_pem?: string | null;
  ca_certificate_sha256?: string[];
  /** Per certificate of the uploaded CA bundle; an older instance publishes only the fingerprints. */
  ca_certificates?: CaCertificate[];
  statement_timeout_ms: number;
  is_enabled: boolean;
  config_version: number;
  last_test_at?: string | null;
  last_test_outcome?: string | null;
  last_test_detail?: Record<string, unknown> | null;
  query_count?: number;
  [key: string]: unknown;
}

interface CaCertificate {
  subject: string;
  issuer?: string;
  not_before?: string;
  not_after: string;
  sha256?: string;
}

interface InstanceOffer {
  runnable_dialects: string[];
  network: { egress_ips: string[]; connections_per_process: number };
}

interface QueryParameter {
  name: string;
  source?: string;
  type?: string;
  description?: string;
  required?: boolean;
  [key: string]: unknown;
}

interface Query {
  id: string;
  connection_id: string;
  connection_name: string;
  tool_definition_id: string;
  slug: string;
  name: string;
  description?: string | null;
  sql_text: string;
  parameters: QueryParameter[];
  params_json_schema?: Record<string, unknown> | null;
  max_rows: number;
  max_result_chars: number;
  allows_anonymous: boolean;
  is_enabled: boolean;
  version: number;
  [key: string]: unknown;
}

interface Run {
  id: string;
  created_at: string;
  source: string;
  outcome: string;
  error_code?: string | null;
  duration_ms?: number | null;
  row_count?: number | null;
  truncated: boolean;
  query_version: number;
  [key: string]: unknown;
}

interface TestStep {
  name: string;
  status: string;
  code?: string | null;
  driver_message?: string | null;
  detail?: Record<string, unknown>;
}

const FEATURE = "database_connector_enabled";
const DOCS_PAGE = "administration/database-connectors";

/** The connector's routes answer 404 while it is off: say so instead, where the instance publishes the switch. */
const connectorOn = (ctx: Context) => requireFeature(ctx, FEATURE, "database_connector_disabled", "the database connector");

/** An answer of 403 with the permission it needs and who holds it, instead of the generic hint. */
function withPermissionHint(error: unknown, hint: string): unknown {
  if (!(error instanceof CavelonError) || error.status !== 403) return error;
  return new CavelonError(error.exitCode, {
    code: error.code,
    status: error.status,
    message: error.message,
    hint: `${hint} \`${cavelonCommand("whoami")}\` shows the token's role.`,
    docs: error.docs,
  });
}

/** The Owner (or a superadmin in the Admin) runs the checks, not every role that reads. */
const ownerOnly = (error: unknown, what: string) =>
  withPermissionHint(
    error,
    `${what} needs the tenant Owner's permission (database_connectors.test), or a superadmin in the Admin; the roles that read the connections do not hold it.`,
  );

/** Every read needs database_connectors.view, which the tenant roles that see tools hold. */
const viewerOnly = (error: unknown) =>
  withPermissionHint(error, "Reading the database connector needs database_connectors.view, which the tenant roles that see tools hold, and a superadmin in Tenant mode.");

async function read<T>(ctx: Context, path: string, what: string, query?: Record<string, string | undefined>): Promise<T> {
  await connectorOn(ctx);
  try {
    return await callStable<T>(ctx, "GET", path, what, { query });
  } catch (error) {
    throw viewerOnly(error);
  }
}

const listConnections = (ctx: Context) => read<Connection[]>(ctx, "/api/v1/database-connectors/connections", "database connections");

const listQueries = (ctx: Context, connectionId?: string) =>
  read<Query[]>(ctx, "/api/v1/database-connectors/queries", "database queries", { connection_id: connectionId });

/** A connection by its name or id. */
async function resolveConnection(ctx: Context, ref: string): Promise<Connection> {
  const all = await listConnections(ctx);
  const hit = all.find((c) => c.id === ref.toLowerCase()) ?? all.find((c) => c.name === ref) ?? all.find((c) => c.name.toLowerCase() === ref.toLowerCase());
  if (hit) return hit;
  throw new CavelonError(ExitCode.failure, {
    code: "database_connection_not_found",
    message: `No database connection "${ref}" in this tenant.`,
    hint: `\`${cavelonCommand("db", "connections")}\` lists them${all.length ? ` (${all.map((c) => c.name).slice(0, 10).join(", ")})` : "; a superadmin creates one in the Admin"}.`,
  });
}

/** A saved query by its tool's slug or the query's id. */
async function resolveQuery(ctx: Context, ref: string): Promise<Query> {
  await connectorOn(ctx);
  if (isUuid(ref)) {
    try {
      return await callStable<Query>(ctx, "GET", "/api/v1/database-connectors/queries/{query_id}", "database queries", { params: { query_id: [ref] } });
    } catch (error) {
      if (!(error instanceof CavelonError && error.status === 404)) throw viewerOnly(error);
    }
  }
  const all = await listQueries(ctx);
  const hit = all.find((q) => q.id === ref.toLowerCase()) ?? all.find((q) => q.slug === ref) ?? all.find((q) => q.slug.toLowerCase() === ref.toLowerCase());
  if (hit) return hit;
  throw new CavelonError(ExitCode.failure, {
    code: "database_query_not_found",
    message: `No database query "${ref}" in this tenant.`,
    hint: `\`${cavelonCommand("db", "queries")}\` lists them by the slug of their tool${all.length ? ` (${all.map((q) => q.slug).slice(0, 10).join(", ")})` : ""}.`,
  });
}

/** A connection without its CA certificate's text (its fingerprints and details stay), so a list stays short. */
function connectionView(c: Connection): Record<string, unknown> {
  const { ca_certificate_pem: pem, ...rest } = c;
  return { ...rest, ca_certificate_set: Boolean(pem) };
}

const DAY_MS = 86_400_000;
/** How long before a CA certificate expires the listing warns. */
const EXPIRY_WARNING_DAYS = 30;

const day = (iso: string) => iso.slice(0, 10);

/**
 * A warning per CA certificate that has expired or expires within 30 days:
 * from that day the connection's TLS check fails where it verifies the
 * server's certificate, and with it every query on the connection.
 */
function expiryWarnings(connections: Connection[], now: Date): string[] {
  const warnings: string[] = [];
  for (const c of connections) {
    for (const cert of c.ca_certificates ?? []) {
      const until = Date.parse(cert.not_after);
      if (Number.isNaN(until)) continue;
      const days = Math.floor((until - now.getTime()) / DAY_MS);
      if (days >= EXPIRY_WARNING_DAYS) continue;
      const when =
        until <= now.getTime()
          ? `expired on ${day(cert.not_after)}`
          : `expires on ${day(cert.not_after)} (in ${days === 0 ? "less than a day" : `${days} day${days === 1 ? "" : "s"}`})`;
      warnings.push(
        `The CA certificate "${cert.subject}" of the database connection "${c.name}" ${when}: from then its TLS check fails, and with it the connection's queries. ` +
          `A superadmin uploads the renewed CA in the Admin; then the tenant Owner tests the connection again: ${cavelonCommand("db", "test", c.name)}`,
      );
    }
  }
  return warnings;
}

/** The CA lines of a listing: subject and expiry per certificate, or that only fingerprints are published. */
function caLines(connections: Connection[]): string[] {
  const lines: string[] = [];
  for (const c of connections) {
    if (c.ca_certificates?.length) {
      for (const cert of c.ca_certificates) lines.push(`${c.name}: ${cert.subject}, valid until ${day(cert.not_after)}`);
    } else if (!c.ca_certificates && c.ca_certificate_sha256?.length) {
      const n = c.ca_certificate_sha256.length;
      lines.push(`${c.name}: a CA is set (${n} certificate${n === 1 ? "" : "s"}); this instance does not publish their subject or expiry`);
    }
  }
  return lines.length ? ["", "", "CA certificates:", ...lines] : [];
}

function lastTest(c: Connection): string {
  if (!c.last_test_at) return "never";
  return `${c.last_test_outcome ?? "?"} (${c.last_test_at})`;
}

/** Who fills a parameter, as the editor says it. */
const filledBy = (p: QueryParameter) => (!p.source || p.source === "model" ? "model" : p.source);

function parameterRows(parameters: QueryParameter[]): Array<Record<string, unknown>> {
  return parameters.map((p) => ({
    name: p.name,
    filled_by: filledBy(p),
    type: p.type ?? "string",
    required: p.required === false ? "no" : "yes",
    constraints:
      ["max_length", "pattern", "enum", "minimum", "maximum"]
        .filter((k) => p[k] !== undefined && p[k] !== null)
        .map((k) => `${k} ${JSON.stringify(p[k])}`)
        .join(", ") || null,
    description: p.description || null,
  }));
}

/** The lines that send a reader to `explain` for each code a listing shows. */
function explainLine(codes: Array<string | null | undefined>): string {
  const distinct = [...new Set(codes.filter((c): c is string => Boolean(c)))];
  if (!distinct.length) return "";
  return `\n\nWhat a code means: ${cavelonCommand("explain", fill("code"))} (${distinct.slice(0, 8).join(", ")})`;
}

/** What a customer's firewall must let through, in a sentence; the text and the JSON say the same. */
function firewallSentence(offer: InstanceOffer): string {
  const { egress_ips: ips, connections_per_process: perProcess } = offer.network;
  const pool = `Each process of the instance that runs agents opens at most ${perProcess} connection${perProcess === 1 ? "" : "s"} per database connection.`;
  if (!ips.length) {
    return (
      "The instance's operator has named no addresses it connects from, so it does not say what to allowlist: " +
      `ask the operator before opening the database's firewall. ${pool}`
    );
  }
  const these = ips.length === 1 ? "this address" : "these addresses";
  return `Allow ${ips.join(", ")} through the database's firewall, on the database's port: the instance connects to a customer's database only from ${these}. ${pool}`;
}

export const dbInstance: CommandSpec = {
  name: "db instance",
  summary: "What this instance offers for database connections: the dialects it runs, and the addresses a database's firewall lets in.",
  description:
    "Read it before a database connection is set up: a connection of a dialect the instance does not run can be saved, but\n" +
    "its test and queries answer unavailable, and the customer's database must let the instance's egress addresses in. An\n" +
    "instance older than this route says only its dialects, in its capabilities.",
  readOnly: true,
  idempotent: true,
  mcpTool: "db_instance",
  examples: ["cavelon db instance", "cavelon db instance --json"],
  async run(ctx) {
    let offer: InstanceOffer;
    try {
      offer = await read<InstanceOffer>(ctx, "/api/v1/database-connectors/instance", "the database connector's dialects and network");
    } catch (error) {
      const unpublished = error instanceof CavelonError && (error.code === "operation_unavailable" || error.status === 404);
      if (!unpublished) throw error;
      // An instance older than the route still names its dialects in its capabilities.
      const dialects = connectorOffer(await (await ctx.contracts()).capabilities()).dialects;
      return {
        data: { published: false, runnable_dialects: dialects ?? null, network: null },
        text:
          "This instance does not publish which addresses it connects to databases from (it is older than that); its operator knows them." +
          (dialects ? `\nDialects it runs: ${dialects.join(", ") || "none"}` : ""),
      };
    }
    const firewall = firewallSentence(offer);
    return {
      data: { published: true, ...offer, firewall },
      text: [
        keyValues([
          ["dialects", offer.runnable_dialects.join(", ") || "none"],
          ["egress_ips", offer.network.egress_ips.join(", ") || "none named"],
          ["connections_per_process", offer.network.connections_per_process],
        ]),
        "",
        firewall,
        ...(offer.runnable_dialects.length ? [] : ["", "This instance runs no database dialect: a connection can be saved, but its test and queries answer unavailable."]),
      ].join("\n"),
    };
  },
};

export const dbConnections: CommandSpec = {
  name: "db connections",
  summary: "The tenant's database connections: dialect, target, TLS mode, CA certificates, last test and query count; never a password.",
  description:
    "A superadmin creates and changes connections in the Admin; a token reads them. A package names a query's connection by\n" +
    "name and dialect, so the same name serves in every tenant and environment. A query tool is ready for agents only while\n" +
    "its connection is enabled and its last test passed; the tenant Owner runs the test with `cavelon db test <connection>`.\n" +
    `It warns of a CA certificate that has expired or expires within ${EXPIRY_WARNING_DAYS} days.`,
  readOnly: true,
  idempotent: true,
  mcpTool: "db_connections",
  options: { limit: { ...LIMIT_OPTION, description: "Return at most n connections (default 50)." }, cursor: CURSOR_OPTION },
  examples: ["cavelon db connections", "cavelon db connections --json"],
  async run(ctx, input) {
    const limit = intOption(input, "limit", { min: 1, max: 500, fallback: 50 })!;
    const all = await listConnections(ctx);
    for (const warning of expiryWarnings(all, ctx.io.now())) ctx.warn(warning);
    const page = pageOf(all.map(connectionView), limit, stringOption(input, "cursor"));
    const rows = page.items.map((c) => {
      const conn = c as unknown as Connection;
      return {
        name: conn.name,
        dialect: conn.dialect,
        target: `${conn.host}:${conn.port}/${conn.database_name}`,
        tls: conn.tls_mode,
        enabled: conn.is_enabled ? "yes" : "no",
        last_test: lastTest(conn),
        queries: conn.query_count ?? null,
        id: conn.id,
      };
    });
    const untested = page.items.filter((c) => (c as unknown as Connection).last_test_outcome !== "ok").map((c) => String(c.name));
    return {
      data: page,
      text:
        (table(rows, ["name", "dialect", "target", "tls", "enabled", "last_test", "queries", "id"]) ||
          `No database connections. A superadmin creates one in the Admin (\`${cavelonCommand("docs", "get", DOCS_PAGE)}\` says who does what).`) +
        caLines(page.items as unknown as Connection[]).join("\n") +
        moreHint(page.next_cursor, cavelonCommand("db", "connections")) +
        (untested.length ? `\n\nNot tested successfully: ${untested.join(", ")}; its queries are not ready for agents. The Owner tests one with: ${cavelonCommand("db", "test", fill("connection"))}` : ""),
    };
  },
};

export const dbQueries: CommandSpec = {
  name: "db queries",
  summary: "The tenant's saved database queries by tool slug; with a query, its SQL, parameters and limits.",
  description:
    "Each saved query is one agent tool (tool_type database_query). A superadmin writes it in the Admin; `cavelon pull` writes\n" +
    "its definition into the package's tools. A parameter filled by end_user.* comes from the signed-in visitor, never from\n" +
    "the model. Without a query: one line per query. With one (its tool's slug or the query's id): the whole query.",
  readOnly: true,
  idempotent: true,
  mcpTool: "db_queries",
  positionals: [{ name: "query", description: "A query's tool slug or id: show it in full." }],
  options: {
    connection: { type: "string", value: "<connection>", description: "Only the queries of this connection (name or id)." },
    limit: { ...LIMIT_OPTION, description: "Return at most n queries (default 50)." },
    cursor: CURSOR_OPTION,
  },
  examples: ["cavelon db queries", "cavelon db queries --connection shop-db", "cavelon db queries order_status --json"],
  async run(ctx, input) {
    const ref = positional(input, "query");
    if (ref) {
      const q = await resolveQuery(ctx, ref);
      const text = [
        keyValues([
          ["query", `${q.slug} (${q.name})`],
          ["connection", q.connection_name],
          ["description", q.description ? clip(q.description, 300) : undefined],
          ["limits", `max_rows ${q.max_rows}, max_result_chars ${q.max_result_chars}`],
          ["anonymous", q.allows_anonymous ? "visitors may call it without signing in" : "a signed-in visitor only"],
          ["enabled", q.is_enabled ? "yes" : "no"],
          ["version", q.version],
          ["id", q.id],
        ]),
        "",
        "SQL:",
        q.sql_text,
        "",
        q.parameters.length ? table(parameterRows(q.parameters), ["name", "filled_by", "type", "required", "constraints", "description"]) : "No parameters.",
        "",
        `Its runs (no values, no rows): ${cavelonCommand("db", "runs", q.slug)}`,
      ].join("\n");
      return { data: q, text };
    }
    const connectionRef = stringOption(input, "connection");
    const connection = connectionRef ? await resolveConnection(ctx, connectionRef) : undefined;
    const limit = intOption(input, "limit", { min: 1, max: 500, fallback: 50 })!;
    // The SQL is the whole query; a listing names each one, and the query itself shows its SQL.
    const all = (await listQueries(ctx, connection?.id)).map(({ sql_text: sql, params_json_schema: _schema, ...q }) => ({ ...q, sql_chars: sql.length }));
    const page = pageOf(all, limit, stringOption(input, "cursor"));
    const rows = page.items.map((q) => ({
      slug: q.slug,
      name: q.name,
      connection: q.connection_name,
      parameters: q.parameters.map((p) => (filledBy(p) === "model" ? p.name : `${p.name} (${filledBy(p)})`)).join(", ") || null,
      max_rows: q.max_rows,
      anonymous: q.allows_anonymous ? "yes" : "no",
      enabled: q.is_enabled ? "yes" : "no",
      version: q.version,
    }));
    return {
      data: page,
      text:
        (table(rows, ["slug", "name", "connection", "parameters", "max_rows", "anonymous", "enabled", "version"], 60) || "No database queries.") +
        moreHint(page.next_cursor, cavelonCommand("db", "queries")) +
        (rows.length ? `\n\nOne query in full: ${cavelonCommand("db", "queries", fill("slug"))}` : ""),
    };
  },
};

export const dbRuns: CommandSpec = {
  name: "db runs",
  summary: "A saved query's runs, newest first: source, outcome, error code, duration and row count; never values or rows.",
  description:
    "Every run leaves this evidence, an agent's call and a test run alike; the instance keeps no parameter value, row or SQL.\n" +
    "`cavelon explain <code>` says what an error code means and how to fix it.",
  readOnly: true,
  idempotent: true,
  mcpTool: "db_runs",
  positionals: [{ name: "query", description: "The query's tool slug or id.", required: true }],
  options: {
    limit: { ...LIMIT_OPTION, description: "Return at most n runs (default 20, at most 200)." },
    cursor: CURSOR_OPTION,
  },
  examples: ["cavelon db runs order_status", "cavelon db runs order_status --limit 50 --json"],
  async run(ctx, input) {
    const q = await resolveQuery(ctx, positional(input, "query")!);
    const limit = intOption(input, "limit", { min: 1, max: 200, fallback: 20 })!;
    const cursor = stringOption(input, "cursor");
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isInteger(offset) || offset < 0) throw usageError(`--cursor "${cursor}" is not a cursor from a previous page.`);
    const page = await callStable<{ items: Run[]; next_offset?: number | null }>(ctx, "GET", "/api/v1/database-connectors/queries/{query_id}/runs", "database query runs", {
      params: { query_id: [q.id] },
      query: { limit, offset },
    }).catch((error: unknown) => {
      throw viewerOnly(error);
    });
    const items = page.items ?? [];
    const next = typeof page.next_offset === "number" ? String(page.next_offset) : null;
    const rows = items.map((r) => ({
      at: r.created_at,
      source: r.source,
      outcome: r.outcome,
      error_code: r.error_code ?? null,
      duration_ms: r.duration_ms ?? null,
      rows: r.row_count ?? null,
      truncated: r.truncated ? "yes" : null,
      version: r.query_version,
    }));
    return {
      data: { query: { id: q.id, slug: q.slug, version: q.version }, items, next_cursor: next },
      text:
        (table(rows, ["at", "source", "outcome", "error_code", "duration_ms", "rows", "truncated", "version"]) || `No runs of ${q.slug} yet.`) +
        moreHint(next, cavelonCommand("db", "runs", q.slug)) +
        explainLine(items.map((r) => r.error_code)),
    };
  },
};

export const dbTest: CommandSpec = {
  name: "db test",
  summary: "Test a database connection step by step (DNS, policy, TCP, TLS, login, SELECT 1, version, write privileges); exit 3 when a step fails.",
  description:
    "Needs the tenant Owner's permission (database_connectors.test). The result becomes the connection's last test: a query tool\n" +
    "is ready for agents only while it passed, and a package's query needs a tested connection of its name to import. A failed\n" +
    "step names its code; `cavelon explain <code>` says how to fix it. A finding under write_privileges means the database user\n" +
    "can write: ask the database administrator for a read-only user.",
  readOnly: false,
  idempotent: true,
  mcpEffect: "Runs the connection test on the instance and stores its outcome as the connection's last test; changes no setting.",
  mcpTool: "db_test",
  operations: ["POST /api/v1/database-connectors/connections/{connection_id}/test"],
  positionals: [{ name: "connection", description: "The connection's name or id.", required: true }],
  examples: ["cavelon db test shop-db", "cavelon db test shop-db --json"],
  async run(ctx, input) {
    const connection = await resolveConnection(ctx, positional(input, "connection")!);
    let result: { outcome: string; steps: TestStep[]; server_version?: string | null; write_privileges?: Record<string, unknown> | null; duration_ms: number; tested_at: string };
    try {
      result = await callStable(ctx, "POST", "/api/v1/database-connectors/connections/{connection_id}/test", "testing database connections", {
        params: { connection_id: [connection.id] },
        timeoutMs: 90_000,
      });
    } catch (error) {
      throw ownerOnly(error, "A connection test");
    }
    const ok = result.outcome === "ok";
    const steps = (result.steps ?? []).map((s) => ({ step: s.name, status: s.status, code: s.code ?? null, message: s.driver_message ? clip(s.driver_message, 160) : null }));
    const text = [
      `Connection "${connection.name}" (${connection.dialect}): ${ok ? "test passed" : `test failed (${result.outcome})`}, ${result.duration_ms} ms.`,
      table(steps, ["step", "status", "code", ...(steps.some((s) => s.message) ? ["message"] : [])], 80),
      ...(result.server_version ? [`server: ${result.server_version}`] : []),
      ...(result.write_privileges ? [`write privileges: ${clip(JSON.stringify(result.write_privileges), 300)}`] : []),
    ].join("\n");
    return {
      data: { connection: { id: connection.id, name: connection.name, dialect: connection.dialect }, ...result },
      text: text + explainLine(steps.filter((s) => s.code && s.status !== "ok").map((s) => s.code)),
      exitCode: ok ? ExitCode.ok : ExitCode.validation,
    };
  },
};

/** A value given as text, as the parameter's type binds it. */
function typed(parameter: QueryParameter | undefined, raw: string): unknown {
  const type = parameter?.type ?? "string";
  if (type === "integer" || type === "number") {
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) {
      throw usageError(`--value ${parameter!.name}: "${raw}" is not ${type === "integer" ? "an integer" : "a number"}.`);
    }
    return value;
  }
  if (type === "boolean") {
    if (raw === "true" || raw === "false") return raw === "true";
    throw usageError(`--value ${parameter!.name}: "${raw}" is not true or false.`);
  }
  return raw;
}

/** The test run's values: one `name=value` per parameter, context parameters included. */
function runValues(query: Query, given: string[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const pair of given) {
    const at = pair.indexOf("=");
    if (at <= 0) throw usageError(`--value takes name=value, got "${pair}".`);
    const name = pair.slice(0, at);
    const parameter = query.parameters.find((p) => p.name === name);
    if (!parameter) {
      throw usageError(
        `${query.slug} has no parameter "${name}".`,
        `Its parameters: ${query.parameters.map((p) => `${p.name} (${filledBy(p)}, ${p.type ?? "string"})`).join(", ") || "none"}.`,
      );
    }
    values[name] = typed(parameter, pair.slice(at + 1));
  }
  return values;
}

const ROWS_SHOWN = 20;

export const dbTestRun: CommandSpec = {
  name: "db test-run",
  summary: "Run a saved query once with the values given, identity parameters included; show what the model would see and the rows.",
  description:
    "Needs the tenant Owner's permission (database_connectors.test); it reads the customer's own data. Give each parameter\n" +
    "with --value name=value, those the platform fills from the signed-in visitor (end_user.*) too: that is how an\n" +
    "identity-scoped query is checked for one customer. The instance records the run (counts only) and audits it with your\n" +
    "name; the rows come back once and are never stored. A failed run names its code; `cavelon explain <code>` says more.",
  readOnly: false,
  idempotent: true,
  mcpEffect: "Runs the saved query once on the instance; it leaves a run record (counts only) and an audit entry, and changes no setting.",
  mcpTool: "db_test_run",
  operations: ["POST /api/v1/database-connectors/queries/{query_id}/test-run"],
  positionals: [{ name: "query", description: "The query's tool slug or id.", required: true }],
  options: {
    value: { type: "string", multiple: true, value: "<name=value>", description: "One parameter's value, typed as the parameter's type." },
    rows: { type: "string", value: "<n>", description: `Show at most n rows in the text (default ${ROWS_SHOWN}); --json carries what the instance returned.` },
  },
  examples: ["cavelon db test-run order_status --value order_no=A-10023 --value email=ada@example.com", "cavelon db test-run stock --value sku=4711 --json"],
  async run(ctx, input) {
    const query = await resolveQuery(ctx, positional(input, "query")!);
    const values = runValues(query, listOption(input, "value"));
    const shown = intOption(input, "rows", { min: 0, max: 500, fallback: ROWS_SHOWN })!;
    let result: {
      outcome: string;
      error_code?: string | null;
      sqlstate?: string | null;
      model_text: string;
      columns?: string[];
      rows?: unknown[][];
      row_count?: number;
      returned_rows?: number;
      truncated?: boolean;
      duration_ms: number;
      run_id?: string | null;
    };
    try {
      result = await callStable(ctx, "POST", "/api/v1/database-connectors/queries/{query_id}/test-run", "test runs of database queries", {
        params: { query_id: [query.id] },
        body: { values },
        timeoutMs: 90_000,
      });
    } catch (error) {
      throw ownerOnly(error, "A test run");
    }
    const ok = result.outcome === "ok" && !result.error_code;
    const columns = result.columns ?? [];
    const rows = (result.rows ?? []).slice(0, shown).map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i] === null || typeof row[i] !== "object" ? row[i] : JSON.stringify(row[i])])));
    const more = (result.rows?.length ?? 0) - rows.length;
    const text = [
      keyValues([
        ["query", `${query.slug} (version ${query.version})`],
        ["outcome", result.error_code ? `${result.outcome} (${result.error_code}${result.sqlstate ? `, SQLSTATE ${result.sqlstate}` : ""})` : result.outcome],
        ["rows", ok ? `${result.returned_rows ?? rows.length} returned of ${result.row_count ?? "?"}${result.truncated ? ", truncated for the model" : ""}` : undefined],
        ["duration_ms", result.duration_ms],
      ]),
      "",
      "What the model sees:",
      clip(result.model_text, 2000),
      ...(rows.length ? ["", table(rows, columns, 40)] : []),
      ...(more > 0 ? [`… ${more} more rows (--rows, or --json).`] : []),
    ].join("\n");
    return {
      data: { query: { id: query.id, slug: query.slug, version: query.version }, ...result },
      text: text + explainLine([result.error_code]),
      exitCode: ok ? ExitCode.ok : ExitCode.validation,
    };
  },
};
