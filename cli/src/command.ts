import type { ExitCodeValue } from "./errors.js";
import { usageError } from "./errors.js";
import type { Io, Style } from "./io.js";
import type { ApiClient } from "./http.js";
import type { Contracts } from "./contracts.js";
import type { GlobalOptions, Session } from "./session.js";

/**
 * A command is data plus one function. The same spec drives the CLI parser,
 * the help text, the `commands` listing and the MCP tool, so a command cannot
 * be marked read-only in one place and changing in another.
 */

export interface OptionSpec {
  type: "string" | "boolean";
  description: string;
  short?: string;
  multiple?: boolean;
  /** Placeholder in help, e.g. "<seconds>". */
  value?: string;
  /** Hidden from the MCP tool (for example --wait, which would block). */
  cliOnly?: boolean;
  /** What the MCP tool says of it, where the tool does something else than the command (init's harness). */
  mcpDescription?: string;
  /**
   * A confirm option: a string in the MCP tool, the `confirm_token` the
   * tool's preview returned. A boolean one is a flag in a terminal that also
   * takes that token after it (`--confirm <token>`), which a coding agent's
   * shell needs; `api`'s is a string that may be empty.
   */
  mcpToken?: boolean;
  /**
   * The option's name in an earlier release, still taken with a warning (as
   * `--<formerly>` and as the tool argument in snake_case), so a script or
   * an agent's habit written against that release keeps working.
   */
  formerly?: string;
}

/** The warning for an option or argument given by its former name. */
export function formerlyWarning(given: string, now: string): string {
  return `${given} is now ${now}; ${given} is still taken for now and will be refused in a later release.`;
}

/**
 * The arguments with each option's former name (`--<formerly>`, also
 * `--<formerly>=<value>`) spelled as it is now, warning once per name.
 */
export function renameFormerOptions(spec: CommandSpec, args: string[], warn: (message: string) => void): string[] {
  const former = new Map(
    Object.entries(spec.options ?? {})
      .filter(([, o]) => o.formerly)
      .map(([name, o]) => [o.formerly!, name]),
  );
  if (!former.size) return args;
  const warned = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      out.push(...args.slice(i));
      break;
    }
    const flag = arg.startsWith("--") ? arg.slice(2).split("=")[0]! : undefined;
    const now = flag !== undefined ? former.get(flag) : undefined;
    if (!now) {
      out.push(arg);
      continue;
    }
    if (!warned.has(flag!)) warn(formerlyWarning(`--${flag}`, `--${now}`));
    warned.add(flag!);
    out.push(`--${now}${arg.slice(2 + flag!.length)}`);
  }
  return out;
}

export interface PositionalSpec {
  name: string;
  description: string;
  required?: boolean;
  variadic?: boolean;
}

export interface Input {
  positionals: Record<string, string | string[] | undefined>;
  options: Record<string, string | boolean | string[] | undefined>;
}

export interface CommandResult {
  data: unknown;
  /** Text for a person; the JSON is printed when absent. */
  text?: string;
  exitCode?: ExitCodeValue;
}

export interface Context {
  io: Io;
  json: boolean;
  style: Style;
  globals: GlobalOptions;
  /** "mcp" when the command runs as an MCP tool: never block, never prompt. */
  mode: "cli" | "mcp";
  warn(message: string): void;
  readonly warnings: string[];
  session(): Promise<Session>;
  /** A client with the credential and the tenant; fails when not logged in. */
  client(options?: { tenant?: boolean }): Promise<ApiClient>;
  /** A client that sends the credential when there is one, for public routes. */
  optionalClient(): Promise<ApiClient>;
  contracts(): Promise<Contracts>;
  /**
   * Over MCP, where the client can ask the person (elicitation): shows them
   * a change and returns their answer, which the agent cannot give. Unset in
   * a terminal and for a client that cannot ask.
   */
  askPerson?: (message: string) => Promise<PersonAnswer>;
}

/** A person's answer to a change the client showed them; `unanswered` when no answer came in time or the client failed. */
export type PersonAnswer = "approved" | "declined" | "unanswered";

