import path from "node:path";
import type { PackageSchema } from "./contracts.js";
import { readJsonFile } from "./fsutil.js";
import { stateDir, writeState } from "./local-state.js";
import { locate, type Finding, type PackageOnDisk } from "./package-files.js";
import { canonical, settledForm } from "./package-format.js";

/**
 * Database query tools in a package: a tool whose `tool_type` is
 * `database_query` carries its saved query (`database_query`: connection by
 * name and dialect, SQL, parameters, limits). The instance writes a query only
 * for a credential holding database_connectors.manage, after the person
 * approves the change. So the kit checks what it can before the preview
 * does, and remembers the queries as the last pull or
 * apply left them, to say which ones an apply would change.
 *
 * Everything here acts only where the instance's package schema describes the
 * field: an older instance's schema has no `database_query` on a tool, and
 * then the kit checks nothing of its own.
 */

/** The tool type, and the tool's field that holds the query, as the package schema publishes them. */
export const QUERY_TOOL_TYPE = "database_query";
const QUERY_FIELD = "database_query";
const TOOLS_SECTION = "tools";

/** A query tool's fields the instance derives from the query and ignores in a package. */
const DERIVED_FIELDS = ["params_json_schema", "default_config"] as const;
/** A query tool's fields that are part of the query: changing one needs the manage permission. */
const QUERY_FIELDS = ["name", "description", QUERY_FIELD] as const;

/** The kit's own codes for what validate finds about query tools. */
export const QUERY_CHANGED_CODE = "database_query_changed";
export const QUERY_FIELDS_IGNORED_CODE = "database_query_fields_ignored";

/** The instance keeps this code for a caller without the query manage permission. */
export const NEEDS_SUPERADMIN_CODE = "database_query_needs_superadmin";

const BASELINE_FILE = "database-queries.json";

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function resolveRef(schema: PackageSchema, node: unknown): Json | undefined {
  let current = isObject(node) ? node : undefined;
  for (let hops = 0; current && typeof current.$ref === "string" && hops < 10; hops++) {
    const ref = current.$ref;
    if (!ref.startsWith("#/$defs/")) return undefined;
    current = (schema.$defs as Record<string, Json> | undefined)?.[ref.slice("#/$defs/".length)];
  }
  return current;
}

/** The schema of a tool entry, or undefined when the schema has no tools section. */
function toolSchema(schema: PackageSchema | null): Json | undefined {
  if (!schema) return undefined;
  const tools = resolveRef(schema, schema.properties?.[TOOLS_SECTION]);
  return resolveRef(schema, tools?.items);
}

/** Whether this instance's package schema describes query tools. */
export function schemaKnowsQueries(schema: PackageSchema | null): boolean {
  const properties = toolSchema(schema)?.properties;
  return isObject(properties) && QUERY_FIELD in properties;
}

/** The schema of a query's parameter, followed from the tool's `database_query`. */
export function parameterSchema(schema: PackageSchema): Json | undefined {
  const field = (toolSchema(schema)?.properties as Json | undefined)?.[QUERY_FIELD];
  const branches = isObject(field) && Array.isArray(field.anyOf) ? field.anyOf : [field];
  for (const branch of branches) {
    const query = resolveRef(schema, branch);
    const parameters = (query?.properties as Json | undefined)?.parameters;
    const items = isObject(parameters) ? resolveRef(schema, parameters.items) : undefined;
    if (items) return items;
  }
  return undefined;
}

export interface QueryTool {
  index: number;
  slug: string;
  tool: Json;
}

/** The package's query tools, with their place in the tools section. */
export function queryTools(pkg: Json): QueryTool[] {
  const tools = pkg[TOOLS_SECTION];
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool, index) =>
    isObject(tool) && tool.tool_type === QUERY_TOOL_TYPE && typeof tool.slug === "string" ? [{ index, slug: tool.slug, tool }] : [],
  );
}

// ---------------------------------------------------------------------------
// The query's own checks
// ---------------------------------------------------------------------------

/**
 * The `:name` placeholders the instance binds: the pattern SQLAlchemy's
 * `text()` reads, so a cast (`x::int`) and an escaped colon (`\:`) bind
 * nothing.
 */
const BIND = /(?<![:\p{L}\p{N}_\\]):([\p{L}\p{N}_]+)(?!:)/gu;

