import { AsyncLocalStorage } from "node:async_hooks";
import { ownsTenant, propertyName, type CommandSpec, type OptionSpec } from "./command.js";
import { CavelonError } from "./errors.js";
import { shellWord } from "./shell.js";

/**
 * Commands the kit prints for a person or an agent to run next: in hints, in
 * `next`, `resume` and `confirm` fields, and in text. They are all built here,
 * so each one acts where the command that printed it did (it carries the
 * `--instance`, `--env` and `--tenant` that command was given; run outside a
 * solution folder, a line without `--tenant` acts in the tenant `cavelon use`
 * stored, which may be another one), and over MCP each one is the tool call
 * with its snake_case arguments, which is what an agent there can make.
 */

/** A value the reader fills in: `<path>` in a terminal, `"<path>"` in a tool call. */
export interface Placeholder {
  placeholder: string;
}

export type Word = string | Placeholder;

export function fill(name: string): Placeholder {
  return { placeholder: name };
}

/** Where the running command acts and how its printed commands are written; set once per command run. */
export interface PrintTarget {
  mode: "cli" | "mcp";
  commands: readonly CommandSpec[];
  /** A coding agent runs this cavelon in its shell, where a bare `--confirm` confirms nothing. */
  agentShell?: boolean;
  /** The options the running command was given (never one read from a file or the environment). */
  instance?: string;
  tenant?: string;
  env?: string;
}

const current = new AsyncLocalStorage<PrintTarget>();

/** Run a command with the target its printed commands carry. */
export function printingFor<T>(target: PrintTarget, run: () => T): T {
  return current.run(target, run);
}

export function printMode(): "cli" | "mcp" {
  return current.getStore()?.mode ?? "cli";
}

/** `cavelon` and its words, where the running command acted; over MCP, the tool call. */
export function cavelonCommand(...words: Word[]): string {
  return printedCommand(words);
}

/**
 * A command for the solution folder whose cavelon.yaml names the instance and
 * the tenant (init's next steps): it carries none of the running command's,
 * which would only repeat them, or override an env file's tenant.
 */
export function folderCommand(...words: Word[]): string {
  const target = current.getStore();
  return target ? current.run({ mode: target.mode, commands: target.commands, agentShell: target.agentShell }, () => printedCommand(words)) : printedCommand(words);
}

/**
 * `cavelonCommand` with the env the line acts in given rather than taken from
 * the running command: a stored preview's env (null: none).
 */
export function printedCommand(words: readonly Word[], override: { env?: string | null } = {}): string {
  const target = current.getStore();
  const spec = target ? commandOf(target.commands, words) : undefined;
  if (target && spec) {
    const env = override.env !== undefined ? override.env ?? undefined : target.env;
    if (target.mode === "mcp") {
      const call = toolCall(target, spec, words.slice(spec.name.split(" ").length), env);
      if (call) return call;
    }
    const line = withTarget(spec, words, { ...target, env });
    return commandLine(target.agentShell ? withTokenPlaceholder(line) : line);
  }
  return commandLine(words);
}

/**
 * A command the person runs in their own terminal, where a plain `--confirm`
 * confirms: a command line even over MCP, with the running command's
 * `--instance`, `--env` and `--tenant`, never a token. For a change a coding
 * agent may not confirm (confirm-token.ts, `PersonChange`).
 */
export function personCommand(...words: Word[]): string {
  const target = current.getStore();
  const spec = target ? commandOf(target.commands, words) : undefined;
  return commandLine(target && spec ? withTarget(spec, words, target) : words);
}

/**
 * In a coding agent's shell a bare `--confirm` only shows the preview again
 * (confirm-token.ts), so a confirm line printed before its preview exists
 * names the token it will need.
 */
function withTokenPlaceholder(words: readonly Word[]): Word[] {
  const at = words.indexOf("--confirm");
  if (at < 0) return [...words];
  const next = words[at + 1];
  if (next !== undefined && (typeof next !== "string" || !next.startsWith("-"))) return [...words];
  return [...words.slice(0, at + 1), fill(PREVIEW_TOKEN_NAME), ...words.slice(at + 1)];
}

