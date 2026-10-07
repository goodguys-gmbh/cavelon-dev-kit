import { X509Certificate } from "node:crypto";
import { promises as fs } from "node:fs";
import { CURSOR_OPTION, intOption, LIMIT_OPTION, listOption, pageOf, positional, stringOption, type CommandSpec, type Context, type Input, type OptionSpec } from "../command.js";
import { principalOf } from "../access.js";
import { confirmation } from "../confirm-token.js";
import { CavelonError, ExitCode, usageError, validationError } from "../errors.js";
import { keyValues, moreHint, table } from "../format.js";
import { callStable, workflowOperation } from "../invoke.js";
import { deref } from "../openapi.js";
import { confinedPath } from "../paths.js";
import { cavelonCommand } from "../printed.js";
import { connectionView, connectorOn, read, resolveConnection, viewerOnly, withPermissionHint, type Connection } from "./db.js";

const CONNECTIONS = "/api/v1/database-connectors/connections";
const CONNECTION = `${CONNECTIONS}/{connection_id}`;
const manageHint = "This needs database_connectors.manage in Tenant mode: the tenant Owner (legacy Admin) or a superadmin, using a personal access token or the dashboard. A tenant API key cannot manage connections.";

/** The server remains the permission authority, including on older instances without principal permissions. */
async function manage<T>(ctx: Context, method: string, route: string, body?: unknown, id?: string): Promise<T> {
  await connectorOn(ctx);
  try {
    const { op } = await workflowOperation(ctx, method, route, "database connection management");
    if (op.personOnly?.marked) throw new CavelonError(ExitCode.needsAction, {
      code: "operation_for_a_person", message: `This instance keeps ${method} ${route} for a person${op.personOnly.reason ? ` (${op.personOnly.reason})` : ""}.`,
      hint: "A person manages the connection in the Admin under Settings › Security & access › Databases. This instance may be older than connection management with a personal access token.",
    });
    return await callStable<T>(ctx, method, route, "database connection management", { body, params: id ? { connection_id: [id] } : undefined });
  } catch (error) {
    if (error instanceof CavelonError && error.code === "credential_required_for_target_change") {
      throw new CavelonError(error.exitCode, { code: error.code, status: error.status, message: error.message, details: error.details,
        hint: "A person changes host, port or dialect of a password-bearing connection in the Admin under Settings › Security & access › Databases, with the new server's password. The kit never takes a password." });
    }
    throw withPermissionHint(error, manageHint);
  }
}

const textOption = (description: string, value = "<value>"): OptionSpec => ({ type: "string", value, description });
const connectionOptions: Record<string, OptionSpec> = {
  dialect: textOption("Database type, checked against this instance's published create/update schema.", "<dialect>"),
  host: textOption("One DNS name or IP address, without port, path or user.", "<host>"),
  port: textOption("Database port; required on create (the instance validates its bounds).", "<port>"),
  "database-name": textOption("Database name on this server.", "<name>"),
  username: textOption("Database login name; its password is set only in the Admin.", "<name>"),
  "tls-mode": textOption("TLS mode, checked against the published schema; omitted on create uses the instance's default.", "<mode>"),
  "statement-timeout-ms": textOption("Statement timeout in milliseconds, within the instance's bounds.", "<ms>"),
  enabled: textOption("Enable or disable the connection (true or false); omitted leaves the instance's default or current value.", "<true|false>"),
};

function booleanText(input: Input, name: string): boolean | undefined {
  const value = stringOption(input, name);
  if (value === undefined) return undefined;
  if (value !== "true" && value !== "false") throw usageError(`--${name} takes true or false.`);
  return value === "true";
}

/** Only explicitly given public fields enter a request; neither passwords nor write enablement have an input. */
function connectionBody(input: Input, name?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (name !== undefined) body.name = name;
  for (const [option, field] of Object.entries({ name: "name", dialect: "dialect", host: "host", "database-name": "database_name", username: "username", "tls-mode": "tls_mode" })) {
    const value = stringOption(input, option);
    if (value !== undefined) body[field] = value;
  }
  for (const [option, field] of Object.entries({ port: "port", "statement-timeout-ms": "statement_timeout_ms" })) {
    const value = intOption(input, option);
    if (value !== undefined) body[field] = value;
  }
  const enabled = booleanText(input, "enabled");
  if (enabled !== undefined) body.is_enabled = enabled;
  return body;
}

