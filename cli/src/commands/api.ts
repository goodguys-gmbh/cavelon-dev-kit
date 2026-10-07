import { promises as fs } from "node:fs";
import path from "node:path";
import { AGENT_VARIABLES, drivenByAgent, type DrivenBy } from "../agent-env.js";
import {
  boolOption,
  CURSOR_OPTION,
  intOption,
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
import { describeSchema, findOperation, jsonBodySchema, matchedLoosely, operations, schemaTypes, secretFields, secretPaths, type Operation } from "../openapi.js";
import { harnessNotFoundError, lookupHarness } from "../harness-ref.js";
import { CONFIRM_TOKEN, confirmInTerminal, confirmThroughClient, confirmToken, confirmTokenRequired, personApproves, personRoute } from "../confirm-token.js";
import { actingTarget, targetLine } from "../acting.js";
import { accessFor, operationAccess, type CredentialAccess, type OperationAccess } from "../access.js";
import { cavelonCommand, fill, personCommand } from "../printed.js";

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
    hint:
      "A person sets a secret in the Admin under Settings › Secrets, or, on an instance that still takes a token there, in their own " +
      "terminal with `cavelon secrets set <name>` (or deletes it with `cavelon secrets delete <name>`).",
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
    const hint = byPathWords(op)?.hint ?? `A person runs it: in Cavelon, or in their own terminal with \`cavelon api ${op.alias}\`.`;
    return { source: "instance", ...(op.personOnly.reason ? { reason: op.personOnly.reason } : {}), hint };
  }
  if (op.readOnly) return undefined;
  const rule = byPathWords(op);
  return rule ? { source: "kit", reason: rule.does, hint: rule.hint } : undefined;
}

/**
 * Who does not send it, for a refusal: no MCP tool, or `cavelon api` in an
 * agent's shell. It never names what tells an agent from a person, which
 * would tell the agent how to get past the guard; the hint says who runs it.
 */