export function bindNames(sql: string): string[] {
  const names: string[] = [];
  for (const match of sql.matchAll(BIND)) if (!names.includes(match[1]!)) names.push(match[1]!);
  return names;
}

/** The constraints each parameter type takes, as the schema's field descriptions say ("Strings only", "Integer or number only"). */
const CONSTRAINTS_BY_TYPE: Record<string, string[]> = {
  string: ["max_length", "pattern", "enum"],
  integer: ["minimum", "maximum", "enum"],
  number: ["minimum", "maximum", "enum"],
};
const CONSTRAINTS = ["max_length", "pattern", "enum", "minimum", "maximum"];

interface Problem {
  /** The instance's code for it, which its error catalog explains. */
  code: string;
  message: string;
  /** Below the query, as `parameters/0/minimum`. */
  at?: string;
}

const problem = (code: string, message: string, at?: string): Problem => ({ code, message, ...(at ? { at } : {}) });

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** One parameter's problems, as the instance refuses them when the query is saved. */
function parameterProblems(p: Json, index: number, defaults: { source: unknown; type: unknown; required: unknown }): Problem[] {
  const name = typeof p.name === "string" ? p.name : `#${index + 1}`;
  const source = p.source ?? defaults.source;
  const type = typeof (p.type ?? defaults.type) === "string" ? String(p.type ?? defaults.type) : "string";
  const required = p.required ?? defaults.required;
  const at = `parameters/${index}`;
  const said = (what: string) => `parameter '${name}': ${what}`;
  const set = CONSTRAINTS.filter((key) => p[key] !== undefined && p[key] !== null);
  // A parameter the platform fills from the signed-in visitor: a required string without constraints.
  if (typeof source === "string" && source !== defaults.source) {
    if (type !== "string") return [problem("parameter_context_not_string", said(`a context parameter (${source}) has type string`), `${at}/type`)];
    if (required === false) return [problem("parameter_context_optional", said(`a context parameter (${source}) is always required`), `${at}/required`)];
    if (set.length) return [problem("parameter_context_constrained", said(`the platform fills a context parameter, so ${set.join(", ")} does not apply`), `${at}/${set[0]}`)];
    return [];
  }
  const problems: Problem[] = [];
  if (typeof p.description !== "string" || !p.description.trim()) {
    problems.push(problem("parameter_description_missing", said("the model needs a description of what to fill in"), at));
  }
  const misplaced = set.filter((key) => !(CONSTRAINTS_BY_TYPE[type] ?? []).includes(key));
  if (misplaced.length) {
    problems.push(problem("parameter_constraint_not_applicable", said(`${misplaced.join(", ")} does not apply to type ${type}`), `${at}/${misplaced[0]}`));
    return problems;
  }
  if (isNumber(p.minimum) && isNumber(p.maximum) && p.minimum > p.maximum) {
    problems.push(problem("parameter_bounds_inverted", said("minimum is greater than maximum"), `${at}/minimum`));
  }
  if (type === "integer" && [p.minimum, p.maximum].some((b) => isNumber(b) && !Number.isInteger(b))) {
    problems.push(problem("parameter_bounds_not_integer", said("an integer's bounds must be integers"), at));
  }
  if (Array.isArray(p.enum)) {
    const fits = (v: unknown) =>
      type === "string"
        ? typeof v === "string" && (!isNumber(p.max_length) || v.length <= p.max_length)
        : type === "integer"
          ? Number.isInteger(v)
          : isNumber(v);
    if (!p.enum.every(fits)) problems.push(problem("parameter_enum_invalid", said(`every enum value must be a ${type} within its limits`), `${at}/enum`));
    else if (new Set(p.enum.map((v) => JSON.stringify(v))).size !== p.enum.length) problems.push(problem("parameter_enum_repeats", said("enum values repeat"), `${at}/enum`));
  }
  return problems;
}

