import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type RequestId, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { accessFor, allOf, credentialWords, operationAccess, whoInstead, type CredentialAccess } from "./access.js";
import { formerlyWarning, ownsTenant, propertyName, type CommandSpec, type Input, type PersonAnswer } from "./command.js";
import { MCP_MAX_WAIT_MS } from "./commands/async.js";
import { PERSON_WAIT_MS } from "./confirm-token.js";
import { createContext, withWarnings } from "./context.js";
import { solutionDirectory } from "./mcp-directory.js";
import { asCavelonError, CavelonError, ExitCode, usageError } from "./errors.js";
import type { Io } from "./io.js";
import { closest } from "./package-references.js";
import { printingFor, spoken, spokenError, spokenHints } from "./printed.js";
import type { SessionTenant } from "./session.js";
import { startSessionUpdateCheck, type SessionUpdateOptions } from "./update-check.js";
import { KIT_VERSION } from "./version.js";

/**
 * `cavelon mcp`: the workflow commands as coarse MCP tools over stdio, never
 * one tool per API operation. Each tool runs the command's own code, carries
 * its read-only or destructive annotation, and never blocks for long: work
 * that takes time returns an operation id, and `operation_status` reads it,
 * waiting only when asked to and never past MCP_MAX_WAIT_MS. The first
 * result of a session may carry one warning that cavelon, the plugin or the
 * folder's skills are behind the latest release (startSessionUpdateCheck).
 */