function commandLine(words: readonly Word[]): string {
  return ["cavelon", ...words.map((w) => (typeof w === "string" ? shellWord(w) : `<${w.placeholder}>`))].join(" ");
}

/** The command a printed line runs: its longest leading words that name one. */
function commandOf(commands: readonly CommandSpec[], words: readonly Word[]): CommandSpec | undefined {
  const lead: string[] = [];
  for (const word of words.slice(0, 3)) {
    if (typeof word !== "string" || word.startsWith("-")) break;
    lead.push(word);
  }
  for (let n = lead.length; n > 0; n--) {
    const spec = commands.find((c) => c.name === lead.slice(0, n).join(" "));
    if (spec) return spec;
  }
  return undefined;
}

const has = (words: readonly Word[], flag: string) => words.some((w) => w === flag || (typeof w === "string" && w.startsWith(`${flag}=`)));

/**
 * The words with the target's options the line does not name itself, as
 * `--instance`, `--env`, `--tenant`, before its `--confirm`: an option beats
 * the env file, so after `--env prod --tenant beta` the line keeps both.
 */
function withTarget(spec: CommandSpec, words: readonly Word[], target: Omit<PrintTarget, "mode" | "commands">): Word[] {
  const added: string[] = [];
  if (target.instance && !has(words, "--instance")) added.push("--instance", target.instance);
  if (target.env && spec.options?.env && !has(words, "--env")) added.push("--env", target.env);
  if (target.tenant && takesTenant(spec) && !has(words, "--tenant")) added.push("--tenant", target.tenant);
  const at = words.indexOf("--confirm");
  return at < 0 ? [...words, ...added] : [...words.slice(0, at), ...added, ...words.slice(at)];
}

function takesTenant(spec: CommandSpec): boolean {
  return !spec.tenantless && !ownsTenant(spec);
}

/** What a confirm holds in a printed line before its preview gave the token. */
const PREVIEW_TOKEN_NAME = "confirm_token of its preview";
export const PREVIEW_TOKEN = `<${PREVIEW_TOKEN_NAME}>`;

/**
 * The tool call a printed command stands for: the tool's name and its
 * arguments as JSON. A command without a tool names the one an agent uses
 * instead (`mcpInstead`); a command a person runs in a terminal (secrets set,
 * login) stays a command line. Undefined when a word does not map to an
 * argument, so the line is printed as it is rather than as a wrong call.
 */
function toolCall(target: PrintTarget, spec: CommandSpec, args: readonly Word[], env: string | undefined): string | undefined {
  const tool = spec.mcpTool ? spec : spec.mcpInstead ? target.commands.find((c) => c.name === spec.mcpInstead) : undefined;
  if (!tool?.mcpTool) return undefined;
  const out: Record<string, unknown> = {};
  const positionals = [...(tool.positionals ?? [])];
  const value = (w: Word | undefined) => (w === undefined ? undefined : typeof w === "string" ? w : `<${w.placeholder}>`);
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (typeof word === "string" && word.startsWith("--")) {
      const eq = word.indexOf("=");
      const name = eq < 0 ? word.slice(2) : word.slice(2, eq);
      const inline = eq < 0 ? undefined : word.slice(eq + 1);
      const take = () => inline ?? value(args[++i]);
      if (name === "json") continue;
      if (name === "instance") {
        take();
        continue;
      }
      if (name === "tenant" && takesTenant(tool)) {
        out.tenant = take();
        continue;
      }
      // An option of the command that its stand-in lacks (`loop watch --timeout`) is the terminal's alone.
      const own = tool === spec ? undefined : spec.options?.[name];
      const option: OptionSpec | undefined = tool.options?.[name] ?? (own ? { ...own, cliOnly: true } : undefined);
      if (!option) return undefined;
      if (option.type === "string") {
        const v = take();
        if (option.cliOnly) continue;
        if (option.multiple) out[propertyName(name)] = [...((out[propertyName(name)] as string[] | undefined) ?? []), v];
        else out[propertyName(name)] = v;
      } else if (option.mcpToken) {
        const next = args[i + 1];
        const token = inline ?? (next !== undefined && (typeof next !== "string" || !next.startsWith("-")) ? value(args[++i]) : undefined);
        out[propertyName(name)] = token ?? PREVIEW_TOKEN;
      } else if (!option.cliOnly) {
        out[propertyName(name)] = true;
      }
      continue;
    }
    const p = positionals[0];
    if (!p) return undefined;
    const key = propertyName(p.name);
    if (p.variadic) out[key] = [...((out[key] as string[] | undefined) ?? []), value(word)];
    else {
      out[key] = value(word);
      positionals.shift();
    }
  }
  if (target.tenant && takesTenant(tool) && out.tenant === undefined) out.tenant = target.tenant;
  if (env && tool.options?.env && out.env === undefined) out.env = env;
  return `${tool.mcpTool} ${JSON.stringify(out)}`;
}

