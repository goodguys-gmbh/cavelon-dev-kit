import {
  boolOption,
  CURSOR_OPTION,
  intOption,
  LIMIT_OPTION,
  pageOf,
  positional,
  stringOption,
  type CommandSpec,
  type Context,
} from "../command.js";
import { confirmation } from "../confirm-token.js";
import { CavelonError, ExitCode, usageError, validationError } from "../errors.js";
import { clip, keyValues, moreHint, table } from "../format.js";
import { callStable, workflowOperation } from "../invoke.js";
import { readAll } from "../io.js";
import { schemaErrors } from "../openapi.js";
import { readPrincipal } from "../principal.js";
import { readHidden } from "../prompt.js";
import { requireToken, type Session } from "../session.js";
import { shellWord } from "../shell.js";

/**
 * Tenant variables (`{{var:…}}`) and secrets (`{{secret:…}}`), one name at a
 * time. A variable is plain text the agent may
 * read and set. A secret's value is written by a person and never read back:
 * `secrets set` reads it from the terminal or standard input, never from an
 * argument, and is no MCP tool; a tenant API key is refused before anything
 * is sent, as the instance would refuse it.
 */

export const ENV_OPTION = { type: "string" as const, value: "<name>", description: "Act in the tenant that env/<name>.yaml names." };
const CONFIRM_OPTION = {
  type: "boolean" as const,
  mcpToken: true,
  description: "Delete it; without this nothing is deleted. Run by a coding agent: the token its preview printed.",
};
/** Key and token values start like this; they belong in a secret, never in a variable or an argument. */
const TOKEN_PREFIXES = ["cbp_", "cvpat_"];
/** A variable's value in a list is cut here; `variables get` returns it whole. */
const LIST_VALUE_CHARS = 200;

interface Variable {
  name: string;
  value: string;
  source?: string | null;
}

interface SecretStatus {
  name: string;
  status: "set" | "not_set";
  changed_at?: string | null;
  declared?: boolean;
  description?: string | null;
}


/**
 * The options that make a printed command act where this one did. An option
 * beats the env file, so a printed command keeps both: after `--env prod
 * --tenant beta`, `--env prod` alone would act in prod's tenant, and without
 * `--instance` it would go to another instance. `env` replaces the session's
 * env file (null: none), for a command that acts where a stored preview did.
 */
export function targetFlags(session: Session, env: string | null | undefined = session.envFile?.name): string {
  let flags = "";
  if (session.urlSource === "option" && session.url) flags += ` --instance ${shellWord(session.url)}`;
  if (env) flags += ` --env ${shellWord(env)}`;
  if (session.tenantSource === "option" && session.tenant) flags += ` --tenant ${shellWord(session.tenant)}`;
  return flags;
}

/** The command a person runs to set a secret; the value is typed or piped, never part of it. */
export function secretSetCommand(name: string, flags = ""): string {
  return `cavelon secrets set ${shellWord(name)}${flags}`;
}

export function variableSetCommand(name: string, flags = ""): string {
  return `cavelon variables set ${shellWord(name)} <value>${flags}`;
}

/** Check a name against the schema the instance publishes for the route's `name`, before anything is sent or asked. */
async function checkName(ctx: Context, method: string, template: string, what: string, name: string): Promise<void> {
  const { doc, op } = await workflowOperation(ctx, method, template, what);
  const param = op.parameters.find((p) => p.name === "name");
  if (!doc || !param?.schema) return;
  const errors = schemaErrors(doc, param.schema, name);
  if (errors.length) {
    throw validationError(
      `"${name}" is not a name this instance accepts: ${errors.map((e) => e.replace("(body) ", "")).join("; ")}.`,
      { name, schema: param.schema },
      param.description,
    );
  }
}

function notFound(error: unknown): boolean {
  return error instanceof CavelonError && error.status === 404;
}

// ---------------------------------------------------------------------------
// variables
// ---------------------------------------------------------------------------

async function readVariable(ctx: Context, name: string): Promise<Variable | undefined> {
  try {
    return await callStable<Variable>(ctx, "GET", "/api/v1/variables/{name}", "tenant variables", { params: { name: [name] } });
  } catch (error) {
    if (notFound(error)) return undefined;
    throw error;
  }
}