const INSTRUCTIONS =
  "Tools for one Cavelon instance, acting with the token a person stored with `cavelon login` " +
  "(or CAVELON_TOKEN). You never see or pass the token. Tools that start work (kb_upload, test_run, " +
  "loop_start, sandbox_seed, artifacts_export) return operation ids at once; read them with operation_status, which returns " +
  `the state at once, or waits up to its timeout (at most ${MCP_MAX_WAIT_MS / 1000} s) when given one, and reports waited_ms, ` +
  "and follow a loop with loop_iterations. What needs confirmation: apply imports only with confirm set to a preview's id; " +
  "tenant_create, variables_set where it replaces another value, variables_delete, loop_start, limits_set, models_set_limit, loop_cancel, sandbox_seed, " +
  "trigger_identity, harness_default, activate of a solution a channel or trigger reaches or with make_default, deactivate, " +
  "and api for an operation that is not read-only, " +
  "return what they would do and a confirm_token, and change nothing until called again with the same arguments and " +
  "confirm set to that token: show the person the preview first. The token confirms exactly the change the preview showed; " +
  "a different change needs a new preview, and confirm: true is refused. A change that reaches live traffic or the whole tenant, " +
  "or that cannot be taken back, is the person's to confirm, and the token alone does not make it: its preview says " +
  "needs_person. With needs_person \"client\", call again with the token and the client asks the person to approve exactly that " +
  "change; their no, or no answer, changes nothing (confirm_declined). Only after their yes does cavelon ask the instance for " +
  "confirmation bound to the token, tenant and exact request. The instance does not verify the person's answer: asking them " +
  "is the kit's responsibility alone. Ask before every guarded change; never answer on the person's behalf or reuse an earlier yes for another change. " +
  "confirmation_required or confirmation_invalid changed nothing: preview again, never retry " +
  "on your own. With needs_person \"terminal\" this client cannot ask " +
  "them: give the person the preview's confirm command, which they run in their own terminal, never in yours. These are " +
  "harness_default and activate (the default route and a solution something reaches: live traffic), deactivate, tenant_create, " +
  "variables_set replacing a value (every solution of the tenant reads it), variables_delete, limits_set, models_set_limit, trigger_identity, " +
  "api for an operation that is not read-only, loop_start unless the trigger's solution is a draft (a run acts as the person " +
  "and spends budget), and apply where its preview says show_to_person (tenant-wide sections, an active solution, deletions, " +
  "env/prod, or database_queries.would_write). A draft's apply with no query writes or other person requirement, a draft's loop_start, loop_cancel, sandbox_seed and kb_upload's replace you confirm with the " +
  "token once the person saw the preview. " +
  "chat sends one message to a solution and returns its answer: the way to try one that is not the default route. " +
  "kb_upload names files that match an active document of the knowledge base; with replace it replaces them, and where the " +
  "instance's upload cannot, it returns what it would deactivate and uploads nothing without its confirm_token. " +
  "init, pull and fmt change nothing on the instance (pull only reads it); they write files in the solution folder without confirm " +
  "(pull refuses to replace a package file that changed since the last pull or apply and is not committed, unless force), " +
  "and the other changing tools act at once. api refuses, even with confirm, an operation the instance marks for a person " +
  "(x-cavelon-person-only; its reason is in the error), or on an instance that marks none, one that changes a secret, " +
  "creates or revokes a credential (tokens, API keys, sign-in) or decides an approval; it also refuses a body that sets a field " +
  "the instance marks as a secret value (x-cavelon-secret): leave the field out and let a person enter the value. " +
  "A tool whose description starts with \"Not for this credential\" is one the instance says this token or key may not use " +
  "in this tenant (whoami lists its permissions, an API key's scopes and the operations a person runs): do not call it to " +
  "find out; tell the person who does it. api_list marks such operations (may_send false) and leaves them out with usable. " +
  "Run from your shell, cavelon's api command applies the same guards, and sends a changing operation only with --confirm and the token " +
  "its preview printed. Tools read and write files only " +
  "inside the solution folder (the folder of cavelon.yaml, or the one the server started in), never in cavelon's own " +
  "directories. In a repository with several solutions, pass solution_dir to select a folder inside the server's startup workspace. " +
  "Use the same solution_dir for preview, confirmation and follow-up tools; harness selects an instance solution, not its local folder. Never infer a folder from a harness name. " +
  "Tools cannot select a folder outside the original workspace or in cavelon's " +
  "config or cache directory. Read limits before planning a solution: it lists what the " +
  "instance allows this tenant (upload sizes and types, run and tool limits, timeouts, quotas) and who changes each. " +
  "Never change a limit on your own: propose the old and new value (limits_set for a limit a tenant admin changes, " +
  "models_set_limit for an endpoint's max_concurrent_requests) and let the person decide; an operator's limit goes to the operator. " +
  "db_connections, db_queries and db_runs read database connections, saved queries and their runs. Connection commands " +
  "and query-writing apply follow the permissions and needs_a_person the instance publishes: use whoami, including " +
  "database_connectors.manage, instead of assuming every token is blocked. An authorized personal access token may " +
  "manage definitions. Creating, changing or deleting a query, including imports that create or change one, needs the person's approval even on a draft; after approval cavelon sends the " +
  "instance's confirmation for the exact change where required. Passwords, privilege acknowledgment and enabling writes " +
  "stay with a person in the Admin; never accept or pass the database password or set allows_writes through a tool. " +
  "variables_list/variables_get/variables_set handle plain-text {{var:…}} values; setting one needs a role that may manage " +
  "the tenant's settings, as a secret does (a Builder's may not): where whoami says the credential may not, tell the person " +
  "who sets it instead of calling variables_set. secrets_list shows which {{secret:…}} " +
  "values are set, never a value: a person sets a secret, so tell them how, as the answers name it: the exact " +
  "`cavelon secrets set <name>` command to run in their terminal, or, where the instance lets no token set one, the Admin " +
  "under Settings › Secrets. Never ask for, read or pass a secret value. Never approve or decide an approval; " +
  "that stays with a person. Use docs_search before guessing, " +
  "and api_list/api_describe/api for anything without its own tool. " +
  "use_tenant chooses the tenant for this MCP session only and never changes the tenant stored for the person; every preview " +
  "names the instance, the tenant and the mode it acts on (its target): show that to the person with the change. " +
  "The first result of a session may carry a warning that cavelon, the Cavelon plugin or this folder's skills are behind " +
  "the latest release, with the commands that update them: pass it on to the person, who runs them; do not run them yourself.";

/** The instructions with each command they name in backticks as the tool call; a person's command (login, secrets set) stays. */
export function mcpInstructions(commands: readonly CommandSpec[]): string {
  return printingFor({ mode: "mcp", commands }, () => spoken(INSTRUCTIONS));
}

type JsonSchema = Record<string, unknown>;

/** How long the tool list waits for what the credential may do before it lists the tools unmarked. */
const TOOL_LIST_ACCESS_MS = 5_000;

/** The tools that choose this session's tenant. */
const TENANT_CHOOSERS = new Set(["use_tenant", "tenant_create"]);

/** What a `confirm` token option says over MCP, after what it does. */
const TOKEN_DESCRIPTION =
  "Over MCP: the confirm_token this tool's preview returned, which confirms exactly the change it showed; true is refused.";

export function toolName(spec: CommandSpec): string | undefined {
  return spec.mcpTool || undefined;
}

export { propertyName };

