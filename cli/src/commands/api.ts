import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AGENT_VARIABLES, drivenByAgent, type DrivenBy } from "../agent-env.js";
import {
  boolOption,
  CURSOR_OPTION,
  intOption,
  LIMIT_OPTION,
  listOption,
  pageOf,
  positional,
  stringOption,
  type CommandResult,
  type CommandSpec,
  type Context,
  type Input,
} from "../command.js";
import { CavelonError, ExitCode, usageError, validationError } from "../errors.js";
import { clip, moreHint, table } from "../format.js";
import { readAll } from "../io.js";
import { callOperation, previewRequest, type CallArguments } from "../invoke.js";
import { confinedPath } from "../paths.js";
import { describeSchema, findOperation, jsonBodySchema, matchedLoosely, operations, schemaTypes, secretFields, type Operation } from "../openapi.js";
import { canonical } from "../package-files.js";
import { cavelonCommand } from "../shell.js";

/** Said once when `--json` carried the body: the alias goes away in a later release. */
export const JSON_BODY_DEPRECATED =
  "`--json <body>` as the request body is deprecated and will be removed in a later release; pass the body with --body. " +
  "--json alone prints JSON, as on every command.";

/**
 * `--json` means "print JSON" on every command. On `api` it also carried the
 * request body before `--body` did (`api <operationId> --json body`): when a
 * value that looks like a body follows, it is still the body, with a warning.
 */
export function splitJsonBody(args: string[], warn?: (message: string) => void): string[] {
  const out: string[] = [];
  let aliased = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--json=")) {
      out.push(`--body=${arg.slice("--json=".length)}`);
      aliased = true;
      continue;
    }
    const next = args[i + 1];
    if (arg === "--json" && next !== undefined && looksLikeBody(next)) {
      out.push("--body", next);
      aliased = true;
      i++;
      continue;
    }
    out.push(arg);
  }
  if (aliased) warn?.(JSON_BODY_DEPRECATED);
  return out;
}

/** The token a preview prints for `--confirm`: 12 hex digits of the request's hash. */
const CONFIRM_TOKEN = /^[0-9a-f]{12}$/;

/**
 * `--confirm` takes the preview's token, but a person may pass it alone, as
 * before it took one; the next argument is the token only when it looks like
 * one, so `--confirm name=value` keeps its parameter.
 */
export function splitConfirm(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg !== "--confirm") {
      out.push(arg);
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && CONFIRM_TOKEN.test(next)) {
      out.push(`--confirm=${next}`);
      i++;
    } else out.push("--confirm=");
  }
  return out;
}