function variableNotSet(name: string, flags: string): CavelonError {
  return new CavelonError(ExitCode.failure, {
    code: "variable_not_set",
    status: 404,
    message: `This tenant has no variable "${name}".`,
    hint: `\`cavelon variables list\` shows them; \`${variableSetCommand(name, flags)}\` sets it.`,
  });
}

export const variablesList: CommandSpec = {
  name: "variables list",
  summary: "List the tenant's variables ({{var:…}}) with their values.",
  description:
    "Variables are plain text: anyone who may view the tenant's settings reads them. A credential belongs in a secret.\n" +
    `A value longer than ${LIST_VALUE_CHARS} characters is cut here; \`cavelon variables get <name>\` returns it whole.`,
  readOnly: true,
  idempotent: true,
  mcpTool: "variables_list",
  options: { limit: LIMIT_OPTION, cursor: CURSOR_OPTION, env: ENV_OPTION },
  examples: ["cavelon variables list", "cavelon variables list --env prod --json"],
  async run(ctx, input) {
    const limit = intOption(input, "limit", { min: 1, max: 500, fallback: 50 })!;
    const all = (await callStable<{ items: Variable[] }>(ctx, "GET", "/api/v1/variables", "tenant variables")).items ?? [];
    const page = pageOf(all, limit, stringOption(input, "cursor"));
    const items = page.items.map((v) => ({
      name: v.name,
      value: v.value.length > LIST_VALUE_CHARS ? v.value.slice(0, LIST_VALUE_CHARS) : v.value,
      ...(v.value.length > LIST_VALUE_CHARS ? { value_truncated: true } : {}),
      source: v.source ?? null,
    }));
    const flags = targetFlags(await ctx.session());
    const text = items.length
      ? table(items.map((v) => ({ ...v, source: v.source ?? "" })), ["name", "value", "source"], 60) + moreHint(page.next_cursor, `cavelon variables list${flags}`)
      : `No variables in this tenant. Set one with: cavelon variables set <name> <value>${flags}`;
    return { data: { items, next_cursor: page.next_cursor, total: page.total }, text };
  },
};

export const variablesGet: CommandSpec = {
  name: "variables get",
  summary: "Show one tenant variable with its whole value.",
  readOnly: true,
  idempotent: true,
  mcpTool: "variables_get",
  positionals: [{ name: "name", description: "The variable's name, as {{var:<name>}} uses it.", required: true }],
  options: { env: ENV_OPTION },
  async run(ctx, input) {
    const name = positional(input, "name")!;
    const variable = await readVariable(ctx, name);
    if (!variable) throw variableNotSet(name, targetFlags(await ctx.session()));
    const data = { name: variable.name, value: variable.value, source: variable.source ?? null };
    return {
      data,
      text: keyValues([
        ["name", data.name],
        ["value", data.value],
        ["source", data.source ? `the setting ${data.source} (change it there)` : undefined],
      ]),
    };
  },
};

export const variablesSet: CommandSpec = {
  name: "variables set",
  summary: "Create or replace a tenant variable.",
  description:
    "The value is plain text that anyone who may view the tenant's settings reads; never put a credential into a variable,\n" +
    "use `cavelon secrets set` (a person runs it). --stdin reads the value from standard input instead of the argument.",
  readOnly: false,
  idempotent: true,
  mcpTool: "variables_set",
  positionals: [
    { name: "name", description: "The variable's name, as {{var:<name>}} uses it.", required: true },
    { name: "value", description: "The value (plain text, not a credential)." },
  ],
  options: {
    stdin: { type: "boolean", description: "Read the value from standard input.", cliOnly: true },
    env: ENV_OPTION,
  },
  examples: ["cavelon variables set crm_base_url https://crm.example.com", "cavelon variables set greeting --stdin < greeting.txt"],
  async run(ctx, input) {
    const name = positional(input, "name")!;
    const argument = positional(input, "value");
    const fromStdin = boolOption(input, "stdin");
    if (argument !== undefined && fromStdin) throw usageError("Pass the value as an argument or with --stdin, not both.");
    if (argument === undefined && !fromStdin) throw usageError("Missing <value>.", "Usage: cavelon variables set <name> <value>  (or --stdin)");
    const value = argument ?? withoutLineEnd(await readAll(ctx.io.stdin));
    if (TOKEN_PREFIXES.some((prefix) => value.startsWith(prefix))) {
      throw usageError(
        "That value looks like a key or token. A variable is plain text anyone with settings access reads; nothing was sent.",
        `Keep credentials in a secret, which a person sets: ${secretSetCommand(name)}. If this was a real token, revoke it.`,
      );
    }
    await checkName(ctx, "PUT", "/api/v1/variables/{name}", "setting tenant variables", name);
    const previous = await readVariable(ctx, name);
    const saved = await callStable<Variable>(ctx, "PUT", "/api/v1/variables/{name}", "setting tenant variables", {
      params: { name: [name] },
      body: { value },
    });
    const changed = previous?.value !== saved.value;
    let text = `Variable ${saved.name} already had this value.`;
    if (!previous) text = `Created variable ${saved.name}.`;
    else if (changed) text = `Replaced variable ${saved.name} (it was ${JSON.stringify(clip(previous.value, LIST_VALUE_CHARS))}).`;
    return { data: { name: saved.name, value: saved.value, created: !previous, changed, previous: previous ? previous.value : null }, text };
  },
};