/**
 * A description as a tool's caller reads it. The help text names the
 * command's options as flags (`--make-default`), which the tool refuses as
 * arguments, and other commands as `cavelon …` lines; here they are the
 * argument names (`make_default`) and the tools (`models_list`).
 */
export function mcpSpelling(text: string, spec: CommandSpec, commands: readonly CommandSpec[] = []): string {
  const own = new Set(Object.entries(spec.options ?? {}).filter(([, o]) => !o.cliOnly).map(([name]) => name));
  if (!ownsTenant(spec)) own.add("tenant");
  return text
    .replace(/`cavelon ([a-z][a-z -]*[a-z])`/g, (whole, words: string) => {
      const tool = commands.find((c) => c.name === words)?.mcpTool;
      return tool ? `\`${tool}\`` : whole;
    })
    .replace(/--([a-z][a-z0-9-]*)/g, (whole, name: string) => (own.has(name) ? propertyName(name) : whole));
}

export function inputSchema(spec: CommandSpec, commands: readonly CommandSpec[] = []): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const said = (text: string) => mcpSpelling(text, spec, commands);
  for (const p of spec.positionals ?? []) {
    properties[propertyName(p.name)] = p.variadic
      ? { type: "array", items: { type: "string" }, description: said(p.description) }
      : { type: "string", description: said(p.description) };
    if (p.required) required.push(propertyName(p.name));
  }
  for (const [name, option] of Object.entries(spec.options ?? {})) {
    if (option.cliOnly) continue;
    const description = said(option.mcpDescription ?? option.description);
    properties[propertyName(name)] = option.mcpToken
      ? { type: "string", description: `${description} ${TOKEN_DESCRIPTION}` }
      : option.type === "boolean"
        ? { type: "boolean", description }
        : option.multiple
          ? { type: "array", items: { type: "string" }, description }
          : { type: ["string", "number"], description };
  }
  if (!ownsTenant(spec)) {
    properties.tenant = {
      type: "string",
      description: "Tenant slug or id, when not the one chosen for this directory or with use_tenant in this session. A preview names the tenant it acts on.",
    };
  }
  properties.solution_dir = {
    type: "string",
    minLength: 1,
    description: "Solution folder inside this MCP session's workspace, relative to its startup folder or an absolute path inside it. Omit to use the startup folder. Use the same folder for preview, confirmation and follow-up calls; harness selects an instance solution, not this folder.",
  };
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

/**
 * What the tool's description says where the instance publishes that this
 * credential may not send the operation the tool exists for: the agent reads
 * it before it calls, instead of learning it from a 403. Undefined where it
 * may, or the instance does not say.
 */
export function notForThisCredential(spec: CommandSpec, access: CredentialAccess | undefined): string | undefined {
  if (!access) return undefined;
  for (const operation of spec.operations ?? []) {
    const refused = operationAccess(access, operation);
    if (refused.allowed !== false) continue;
    const why = refused.person ? "a person runs it" : `it needs ${allOf(refused.missing!)}, which it does not hold`;
    return `Not for this credential: ${credentialWords(access)} may not send ${operation} (${why}). ${whoInstead(access, refused)} Do not call it to find out; tell the person.`;
  }
  return undefined;
}

export function toolFor(spec: CommandSpec, commands: readonly CommandSpec[] = [], access?: CredentialAccess): Tool {
  const marked =
    spec.mcpEffect ?? (spec.readOnly ? "Read-only." : spec.destructive ? "Changes the instance; may delete or overwrite." : "Changes the instance.");
  const refused = notForThisCredential(spec, access);
  const conditional = (spec.operations ?? []).flatMap(operation => {
    const reason = operationAccess(access, operation).personWhen;
    return reason === undefined ? [] : [`Needs a person only when (${operation}): ${reason}. Ordinary requests remain usable; the instance decides every request.`];
  });
  return {
    name: toolName(spec)!,
    description: mcpSpelling([refused, spec.summary, spec.description, ...conditional, marked].filter(Boolean).join("\n"), spec, commands),
    inputSchema: inputSchema(spec, commands) as Tool["inputSchema"],
    annotations: {
      title: spec.summary,
      readOnlyHint: spec.readOnly,
      destructiveHint: !spec.readOnly && Boolean(spec.destructive),
      idempotentHint: Boolean(spec.idempotent),
      openWorldHint: true,
    },
  };
}

