import { promises as fs } from "node:fs";
import path from "node:path";
import {
  boolOption,
  CURSOR_OPTION,
  intOption,
  LIMIT_OPTION,
  listOption,
  pageOf,
  positional,
  stringOption,
  type CommandSpec,
  type Context,
  type Input,
} from "../command.js";
import { CavelonError, ExitCode, usageError, validationError } from "../errors.js";
import { clip, moreHint, table } from "../format.js";
import { readAll } from "../io.js";
import { callOperation, previewRequest, type CallArguments } from "../invoke.js";
import { confinedPath } from "../paths.js";
import { describeSchema, findOperation, jsonBodySchema, operations, schemaTypes, type Operation } from "../openapi.js";
import { cavelonCommand } from "../shell.js";

/**
 * `--json` means "print JSON" on every command. On `api` it may also carry
 * the request body, as the plan writes it (`api <operationId> --json body`):
 * when a value follows, it is the body.
 */
export function splitJsonBody(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--json=")) {
      out.push(`--body=${arg.slice("--json=".length)}`);
      continue;
    }
    const next = args[i + 1];
    if (arg === "--json" && next !== undefined && looksLikeBody(next)) {
      out.push("--body", next);
      i++;
      continue;
    }
    out.push(arg);
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

export async function readBody(ctx: Context, raw: string): Promise<unknown> {
  let text = raw;
  if (raw === "-" && ctx.mode === "mcp") {
    throw usageError("A body from standard input is not available over MCP; pass the JSON itself.");
  }
  if (raw === "-") text = await readAll(ctx.io.stdin);
  else if (raw.startsWith("@")) text = await fs.readFile(await confinedPath(ctx, raw.slice(1), "The body file"), "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw usageError(`The body is not JSON: ${error instanceof Error ? error.message : String(error)}`, "Pass --json '{\"key\": \"value\"}', @file.json or - for stdin.");
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
 * What the kit keeps for a person even when an agent has `confirm`: setting
 * or deleting a secret value, creating or revoking a credential (tokens, API
 * keys, sign-in), and deciding an approval. A dedicated command for each is
 * CLI-only or absent; this keeps `api` from reaching the same operations over
 * MCP. The words of the path decide, so an instance's newer route of the same
 * kind is kept too.
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

export function keptForPerson(op: Operation): { does: string; hint: string } | undefined {
  if (op.readOnly) return undefined;
  const words = op.path.toLowerCase().split("/").filter((word) => word && !word.startsWith("{"));
  return FOR_A_PERSON.find((rule) => words.some((word) => rule.match(word)));
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
    "Parameters: -p name=value or name=value. Body: --json '<json>', --json @file.json or --json - (stdin).\n" +
    "The body is checked against the operation's schema before it is sent.\n" +
    "As an MCP tool, an operation that changes something returns what it would send and sends it only with confirm;\n" +
    "one that changes a secret, creates or revokes a credential or decides an approval is refused, as are files outside\n" +
    "the solution folder.",
  readOnly: false,
  destructive: true,
  mcpTool: "api",
  positionals: [
    { name: "operation", description: "operationId or its short name.", required: true },
    { name: "params", description: "Parameters as name=value.", variadic: true },
  ],
  options: {
    param: { type: "string", short: "p", multiple: true, value: "<name=value>", description: "A path, query or header parameter." },
    body: { type: "string", value: "<json|@file|->", description: "The request body (also accepted as --json <body>)." },
    file: { type: "string", multiple: true, value: "<field=path>", description: "Attach a file to a multipart body." },
    output: { type: "string", value: "<file>", description: "Write the response body to a file instead of printing it.", cliOnly: true },
    confirm: {
      type: "boolean",
      description: "As an MCP tool: send an operation that changes something; without it, nothing is sent. The CLI sends at once.",
    },
    limit: { type: "string", value: "<n>", description: "Show at most n items of a list response (default 50, 0 for all)." },
  },
  examples: [
    "cavelon api list_harnesses",
    "cavelon api get_harness_by_slug slug=support",
    "cavelon api create_knowledge_base --json '{\"name\": \"FAQ\"}'",
  ],
  preprocess: splitJsonBody,
  async run(ctx, input) {
    const name = positional(input, "operation")!;
    const doc = await (await ctx.contracts()).openapi();
    const op = findOperation(doc, name);
    const args: CallArguments = { params: parseParams(input) };
    const rawBody = stringOption(input, "body");
    if (rawBody !== undefined) args.body = await readBody(ctx, rawBody);
    for (const spec of listOption(input, "file")) {
      const at = spec.indexOf("=");
      if (at <= 0) throw usageError(`--file "${spec}" is not field=path.`);
      const file = await confinedPath(ctx, spec.slice(at + 1), "The file");
      args.files = [...(args.files ?? []), { field: spec.slice(0, at), path: file }];
    }
    if (ctx.mode === "mcp" && !op.readOnly) {
      const kept = keptForPerson(op);
      if (kept) {
        throw new CavelonError(ExitCode.usage, {
          code: "operation_for_a_person",
          message: `${op.alias} (${op.method} ${op.path}) ${kept.does}; that stays with a person, so no tool sends it, with or without confirm.`,
          hint: kept.hint,
        });
      }
      if (!boolOption(input, "confirm")) {
        const request = previewRequest(doc, op, args);
        const files = (args.files ?? []).map((f) => ({ field: f.field, file: path.relative(ctx.io.cwd, f.path) || f.path }));
        return {
          data: { operation: op.alias, ...request, ...(files.length ? { files } : {}), sent: false, confirm: "Call api again with the same arguments and confirm: true." },
          text: `Would send ${request.method} ${request.path}. Nothing was sent.`,
        };
      }
    }
    const client = await ctx.client();
    const result = await callOperation(ctx, client, doc, op, args);
    const output = stringOption(input, "output");
    if (output) {
      const content = result.bytes ?? (typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2));
      await fs.writeFile(output, content);
      const size = typeof content === "string" ? Buffer.byteLength(content) : content.length;
      return { data: { status: result.status, written: output, bytes: size }, text: `Wrote ${size} bytes to ${output}.` };
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
    const op = findOperation(doc, positional(input, "operation")!);
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