/** A body is JSON, @file or - (stdin); anything else after --json (name=value) is a parameter. */
function looksLikeBody(value: string): boolean {
  if (value === "-" || value.startsWith("@") || /^\s*[[{"]/.test(value)) return true;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

export async function readBody(ctx: Context, raw: string, confine = ctx.mode === "mcp"): Promise<unknown> {
  let text = raw;
  if (raw === "-" && ctx.mode === "mcp") {
    throw usageError("A body from standard input is not available over MCP; pass the JSON itself.");
  }
  if (raw === "-") text = await readAll(ctx.io.stdin);
  else if (raw.startsWith("@")) text = await fs.readFile(await confinedPath(ctx, raw.slice(1), "The body file", confine), "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw usageError(`The body is not JSON: ${error instanceof Error ? error.message : String(error)}`, "Pass --body '{\"key\": \"value\"}', @file.json or - for stdin.");
  }
}

function parseParams(input: Input): Record<string, string[]> {
  const params: Record<string, string[]> = {};
  const pairs = [...listOption(input, "param"), ...((input.positionals.params as string[] | undefined) ?? [])];
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) throw usageError(`"${pair}" is not name=value.`, "Pass parameters as -p name=value.");
    const name = pair.slice(0, at);
    (params[name] ??= []).push(pair.slice(at + 1));
  }
  return params;
}

/**
 * What an instance that does not mark its operations keeps for a person even
 * when an agent has `confirm`: setting or deleting a secret value, creating or
 * revoking a credential (tokens, API keys, sign-in), and deciding an approval.
 * A dedicated command for each is CLI-only or absent; this keeps `api` from
 * reaching the same operations over MCP. The words of the path decide, so an
 * instance's newer route of the same kind is kept too.
 */
const FOR_A_PERSON: Array<{ does: string; hint: string; match(word: string): boolean }> = [
  {
    does: "changes a secret",
    hint: "A person sets a secret in their terminal with `cavelon secrets set <name>` (or deletes it with `cavelon secrets delete <name>`).",
    match: (word) => word.includes("secret"),
  },
  {
    does: "creates or revokes a credential",
    hint: "A person creates and revokes tokens and API keys in Cavelon, and signs in with `cavelon login`.",
    match: (word) => /token|api-?keys?|credential|password|mfa/.test(word) || word === "auth",
  },
  {
    does: "decides an approval",
    hint: "A person decides an approval in Cavelon, as someone its approver rule names.",
    match: (word) => word.includes("approv") || word === "decide" || word.startsWith("decision"),
  },
];

function byPathWords(op: Operation): (typeof FOR_A_PERSON)[number] | undefined {
  const words = op.path.toLowerCase().split("/").filter((word) => word && !word.startsWith("{"));
  return FOR_A_PERSON.find((rule) => words.some((word) => rule.match(word)));
}

export interface KeptForPerson {
  /** "instance" when the instance marks the operation, "kit" when the path's words decided. */
  source: "instance" | "kit";
  reason?: string;
  hint: string;
}

/**
 * Whether `api` over MCP refuses an operation. An instance that publishes
 * `x-cavelon-person-only` on any operation decides alone: exactly the marked
 * operations are refused, read-only or not. Only for an instance that marks
 * none do the path's words decide.
 */
export function keptForPerson(op: Operation, all: Operation[]): KeptForPerson | undefined {
  if (all.some((o) => o.personOnly)) {
    if (!op.personOnly?.marked) return undefined;
    // The path's words only pick the most useful hint; the marker decided.
    const hint = byPathWords(op)?.hint ?? `A person runs it: in Cavelon, or in their terminal with \`cavelon api ${op.alias}\`.`;
    return { source: "instance", ...(op.personOnly.reason ? { reason: op.personOnly.reason } : {}), hint };
  }
  if (op.readOnly) return undefined;
  const rule = byPathWords(op);
  return rule ? { source: "kit", reason: rule.does, hint: rule.hint } : undefined;
}

/** Who does not send it, for a refusal: no MCP tool, or `cavelon api` in an agent's shell. */
function notSentBy(driven: DrivenBy): string {
  return driven.by === "mcp"
    ? "no tool sends it, with or without confirm."
    : `cavelon api does not send it when a coding agent runs it (${driven.variable} is set), with or without --confirm.`;
}

/** How a person runs it instead, after the refusal's own hint, in an agent's shell. */
function personHint(hint: string, driven: DrivenBy): string {
  return driven.by === "mcp" ? hint : `${hint} A person's own terminal is not guarded: it does not set ${driven.variable}.`;
}

function refusal(op: Operation, kept: KeptForPerson, driven: DrivenBy): string {
  const named = `${op.alias} (${op.method} ${op.path})`;
  const after = notSentBy(driven);
  if (kept.source === "kit") return `${named} ${kept.reason}; that stays with a person, so ${after}`;
  return `${named} is for a person only, as the instance marks it${kept.reason ? ` (${kept.reason})` : ""}; ${after}`;
}

/**
 * The fields of the request the instance marks `x-cavelon-secret`, under any
 * of the operation's body types, including a file sent as such a field.
 */
function secretsIn(doc: Parameters<typeof secretFields>[0], op: Operation, args: CallArguments): string[] {
  const found = new Set<string>();
  const fileFields = args.files?.length ? Object.fromEntries(args.files.map((f) => [f.field, f.path])) : undefined;
  for (const media of Object.values(op.requestBody?.content ?? {})) {
    if (args.body !== undefined) for (const field of secretFields(doc, media.schema, args.body)) found.add(field);
    if (fileFields) for (const field of secretFields(doc, media.schema, fileFields)) found.add(field);
  }
  return [...found];
}

function secretRefusal(op: Operation, fields: string[], driven: DrivenBy): CavelonError {
  const named = fields.map((f) => `"${f}"`).join(", ");
  return new CavelonError(ExitCode.usage, {
    code: "secret_field_for_a_person",
    message:
      `The request to ${op.alias} sets ${named}, which the instance marks as a secret value (x-cavelon-secret); ` +
      `a person enters secret values, so ${notSentBy(driven)}`,
    hint: personHint(
      "A person sets a secret value in their terminal with `cavelon secrets set <name>`, or enters it in the Admin. Leave the field out to send the rest.",
      driven,
    ),
    details: { fields },
  });
}

/**
 * The token that sends exactly a previewed request from an agent's shell: a
 * hash of where it goes and what it carries, so a changed body, parameter,
 * file, tenant or instance needs a new preview. It holds no secret; it only
 * makes sending take a preview first.
 */
function confirmToken(target: { url?: string; tenant?: string }, request: unknown, files: unknown): string {
  return createHash("sha256")
    .update(canonical({ instance: target.url ?? null, tenant: target.tenant ?? null, request, files }))
    .digest("hex")
    .slice(0, 12);
}

function truncate(data: unknown, limit: number): { data: unknown; total?: number } {
  if (limit <= 0) return { data };
  if (Array.isArray(data) && data.length > limit) return { data: data.slice(0, limit), total: data.length };
  if (data && typeof data === "object" && Array.isArray((data as { items?: unknown[] }).items)) {
    const items = (data as { items: unknown[] }).items;
    if (items.length > limit) return { data: { ...(data as object), items: items.slice(0, limit) }, total: items.length };
  }
  return { data };
}

export const api: CommandSpec = {
  name: "api",
  summary: "Call any operation the instance publishes in its OpenAPI.",
  description:
    "The operation is its operationId or the short name before FastAPI's path suffix (list_harnesses).\n" +
    "Parameters: -p name=value or name=value (not --name). Body: --body '<json>', --body @file.json or --body - (stdin);\n" +
    "--json <body> still works for now but is deprecated: --json alone prints JSON, as on every command.\n" +
    "The body is checked against the operation's schema before it is sent.\n" +
    "As an MCP tool, or run by a coding agent (" +
    AGENT_VARIABLES.filter((v) => v.variable !== "CAVELON_AGENT").map((v) => v.variable).join(", ") +
    "\nor CAVELON_AGENT=1 is set), an operation that changes something returns what it would send and sends it only\n" +
    "with confirm (as an MCP tool) or --confirm <token> (the token the preview printed).\n" +
    "Run by an agent, one the instance marks for a person only (x-cavelon-person-only) is refused, as is a body that\n" +
    "sets a field the instance marks as a secret value (x-cavelon-secret) and a file outside the solution folder. On an\n" +
    "instance that marks no operation, one that changes a secret, creates or revokes a credential or decides an\n" +
    "approval is refused. A person's own terminal sends at once.",
  readOnly: false,
  destructive: true,
  mcpTool: "api",
  positionals: [
    { name: "operation", description: "operationId or its short name.", required: true },
    { name: "params", description: "Parameters as name=value.", variadic: true },
  ],
  options: {
    param: { type: "string", short: "p", multiple: true, value: "<name=value>", description: "A path, query or header parameter." },
    body: { type: "string", value: "<json|@file|->", description: "The request body: JSON, @file.json or - for stdin (--json <body> is a deprecated alias)." },
    file: { type: "string", multiple: true, value: "<field=path>", description: "Attach a file to a multipart body." },
    output: { type: "string", value: "<file>", description: "Write the response body to a file instead of printing it.", cliOnly: true },
    confirm: {
      type: "string",
      value: "<token>",
      mcpBoolean: true,
      description:
        "Send an operation that changes something: run by a coding agent, the token its preview printed; as an MCP tool, true. " +
        "Without it, nothing is sent. A person's terminal sends at once.",
    },
    limit: { type: "string", value: "<n>", description: "Show at most n items of a list response (default 50, 0 for all)." },
  },
  examples: [
    "cavelon api list_harnesses",
    "cavelon api get_harness_by_slug slug=support",
    "cavelon api create_knowledge_base --body '{\"name\": \"FAQ\"}'",
  ],
  preprocess: (args, warn) => splitConfirm(splitJsonBody(args, warn)),
  async run(ctx, input) {
    const name = positional(input, "operation")!;
    const doc = await (await ctx.contracts()).openapi();
    const op = findOperation(doc, name);
    if (matchedLoosely(op, name)) ctx.warn(`"${name}" is taken as ${op.alias} (${op.method} ${op.path}).`);
    // An MCP client, or a coding agent in its shell: the same guards hold for both.
    const driven = drivenByAgent(ctx);
    const confine = driven !== undefined;
    const args: CallArguments = { params: parseParams(input) };
    const rawBody = stringOption(input, "body");
    if (rawBody !== undefined) args.body = await readBody(ctx, rawBody, confine);
    for (const spec of listOption(input, "file")) {
      const at = spec.indexOf("=");
      if (at <= 0) throw usageError(`--file "${spec}" is not field=path.`);
      const file = await confinedPath(ctx, spec.slice(at + 1), "The file", confine);
      args.files = [...(args.files ?? []), { field: spec.slice(0, at), path: file }];
    }
    const rawOutput = stringOption(input, "output");
    const output = rawOutput ? await confinedPath(ctx, rawOutput, "The output file", confine) : undefined;
    if (driven) {
      const kept = keptForPerson(op, operations(doc));
      if (kept) {
        throw new CavelonError(ExitCode.usage, {
          code: "operation_for_a_person",
          message: refusal(op, kept, driven),
          hint: personHint(kept.hint, driven),
          details: { source: kept.source, ...(kept.reason ? { reason: kept.reason } : {}), ...(driven.by === "agent" ? { agent_variable: driven.variable } : {}) },
        });
      }
      const secrets = secretsIn(doc, op, args);
      if (secrets.length) throw secretRefusal(op, secrets, driven);
    }
    if (driven && !op.readOnly) {
      const preview = await previewUnlessConfirmed(ctx, input, doc, op, args, driven);
      if (preview) return preview;
    }
    const client = await ctx.client();
    const result = await callOperation(ctx, client, doc, op, args);
    if (output) {
      const content = result.bytes ?? (typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2));
      await fs.writeFile(output, content);
      const size = typeof content === "string" ? Buffer.byteLength(content) : content.length;
      return { data: { status: result.status, written: rawOutput, bytes: size }, text: `Wrote ${size} bytes to ${rawOutput}.` };
    }
    if (result.bytes) {
      throw validationError(`${op.alias} answered ${result.contentType} (${result.bytes.length} bytes).`, undefined, "Save it with --output <file>.");
    }
    const limit = intOption(input, "limit", { min: 0, fallback: 50 })!;
    const { data, total } = truncate(result.data, limit);
    if (total !== undefined) ctx.warn(`Showing ${limit} of ${total} items; pass --limit 0 for all, or --output <file>.`);
    const text = typeof data === "string" ? data : data === null ? `${result.status} (no content)` : JSON.stringify(data, null, 2);
    return { data, text };
  },
};

/**
 * What a changing operation would send, when an agent has not confirmed it
 * yet; undefined when it has. Over MCP `confirm: true` sends; from an agent's
 * shell only the token of this very request does, so the agent has to show
 * the preview before it can send.
 */
async function previewUnlessConfirmed(
  ctx: Context,
  input: Input,
  doc: Parameters<typeof previewRequest>[0],
  op: Operation,
  args: CallArguments,
  driven: DrivenBy,
): Promise<CommandResult | undefined> {
  if (driven.by === "mcp" && boolOption(input, "confirm")) return undefined;
  const request = previewRequest(doc, op, args);
  const files = (args.files ?? []).map((f) => ({ field: f.field, file: path.relative(ctx.io.cwd, f.path) || f.path }));
  const shown = { operation: op.alias, ...request, ...(files.length ? { files } : {}), sent: false };
  if (driven.by === "mcp") {
    return {
      data: { ...shown, confirm: "Call api again with the same arguments and confirm: true." },
      text: `Would send ${request.method} ${request.path}. Nothing was sent.`,
    };
  }
  const session = await ctx.session();
  const token = confirmToken({ url: session.url, tenant: session.tenant }, request, files);
  const given = stringOption(input, "confirm");
  if (given === token) return undefined;
  const stale = Boolean(given);
  const confirm = `Show the person this request, then run the same command again with --confirm ${token} to send exactly it.`;
  const lines = [`Would send ${request.method} ${request.path}. Nothing was sent.`];
  if (stale) lines.push("The --confirm token is not this request's: the request changed since its preview, or the token is another one's.");
  if (Object.keys(request.query).length) lines.push(`Query: ${JSON.stringify(request.query)}`);
  if (Object.keys(request.headers).length) lines.push(`Headers: ${JSON.stringify(request.headers)}`);
  if (request.body !== null) lines.push("Body:", JSON.stringify(request.body, null, 2));
  for (const f of files) lines.push(`File: ${f.field} = ${f.file}`);
  lines.push(confirm);
  return {
    data: { ...shown, confirm_token: token, confirm, ...(stale ? { token_mismatch: true } : {}) },
    text: lines.join("\n"),
    ...(stale ? { exitCode: ExitCode.conflict } : {}),
  };
}

export const apiList: CommandSpec = {
  name: "api list",
  summary: "List the operations the instance publishes.",
  readOnly: true,
  idempotent: true,
  mcpTool: "api_list",
  options: {
    tag: { type: "string", value: "<tag>", description: "Only operations with this OpenAPI tag." },
    search: { type: "string", value: "<text>", description: "Only operations whose name, path or summary contains the text." },
    method: { type: "string", value: "<method>", description: "Only this HTTP method (GET, POST, …)." },
    tags: { type: "boolean", description: "List the tags with their operation counts instead." },
    limit: LIMIT_OPTION,
    cursor: CURSOR_OPTION,
  },
  async run(ctx, input) {
    const doc = await (await ctx.contracts()).openapi();
    let ops = operations(doc);
    if (input.options.tags === true) {
      const counts = new Map<string, number>();
      for (const op of ops) for (const tag of op.tags.length ? op.tags : ["(none)"]) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      const items = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tag, count]) => ({ tag, operations: count }));
      return { data: { items }, text: table(items, ["tag", "operations"]) };
    }
    const tag = stringOption(input, "tag");
    if (tag) {
      ops = ops.filter((o) => o.tags.includes(tag));
      if (ops.length === 0) throw usageError(`No operations tagged "${tag}".`, "`cavelon api list --tags` shows the tags.");
    }
    const method = stringOption(input, "method")?.toUpperCase();
    if (method) ops = ops.filter((o) => o.method === method);
    const search = stringOption(input, "search")?.toLowerCase();
    if (search) {
      ops = ops.filter((o) => [o.operationId, o.path, o.summary ?? ""].some((s) => s.toLowerCase().includes(search)));
    }
    const limit = intOption(input, "limit", { min: 1, max: 1000, fallback: 50 })!;
    const page = pageOf(
      ops.map((o) => ({
        operation: o.alias,
        operation_id: o.operationId,
        method: o.method,
        path: o.path,
        summary: o.summary ?? null,
        tags: o.tags,
        read_only: o.readOnly,
      })),
      limit,
      stringOption(input, "cursor"),
    );
    const flags = [tag ? ["--tag", tag] : [], method ? ["--method", method] : [], search ? ["--search", search] : []].flat();
    return {
      data: page,
      text:
        table(page.items, ["operation", "method", "path", "summary"]) +
        `\n${page.items.length} of ${page.total}` +
        moreHint(page.next_cursor, cavelonCommand("api", "list", ...flags)),
    };
  },
};