/** What the instance would refuse in one query: its SQL's placeholders against its parameters, and each parameter. */
export function queryProblems(query: Json, schema: PackageSchema): Problem[] {
  const props = (parameterSchema(schema)?.properties ?? {}) as Record<string, Json | undefined>;
  const defaults = { source: props.source?.default ?? "model", type: props.type?.default ?? "string", required: props.required?.default ?? true };
  const parameters = Array.isArray(query.parameters) ? query.parameters.filter(isObject) : [];
  const problems: Problem[] = [];
  const names = parameters.map((p) => p.name).filter((n): n is string => typeof n === "string");
  const repeated = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))].sort((a, b) => a.localeCompare(b, "en"));
  if (repeated.length) problems.push(problem("parameter_names_repeat", `parameter names repeat: ${repeated.join(", ")}`, "parameters"));
  parameters.forEach((p, index) => problems.push(...parameterProblems(p, index, defaults)));
  if (typeof query.sql_text === "string" && query.sql_text.trim()) {
    const found = bindNames(query.sql_text);
    const missing = found.filter((n) => !names.includes(n)).sort((a, b) => a.localeCompare(b, "en"));
    const unused = [...new Set(names)].filter((n) => !found.includes(n)).sort((a, b) => a.localeCompare(b, "en"));
    if (missing.length || unused.length) {
      const parts = [
        ...(missing.length ? [`placeholders without a declared parameter: ${missing.map((n) => `:${n}`).join(", ")}`] : []),
        ...(unused.length ? [`declared parameters the SQL never uses: ${unused.join(", ")}`] : []),
      ];
      problems.push(problem("bind_mismatch", `The SQL and its parameters disagree; ${parts.join("; ")}.`, "sql_text"));
    }
  }
  const context = parameters.some((p) => typeof p.source === "string" && p.source !== defaults.source);
  if (query.allows_anonymous === true && context) {
    problems.push(
      problem(
        "anonymous_with_context_parameter",
        "allows_anonymous is true, but a parameter is filled from the signed-in visitor's identity, so the query needs a visitor anyway.",
        "allows_anonymous",
      ),
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// A stored-procedure call
// ---------------------------------------------------------------------------

/** The one call a SQL Server query may be, as the instance's refusals spell it. */
export const PROCEDURE_CALL_FORM = "EXEC [schema].[procedure] @p1 = :p1, @p2 = :p2";

/** The dialect whose queries may call a stored procedure. */
const PROCEDURE_DIALECT = "mssql";

interface Token {
  kind: "word" | "string" | "identifier" | "comment" | "semicolon" | "symbol";
  text: string;
  start: number;
}

const WORD_START = /[A-Za-z_]/;
const WORD_PART = /[A-Za-z0-9_$]/;

/** Where a quote opened at `start` closes (after the closing quote); a doubled quote is part of the text. Undefined when it never closes. */
function closing(sql: string, start: number, quote: string, backslash: boolean): number | undefined {
  for (let i = start + 1; i < sql.length; i++) {
    if (backslash && sql[i] === "\\") {
      i++;
      continue;
    }
    if (sql[i] !== quote) continue;
    if (sql[i + 1] === quote) {
      i++;
      continue;
    }
    return i + 1;
  }
  return undefined;
}

/**
 * The SQL as the instance's check reads it, far enough to find an `EXEC` and
 * check its form: strings, quoted identifiers and comments are one token each,
 * so a keyword inside one is no keyword. Undefined for SQL with an unclosed
 * quote or comment, which the instance refuses with a code of its own.
 */
function sqlTokens(sql: string, dialect: string): Token[] | undefined {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const char = sql[i]!;
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    let end: number | undefined;
    let kind: Token["kind"];
    if (sql.startsWith("--", i)) {
      const newline = sql.indexOf("\n", i);
      end = newline === -1 ? sql.length : newline;
      kind = "comment";
    } else if (sql.startsWith("/*", i)) {
      const close = sql.indexOf("*/", i + 2);
      if (close === -1) return undefined;
      end = close + 2;
      kind = "comment";
    } else if (char === "'") {
      end = closing(sql, i, "'", dialect === "mysql");
      kind = "string";
    } else if (char === '"') {
      end = closing(sql, i, '"', dialect === "mysql");
      kind = dialect === "mysql" ? "string" : "identifier";
    } else if (char === "`" && dialect === "mysql") {
      end = closing(sql, i, "`", false);
      kind = "identifier";
    } else if (char === "[" && dialect === PROCEDURE_DIALECT) {
      end = closing(sql, i, "]", false);
      kind = "identifier";
    } else if (WORD_START.test(char)) {
      end = i + 1;
      while (end < sql.length && WORD_PART.test(sql[end]!)) end++;
      kind = "word";
    } else {
      end = i + 1;
      kind = char === ";" ? "semicolon" : "symbol";
    }
    if (end === undefined) return undefined;
    tokens.push({ kind, text: sql.slice(i, end), start: i });
    i = end;
  }
  return tokens;
}

const isWord = (token: Token | undefined, ...words: string[]) => token?.kind === "word" && words.includes(token.text.toUpperCase());
const isSymbol = (token: Token | undefined, text: string) => token?.kind === "symbol" && token.text === text;
const touching = (first: Token, second: Token) => second.start === first.start + first.text.length;

/** System procedures that run SQL text or code outside the database: the instance refuses a query that calls one. */
const DYNAMIC_SQL_PROCEDURES = ["sp_executesql", "sp_sqlexec", "sp_execute", "sp_execute_external_script", "sp_invoke_external_rest_endpoint"];
const DYNAMIC_SQL_PREFIXES = ["xp_", "sp_prep", "sp_cursor", "sp_oa", "sp_msforeach"];

/** One part of the procedure's name: a plain word or a `[bracketed]` identifier. */
function namePart(token: Token | undefined): string | undefined {
  if (token?.kind === "identifier" && token.text.startsWith("[") && token.text.length > 2) return token.text.slice(1, -1).replaceAll("]]", "]");
  return token?.kind === "word" ? token.text : undefined;
}

/** Why an EXEC is not the one call the instance takes, or undefined when it is. */
function procedureFormProblem(sql: string, code: Token[]): string | undefined {
  const tokens = code[code.length - 1]?.kind === "semicolon" ? code.slice(0, -1) : code;
  if (!isWord(tokens[0], "EXEC", "EXECUTE")) return "Nothing may stand before EXEC.";
  if (tokens.length < 2) return "EXEC names no procedure.";
  const parts: string[] = [];
  let position = 1;
  for (;;) {
    const part = namePart(tokens[position]);
    if (part === undefined) return `${tokens[position]?.text ?? "Nothing"} is not a procedure name.`;
    parts.push(part);
    position++;
    if (!isSymbol(tokens[position], ".")) break;
    if (parts.length === 2) return "The procedure is named by at most a schema and its name, not a database or server.";
    position++;
  }
  const procedure = parts[parts.length - 1]!;
  const lower = procedure.toLowerCase();
  if (DYNAMIC_SQL_PROCEDURES.includes(lower) || DYNAMIC_SQL_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return `${procedure} runs SQL text or code outside the database; a query may not call it.`;
  }
  const args = tokens.slice(position);
  for (let index = 0; index < args.length; ) {
    const [at, name, equals, colon, bind] = args.slice(index, index + 5);
    const argument =
      isSymbol(at, "@") && name?.kind === "word" && touching(at!, name) && isSymbol(equals, "=") && isSymbol(colon, ":") && bind?.kind === "word" && touching(colon!, bind) && !bind.text.includes("$");
    if (!argument) {
      const shown = args.slice(index, index + 5);
      const last = shown[shown.length - 1]!;
      return `The argument '${sql.slice(shown[0]!.start, last.start + last.text.length)}' is not written @name = :placeholder.`;
    }
    index += 5;
    if (index === args.length) break;
    if (!isSymbol(args[index], ",")) return `'${args[index]!.text}' follows an argument, where only a comma and the next argument may stand.`;
    if (index + 1 === args.length) return "The arguments end with a comma.";
    index++;
  }
  return undefined;
}

/**
 * What the instance would refuse in a query that calls a stored procedure: on
 * a dialect other than SQL Server any `EXEC` (`not_select`), on SQL Server an
 * `EXEC` that is not exactly the one call form (`procedure_call_form`).
 * Nothing for a query that does not start with `EXEC`, for one without a
 * dialect, or for SQL the instance refuses with another code first. Whether
 * the connection's login and the procedure's definition allow the call, only
 * the instance can check.
 */
export function procedureCallProblem(sql: string, dialect: string | undefined): Problem | undefined {
  if (!dialect) return undefined;
  const tokens = sqlTokens(sql, dialect);
  if (!tokens) return undefined;
  const code = tokens.filter((t) => t.kind !== "comment");
  const first = code.find((t) => !isSymbol(t, "("));
  if (!isWord(first, "EXEC", "EXECUTE")) return undefined;
  if (dialect !== PROCEDURE_DIALECT) {
    return problem(
      "not_select",
      `the SQL calls a stored procedure (${first!.text.toUpperCase()}), which only a query on a SQL Server (${PROCEDURE_DIALECT}) connection may do; ` +
        `on ${dialect} the instance refuses it (not_select). Write the query as a SELECT.`,
      "sql_text",
    );
  }
  // A second statement is the instance's multiple_statements, not this form's.
  if (code.some((t, i) => t.kind === "semicolon" && i !== code.length - 1)) return undefined;
  const why = procedureFormProblem(sql, code);
  if (!why) return undefined;
  return problem("procedure_call_form", `${why} A stored-procedure query is exactly ${PROCEDURE_CALL_FORM}, every argument a :placeholder (procedure_call_form).`, "sql_text");
}

/** Whether a query's SQL is a stored-procedure call on SQL Server, as the instance tells one apart: its first keyword is EXEC. */
export function isProcedureCall(sql: string, dialect: string | undefined): boolean {
  if (dialect !== PROCEDURE_DIALECT) return false;
  const code = sqlTokens(sql, dialect)?.filter((t) => t.kind !== "comment");
  return isWord(
    code?.find((t) => !isSymbol(t, "(")),
    "EXEC",
    "EXECUTE",
  );
}

// ---------------------------------------------------------------------------
// What changed since the last pull or apply
// ---------------------------------------------------------------------------

/** A query tool as the last pull or apply left it: its fields in the settled form (defaults and nulls left out). */
type BaselineTool = Partial<Record<(typeof QUERY_FIELDS)[number] | (typeof DERIVED_FIELDS)[number], unknown>>;

export interface QueryBaseline {
  written_at: string;
  /** "pull" or "apply": what left the queries as they are here. */
  by: string;
  tools: Record<string, BaselineTool>;
}

function settledTool(schema: PackageSchema, tool: Json): Json {
  const settled = settledForm(schema, schema.properties?.[TOOLS_SECTION], [tool]);
  return Array.isArray(settled) && isObject(settled[0]) ? settled[0] : tool;
}

function baselineOf(schema: PackageSchema, tool: Json): BaselineTool {
  const settled = settledTool(schema, tool);
  const out: BaselineTool = {};
  for (const key of [...QUERY_FIELDS, ...DERIVED_FIELDS]) if (settled[key] !== undefined) out[key] = settled[key];
  return out;
}

export async function readQueryBaseline(root: string): Promise<QueryBaseline | undefined> {
  const stored = await readJsonFile<QueryBaseline>(path.join(stateDir(root), BASELINE_FILE));
  return stored && isObject(stored.tools) ? stored : undefined;
}

/**
 * Remember the query tools of a package the instance now holds as it is (an
 * export just pulled, or an import just applied). An applied query tool
 * without its query kept the instance's query, name and description, so those
 * stay as remembered before. Nothing is written where the schema does not
 * describe query tools.
 */
export async function rememberQueries(root: string, pkg: Json, schema: PackageSchema | null, by: "pull" | "apply", now: Date): Promise<void> {
  if (!schema || !schemaKnowsQueries(schema)) return;
  const previous = by === "apply" ? (await readQueryBaseline(root))?.tools : undefined;
  const tools: Record<string, BaselineTool> = {};
  for (const { slug, tool } of queryTools(pkg)) {
    const kept = previous?.[slug];
    tools[slug] = !isObject(tool[QUERY_FIELD]) && kept ? { ...baselineOf(schema, tool), ...pick(kept, QUERY_FIELDS) } : baselineOf(schema, tool);
  }
  const baseline: QueryBaseline = { written_at: now.toISOString(), by, tools };
  await writeState(root, BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`);
}

function pick(tool: BaselineTool, keys: readonly (keyof BaselineTool)[]): BaselineTool {
  const out: BaselineTool = {};
  for (const key of keys) if (tool[key] !== undefined) out[key] = tool[key];
  return out;
}

const same = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);

/** One query tool the package changes against the last pull or apply. */
export interface QueryChange {
  slug: string;
  index: number;
  /** True for a query tool the tenant did not hold. */
  created: boolean;
  /** Which of name, description and database_query differ. */
  fields: string[];
}

/** The query tools whose query, name or description differ from the last pull or apply; a tool without its query refers to the instance's as it is. */
export function queryChanges(pkg: Json, schema: PackageSchema, baseline: QueryBaseline): QueryChange[] {
  const out: QueryChange[] = [];
  for (const { slug, index, tool } of queryTools(pkg)) {
    if (!isObject(tool[QUERY_FIELD])) continue;
    const before = baseline.tools[slug];
    const now = baselineOf(schema, tool);
    if (!before) {
      out.push({ slug, index, created: true, fields: [...QUERY_FIELDS] });
      continue;
    }
    const fields = QUERY_FIELDS.filter((key) => !same(before[key], now[key]));
    if (fields.length) out.push({ slug, index, created: false, fields });
  }
  return out;
}

/**
 * validate's findings for the package's query tools: what the instance would
 * refuse in a query (errors), the query tools an apply would change, which a
 * person approves (warnings), and fields the instance ignores on
 * a query tool (warnings).
 */
export function checkQueryTools(disk: PackageOnDisk, schema: PackageSchema, baseline: QueryBaseline | undefined): Finding[] {
  if (!schemaKnowsQueries(schema)) return [];
  const findings: Finding[] = [];
  for (const { slug, index, tool } of queryTools(disk.package)) {
    const query = tool[QUERY_FIELD];
    if (!isObject(query)) continue;
    for (const problem of queryProblems(query, schema)) {
      findings.push({
        code: problem.code,
        severity: "error",
        ...locate(disk, `/${TOOLS_SECTION}/${index}/${QUERY_FIELD}${problem.at ? `/${problem.at}` : ""}`),
        message: `Query tool "${slug}": ${problem.message}`,
      });
    }
    // Only where the SQL is the instance's to judge in full: a warning, since the instance's own check decides.
    const dialect = isObject(query.connection) && typeof query.connection.dialect === "string" ? query.connection.dialect : undefined;
    const call = typeof query.sql_text === "string" ? procedureCallProblem(query.sql_text, dialect) : undefined;
    if (call) {
      findings.push({
        code: call.code,
        severity: "warning",
        ...locate(disk, `/${TOOLS_SECTION}/${index}/${QUERY_FIELD}/${call.at}`),
        message: `Query tool "${slug}": ${call.message}`,
      });
    }
  }
  if (!baseline) return findings;
  for (const change of queryChanges(disk.package, schema, baseline)) {
    const what = change.created
      ? `is new since the last ${baseline.by}: creating a query`
      : `changes its ${change.fields.map((f) => (f === QUERY_FIELD ? "query (database_query)" : f)).join(", ")} since the last ${baseline.by}: ` +
        `${change.fields.some((f) => f !== QUERY_FIELD) ? "a query tool's own name and description belong to the query, and changing one" : "changing a query"}`;
    findings.push({
      code: QUERY_CHANGED_CODE,
      severity: "warning",
      ...locate(disk, `/${TOOLS_SECTION}/${change.index}`),
      message:
        `Query tool "${change.slug}" ${what} needs database_connectors.manage (the tenant Owner or a superadmin in Tenant mode) and the person's approval. ` +
        `The import preview blocks a credential without that permission (${NEEDS_SUPERADMIN_CODE}). An agent's or skill's override of the tool's name, description or max_calls is no query change.`,
    });
  }
  for (const { slug, index, tool } of queryTools(disk.package)) {
    const before = baseline.tools[slug];
    if (!before) continue;
    const now = baselineOf(schema, tool);
    const edited = DERIVED_FIELDS.filter((key) => !same(before[key], now[key]));
    if (!edited.length) continue;
    findings.push({
      code: QUERY_FIELDS_IGNORED_CODE,
      severity: "warning",
      ...locate(disk, `/${TOOLS_SECTION}/${index}/${edited[0]}`),
      message: `Query tool "${slug}" changes its ${edited.join(" and ")}; the instance derives ${edited.length === 1 ? "it" : "them"} from the query's parameters and ignores the package's.`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// What the instance offers this credential
// ---------------------------------------------------------------------------

/** The connector as the instance's capabilities describe it; a field it does not publish stays undefined. */
export interface ConnectorOffer {
  enabled?: boolean;
  /** The dialects whose queries it runs. */
  dialects?: string[];
  /** Whether this credential may create or change a query, as its manage permission allows. */
  may_write_queries?: boolean;
  /** The setting that switches the connector on. */
  setting?: string;
  /** Who writes queries, and where, in the instance's words. */
  queries_written_by?: string;
}

export function connectorOffer(caps: Record<string, unknown> | null | undefined): ConnectorOffer {
  const features = isObject(caps?.features) ? caps.features : {};
  const section = isObject(caps?.database_connector) ? caps.database_connector : {};
  return {
    ...(typeof features.database_connector_enabled === "boolean" ? { enabled: features.database_connector_enabled } : {}),
    ...(Array.isArray(section.dialects) ? { dialects: section.dialects.filter((d): d is string => typeof d === "string") } : {}),
    ...(typeof section.may_write_queries === "boolean" ? { may_write_queries: section.may_write_queries } : {}),
    ...(typeof section.setting === "string" ? { setting: section.setting } : {}),
    ...(typeof section.queries_written_by === "string" ? { queries_written_by: section.queries_written_by } : {}),
  };
}

const named = (slugs: string[]) => slugs.map((s) => `"${s}"`).join(", ");

/**
 * What apply says before it sends a package with query tools: a connector
 * switched off, a dialect the instance does not run, and query changes this
 * credential may not make, which stop the whole import.
 */
export function applyQueryNotes(pkg: Json, changes: QueryChange[], offer: ConnectorOffer): { warnings: string[]; data?: Record<string, unknown> } {
  const tools = queryTools(pkg);
  if (!tools.length) return { warnings: [] };
  const warnings: string[] = [];
  const setting = offer.setting ?? "its setting";
  if (offer.enabled === false) {
    warnings.push(
      `The package holds database query tools (${named(tools.map((t) => t.slug))}), and this instance has the database connector switched off (${setting}): ` +
        "the import may carry them, but no agent gets a database tool until its operator switches the connector on.",
    );
  } else if (offer.enabled && offer.dialects) {
    const unrun = tools.filter((t) => {
      const dialect = isObject(t.tool[QUERY_FIELD]) && isObject(t.tool[QUERY_FIELD].connection) ? t.tool[QUERY_FIELD].connection.dialect : undefined;
      return typeof dialect === "string" && !offer.dialects!.includes(dialect);
    });
    if (unrun.length) {
      warnings.push(
        `This instance runs ${offer.dialects.length ? `only ${offer.dialects.join(", ")} queries` : "no database queries"}; ${named(unrun.map((t) => t.slug))} ` +
          `${unrun.length === 1 ? "names" : "name"} another dialect, so no agent can call ${unrun.length === 1 ? "it" : "them"} here.`,
      );
    }
  }
  const slugs = changes.map((c) => c.slug);
  // While the connector is off the capability is false even for a caller holding manage; the preview still decides permission.
  if (slugs.length && offer.enabled !== false && offer.may_write_queries === false) {
    warnings.push(
      `This apply would ${changes.every((c) => c.created) ? "create" : "create or change"} the database quer${slugs.length === 1 ? "y" : "ies"} ${named(slugs)}, ` +
        `which this credential may not do (may_write_queries is false): the preview blocks ${slugs.length === 1 ? "it" : "them"}, and one blocked query stops the whole import. ` +
        (offer.queries_written_by ? `${offer.queries_written_by} ` : "") +
        "To apply the rest first, leave each such query as the instance holds it (restore the tool's entry as the last pull wrote it, or remove its database_query block).",
    );
  }
  return {
    warnings,
    data: {
      tools: tools.map((t) => t.slug),
      changed: changes.map((c) => ({ slug: c.slug, created: c.created, fields: c.fields })),
      connector_enabled: offer.enabled ?? null,
      dialects: offer.dialects ?? null,
      may_write_queries: offer.may_write_queries ?? null,
    },
  };
}

/** The hint under a preview that a query blocks: the whole import stops, and how to apply the rest. */
export function queryBlockedHint(files: string[]): string {
  const where = files.length ? ` in ${files.join(", ")}` : "";
  return (
    "A database query the import would create or change stops the whole import: nothing is applied while one blocks. " +
    "The blocker's hint names who this instance permits and where they apply it (with the manage gate, the tenant Owner may use a personal access token holding database_connectors.manage); after that, apply passes while the queries match. " +
    `To apply the other changes first, leave each blocked query as the instance holds it${where}: restore the tool's entry as the last pull wrote it, ` +
    "or remove its database_query block (the tool then keeps the instance's query, name and description), and apply again."
  );
}

/** Only the instance knows whether this import writes a query; local changes since pull are advisory. Older previews may omit the report. */
export function importWritesQueries(preview: Record<string, unknown>): boolean {
  const report = preview.database_queries;
  return isObject(report) && Array.isArray(report.would_write) && report.would_write.length > 0;
}
