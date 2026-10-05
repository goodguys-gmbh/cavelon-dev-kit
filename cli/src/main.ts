import { parseArgs, type ParseArgsConfig } from "node:util";
import { GLOBAL_OPTIONS, optionDescription, optionFlag, renameFormerOptions, type CommandResult, type CommandSpec, type Context, type Input, type OptionSpec } from "./command.js";
import { createContext, withWarnings } from "./context.js";
import { CONFIRM_TOKEN } from "./confirm-token.js";
import { asCavelonError, CavelonError, ExitCode, usageError } from "./errors.js";
import { blockerLines } from "./format.js";
import type { Io } from "./io.js";
import { blockerLines as detailedBlockerLines } from "./preview-report.js";
import { printingFor } from "./printed.js";
import { KIT_VERSION } from "./version.js";
import { currentInstall, installLabel, type Install } from "./install.js";
import { startUpdateCheck, type UpdateCheckOptions } from "./update-check.js";
import { COMMANDS } from "./commands/index.js";

/**
 * Parse, run one command, print its result, return the exit code. Nothing
 * here prompts; `login` alone reads a hidden token, and only from a terminal.
 */

export async function run(argv: string[], io: Io, commands: CommandSpec[] = COMMANDS, updates: UpdateCheckOptions = {}): Promise<number> {
  const json = argv.includes("--json");
  let ctx: Context | undefined;
  let notice: Promise<string | undefined> | undefined;
  try {
    if (argv.length === 0) {
      io.stderr.write(rootHelp(commands));
      return ExitCode.usage;
    }
    if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") {
      io.stdout.write(versionText(updates.install ?? currentInstall(io.env), json));
      return ExitCode.ok;
    }
    const found = findCommand(argv, commands);
    if (!found) {
      if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
        const topic = argv.filter((a) => !a.startsWith("-") && a !== "help");
        const group = commands.filter((c) => c.name.startsWith(`${topic.join(" ")} `) || c.name === topic.join(" "));
        io.stdout.write(topic.length && group.length ? groupHelp(topic.join(" "), group) : rootHelp(commands));
        return ExitCode.ok;
      }
      const words = argv.filter((a) => !a.startsWith("-"));
      const group = commands.filter((c) => c.name.startsWith(`${words[0]} `));
      throw usageError(
        `Unknown command "${words.slice(0, 2).join(" ") || argv[0]}".`,
        group.length ? `Try: ${group.map((c) => `cavelon ${c.name}`).join(", ")}` : "Run `cavelon --help` for the commands.",
      );
    }
    const { spec, rest } = found;
    const early: string[] = [];
    const renamed = renameFormerOptions(spec, rest, (message) => early.push(message));
    const args = spec.preprocess ? spec.preprocess(renamed, (message) => early.push(message)) : renamed;
    const parsed = parse(spec, args);
    if (parsed.options.help === true) {
      io.stdout.write(commandHelp(spec));
      return ExitCode.ok;
    }
    ctx = createContext(io, {
      json: parsed.options.json === true,
      instance: typeof parsed.options.instance === "string" ? parsed.options.instance : undefined,
      tenant: typeof parsed.options.tenant === "string" ? parsed.options.tenant : undefined,
      solutionEnv: spec.options?.env && typeof parsed.options.env === "string" ? parsed.options.env : undefined,
    });
    for (const message of early) ctx.warn(message);
    notice = startUpdateCheck({
      io,
      version: KIT_VERSION,
      install: updates.install ?? currentInstall(io.env),
      json: ctx.json,
      command: spec.name,
      fetch: updates.fetch,
    });
    const { globals } = ctx;
    const given = spec.storesTarget ? {} : { instance: globals.instance, tenant: globals.tenant, env: globals.solutionEnv };
    const target = { mode: "cli" as const, commands, ...given };
    const result = await printingFor(target, () => spec.run(ctx!, parsed));
    printResult(ctx, result);
    await printNotice(io, notice);
    return result.exitCode ?? ExitCode.ok;
  } catch (error) {
    const err = asCavelonError(error);
    printError(io, ctx?.json ?? json, err, ctx?.warnings ?? []);
    await printNotice(io, notice);
    return err.exitCode;
  }
}

/** The version on the first line, alone, for scripts that compare it; then how it was installed. */
function versionText(install: Install, json: boolean): string {
  if (json) {
    return `${JSON.stringify({ version: KIT_VERSION, install: { method: install.method, path: install.path, update: install.update ?? null } })}\n`;
  }
  const lines = [KIT_VERSION, `installed with: ${installLabel(install.method)} (${install.path})`];
  if (install.update) lines.push(`update with: ${install.update}`);
  else if (install.advice) lines.push(install.advice);
  return `${lines.join("\n")}\n`;
}

