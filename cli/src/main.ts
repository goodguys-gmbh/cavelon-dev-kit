import { parseArgs, type ParseArgsConfig } from "node:util";
import { GLOBAL_OPTIONS, type CommandResult, type CommandSpec, type Context, type Input, type OptionSpec } from "./command.js";
import { createContext } from "./context.js";
import { asCavelonError, CavelonError, ExitCode, usageError } from "./errors.js";
import { blockerLines } from "./format.js";
import type { Io } from "./io.js";
import { KIT_VERSION } from "./version.js";
import { COMMANDS } from "./commands/index.js";

/**
 * Parse, run one command, print its result, return the exit code. Nothing
 * here prompts; `login` alone reads a hidden token, and only from a terminal.
 */

export async function run(argv: string[], io: Io, commands: CommandSpec[] = COMMANDS): Promise<number> {
  const json = argv.includes("--json");
  let ctx: Context | undefined;
  try {
    if (argv.length === 0) {
      io.stderr.write(rootHelp(commands));
      return ExitCode.usage;
    }
    if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") {
      io.stdout.write(json ? `${JSON.stringify({ version: KIT_VERSION })}\n` : `${KIT_VERSION}\n`);
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
    const args = spec.preprocess ? spec.preprocess(rest) : rest;
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
    const result = await spec.run(ctx, parsed);
    printResult(ctx, result);
    return result.exitCode ?? ExitCode.ok;
  } catch (error) {
    const err = asCavelonError(error);
    printError(io, ctx?.json ?? json, err, ctx?.warnings ?? []);
    return err.exitCode;
  }
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
  const config: ParseArgsConfig = {
    args,
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
    throw usageError(error instanceof Error ? error.message : String(error), `Run \`cavelon ${spec.name} --help\`.`);
  }
  if (values.help === true) return { positionals: {}, options: { help: true } };
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

function missing(spec: CommandSpec, name: string): CavelonError {
  return usageError(`Missing <${name}>.`, `Usage: ${usageLine(spec)}`);
}

function printResult(ctx: Context, result: CommandResult): void {
  const { io } = ctx;
  for (const warning of ctx.warnings) io.stderr.write(`${ctx.style.yellow("warning:")} ${warning}\n`);
  if (ctx.json) {
    let data = result.data;
    if (ctx.warnings.length && data && typeof data === "object" && !Array.isArray(data)) {
      data = { ...(data as Record<string, unknown>), warnings: ctx.warnings };
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
  if (err.blockers?.length) lines.push(blockerLines(err.blockers));
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
  const rows = Object.entries(options).map(([name, o]) => {
    const flag = `${o.short ? `-${o.short}, ` : ""}--${name}${o.type === "string" ? ` ${o.value ?? "<value>"}` : ""}`;
    return [flag, o.description + (o.multiple ? " Repeatable." : "")] as const;
  });
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