function notSentBy(driven: DrivenBy): string {
  return driven.by === "mcp" ? "no tool sends it, with or without confirm." : "cavelon api does not send it when a coding agent runs it, with or without --confirm.";
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
  return new CavelonError(ExitCode.needsAction, {
    code: "secret_field_for_a_person",
    message:
      `The request to ${op.alias} sets ${named}, which the instance marks as a secret value (x-cavelon-secret); ` +
      `a person enters secret values, so ${notSentBy(driven)}`,
    hint: `A person sets a secret value in their own terminal with \`${cavelonCommand("secrets", "set", fill("name"))}\`, or enters it in the Admin. Leave the field out to send the rest.`,
    details: { fields },
  });
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

/**
 * The persona routes: without `harness_id` they read and write the persona of
 * the tenant's default route, which in a solution folder is rarely the
 * solution being built, so a new persona looked as if it had not arrived.
 */
const PERSONA_ROUTE = "/api/v1/bot-persona";

/**
 * In a solution folder, a persona operation that is not given `harness_id`
 * gets the folder's solution (env file, then cavelon.yaml), and says so. The
 * caller's own `harness_id` always wins.
 */
async function solutionForPersona(ctx: Context, op: Operation, params: Record<string, string[]>): Promise<void> {
  if (op.path !== PERSONA_ROUTE && !op.path.startsWith(`${PERSONA_ROUTE}/`)) return;
  if (params.harness_id || !op.parameters.some((p) => p.name === "harness_id" && p.in === "query")) return;
  const session = await ctx.session();
  const ref = session.envFile?.harness ?? session.project?.harness;
  if (!ref) return;
  const source = session.envFile?.harness ? `env/${session.envFile.name}.yaml` : "cavelon.yaml";
  const { harness, candidates } = await lookupHarness(ctx, ref);
  if (!harness) throw harnessNotFoundError(ref, candidates, source, (slug) => `harness_id=<id of ${slug}>`);
  params.harness_id = [harness.id];
  ctx.warn(
    `Sent harness_id=${harness.id}, the solution ${harness.slug} from ${source}: without it, ${op.alias} reaches the tenant's default route. ` +
      "Pass harness_id=<id> for another solution.",
  );
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
    AGENT_VARIABLES.filter((v) => v.variable !== "CAVELON_AGENT").map((v) => (v.value ? `${v.variable}=${v.value}` : v.variable)).join(", ") +
    "\nor CAVELON_AGENT=1 is set), an operation that changes something returns what it would send and a confirm token,\n" +
    "and sends it only with that token and the person's yes: as an MCP tool, confirm: \"<token>\", after which the client\n" +
    "asks the person; from an agent's shell, the person sends it from their own terminal. A changed request needs a new\n" +
    "preview; confirm: true is refused.\n" +
    "Run by an agent, one the instance marks for a person only (x-cavelon-person-only) is refused, as is a body that\n" +
    "sets a field the instance marks as a secret value (x-cavelon-secret) and a file outside the solution folder. On an\n" +
    "instance that marks no operation, one that changes a secret, creates or revokes a credential or decides an\n" +
    "approval is refused. A person's own terminal sends at once.\n" +
    "In a solution folder, the persona operations (get_bot_persona, upsert_bot_persona, …) get the folder's solution as\n" +
    "harness_id when none is passed, since without it they reach the tenant's default route.",
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
      mcpToken: true,
      description:
        "Send an operation that changes something: run by a coding agent or as an MCP tool, the token its preview returned. " +
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
    await solutionForPersona(ctx, op, args.params!);
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
        // A policy, not a mistyped command: a person has to run it (exit 5, "needs a person").
        throw new CavelonError(ExitCode.needsAction, {
          code: "operation_for_a_person",
          message: refusal(op, kept, driven),
          hint: kept.hint,
          details: { source: kept.source, ...(kept.reason ? { reason: kept.reason } : {}) },
        });
      }
      const secrets = secretsIn(doc, op, args);
      if (secrets.length) throw secretRefusal(op, secrets, driven);
    }
    if (driven && !op.readOnly) {
      // The same call as the person types it in their own terminal, where it sends at once.
      const words = [
        "api",
        name,
        ...((input.positionals.params as string[] | undefined) ?? []),
        ...listOption(input, "param").flatMap((p) => ["-p", p]),
        ...(rawBody !== undefined ? ["--body", rawBody] : []),
        ...listOption(input, "file").flatMap((f) => ["--file", f]),
      ];
      const preview = await previewUnlessConfirmed(ctx, input, doc, op, args, driven, personCommand(...words));
      if (preview) return preview;
    }
    // A person's own terminal sends what they typed: the instance's confirmation is asked for if the instance asks for it.
    if (!driven && !op.readOnly) ctx.approved = { guarded: false };
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
 * yet; undefined when it has. Over MCP and from an agent's shell alike, only
 * the token of this very request sends it, so the agent has to show the
 * preview before it can send, and cannot send another body than it showed.
 * `api` reaches every operation, the live and tenant-wide ones too, so the
 * token is not enough: the person approves in the MCP client's dialog, or
 * sends it from their own terminal (`command`).
 */
async function previewUnlessConfirmed(
  ctx: Context,
  input: Input,
  doc: Parameters<typeof previewRequest>[0],
  op: Operation,
  args: CallArguments,
  driven: DrivenBy,
  command: string,
): Promise<CommandResult | undefined> {
  const given = input.options.confirm;
  if (given === true) throw confirmTokenRequired("api");
  const request = previewRequest(doc, op, args);
  const files = (args.files ?? []).map((f) => ({ field: f.field, file: path.relative(ctx.io.cwd, f.path) || f.path }));
  const session = await ctx.session();
  const token = confirmToken({ url: session.url, tenant: session.tenant }, "api", { request, files });
  const route = personRoute(ctx, driven);
  if (typeof given === "string" && given === token) {
    await personApproves(ctx, driven, { tool: "api", what: `Send ${request.method} ${request.path} (${op.alias}).`, command });
    return undefined;
  }
  const stale = typeof given === "string" && given !== "";
  // `--confirm` alone, which splitConfirm passes on as an empty token: it shows the preview, as in every changing command.
  const bare = given === "" && driven.by === "agent";
  const confirm = route === "client" ? confirmThroughClient("api", token) : confirmInTerminal(command);
  // Where it would go: the person who approves sees the tenant an agent passed, or that none is chosen.
  const target = await actingTarget(ctx);
  const shown = { operation: op.alias, ...request, ...(files.length ? { files } : {}), target, sent: false };
  const lines = [`Would send ${request.method} ${request.path}. Nothing was sent.`, targetLine(target)];
  if (stale) lines.push("The confirm token is not this request's: the request changed since its preview, or the token is another one's.");
  if (bare && driven.by === "agent") lines.push("A coding agent cannot send it: the person sends it from their own terminal.");
  if (op.confirmation) lines.push(`The instance asks for the person's confirmation of it (x-cavelon-confirmation)${op.confirmationWhen ? `: ${op.confirmationWhen}` : ""}`);
  if (Object.keys(request.query).length) lines.push(`Query: ${JSON.stringify(request.query)}`);
  if (Object.keys(request.headers).length) lines.push(`Headers: ${JSON.stringify(request.headers)}`);
  if (request.body !== null) lines.push("Body:", JSON.stringify(request.body, null, 2));
  for (const f of files) lines.push(`File: ${f.field} = ${f.file}`);
  lines.push(confirm);
  return {
    data: {
      ...shown,
      ...(route === "client" ? { confirm_token: token } : {}),
      confirm,
      needs_person: route,
      ...(op.confirmation ? { instance_confirmation: op.confirmationWhen ?? true } : {}),
      ...(stale ? { token_mismatch: true } : {}),
      ...(bare ? { token_required: true } : {}),
    },
    text: lines.join("\n"),
    ...(stale ? { exitCode: ExitCode.conflict } : bare ? { exitCode: ExitCode.needsAction } : {}),
  };
}