async function savedResult(ctx: Context, connection: Connection, verb: string) {
  const principal = await principalOf(await ctx.client());
  const person = principal?.needs_a_person?.find(o => o.method === "PUT" && o.path === `${CONNECTION}/password`) ?? null;
  const next = connection.password_set ? `Test the connection: ${cavelonCommand("db", "test", connection.name)}` :
    `${person?.reason ? `${person.reason}: ` : ""}a person sets the password in the Admin under Settings › Security & access › Databases, then runs ${cavelonCommand("db", "test", connection.name)}. The password never goes through the kit.`;
  return { data: { connection: connectionView(connection), needs_a_person: person, next_step: next }, text: `${verb} connection ${connection.name} (${connection.id}).\n${keyValues([
    ["dialect", connection.dialect], ["target", `${connection.host}:${connection.port}/${connection.database_name}`], ["username", connection.username],
    ["tls_mode", connection.tls_mode], ["password_set", connection.password_set], ["allows_writes", connection.allows_writes],
    ["ca_certificates", connection.ca_certificates], ["ca_certificate_sha256", connection.ca_certificate_sha256],
  ])}\n${next}` };
}

export const dbConnectionCreate: CommandSpec = {
  name: "db connections create", summary: "Create a connection without a password (database_connectors.manage); print the Admin password step.",
  description: "The tenant Owner (legacy Admin), or a superadmin in Tenant mode, creates it with a personal access token.\n" +
    "Fields and defaults come from this instance's OpenAPI. No password argument, environment value, stdin or file is read.\n" +
    "A person sets the password in Settings › Security & access › Databases before testing. Connections stay outside packages.",
  readOnly: false, mcpTool: "db_connection_create", operations: [`POST ${CONNECTIONS}`],
  positionals: [{ name: "name", required: true, description: "Connection name, the same in every environment that uses the package." }],
  options: connectionOptions,
  examples: ["cavelon db connections create shop-db --dialect postgresql --host db.example.com --port 5432 --database-name shop --username cavelon_reader"],
  async run(ctx, input) {
    const body = connectionBody(input, positional(input, "name")!);
    for (const field of ["dialect", "host", "port", "database_name", "username"]) if (body[field] === undefined) throw usageError(`Create needs --${field.replaceAll("_", "-")}.`);
    return savedResult(ctx, await manage<Connection>(ctx, "POST", CONNECTIONS, body), "Created");
  },
};

export const dbConnectionUpdate: CommandSpec = {
  name: "db connections update", summary: "Change only given public connection fields (database_connectors.manage); never a password or allows_writes.",
  description: "A person must move a password-bearing connection to another host, port or dialect in the Admin with its password.\n" +
    "The instance refuses that change from the kit; an uncredentialed connection moves freely. Test again after changing it.\n" +
    "Enabling writes and acknowledging write privileges remain dashboard actions and never enter a package.",
  readOnly: false, idempotent: true, mcpTool: "db_connection_update", operations: [`PATCH ${CONNECTION}`],
  positionals: [{ name: "connection", required: true, description: "Connection name or id." }],
  options: { name: textOption("New connection name.", "<name>"), ...connectionOptions },
  examples: ["cavelon db connections update shop-db --statement-timeout-ms 3000", "cavelon db connections update shop-db --enabled false"],
  async run(ctx, input) {
    const body = connectionBody(input);
    if (!Object.keys(body).length) throw usageError("Give at least one connection field to change.");
    const connection = await resolveConnection(ctx, positional(input, "connection")!);
    return savedResult(ctx, await manage<Connection>(ctx, "PATCH", CONNECTION, body, connection.id), "Updated");
  },
};

export const dbConnectionDelete: CommandSpec = {
  name: "db connections delete", summary: "Delete an unused connection (database_connectors.manage); previews first, --confirm deletes it.",
  description: "Without --confirm nothing is deleted. The instance refuses deletion while queries still use the connection.",
  readOnly: false, destructive: true, mcpTool: "db_connection_delete", operations: [`DELETE ${CONNECTION}`],
  positionals: [{ name: "connection", required: true, description: "Connection name or id." }],
  options: { confirm: { type: "boolean", mcpToken: true, description: "Delete the previewed connection." } },
  examples: ["cavelon db connections delete unused-db", "cavelon db connections delete unused-db --confirm"],
  async run(ctx, input) {
    const connection = await resolveConnection(ctx, positional(input, "connection")!);
    await connectorOn(ctx);
    await workflowOperation(ctx, "DELETE", CONNECTION, "database connection deletion");
    const gate = await confirmation(ctx, input, "db_connection_delete", { id: connection.id, config_version: connection.config_version });
    if (!gate.confirmed) return {
      data: { deleted: false, connection: connectionView(connection), confirm: gate.confirm(cavelonCommand("db", "connections", "delete", connection.id, "--confirm")), ...gate.fields },
      text: `Connection ${connection.name} (${connection.id}), ${connection.query_count ?? "unknown"} queries.\n${gate.where}\nNothing was deleted. Delete it with: ${gate.confirm(cavelonCommand("db", "connections", "delete", connection.id, "--confirm"))}`,
      exitCode: gate.exitCode,
    };
    await manage(ctx, "DELETE", CONNECTION, undefined, connection.id);
    return { data: { deleted: true, id: connection.id, name: connection.name }, text: `Deleted connection ${connection.name}.` };
  },
};