/**
 * The arguments by the tool's property names. A property the schema does not
 * list is refused, naming the closest one, rather than dropped: an
 * `activate` that lost `make_default` would activate without the preview it
 * was asked for. The CLI's spelling of a multi-word option (`make-default`)
 * is refused like any other, naming the snake_case property. An option's
 * former snake_case name (`tenant_wide` for `include_tenant_wide`) is still
 * taken for a release, with a warning.
 */
function argumentsOf(spec: CommandSpec, args: Record<string, unknown>, warn: (message: string) => void): Record<string, unknown> {
  const properties = Object.keys((inputSchema(spec).properties as Record<string, unknown>) ?? {});
  const former = new Map(
    Object.entries(spec.options ?? {})
      .filter(([, o]) => o.formerly && !o.cliOnly)
      .map(([name, o]) => [propertyName(o.formerly!), propertyName(name)]),
  );
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (properties.includes(key)) {
      out[key] = value;
      continue;
    }
    const now = former.get(key);
    if (now) {
      warn(formerlyWarning(`"${key}"`, `"${now}"`));
      if (!(now in args)) out[now] = value;
      continue;
    }
    const spelled = propertyName(key);
    const near = spelled !== key && properties.includes(spelled) ? spelled : closest(key, properties);
    throw new CavelonError(ExitCode.usage, {
      code: "unknown_argument",
      message: `${spec.mcpTool} has no argument "${key}"; nothing was done.${near ? ` Did you mean "${near}"?` : ""}`,
      hint: `Its arguments: ${properties.join(", ")}.`,
      details: { argument: key, ...(near ? { suggestion: near } : {}), arguments: properties },
    });
  }
  return out;
}

function inputFrom(spec: CommandSpec, args: Record<string, unknown>): Input {
  const input: Input = { positionals: {}, options: {} };
  for (const p of spec.positionals ?? []) {
    const value = args[propertyName(p.name)];
    if (value === undefined || value === null) continue;
    input.positionals[p.name] = p.variadic ? (Array.isArray(value) ? value.map(String) : [String(value)]) : String(value);
  }
  for (const [name, option] of Object.entries(spec.options ?? {})) {
    if (option.cliOnly) continue;
    const value = args[propertyName(name)];
    if (value === undefined || value === null) continue;
    // A token stays a string; `true` is kept as such, so the command refuses it rather than taking it as yes.
    if (option.mcpToken) input.options[name] = value === true || value === "true" ? true : value === false ? false : String(value);
    else if (option.type === "boolean") input.options[name] = value === true || value === "true";
    else if (option.multiple) input.options[name] = Array.isArray(value) ? value.map(String) : [String(value)];
    else input.options[name] = String(value);
  }
  return input;
}

function missingRequired(spec: CommandSpec, args: Record<string, unknown>): string[] {
  return (spec.positionals ?? [])
    .map((p) => ({ ...p, name: propertyName(p.name) }))
    .filter((p) => p.required && (args[p.name] === undefined || args[p.name] === ""))
    .map((p) => p.name);
}

/** The one field of the dialog in which the client asks the person; the agent never sees or answers it. */
const APPROVAL_SCHEMA = {
  type: "object" as const,
  properties: { approve: { type: "boolean" as const, title: "Make this change", description: "Yes makes exactly the change shown; no changes nothing." } },
  required: ["approve"],
};

/** Whether the client can show the person a form (elicitation); an empty capability means form, as the protocol says. */
function clientAsks(server: Server): boolean {
  const elicitation = server.getClientCapabilities()?.elicitation as Record<string, unknown> | undefined;
  return Boolean(elicitation && (elicitation.form || Object.keys(elicitation).length === 0));
}

/**
 * The person's answer to a change, asked through the client, tied to the
 * tool call that asks. Bounded: no answer within PERSON_WAIT_MS, or a client
 * that fails to ask, changes nothing.
 */
async function askThroughClient(server: Server, message: string, relatedRequestId: RequestId): Promise<PersonAnswer> {
  try {
    const result = await server.elicitInput({ mode: "form", message, requestedSchema: APPROVAL_SCHEMA }, { timeout: PERSON_WAIT_MS, relatedRequestId });
    return result.action === "accept" && result.content?.approve === true ? "approved" : "declined";
  } catch {
    return "unanswered";
  }
}

/** Commands write nothing to stdout in MCP mode; stdout belongs to the protocol. */
function mcpIo(io: Io): Io {
  return { ...io, stdout: { write: () => true, isTTY: false } };
}