/** A `cavelon …` in backticks inside a fixed text; a placeholder may hold spaces. */
const NAMED_COMMAND = /`cavelon ([^`]+)`/g;
const SPAN_WORD = /<[^>]*>|\S+/g;

/**
 * A fixed text (a catalog's hint, a test-case status's next step, a refusal's
 * hint) with each `cavelon …` it names in backticks printed the way the
 * running command prints its own commands: over MCP the tool call (only the
 * tool's name when it takes no argument), in a terminal the line with the
 * running command's `--instance`, `--env` and `--tenant`. A command a person
 * runs (login, secrets set) stays a command line. Outside a command run, and
 * where nothing changes, the text stays as written.
 */
export function spoken(text: string): string {
  if (!current.getStore() || !text.includes("`cavelon ")) return text;
  return text.replace(NAMED_COMMAND, (whole, line: string) => {
    const words: Word[] = (line.match(SPAN_WORD) ?? []).map((w) => (w.startsWith("<") && w.endsWith(">") ? fill(w.slice(1, -1)) : w));
    const printed = printedCommand(words);
    if (printed === commandLine(words)) return whole;
    return `\`${printed.endsWith(" {}") ? printed.slice(0, -" {}".length) : printed}\``;
  });
}

/** The fields of a tool's or command's answer that tell the reader what to do next. */
const HINT_FIELDS = new Set(["hint", "next", "fix", "cli_fix", "kit_hint", "warnings"]);

/**
 * An answer with `spoken` applied to each of its hint fields, at any depth:
 * the hints of validate's findings, explain's fix, a refusal's hint. Other
 * text (a docs page, a file, an assistant's answer) is the instance's or the
 * customer's and stays as it is.
 */
export function spokenHints<T>(value: T): T {
  if (!current.getStore()) return value;
  const walk = (v: unknown, hint: boolean): unknown => {
    if (typeof v === "string") return hint ? spoken(v) : v;
    if (Array.isArray(v)) return v.map((item) => walk(item, hint));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([key, item]) => [key, walk(item, HINT_FIELDS.has(key))]));
    return v;
  };
  return walk(value, false) as T;
}

/** A thrown error with its hint and the hints in its details spoken; the runners call it inside the command's run. */
export function spokenError(error: unknown): unknown {
  if (!(error instanceof CavelonError) || !current.getStore()) return error;
  const hint = error.hint === undefined ? undefined : spoken(error.hint);
  const details = spokenHints(error.details);
  const blockerDetails = spokenHints(error.blockerDetails);
  if (hint === error.hint && JSON.stringify(details) === JSON.stringify(error.details) && JSON.stringify(blockerDetails) === JSON.stringify(error.blockerDetails)) return error;
  const { exitCode, code, message, docs, status, blockers } = error;
  return new CavelonError(exitCode, { code, message, hint, docs, status, details, blockers, blockerDetails });
}
