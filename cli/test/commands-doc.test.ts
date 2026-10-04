import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GLOBAL_OPTIONS, type CommandSpec, type OptionSpec } from "../src/command.js";
import { COMMANDS } from "../src/commands/index.js";
import { usageLine } from "../src/main.js";

/**
 * docs/commands.md is rendered from the same specs that drive `--help`, the
 * `commands` listing and the MCP tools, so the reference cannot drift from the
 * binary. `npm run docs:commands` rewrites it; this test fails while it is out
 * of date.
 */

const GROUPS: Array<{ title: string; intro: string; names: string[] }> = [
  {
    title: "Session",
    intro: "Set up your coding agents, log in, choose a tenant, and see where you are.",
    names: ["setup", "login", "logout", "whoami", "use", "status"],
  },
  {
    title: "Solution as code",
    intro: "Turn a folder into a solution, check it, preview it, import it and activate it.",
    names: ["init", "pull", "validate", "schema", "apply", "activate", "explain"],
  },
  {
    title: "Tenants and solutions",
    intro: "Create and list tenants and solutions (harnesses).",
    names: ["tenant create", "tenant list", "harness list", "harness new", "harness clone"],
  },
  {
    title: "Knowledge, tests and traces",
    intro: "Seed knowledge bases, run test suites, wait for the work and read what happened.",
    names: ["kb upload", "test run", "wait", "watch", "trace"],
  },
  {
    title: "Variables and secrets",
    intro: "Tenant values a package refers to as `{{var:…}}` and `{{secret:…}}`. A secret's value is set by a person, never by the agent.",
    names: ["variables list", "variables get", "variables set", "variables delete", "secrets list", "secrets set", "secrets delete"],
  },
  {
    title: "Limits and capacity",
    intro: "Read the instance's limits and change those you may change. See [Limits](limits.md).",
    names: ["limits", "limits set", "models list", "models set-limit"],
  },
  {
    title: "Loops and triggers",
    intro: "Start, follow and control long-running loops, and the identity a trigger's unattended runs act as.",
    names: ["loop start", "loop watch", "loop iterations", "loop pause", "loop resume", "loop cancel", "trigger identity"],
  },
  {
    title: "Sandboxes",
    intro: "Inspect and prepare the Sandboxes a solution runs code in.",
    names: [
      "sandbox list",
      "sandbox validate",
      "sandbox files",
      "sandbox cat",
      "sandbox activity",
      "sandbox logs",
      "sandbox receipt",
      "sandbox seed",
      "sandbox refresh",
      "artifacts export",
    ],
  },
  {
    title: "API and docs",
    intro: "Call any operation the instance publishes, and read the instance's documentation.",
    names: ["api list", "api describe", "api", "docs search", "docs get"],
  },
  {
    title: "For agents",
    intro: "The command list and the MCP server. See [MCP server](mcp.md).",
    names: ["commands", "mcp"],
  },
];

/** Markdown text outside code spans: `<`, `>` and `|` escaped, line breaks as spaces. */
function md(text: string): string {
  return text
    .split("`")
    .map((part, index) => (index % 2 ? part : part.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|")))
    .join("`")
    .split("\n")
    .join(" ");
}

function anchor(name: string): string {
  return `cavelon-${name.replace(/ /g, "-")}`;
}

function marked(spec: CommandSpec): string {
  return spec.readOnly ? "read-only" : spec.destructive ? "changing (destructive)" : "changing";
}

function optionRows(options: Record<string, OptionSpec>, withMcp: boolean): string[] {
  const rows = [withMcp ? "| Option | Description | MCP |" : "| Option | Description |", withMcp ? "|---|---|---|" : "|---|---|"];
  for (const [name, o] of Object.entries(options)) {
    const flag = `${o.short ? `-${o.short}, ` : ""}--${name}${o.type === "string" ? ` ${o.value ?? "<value>"}` : ""}`;
    const description = md(o.description + (o.multiple ? " Repeatable." : ""));
    rows.push(withMcp ? `| \`${flag}\` | ${description} | ${o.cliOnly ? "CLI only" : "yes"} |` : `| \`${flag}\` | ${description} |`);
  }
  return rows;
}

function section(spec: CommandSpec): string[] {
  const lines = [`### cavelon ${spec.name}`, "", md(spec.summary), ""];
  lines.push(`**${marked(spec)}** · MCP tool: ${spec.mcpTool ? `\`${spec.mcpTool}\`` : "none (run it in a terminal)"}`, "");
  lines.push("```text", usageLine(spec), "```", "");
  if (spec.description) {
    for (const paragraph of spec.description.split("\n\n")) lines.push(md(paragraph), "");
  }
  if (spec.positionals?.length) {
    lines.push("| Argument | Description |", "|---|---|");
    for (const p of spec.positionals) {
      lines.push(`| \`${p.name}\` | ${md(p.description)}${p.required ? " Required." : ""}${p.variadic ? " One or more." : ""} |`);
    }
    lines.push("");
  }
  const options = spec.options ?? {};
  if (Object.keys(options).length) lines.push(...optionRows(options, Boolean(spec.mcpTool)), "");
  if (spec.examples?.length) lines.push("Examples:", "", "```bash", ...spec.examples, "```", "");
  return lines;
}