export function createMcpServer(io: Io, commands: CommandSpec[], updates: SessionUpdateOptions = {}): Server {
  const tools = commands.filter((c) => c.mcpTool);
  const byName = new Map(tools.map((c) => [toolName(c)!, c]));
  const server = new Server({ name: "cavelon", version: KIT_VERSION }, { capabilities: { tools: { listChanged: true } }, instructions: mcpInstructions(commands) });
  const notice = startSessionUpdateCheck(io, updates);
  // The tenants use_tenant chose: this server's alone, never the person's stored choice.
  const sessionTenants = new Map<string, SessionTenant>();

  /**
   * What the credential may do in this session's tenant, so the tool list
   * marks what it may not. Bounded: the list never waits long for it, and
   * without an instance, a token or an answer the tools are listed as they are.
   */
  async function credentialAccess(): Promise<CredentialAccess | undefined> {
    const read = (async () => {
      const ctx = createContext(mcpIo(io), { json: true, sessionTenants }, "mcp");
      const session = await ctx.session();
      if (!session.url || !session.token) return undefined;
      return accessFor(await ctx.client());
    })().catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), TOOL_LIST_ACCESS_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([read, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const access = await credentialAccess();
    return { tools: tools.map((t) => toolFor(t, commands, access)) };
  });

  /** The tool's `--json` document, or its error. */
  async function call(name: string, given: Record<string, unknown>, requestId: RequestId): Promise<{ body: unknown; isError?: true }> {
    const spec = byName.get(name);
    const fail = (error: unknown) => ({ isError: true as const, body: { error: asCavelonError(error).toJSON() } });
    if (!spec) return fail(new Error(`Unknown tool ${name}.`));
    const renamed: string[] = [];
    let args: Record<string, unknown>;
    try {
      args = argumentsOf(spec, given, (message) => renamed.push(message));
    } catch (error) {
      return fail(error);
    }
    const missing = missingRequired(spec, args);
    if (missing.length) {
      return fail(usageError(`Missing ${missing.join(", ")}.`));
    }
    const tenant = !ownsTenant(spec) && typeof args.tenant === "string" ? args.tenant : undefined;
    const solutionEnv = spec.options?.env && typeof args.env === "string" ? args.env : undefined;
    let folder: Awaited<ReturnType<typeof solutionDirectory>>;
    try {
      folder = await solutionDirectory(io, args.solution_dir);
    } catch (error) {
      return fail(error);
    }
    const ctx = createContext(mcpIo(folder.io), { json: true, tenant, solutionEnv, sessionTenants }, "mcp");
    if (clientAsks(server)) ctx.askPerson = (message) => askThroughClient(server, message, requestId);
    for (const message of renamed) ctx.warn(message);
    try {
      // A command a person runs in a terminal knows nothing of this session's tenant, so the lines printed for one name it.
      const chosen = tenant ?? (await ctx.session().then((s) => (s.tenantSource === "session" ? s.tenant : undefined), () => undefined));
      // The answer's hints, warnings and a refusal's hint name tool calls, as the commands it prints do.
      const { result, warnings } = await printingFor({ mode: "mcp", commands, solutionDir: folder.selected, personCwd: folder.directory, ...(spec.storesTarget ? {} : { tenant: chosen, env: solutionEnv }) }, async () => {
        try {
          const done = await spec.run(ctx, inputFrom(spec, args));
          return { result: { ...done, data: spokenHints(done.data) }, warnings: ctx.warnings.map(spoken) };
        } catch (error) {
          throw spokenError(error);
        }
      });
      let data = result.data;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        data = warnings.length ? withWarnings(data as Record<string, unknown>, warnings) : { ...(data as Record<string, unknown>) };
        if (result.exitCode) (data as Record<string, unknown>).exit_code = result.exitCode;
      }
      return { body: data ?? null };
    } catch (error) {
      return fail(error);
    }
  }

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // The lookup runs beside the tool; only the session's first call waits for it, and briefly.
    const warning = notice.forCall(() => server.getClientVersion()?.name);
    const { body, isError } = await call(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>, extra.requestId);
    // Another tenant may let the credential do other things: the client lists the tools again.
    if (!isError && TENANT_CHOOSERS.has(request.params.name)) void server.sendToolListChanged().catch(() => undefined);
    let out = body;
    const text = await warning;
    if (text) {
      if (out && typeof out === "object" && !Array.isArray(out)) out = withWarnings(out as Record<string, unknown>, [text]);
      else notice.keep();
    }
    return { ...(isError ? { isError } : {}), content: [{ type: "text" as const, text: JSON.stringify(out) }] };
  });
  return server;
}
