import { AsyncLocalStorage } from "node:async_hooks";
import { ownsTenant, propertyName, type CommandSpec, type OptionSpec } from "./command.js";
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
  return target ? current.run({ mode: target.mode, commands: target.commands }, () => printedCommand(words)) : printedCommand(words);
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
    return commandLine(withTarget(spec, words, { ...target, env }));
  }
  return commandLine(words);
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

/** What a confirm argument holds in a printed call before its preview gave the token. */
const PREVIEW_TOKEN = "<confirm_token of its preview>";

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