export const variablesDelete: CommandSpec = {
  name: "variables delete",
  summary: "Delete a tenant variable (needs --confirm).",
  description: "Without --confirm, shows the variable and deletes nothing. A prompt or tool that names it gets no value afterwards.",
  readOnly: false,
  destructive: true,
  idempotent: true,
  mcpTool: false,
  positionals: [{ name: "name", description: "The variable's name.", required: true }],
  options: { confirm: CONFIRM_OPTION, env: ENV_OPTION },
  examples: ["cavelon variables delete old_url", "cavelon variables delete old_url --confirm"],
  async run(ctx, input) {
    const name = positional(input, "name")!;
    const flags = targetFlags(await ctx.session());
    const current = await readVariable(ctx, name);
    if (!current) return { data: { name, deleted: false, existed: false }, text: `This tenant has no variable "${name}"; nothing to delete.` };
    const gate = await confirmation(ctx, input, "variables_delete", { name, value: current.value });
    if (!gate.confirmed) {
      const confirm = gate.confirm(`cavelon variables delete ${shellWord(name)}${flags} --confirm`);
      return {
        data: { name, deleted: false, existed: true, value: current.value, confirm, ...gate.fields },
        text: `Variable ${name} = ${JSON.stringify(clip(current.value, LIST_VALUE_CHARS))}.\n${gate.mismatch ? `${gate.mismatch}\n` : ""}Nothing was deleted. Delete it with: ${confirm}`,
        ...(gate.exitCode ? { exitCode: gate.exitCode } : {}),
      };
    }
    try {
      await callStable(ctx, "DELETE", "/api/v1/variables/{name}", "deleting tenant variables", { params: { name: [name] } });
    } catch (error) {
      if (!notFound(error)) throw error;
      return { data: { name, deleted: false, existed: false }, text: `This tenant has no variable "${name}"; nothing to delete.` };
    }
    return { data: { name, deleted: true, existed: true, value: current.value }, text: `Deleted variable ${name}.` };
  },
};

// ---------------------------------------------------------------------------
// secrets
// ---------------------------------------------------------------------------

/**
 * Setting or deleting a secret needs a person (a session or a personal access
 * token); the instance answers a tenant API key 403 `secret_needs_a_person`.
 * Refused here first, before a value is asked for or anything is sent.
 */
async function requirePerson(ctx: Context, verb: "set" | "delete", name: string): Promise<void> {
  const session = await ctx.session();
  requireToken(session);
  let apiKey = session.tokenKind === "api_key";
  if (!apiKey && session.tokenKind !== "personal_access_token") apiKey = (await readPrincipal(await ctx.client()))?.kind === "api_key";
  if (!apiKey) return;
  const fromEnv = session.tokenSource === "CAVELON_TOKEN" ? "CAVELON_TOKEN holds a tenant API key. " : "";
  throw new CavelonError(ExitCode.unauthorized, {
    code: "secret_needs_a_person",
    message: `A tenant API key cannot ${verb} a secret, so nothing was sent: ${verb === "set" ? "setting" : "deleting"} a secret needs a person (a dashboard session or a personal access token).`,
    hint: `${fromEnv}A person logs in with a personal access token (\`cavelon login\`) and runs \`cavelon secrets ${verb} ${shellWord(name)}\`, or does it in the Admin.`,
    details: { sent: false, credential: "api_key" },
  });
}