/** Public PEM only: parse every certificate and refuse every other block or trailing payload, without echoing it. */
function publicCertificates(pem: string): string {
  while (pem.endsWith("\0")) pem = pem.slice(0, -1);
  const refusal = () => validationError("A public CA certificate bundle is required; private keys and other content are refused.");
  if (pem.includes("PRIVATE KEY") || pem.includes("\0")) throw refusal();
  const blocks = [...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)];
  if (!blocks.length) throw refusal();
  let previous = 0;
  for (const block of blocks) {
    if (pem.slice(previous, block.index).trim()) throw refusal();
    try { new X509Certificate(block[0]); } catch { throw validationError("The public CA certificate is invalid."); }
    previous = block.index + block[0].length;
  }
  if (pem.slice(previous).trim()) throw refusal();
  return pem;
}

export const dbConnectionCa: CommandSpec = {
  name: "db connections ca", summary: "Upload a public CA certificate bundle (database_connectors.manage); refuse private keys before sending.",
  description: "The file must contain only valid PEM CERTIFICATE blocks. It is bounded by the instance's published CA limit.\n" +
    "The output keeps certificate metadata and fingerprints, never the PEM. Test the connection again after uploading it.",
  readOnly: false, idempotent: true, mcpTool: "db_connection_ca", operations: [`PATCH ${CONNECTION}`],
  positionals: [{ name: "connection", required: true, description: "Connection name or id." }, { name: "file", required: true, description: "Public PEM certificate file, never a private key." }],
  examples: ["cavelon db connections ca shop-db ./public-ca.pem"],
  async run(ctx, input) {
    await connectorOn(ctx);
    const { doc, op } = await workflowOperation(ctx, "PATCH", CONNECTION, "public CA certificate upload");
    const body = doc ? deref(doc, op.requestBody?.content["application/json"]?.schema) as { properties?: Record<string, { maxLength?: number; anyOf?: Array<{ maxLength?: number }> }> } : undefined;
    const ca = body?.properties?.ca_certificate_pem;
    // A finite local cap also bounds a file when an older instance serves no OpenAPI.
    const limit = ca?.maxLength ?? ca?.anyOf?.find(s => s.maxLength !== undefined)?.maxLength ?? 32768;
    const file = await fs.open(await confinedPath(ctx, positional(input, "file")!, "The public CA certificate file"), "r");
    let pem: string;
    try {
      if (!(await file.stat()).isFile()) throw validationError("The public CA certificate must be a regular file.");
      const bytes = Buffer.alloc(limit + 1);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const chunk = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > limit) throw validationError("The public CA certificate file exceeds the instance's size limit.");
      pem = publicCertificates(bytes.subarray(0, bytesRead).toString("utf8"));
    } finally { await file.close(); }
    const connection = await resolveConnection(ctx, positional(input, "connection")!);
    return savedResult(ctx, await manage<Connection>(ctx, "PATCH", CONNECTION, { ca_certificate_pem: pem }, connection.id), "Updated CA of");
  },
};