export const apiList: CommandSpec = {
  name: "api list",
  summary: "List the operations the instance publishes.",
  description: "Shows needs_a_person_when separately from unconditional access restrictions; --usable keeps operations with conditional identity cases available for ordinary requests.",
  readOnly: true,
  idempotent: true,
  mcpTool: "api_list",
  options: {
    tag: { type: "string", value: "<tag>", description: "Only operations with this OpenAPI tag." },
    search: { type: "string", value: "<text>", description: "Only operations whose name, path or summary contains the text." },
    method: { type: "string", value: "<method>", description: "Only this HTTP method (GET, POST, …)." },
    tags: { type: "boolean", description: "List the tags with their operation counts instead." },
    limit: { type: "string", value: "<n>", description: "Return at most n operations (default 50, 0 for all)." },
    usable: { type: "boolean", description: "Leave out the operations the instance says this credential may not send." },
    cursor: CURSOR_OPTION,
  },
  async run(ctx, input) {
    const doc = await (await ctx.contracts()).openapi();
    let ops = operations(doc);
    const access = await listAccess(ctx);
    if (input.options.tags === true) {
      const counts = new Map<string, number>();
      for (const op of ops) for (const tag of op.tags.length ? op.tags : ["(none)"]) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      const items = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tag, count]) => ({ tag, operations: count }));
      return { data: { items }, text: table(items, ["tag", "operations"]) };
    }
    const tag = stringOption(input, "tag");
    if (tag) {
      ops = ops.filter((o) => o.tags.includes(tag));
      if (ops.length === 0) throw usageError(`No operations tagged "${tag}".`, `\`${cavelonCommand("api", "list", "--tags")}\` shows the tags.`);
    }
    const method = stringOption(input, "method")?.toUpperCase();
    if (method) ops = ops.filter((o) => o.method === method);
    const search = stringOption(input, "search")?.toLowerCase();
    if (search) {
      ops = ops.filter((o) => [o.operationId, o.path, o.summary ?? ""].some((s) => s.toLowerCase().includes(search)));
    }
    const usableOnly = boolOption(input, "usable");
    const marks = new Map(ops.map((o) => [o, operationAccess(access, `${o.method} ${o.path}`)]));
    if (usableOnly) ops = ops.filter((o) => marks.get(o)!.allowed !== false);
    // 0 lists them all, as `api --limit 0` shows a whole response.
    const wanted = intOption(input, "limit", { min: 0, max: 1000, fallback: 50 })!;
    const limit = wanted === 0 ? Math.max(ops.length, 1) : wanted;
    const page = pageOf(
      ops.map((o) => ({
        operation: o.alias,
        operation_id: o.operationId,
        method: o.method,
        path: o.path,
        summary: o.summary ?? null,
        tags: o.tags,
        read_only: o.readOnly,
        ...accessFields(marks.get(o)!),
      })),
      limit,
      stringOption(input, "cursor"),
    );
    const flags = [tag ? ["--tag", tag] : [], method ? ["--method", method] : [], search ? ["--search", search] : [], usableOnly ? ["--usable"] : []].flat();
    const marked = page.items.some((i) => i.may_send === false);
    const conditional = page.items.some(i => i.needs_a_person_when !== null);
    return {
      data: { ...page, credential_published: Boolean(access) },
      text:
        table(
          page.items.map((i) => ({ ...i, access: i.needs_a_person ? "a person" : i.needs?.length ? `needs ${i.needs.join(" and ")}` : "" })),
          marked ? ["operation", "method", "path", "access", "summary"] : ["operation", "method", "path", "summary"],
        ) +
        (conditional ? `\nNeeds a person only when (ordinary requests remain usable):${page.items.filter(i => i.needs_a_person_when !== null).map(i => `\n  ${i.method} ${i.path}: ${clip(i.needs_a_person_when!, 240)}`).join("")}` : "") +
        `\n${page.items.length} of ${page.total}` +
        (marked ? `\nOperations with an access entry are ones this credential may not send, as the instance says; --usable leaves them out.` : "") +
        moreHint(page.next_cursor, cavelonCommand("api", "list", ...flags)),
    };
  },
};