export const apiDescribe: CommandSpec = {
  name: "api describe",
  summary: "Show one operation's parameters, body and responses.",
  readOnly: true,
  idempotent: true,
  mcpTool: "api_describe",
  positionals: [{ name: "operation", description: "operationId or its short name.", required: true }],
  async run(ctx, input) {
    const doc = await (await ctx.contracts()).openapi();
    const name = positional(input, "operation")!;
    const op = findOperation(doc, name);
    if (matchedLoosely(op, name)) ctx.warn(`"${name}" is taken as ${op.alias}; that is the name \`cavelon api\` takes.`);
    const bodyTypes = Object.keys(op.requestBody?.content ?? {});
    const bodySchema = jsonBodySchema(op) ?? op.requestBody?.content?.[bodyTypes[0] ?? ""]?.schema;
    const responses = Object.fromEntries(
      Object.entries(op.responses)
        .filter(([code]) => code.startsWith("2"))
        .map(([code, r]) => [code, describeSchema(doc, r.content?.["application/json"]?.schema)]),
    );
    const data = {
      operation: op.alias,
      operation_id: op.operationId,
      method: op.method,
      path: op.path,
      read_only: op.readOnly,
      tags: op.tags,
      summary: op.summary ?? null,
      description: op.description ? clip(op.description, 1500) : null,
      parameters: op.parameters.map((p) => ({
        name: p.name,
        in: p.in,
        required: Boolean(p.required),
        type: schemaTypes(p.schema).filter((t) => t !== "null").join("|") || "string",
        description: p.description ?? (p.schema?.description as string | undefined) ?? null,
      })),
      body: op.requestBody
        ? { required: Boolean(op.requestBody.required), content_types: bodyTypes, schema: describeSchema(doc, bodySchema) }
        : null,
      responses,
    };
    const lines = [`${op.method} ${op.path}  (${op.readOnly ? "read-only" : "changing"})`, op.summary ?? ""];
    if (data.description && data.description !== op.summary) lines.push("", data.description);
    if (data.parameters.length) {
      lines.push("", "Parameters:", table(data.parameters, ["name", "in", "required", "type", "description"]));
    }
    if (data.body) lines.push("", `Body (${bodyTypes.join(", ")}${data.body.required ? ", required" : ""}):`, JSON.stringify(data.body.schema, null, 2));
    if (Object.keys(responses).length) lines.push("", "Responses:", JSON.stringify(responses, null, 2));
    return { data, text: lines.join("\n") };
  },
};