async function printNotice(io: Io, notice: Promise<string | undefined> | undefined): Promise<void> {
  const text = await notice;
  if (text) io.stderr.write(`\n${text}`);
}

function findCommand(argv: string[], commands: CommandSpec[]): { spec: CommandSpec; rest: string[] } | undefined {
  // Command words come first; global options may stand before them.
  const words: Array<{ word: string; index: number }> = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--instance" || arg === "--tenant") {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    words.push({ word: arg, index: i });
    if (words.length === 3) break;
  }
  for (let n = Math.min(words.length, 3); n > 0; n--) {
    const name = words.slice(0, n).map((w) => w.word).join(" ");
    const spec = commands.find((c) => c.name === name);
    if (spec) {
      const drop = new Set(words.slice(0, n).map((w) => w.index));
      return { spec, rest: argv.filter((_, i) => !drop.has(i)) };
    }
  }
  return undefined;
}

function parse(spec: CommandSpec, args: string[]): Input {
  for (const arg of args) {
    if (arg === "--token" || arg.startsWith("--token=")) {
      throw usageError(
        "cavelon never takes a token as an argument; it would end up in the shell history.",
        "Run `cavelon login` and paste it when asked, or pipe it: `cavelon login --token-stdin`.",
      );
    }
  }
  const options: Record<string, OptionSpec> = { ...GLOBAL_OPTIONS, ...spec.options };
  const { rest, tokens } = takeTokens(spec, args);
  const config: ParseArgsConfig = {
    args: rest,
    allowPositionals: true,
    strict: true,
    options: Object.fromEntries(
      Object.entries(options).map(([name, o]) => [
        name,
        { type: o.type, ...(o.multiple ? { multiple: true } : {}), ...(o.short ? { short: o.short } : {}) },
      ]),
    ),
  };
  let values: Record<string, string | boolean | Array<string | boolean> | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs(config) as unknown as {
      values: Record<string, string | boolean | Array<string | boolean> | undefined>;
      positionals: string[];
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // `api` takes an operation's parameters as name=value; `--harness_id x` is the likely slip.
    const unknown = /Unknown option '--([^'=\s]+)/.exec(message)?.[1];
    if (unknown && spec.positionals?.some((p) => p.variadic && p.name === "params")) {
      throw usageError(
        `Unknown option '--${unknown}'.`,
        `${spec.name} takes an operation's parameters as name=value: pass ${unknown}=<value> (or -p ${unknown}=<value>). Run \`cavelon ${spec.name} --help\`.`,
      );
    }
    throw usageError(message, `Run \`cavelon ${spec.name} --help\`.`);
  }
  if (values.help === true) return { positionals: {}, options: { help: true } };
  Object.assign(values, tokens);
  const named: Input["positionals"] = {};
  const specs = spec.positionals ?? [];
  let index = 0;
  for (const p of specs) {
    if (p.variadic) {
      named[p.name] = positionals.slice(index);
      if (p.required && positionals.length <= index) throw missing(spec, p.name);
      index = positionals.length;
      break;
    }
    const value = positionals[index++];
    if (value === undefined && p.required) throw missing(spec, p.name);
    named[p.name] = value;
  }
  if (positionals.length > index) {
    throw usageError(`Unexpected argument "${positionals[index]}".`, `Run \`cavelon ${spec.name} --help\`.`);
  }
  return { positionals: named, options: values as Input["options"] };
}

/**
 * A confirm flag (`mcpToken`) also takes the token its preview printed:
 * `--confirm <token>` or `--confirm=<token>`. The next argument is the token
 * only when it looks like one, so a positional after the flag keeps its
 * place; the flag alone stays a flag.
 */
function takeTokens(spec: CommandSpec, args: string[]): { rest: string[]; tokens: Record<string, string> } {
  const names = Object.entries(spec.options ?? {})
    .filter(([, o]) => o.mcpToken && o.type === "boolean")
    .map(([name]) => name);
  const tokens: Record<string, string> = {};
  if (!names.length) return { rest: args, tokens };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      rest.push(...args.slice(i));
      break;
    }
    const name = names.find((n) => arg === `--${n}` || arg.startsWith(`--${n}=`));
    if (!name) {
      rest.push(arg);
      continue;
    }
    const inline = arg.startsWith(`--${name}=`) ? arg.slice(name.length + 3) : undefined;
    const next = args[i + 1];
    if (inline) tokens[name] = inline;
    else if (inline === undefined && next !== undefined && CONFIRM_TOKEN.test(next)) {
      tokens[name] = next;
      i++;
    } else rest.push(`--${name}`);
  }
  return { rest, tokens };
}