/** What the credential may do, for marking operations; undefined without a token or an answer. */
async function listAccess(ctx: Context): Promise<CredentialAccess | undefined> {
  try {
    const session = await ctx.session();
    return session.token ? await accessFor(await ctx.client()) : undefined;
  } catch {
    return undefined;
  }
}

/** An operation's entry as the credential may send it: may_send null where the instance does not say. */
function accessFields(mark: OperationAccess): { may_send: boolean | null; needs_a_person: string | null; needs_a_person_when: string | null; needs: string[] | null } {
  return { may_send: mark.allowed, needs_a_person: mark.person ?? null, needs_a_person_when: mark.personWhen ?? null, needs: mark.missing ?? null };
}

export const apiDescribe: CommandSpec = {
  name: "api describe",
  summary: "Show one operation's parameters, body and responses.",
  description: "Shows the credential's published needs_a_person_when as advisory guidance. Its reason describes the condition; it does not refuse an ordinary request.",
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
    // Who may send it: the instance's own marker, else the kit's rule for an instance that marks none.
    const kept = keptForPerson(op, operations(doc));
    const secrets = secretPaths(doc, bodySchema);
    const data = {
      operation: op.alias,
      operation_id: op.operationId,
      method: op.method,
      path: op.path,
      read_only: op.readOnly,
      ...accessFields(operationAccess(await listAccess(ctx), `${op.method} ${op.path}`)),
      person_only: kept ? { source: kept.source, reason: kept.reason ?? null, hint: kept.hint } : null,
      secret_fields: secrets,
      confirmation: op.confirmation ? { required: true, when: op.confirmationWhen ?? null } : null,
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
    if (data.needs_a_person_when !== null) lines.push(`Needs a person only when: ${data.needs_a_person_when}. Ordinary requests remain usable; the instance decides every request.`);
    if (kept) {
      lines.push(
        kept.source === "instance"
          ? `For a person only (x-cavelon-person-only${kept.reason ? `: ${kept.reason}` : ""}): an agent does not send it. ${kept.hint}`
          : `For a person: it ${kept.reason}, and this instance marks no operation, so an agent does not send it. ${kept.hint}`,
      );
    }
    if (secrets.length) lines.push(`Secret values (x-cavelon-secret): ${secrets.join(", ")}. A person enters them; an agent leaves them out.`);
    if (op.confirmation) {
      lines.push(
        `A person confirms it (x-cavelon-confirmation)${op.confirmationWhen ? `: ${op.confirmationWhen}` : "."} cavelon asks the instance for the ` +
          "confirmation once the person approved the call: in their own terminal, or in the MCP client's dialog.",
      );
    }
    if (data.description && data.description !== op.summary) lines.push("", data.description);
    if (data.parameters.length) {
      lines.push("", "Parameters:", table(data.parameters, ["name", "in", "required", "type", "description"]));
    }
    if (data.body) lines.push("", `Body (${bodyTypes.join(", ")}${data.body.required ? ", required" : ""}):`, JSON.stringify(data.body.schema, null, 2));
    if (Object.keys(responses).length) lines.push("", "Responses:", JSON.stringify(responses, null, 2));
    return { data, text: lines.join("\n") };
  },
};