interface LoginScript { dialect: string; kind: string; script: string; [key: string]: unknown }
export const dbLoginScript: CommandSpec = {
  name: "db login-script", summary: "Print the instance's published read-only login SQL for a dialect or saved connection; no database is contacted.",
  description: "Needs database_connectors.view. The DBA replaces the script's password placeholder locally, outside the kit.\n" +
    "Only variants this instance publishes are offered; this build publishes read_only. Omitted inputs use its defaults.\n" +
    "For SQL Server, connection_limit_enforced is false; --schema scopes SELECT instead of granting db_datareader.",
  readOnly: true, idempotent: true, mcpTool: "db_login_script", operations: ["GET /api/v1/database-connectors/login-script", `GET ${CONNECTION}/login-script`],
  positionals: [{ name: "dialect", description: "Database dialect; omit only with --connection." }],
  options: {
    connection: textOption("Use dialect, database, user and TLS from this saved connection (name or id).", "<connection>"),
    "database-name": textOption("Database the login may read (without --connection).", "<name>"),
    username: textOption("Database login name (without --connection).", "<name>"),
    schema: textOption("Schema the read grants cover.", "<name>"),
    "egress-ip": { ...textOption("Outbound IP address; omitted uses the instance's configured addresses.", "<ip>"), multiple: true },
    "connection-limit": textOption("Connections to allow; omitted uses the instance's pool size times four.", "<n>"),
    "require-tls": textOption("MySQL REQUIRE SSL (true or false, without --connection).", "<true|false>"),
  },
  examples: ["cavelon db login-script postgresql --database-name shop --username cavelon_reader", "cavelon db login-script --connection shop-db --schema public"],
  async run(ctx, input) {
    const dialect = positional(input, "dialect");
    const connectionRef = stringOption(input, "connection");
    if (Boolean(dialect) === Boolean(connectionRef)) throw usageError("Give a dialect or --connection, exactly one.");
    if (connectionRef && ["database-name", "username", "require-tls"].some(k => input.options[k] !== undefined)) throw usageError("With --connection, database, username and TLS come from the saved connection.");
    const query: Record<string, string | string[] | undefined> = {};
    for (const [option, field] of Object.entries({ "database-name": "database_name", username: "username", schema: "schema" })) query[field] = stringOption(input, option);
    const ips = listOption(input, "egress-ip"); if (ips.length) query.egress_ips = ips;
    const limit = intOption(input, "connection-limit"); if (limit !== undefined) query.connection_limit = String(limit);
    const tls = booleanText(input, "require-tls"); if (tls !== undefined) query.require_tls = String(tls);
    const connection = connectionRef ? await resolveConnection(ctx, connectionRef) : undefined;
    if (dialect) query.dialect = dialect;
    let script: LoginScript;
    if (connection) {
      try { script = await callStable<LoginScript>(ctx, "GET", `${CONNECTION}/login-script`, "database login scripts", { params: { connection_id: [connection.id] }, query }); }
      catch (error) { throw viewerOnly(error); }
    } else script = await read<LoginScript>(ctx, "/api/v1/database-connectors/login-script", "database login scripts", query);
    return { data: script, text: `${keyValues(Object.entries(script).filter(([key]) => key !== "script"))}\n\n${script.script}\n\nThe DBA replaces the password placeholder locally, outside the kit.` };
  },
};

interface SchemaTable { name: string; kind: string; columns: Array<{ name: string; data_type: string; nullable: boolean }>; columns_truncated?: boolean }
interface SchemaResult { schema?: string | null; schemas: string[]; tables: SchemaTable[]; truncated: boolean; error_code?: string | null; driver_message?: string | null; duration_ms: number }
export const dbSchema: CommandSpec = {
  name: "db schema", summary: "Explore readable schemas or one schema's tables and columns (database_connectors.manage); read-only.",
  description: "Reads only the database catalog, under the connection's timeout and read-only boundary. The instance records\n" +
    "counts in its audit log. It caps schemas/tables at 500 and columns at 2,000; truncated flags say what was cut.\n" +
    "Only the tenant Owner (legacy Admin) or a superadmin in Tenant mode may explore, using a session or personal access token.",
  readOnly: true, idempotent: true, mcpTool: "db_schema", operations: [`POST ${CONNECTION}/schema`],
  positionals: [{ name: "connection", required: true, description: "Connection name or id." }, { name: "schema", description: "Schema to inspect; omitted lists schemas." }],
  options: { limit: { ...LIMIT_OPTION, description: "Return at most n schemas or tables (default 50, maximum 500)." }, cursor: CURSOR_OPTION },
  examples: ["cavelon db schema shop-db", "cavelon db schema shop-db public --json"],
  async run(ctx, input) {
    const limit = intOption(input, "limit", { min: 1, max: 500, fallback: 50 })!;
    const connection = await resolveConnection(ctx, positional(input, "connection")!);
    const schema = positional(input, "schema");
    const result = await manage<SchemaResult>(ctx, "POST", `${CONNECTION}/schema`, schema ? { schema } : {}, connection.id);
    const page = pageOf<string | SchemaTable>(schema ? result.tables : result.schemas, limit, stringOption(input, "cursor"));
    const data = { ...result, ...(schema ? { tables: page.items } : { schemas: page.items }), next_cursor: page.next_cursor, total: page.total };
    const lines = schema ? page.items.flatMap(item => { const t = item as SchemaTable; return [`${t.name} (${t.kind})`, table(t.columns.map(c => ({ ...c, nullable: c.nullable ? "yes" : "no" })), ["name", "data_type", "nullable"]), ...(t.columns_truncated ? ["Columns truncated by the instance."] : [])]; }) : page.items.map(String);
    return { data, text: [result.error_code ? `Schema exploration failed (${result.error_code}). ${result.driver_message ?? ""}` : lines.join("\n") || "No readable schemas or tables.", ...(result.truncated ? ["The instance truncated the catalog result."] : []), moreHint(page.next_cursor, cavelonCommand("db", "schema", connection.name, ...(schema ? [schema] : [])))].filter(Boolean).join("\n"), exitCode: result.error_code ? ExitCode.failure : ExitCode.ok };
  },
};