export function renderCommandsDoc(commands: CommandSpec[]): string {
  const listed = new Set(GROUPS.flatMap((g) => g.names));
  const groups = [...GROUPS];
  const others = commands.filter((c) => !listed.has(c.name)).map((c) => c.name);
  if (others.length) groups.push({ title: "Other commands", intro: "", names: others });
  const byName = new Map(commands.map((c) => [c.name, c]));

  const lines = [
    "# Command reference",
    "",
    "<!-- Generated from the commands' own help by cli/test/commands-doc.test.ts. Do not edit by hand: run `npm run docs:commands` in cli/. -->",
    "",
    "Every command prints text for a person, or one JSON document with `--json`. Every command runs without a prompt",
    "(only `login` and `secrets set` read a value, from a terminal or stdin), and is marked **read-only** (changes",
    "nothing) or **changing**; a changing command that may delete or overwrite something is **destructive**. The same",
    "commands are tools of the [MCP server](mcp.md), named in each section. `cavelon <command> --help` prints the same",
    "help in the terminal.",
    "",
    "In a `--json` document, `warnings` is always a list, never a count, and carries the warnings printed on stderr:",
    "messages, or for `validate` objects with `code` and `message`.",
    "",
    "## Global options",
    "",
    "Every command takes these:",
    "",
    ...optionRows(GLOBAL_OPTIONS, false),
    "",
    "The instance, tenant and token can also come from the environment (`CAVELON_URL`, `CAVELON_TENANT`,",
    "`CAVELON_TOKEN`) or from the solution's `cavelon.yaml` and `env/<name>.yaml`; an option wins over the environment,",
    "the environment over the files. The exit codes are listed in [Troubleshooting](troubleshooting.md#exit-codes).",
    "",
    "## Contents",
    "",
  ];
  for (const group of groups) {
    const names = group.names.filter((n) => byName.has(n));
    lines.push(`- **${group.title}:** ${names.map((n) => `[\`${n}\`](#${anchor(n)})`).join(", ")}`);
  }
  lines.push("");
  for (const group of groups) {
    const specs = group.names.map((n) => byName.get(n)).filter((c): c is CommandSpec => Boolean(c));
    if (!specs.length) continue;
    lines.push(`## ${group.title}`, "");
    if (group.intro) lines.push(group.intro, "");
    for (const spec of specs) lines.push(...section(spec));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

describe("docs/commands.md", () => {
  it("lists every command, each once", () => {
    const names = COMMANDS.map((c) => c.name);
    const grouped = GROUPS.flatMap((g) => g.names);
    expect(grouped.filter((n) => !names.includes(n)), "grouped commands that do not exist").toEqual([]);
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("docs/mcp.md lists every MCP tool", () => {
    const mcp = readFileSync(path.resolve(__dirname, "../../docs/mcp.md"), "utf8");
    const missing = COMMANDS.filter((c) => c.mcpTool && !mcp.includes(`| \`${c.mcpTool}\` | \`cavelon ${c.name}\` |`)).map((c) => c.mcpTool);
    expect(missing).toEqual([]);
  });

  it("docs/mcp.md says which changing tools need confirm and which act at once", () => {
    const mcp = readFileSync(path.resolve(__dirname, "../../docs/mcp.md"), "utf8");
    const bullet = (title: string) => mcp.split(`- **${title}**`)[1]!.split("\n- **")[0]!;
    const changing = COMMANDS.filter((c) => c.mcpTool && !c.readOnly);
    const gated = changing.filter((c) => c.options?.confirm).map((c) => c.mcpTool as string);
    const atOnce = changing.filter((c) => !c.options?.confirm).map((c) => c.mcpTool as string);
    expect(gated.filter((t) => !bullet("What needs `confirm`.").includes(`\`${t}\``))).toEqual([]);
    expect(atOnce.filter((t) => !bullet("What changes without `confirm`.").includes(`\`${t}\``))).toEqual([]);
  });

  it("is the commands' own help (npm run docs:commands rewrites it)", async () => {
    await expect(renderCommandsDoc(COMMANDS)).toMatchFileSnapshot(path.resolve(__dirname, "../../docs/commands.md"));
  });
});