function withoutLineEnd(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

/** Options of `secrets set` that take a value; whatever else is not an option is a positional argument. */
const OPTIONS_WITH_VALUE = new Set(["--instance", "--tenant", "--env"]);

/**
 * Refuse a value given as an argument before the parser would repeat it in
 * its "Unexpected argument" error: it stays out of the output, though it is
 * in the shell history already.
 */
function refuseValueArgument(args: string[]): string[] {
  let positionals = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      positionals += args.length - i - 1;
      break;
    }
    if (OPTIONS_WITH_VALUE.has(arg)) i++;
    else if (!arg.startsWith("-")) positionals++;
  }
  if (positionals > 1) {
    throw usageError(
      "cavelon secrets set never takes the value as an argument: it would stay in the shell history. Nothing was sent.",
      "Run `cavelon secrets set <name>` and type the value when asked, or pipe it in. If that was a real secret, rotate it.",
    );
  }
  return args;
}

/** The value from the terminal without echo, or from standard input when it is piped; never from an argument. */
async function readSecretValue(ctx: Context, name: string): Promise<string> {
  const { io } = ctx;
  const usage = `A person runs \`${secretSetCommand(name)}\` in a terminal and types it, or pipes it in: \`op read … | ${secretSetCommand(name)}\`.`;
  let value: string;
  if (io.stdin.isTTY) {
    if (!io.stderr.isTTY) throw usageError(`No terminal to ask for the value of ${name} on; nothing was sent.`, usage);
    value = await readHidden(io, `Value of secret ${name} (input hidden): `, `Nothing was set; secret ${name} is unchanged.`);
  } else {
    value = withoutLineEnd(await readAll(io.stdin));
  }
  if (!value) throw usageError(`No value for secret ${name} on standard input; nothing was sent.`, usage);
  return value;
}

/** The error with every occurrence of the value replaced, should an answer ever repeat it. */
function withoutValue(error: unknown, value: string): unknown {
  const scrub = (item: unknown): unknown => {
    if (typeof item === "string") return item.replaceAll(value, "[secret value]");
    if (Array.isArray(item)) return item.map(scrub);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, scrub(v)]));
    return item;
  };
  if (error instanceof CavelonError) {
    return new CavelonError(error.exitCode, {
      code: error.code,
      message: scrub(error.message) as string,
      hint: error.hint === undefined ? undefined : (scrub(error.hint) as string),
      docs: error.docs,
      status: error.status,
      details: scrub(error.details),
    });
  }
  return new Error(scrub(error instanceof Error ? error.message : String(error)) as string);
}

/** " (changed <when>)", or nothing when the instance does not know. */
function changedNote(changedAt: string | null): string {
  return changedAt ? " (changed " + changedAt + ")" : "";
}

function secretView(status: SecretStatus) {
  return {
    name: status.name,
    status: status.status,
    changed_at: status.changed_at ?? null,
    declared: Boolean(status.declared),
    description: status.description ?? null,
  };
}

export const secretsList: CommandSpec = {
  name: "secrets list",
  summary: "List the tenant's secret names ({{secret:…}}) with whether each is set; never a value.",
  description:
    "Lists every secret that has a value or that an imported package declared. A person sets a missing one with\n" +
    "`cavelon secrets set <name>`; an agent never sets or reads a secret value.",
  readOnly: true,
  idempotent: true,
  mcpTool: "secrets_list",
  options: {
    missing: { type: "boolean", description: "Only the secrets that are not set." },
    limit: LIMIT_OPTION,
    cursor: CURSOR_OPTION,
    env: ENV_OPTION,
  },
  examples: ["cavelon secrets list", "cavelon secrets list --missing --json"],
  async run(ctx, input) {
    const limit = intOption(input, "limit", { min: 1, max: 500, fallback: 50 })!;
    const flags = targetFlags(await ctx.session());
    const all = ((await callStable<{ items: SecretStatus[] }>(ctx, "GET", "/api/v1/secrets", "tenant secrets")).items ?? []).map(secretView);
    const wanted = boolOption(input, "missing") ? all.filter((s) => s.status !== "set") : all;
    const page = pageOf(wanted, limit, stringOption(input, "cursor"));
    const items = page.items.map((s) => (s.status === "set" ? s : { ...s, set_by_person: secretSetCommand(s.name, flags) }));
    const missing = all.filter((s) => s.status !== "set").length;
    const onlyMissing = boolOption(input, "missing");
    let text = onlyMissing ? "Every secret this tenant knows is set." : "This tenant has no secrets and no package declared one.";
    if (items.length) {
      const rows = items.map((s) => ({ ...s, declared: s.declared ? "yes" : "", changed_at: s.changed_at ?? "", description: s.description ?? "" }));
      const next = moreHint(page.next_cursor, `cavelon secrets list${onlyMissing ? " --missing" : ""}${flags}`);
      const howTo = missing ? `\n\n${missing} not set. A person sets each with: cavelon secrets set <name>${flags}` : "";
      text = table(rows, ["name", "status", "declared", "changed_at", "description"], 50) + next + howTo;
    }
    return { data: { items, next_cursor: page.next_cursor, total: page.total, not_set: missing }, text };
  },
};