function missing(spec: CommandSpec, name: string): CavelonError {
  return usageError(`Missing <${name}>.`, `Usage: ${usageLine(spec)}`);
}

function printResult(ctx: Context, result: CommandResult): void {
  const { io } = ctx;
  for (const warning of ctx.warnings) io.stderr.write(`${ctx.style.yellow("warning:")} ${warning}\n`);
  if (ctx.json) {
    let data = result.data;
    if (ctx.warnings.length && data && typeof data === "object" && !Array.isArray(data)) {
      data = withWarnings(data as Record<string, unknown>, ctx.warnings);
    }
    if (data !== undefined) io.stdout.write(`${JSON.stringify(data)}\n`);
    return;
  }
  const text = result.text ?? (result.data === undefined ? "" : JSON.stringify(result.data, null, 2));
  if (text) io.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function printError(io: Io, json: boolean, err: CavelonError, warnings: string[]): void {
  for (const warning of warnings) io.stderr.write(`warning: ${warning}\n`);
  if (json) {
    io.stdout.write(`${JSON.stringify({ error: err.toJSON() })}\n`);
    return;
  }
  const lines = [`error: ${err.message}`];
  if (err.blockerDetails?.length) {
    const more = err.blockerDetails.length - 10;
    lines.push(`blockers:${detailedBlockerLines(err.blockerDetails.slice(0, 10))}${more > 0 ? `\n  … ${more} more (--json)` : ""}`);
  }
  else if (err.blockers?.length) lines.push(blockerLines(err.blockers));
  if (err.hint) lines.push(`hint: ${err.hint}`);
  if (err.docs) lines.push(`docs: ${err.docs}`);
  io.stderr.write(`${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export function usageLine(spec: CommandSpec): string {
  const parts = [`cavelon ${spec.name}`];
  for (const p of spec.positionals ?? []) {
    const name = p.variadic ? `${p.name}...` : p.name;
    parts.push(p.required ? `<${name}>` : `[${name}]`);
  }
  if (Object.keys(spec.options ?? {}).length) parts.push("[options]");
  return parts.join(" ");
}

function optionLines(options: Record<string, OptionSpec>): string[] {
  const rows = Object.entries(options).map(([name, o]) => [optionFlag(name, o), optionDescription(name, o)] as const);
  const width = Math.max(...rows.map(([f]) => f.length));
  return rows.map(([f, d]) => `  ${f.padEnd(width)}  ${d}`);
}

export function commandHelp(spec: CommandSpec): string {
  const lines = [
    `Usage: ${usageLine(spec)}`,
    "",
    spec.summary,
    `Marked: ${spec.readOnly ? "read-only" : spec.destructive ? "changing (destructive)" : "changing"}`,
  ];
  if (spec.description) lines.push("", spec.description);
  if (spec.positionals?.length) {
    lines.push("", "Arguments:");
    const width = Math.max(...spec.positionals.map((p) => p.name.length));
    for (const p of spec.positionals) lines.push(`  ${p.name.padEnd(width)}  ${p.description}`);
  }
  if (spec.options && Object.keys(spec.options).length) lines.push("", "Options:", ...optionLines(spec.options));
  lines.push("", "Global options:", ...optionLines(GLOBAL_OPTIONS));
  if (spec.examples?.length) lines.push("", "Examples:", ...spec.examples.map((e) => `  ${e}`));
  return `${lines.join("\n")}\n`;
}

function groupHelp(group: string, commands: CommandSpec[]): string {
  const width = Math.max(...commands.map((c) => c.name.length));
  return `${[
    `cavelon ${group}`,
    "",
    ...commands.map((c) => `  ${c.name.padEnd(width)}  ${c.readOnly ? "[read-only]" : "[changing] "}  ${c.summary}`),
    "",
    `Run \`cavelon <command> --help\` for its options.`,
  ].join("\n")}\n`;
}

export function rootHelp(commands: CommandSpec[]): string {
  const width = Math.max(...commands.map((c) => c.name.length));
  return `${[
    `cavelon ${KIT_VERSION}: build, seed and test Cavelon solutions from a repository.`,
    "",
    "Usage: cavelon <command> [arguments] [options]",
    "",
    "Commands:",
    ...commands.map((c) => `  ${c.name.padEnd(width)}  ${c.readOnly ? "[read-only]" : "[changing] "}  ${c.summary}`),
    "",
    "Every command takes --json, --instance <url> and --tenant <tenant>.",
    "Environment: CAVELON_URL, CAVELON_TOKEN, CAVELON_TENANT.",
    "Exit codes: 0 ok, 1 other error, 2 usage, 3 validation failed, 4 conflict or stale preview,",
    "            5 needs a person, 6 timed out, 7 not authorised, 8 server or network error.",
  ].join("\n")}\n`;
}