export interface CommandSpec {
  /** Words, e.g. "tenant create". */
  name: string;
  summary: string;
  description?: string;
  /** Changes nothing on the instance or the machine. */
  readOnly: boolean;
  /** May delete or overwrite something; for the MCP destructive annotation. */
  destructive?: boolean;
  /**
   * What the MCP tool's description says the command changes, where the
   * marking alone would mislead: a command that writes only local files is
   * not one that "changes the instance".
   */
  mcpEffect?: string;
  /** Repeating the call with the same arguments has no further effect. */
  idempotent?: boolean;
  positionals?: PositionalSpec[];
  options?: Record<string, OptionSpec>;
  /** The MCP tool name, or false for commands only a person runs (login, logout). */
  mcpTool: string | false;
  /**
   * The instance operations (`METHOD /path` as the OpenAPI names them) the
   * command exists to send: where the credential may not send one of them,
   * the MCP tool's description says so (access.ts).
   */
  operations?: readonly string[];
  /**
   * For a command without a tool: the command whose tool does its job over
   * MCP (`wait` for `watch`), so a line the kit prints for it there names that
   * tool. It must take the same arguments.
   */
  mcpInstead?: string;
  /** Acts in no tenant (docs, explain, login): a command line the kit prints for it carries no `--tenant`. */
  tenantless?: boolean;
  /** Stores the instance and tenant it is given (login), so the commands it prints act there without them. */
  storesTarget?: boolean;
  examples?: string[];
  /** Rewrite raw arguments before parsing (`api --json <body>`); `warn` reaches the command's warnings. */
  preprocess?(args: string[], warn: (message: string) => void): string[];
  run(ctx: Context, input: Input): Promise<CommandResult>;
}

/**
 * A tool's property for a command's option or positional: the CLI's name in
 * snake_case (`make_default` for `--make-default`), as the instructions and
 * docs spell it and as tool arguments are usually written.
 */
export function propertyName(name: string): string {
  return name.replaceAll("-", "_");
}

/** A command with its own `tenant` argument (use_tenant) takes no tenant override. */
export function ownsTenant(spec: CommandSpec): boolean {
  return Boolean(spec.positionals?.some((p) => p.name === "tenant") || spec.options?.tenant);
}

export const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  json: { type: "boolean", description: "Print one JSON document instead of text." },
  instance: { type: "string", value: "<url>", description: "The instance URL (overrides CAVELON_URL and cavelon.yaml)." },
  tenant: { type: "string", value: "<tenant>", description: "Tenant slug, name or id (overrides CAVELON_TENANT and cavelon.yaml)." },
  help: { type: "boolean", short: "h", description: "Show help for the command." },
};

/**
 * An option as help and the command reference show it. A confirm flag that
 * also takes its preview's token shows both forms, since a coding agent's
 * shell refuses the bare flag.
 */
export function optionFlag(name: string, o: OptionSpec): string {
  const value = o.type === "string" ? ` ${o.value ?? "<value>"}` : o.mcpToken ? " [<token>]" : "";
  return `${o.short ? `-${o.short}, ` : ""}--${name}${value}`;
}

export function optionDescription(name: string, o: OptionSpec): string {
  const token =
    o.type === "boolean" && o.mcpToken
      ? ` In a person's terminal the flag alone confirms; run by a coding agent, \`--${name} <token>\` with the token its preview printed (the bare flag only shows the preview there, exit 5).`
      : "";
  const former = o.formerly ? ` Formerly \`--${o.formerly}\`, still taken with a warning.` : "";
  return o.description + token + (o.multiple ? " Repeatable." : "") + former;
}

export function stringOption(input: Input, name: string): string | undefined {
  const value = input.options[name];
  if (Array.isArray(value)) return value[value.length - 1];
  return typeof value === "string" ? value : undefined;
}

export function listOption(input: Input, name: string): string[] {
  const value = input.options[name];
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? [value] : [];
}

export function boolOption(input: Input, name: string): boolean {
  return input.options[name] === true;
}

export function positional(input: Input, name: string): string | undefined {
  const value = input.positionals[name];
  return Array.isArray(value) ? value[0] : value;
}

export function intOption(
  input: Input,
  name: string,
  bounds: { min?: number; max?: number; fallback?: number } = {},
): number | undefined {
  const raw = stringOption(input, name);
  if (raw === undefined) return bounds.fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw usageError(`--${name} must be a whole number, got "${raw}".`);
  if (bounds.min !== undefined && value < bounds.min) throw usageError(`--${name} must be at least ${bounds.min}.`);
  if (bounds.max !== undefined && value > bounds.max) throw usageError(`--${name} must be at most ${bounds.max}.`);
  return value;
}

/** "90s", "5m", "1h", "500ms" or plain seconds, as milliseconds. */
export function parseDuration(raw: string, name = "timeout"): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(raw.trim());
  if (!match) throw usageError(`--${name} must be a duration such as 90s, 5m or 1h, got "${raw}".`);
  const value = Number(match[1]);
  const unit = match[2] ?? "s";
  const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(value * factor);
}

export const LIMIT_OPTION: OptionSpec = { type: "string", value: "<n>", description: "Return at most n items." };
export const CURSOR_OPTION: OptionSpec = {
  type: "string",
  value: "<cursor>",
  description: "Continue after the previous page (its next_cursor).",
};

/** One page of a list the server returns whole; the cursor is an offset. */
export function pageOf<T>(items: T[], limit: number, cursor: string | undefined): { items: T[]; next_cursor: string | null; total: number } {
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isInteger(offset) || offset < 0) throw usageError(`--cursor "${cursor}" is not a cursor from a previous page.`);
  const slice = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? String(offset + limit) : null;
  return { items: slice, next_cursor: next, total: items.length };
}