export const secretsSet: CommandSpec = {
  name: "secrets set",
  summary: "Set a secret's value (a person runs this, never the agent).",
  description:
    "Asks for the value without echoing it, or reads it from standard input when that is piped (one trailing line break is\n" +
    "dropped). The value is never an argument, never printed and never read back. A tenant API key cannot set a secret.",
  readOnly: false,
  idempotent: true,
  mcpTool: false,
  positionals: [{ name: "name", description: "The secret's name, as {{secret:<name>}} uses it.", required: true }],
  options: { env: ENV_OPTION },
  examples: ["cavelon secrets set crm_api_token", "op read op://dev/crm/token | cavelon secrets set crm_api_token"],
  preprocess: refuseValueArgument,
  async run(ctx, input) {
    const name = positional(input, "name")!;
    await requirePerson(ctx, "set", name);
    await checkName(ctx, "PUT", "/api/v1/secrets/{name}", "setting secrets", name);
    const value = await readSecretValue(ctx, name);
    let status: SecretStatus;
    try {
      status = await callStable<SecretStatus>(ctx, "PUT", "/api/v1/secrets/{name}", "setting secrets", { params: { name: [name] }, body: { value } });
    } catch (error) {
      throw withoutValue(error, value);
    }
    const data = secretView(status);
    return { data, text: `Secret ${data.name} is set${changedNote(data.changed_at)}. Its value is never shown.` };
  },
};

export const secretsDelete: CommandSpec = {
  name: "secrets delete",
  summary: "Delete a secret's value (needs --confirm; a person runs this).",
  description:
    "Without --confirm, shows the secret's status and deletes nothing. A tool or prompt that names it fails until a person\n" +
    "sets it again. A tenant API key cannot delete a secret.",
  readOnly: false,
  destructive: true,
  idempotent: true,
  mcpTool: false,
  positionals: [{ name: "name", description: "The secret's name.", required: true }],
  options: { confirm: CONFIRM_OPTION, env: ENV_OPTION },
  examples: ["cavelon secrets delete old_token", "cavelon secrets delete old_token --confirm"],
  async run(ctx, input) {
    const name = positional(input, "name")!;
    await requirePerson(ctx, "delete", name);
    const flags = targetFlags(await ctx.session());
    const current = secretView(
      await callStable<SecretStatus>(ctx, "GET", "/api/v1/secrets/{name}", "tenant secrets", { params: { name: [name] } }),
    );
    const nothing = { data: { ...current, deleted: false }, text: `Secret ${name} has no value; nothing to delete.` };
    if (current.status !== "set") return nothing;
    const gate = await confirmation(ctx, input, "secrets_delete", { name, changed_at: current.changed_at ?? null });
    if (!gate.confirmed) {
      const confirm = gate.confirm(`cavelon secrets delete ${shellWord(name)}${flags} --confirm`);
      return {
        data: { ...current, deleted: false, confirm, ...gate.fields },
        text: `Secret ${name} is set${changedNote(current.changed_at)}.\n${gate.mismatch ? `${gate.mismatch}\n` : ""}Nothing was deleted. Delete it with: ${confirm}`,
        ...(gate.exitCode ? { exitCode: gate.exitCode } : {}),
      };
    }
    try {
      await callStable(ctx, "DELETE", "/api/v1/secrets/{name}", "deleting secrets", { params: { name: [name] } });
    } catch (error) {
      if (notFound(error)) return nothing;
      throw error;
    }
    return {
      data: { ...current, status: "not_set", deleted: true },
      text: `Deleted the value of secret ${name}. A person sets it again with: ${secretSetCommand(name, flags)}`,
    };
  },
};
