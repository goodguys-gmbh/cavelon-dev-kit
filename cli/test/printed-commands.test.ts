import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ownsTenant } from "../src/command.js";
import { COMMANDS } from "../src/commands/index.js";
import type { InStream } from "../src/io.js";
import { createMcpServer, propertyName } from "../src/mcp.js";
import { readFileSync } from "node:fs";
import { BY_CODE, BY_ROUTE, cliFix } from "../src/code-hints.js";
import { KIT_ERROR_CODES, kitErrorEntry } from "../src/kit-codes.js";
import { KIT_CODES } from "../src/package-check.js";
import { CASE_STATUSES } from "../src/results.js";
import { KNOWLEDGE_OUTCOMES } from "../src/trace-view.js";
import { mcpInstructions } from "../src/mcp.js";
import { cavelonCommand, fill, folderCommand, printingFor, printedCommand, spoken, type PrintTarget } from "../src/printed.js";
import { currentShell, useShell } from "../src/shell.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { askingClient, cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * The commands the kit prints act where the command that printed it did: a
 * confirm line keeps the `--tenant` it was given, so outside a solution folder
 * it does not fall back to the tenant `cavelon use` stored. Over MCP they are
 * the tool calls an agent there makes, with snake_case arguments, and the
 * tools' argument descriptions use those names too.
 */

let server: FakeServer;
let sb: Sandbox;
let acme: string;
let beta: string;

const AGENT = { CLAUDECODE: "1" };
/** The words after `cavelon` of a printed command whose words are all bare. */
const argsOf = (line: string) => line.split(" ").slice(1);
const solution = (tenantId: string, slug: string) => server.state.harnesses.find((h) => h.tenant_id === tenantId && h.slug === slug)!;

function mcpClient(env: Record<string, string> = sb.env) {
  const mcp = createMcpServer(
    {
      stdout: { write: () => true },
      stderr: { write: () => true },
      stdin: Readable.from([]) as unknown as InStream,
      env,
      cwd: sb.home,
      now: () => new Date(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
    COMMANDS,
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = askingClient();
  const connected = (async () => {
    await mcp.connect(serverSide);
    await client.connect(clientSide);
  })();
  return {
    client,
    async call(name: string, args: Record<string, unknown>) {
      await connected;
      const result = await client.callTool({ name, arguments: args });
      return { isError: Boolean(result.isError), body: JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, any> };
    },
    async tools() {
      await connected;
      return (await client.listTools()).tools;
    },
    close: () => client.close(),
  };
}

beforeAll(async () => {
  server = await startFakeServer();
  acme = server.addTenant("acme", "Acme");
  beta = server.addTenant("beta", "Beta");
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [acme, beta], defaultTenant: acme, mayActivate: true }));
  for (const tenant of ["acme", "beta"]) {
    for (const [slug, name] of [["default", "Default"], ["support", "Support"]]) await cli(sb, ["harness", "new", slug!, "--name", name!, "--tenant", tenant]);
  }
  // The stored tenant is beta; every command below names acme and runs outside a solution folder.
  expect((await cli(sb, ["use", "beta"])).code).toBe(0);
});

beforeEach(() => {
  server.state.ready = true;
  for (const h of server.state.harnesses) [h.status, h.is_default] = h.slug === "default" ? ["active", true] : ["active", false];
});

afterAll(async () => {
  sb.cleanup();
  await server.close();
});

describe("a printed confirm keeps the --tenant it was given, outside a solution folder", () => {
  it("deactivate: the confirm line names acme, and running it changes acme, not the stored beta", async () => {
    const preview = await cli(sb, ["deactivate", "--harness", "support", "--tenant", "acme", "--json"]);
    expect(preview.code, preview.stderr).toBe(0);
    const { confirm } = preview.json<{ confirm: string }>();
    expect(confirm).toBe("cavelon deactivate --harness support --tenant acme --confirm");
    expect((await cli(sb, argsOf(confirm))).code).toBe(0);
    expect(solution(acme, "support").status).toBe("inactive");
    expect(solution(beta, "support").status).toBe("active");
  });

  it("deactivate from an agent's shell: a bare --confirm prints the person's line with --tenant", async () => {
    const bare = await cli(sb, ["deactivate", "--harness", "support", "--tenant", "acme", "--confirm", "--json"], { env: AGENT });
    expect(bare.code).toBe(5);
    const shown = bare.json<{ confirm: string }>();
    const line = "cavelon deactivate --harness support --tenant acme --confirm";
    expect(shown.confirm).toBe(`${line} (the person runs it in their own terminal: a coding agent cannot confirm this change)`);
    // The person runs it in their own terminal, where it acts in the tenant the agent's command named.
    expect((await cli(sb, argsOf(line))).code).toBe(0);
    expect(solution(acme, "support").status).toBe("inactive");
    expect(solution(beta, "support").status).toBe("active");
  });

  it("harness default: the confirm line names acme", async () => {
    const preview = await cli(sb, ["harness", "default", "support", "--tenant", "acme", "--json"]);
    expect(preview.code, preview.stderr).toBe(0);
    const { confirm } = preview.json<{ confirm: string }>();
    expect(confirm).toBe("cavelon harness default support --tenant acme --confirm");
    expect((await cli(sb, argsOf(confirm))).code).toBe(0);
    expect(solution(acme, "support").is_default).toBe(true);
    expect(solution(beta, "support").is_default).toBe(false);
  });

  it("activate: the default route's preview and confirm lines name acme", async () => {
    solution(acme, "support").status = "draft";
    const activated = await cli(sb, ["activate", "--harness", "support", "--tenant", "acme", "--json"]);
    expect(activated.code, activated.stderr).toBe(0);
    expect(activated.json()).toMatchObject({
      default_route: { preview: "cavelon harness default support --tenant acme", confirm: "cavelon harness default support --tenant acme --confirm" },
    });
    const make = await cli(sb, ["activate", "--harness", "support", "--make-default", "--tenant", "acme", "--json"]);
    const { confirm } = make.json<{ default_route: { confirm: string } }>().default_route;
    expect(confirm).toBe("cavelon activate --harness support --make-default --tenant acme --confirm");
    expect((await cli(sb, argsOf(confirm))).code).toBe(0);
    expect(solution(acme, "support").is_default).toBe(true);
    expect(solution(beta, "support").is_default).toBe(false);
  });

  it("a miss's hint names its commands in acme too", async () => {
    const miss = await cli(sb, ["harness", "default", "suport", "--tenant", "acme", "--json"]);
    expect(miss.code).toBe(1);
    const { hint } = miss.json<{ error: { hint: string } }>().error;
    expect(hint).toContain("cavelon harness default support --tenant acme");
    expect(hint).toContain("`cavelon harness list --tenant acme`");
  });
});

describe("over MCP, a next step is the tool call", () => {
  it("activate's default route names harness_default with the tenant, and confirms with its preview's token", async () => {
    const mcp = mcpClient();
    try {
      const { body } = await mcp.call("activate", { harness: "support", tenant: "acme" });
      expect(body.default_route).toMatchObject({
        preview: 'harness_default {"solution":"support","tenant":"acme"}',
        confirm: 'harness_default {"solution":"support","confirm":"<confirm_token of its preview>","tenant":"acme"}',
      });
      const preview = await mcp.call("harness_default", JSON.parse(body.default_route.preview.slice("harness_default ".length)));
      expect(preview.body).toMatchObject({ changed: false, confirm_token: expect.stringMatching(/^[0-9a-f]{12}$/) });
      const done = await mcp.call("harness_default", { solution: "support", tenant: "acme", confirm: preview.body.confirm_token });
      expect(done.body).toMatchObject({ changed: true });
      expect(solution(acme, "support").is_default).toBe(true);
    } finally {
      await mcp.close();
    }
  });

  it("operation_status resumes with operation_status, not `cavelon wait`", async () => {
    const op = server.addOperation("test_run", acme, ["running"]);
    const mcp = mcpClient();
    try {
      const { body } = await mcp.call("operation_status", { operation: [op.id], tenant: "acme" });
      expect(body).toMatchObject({ settled: false, resume: `operation_status {"operation":["${op.id}"],"tenant":"acme"}` });
    } finally {
      await mcp.close();
    }
    const shell = await cli(sb, ["wait", op.id, "--timeout", "0", "--tenant", "acme", "--json"]);
    expect(shell.json()).toMatchObject({ resume: `cavelon wait ${op.id} --tenant acme` });
  });

  it("argument and tool descriptions name the tool's arguments in snake_case, never as CLI flags", async () => {
    const mcp = mcpClient();
    try {
      const tools = await mcp.tools();
      const flagged: string[] = [];
      for (const tool of tools) {
        const spec = COMMANDS.find((c) => c.mcpTool === tool.name)!;
        const own = [...Object.keys(spec.options ?? {}).filter((o) => !spec.options![o]!.cliOnly), ...(ownsTenant(spec) ? [] : ["tenant"])];
        const properties = (tool.inputSchema as { properties: Record<string, { description: string }> }).properties;
        const texts = [tool.description ?? "", ...Object.values(properties).map((p) => p.description)];
        for (const text of texts) for (const name of own) if (text.includes(`--${name}`)) flagged.push(`${tool.name}: --${name}`);
      }
      expect(flagged).toEqual([]);
      const byName = (name: string) => (tools.find((t) => t.name === name)!.inputSchema as { properties: Record<string, { description: string }> }).properties;
      expect(byName("activate").make_default!.description).toMatch(/with confirm/);
      expect(byName("activate").confirm!.description).toMatch(/^With make_default/);
      expect(byName("init").harness!.description).toMatch(/is not created: init names the harness_new call/);
      expect(byName("init").harness!.description).not.toMatch(/created as a draft with that name/);
      expect(byName("models_set_limit").model!.description).toContain("`models_list`");
      // The help keeps the CLI's spelling.
      expect(COMMANDS.find((c) => c.name === "activate")!.options!["make-default"]!.description).toMatch(/with --confirm/);
      expect(propertyName("make-default")).toBe("make_default");
    } finally {
      await mcp.close();
    }
  });
});

describe("printedCommand", () => {
  const cliTarget: PrintTarget = { mode: "cli", commands: COMMANDS, instance: "https://cavelon.example.com", tenant: "acme", env: "prod" };
  const mcpTarget: PrintTarget = { mode: "mcp", commands: COMMANDS, tenant: "acme", env: "prod" };

  it("adds the options the running command was given, before its --confirm, where the command takes them", () => {
    printingFor(cliTarget, () => {
      expect(cavelonCommand("limits", "set", "agent_max_turns", "7", "--confirm")).toBe(
        "cavelon limits set agent_max_turns 7 --instance https://cavelon.example.com --env prod --tenant acme --confirm",
      );
      // harness default takes no --env; docs act in no tenant; use names its own tenant.
      expect(cavelonCommand("harness", "default", "support")).toBe("cavelon harness default support --instance https://cavelon.example.com --tenant acme");
      expect(cavelonCommand("docs", "get", "guide")).toBe("cavelon docs get guide --instance https://cavelon.example.com");
      expect(cavelonCommand("use", "beta")).toBe("cavelon use beta --instance https://cavelon.example.com");
      // What a line names itself stays, once.
      expect(cavelonCommand("init", "--tenant", "beta")).toBe("cavelon init --tenant beta --instance https://cavelon.example.com");
      expect(printedCommand(["apply", "--confirm", "pv_1"], { env: null })).toBe("cavelon apply --instance https://cavelon.example.com --tenant acme --confirm pv_1");
      // A word with a space is quoted for the shell the person types into; pin POSIX so Windows runners agree.
      const shell = currentShell();
      useShell("posix");
      try {
        expect(cavelonCommand("variables", "set", "crm url", fill("value"))).toBe(
          "cavelon variables set 'crm url' <value> --instance https://cavelon.example.com --env prod --tenant acme",
        );
      } finally {
        useShell(shell);
      }
    });
  });

  it("over MCP, is the tool call with snake_case arguments, the tenant and env it was given", () => {
    printingFor(mcpTarget, () => {
      expect(cavelonCommand("activate", "--harness", "support", "--make-default", "--confirm")).toBe(
        'activate {"harness":"support","make_default":true,"confirm":"<confirm_token of its preview>","tenant":"acme","env":"prod"}',
      );
      expect(cavelonCommand("deactivate", "--harness", "support", "--confirm", "0bfed9985ec3")).toBe(
        'deactivate {"harness":"support","confirm":"0bfed9985ec3","tenant":"acme","env":"prod"}',
      );
      expect(cavelonCommand("wait", "op_a", "op_b", "--timeout", "5m")).toBe('operation_status {"operation":["op_a","op_b"],"timeout":"5m","tenant":"acme"}');
      expect(cavelonCommand("trace", fill("child_run_id"))).toBe('trace {"run":"<child_run_id>","tenant":"acme"}');
      // A command without a tool names the one that does its job; its own terminal options drop.
      expect(cavelonCommand("watch", "op_a")).toBe('operation_status {"operation":["op_a"],"tenant":"acme"}');
      expect(cavelonCommand("loop", "watch", "run_1", "--loop", "loop_1", "--timeout", "5m")).toBe('loop_iterations {"run":"run_1","loop":"loop_1","tenant":"acme"}');
      // A person runs this one in a terminal; it stays a command line, in the same tenant.
      expect(cavelonCommand("secrets", "set", "crm_token")).toBe("cavelon secrets set crm_token --env prod --tenant acme");
      // A word that is no argument of the tool: printed as the command it is, never as a wrong call.
      expect(cavelonCommand("trace", "run_1", "--no-such-flag")).toBe("cavelon trace run_1 --no-such-flag --tenant acme");
    });
  });

  it("for the folder whose cavelon.yaml names the tenant (init's next steps), carries none of it", () => {
    printingFor(cliTarget, () => expect(folderCommand("apply", "--env", "test")).toBe("cavelon apply --env test"));
    printingFor(mcpTarget, () => expect(folderCommand("harness", "new", "orders", "--name", "Orders")).toBe('harness_new {"slug":"orders","name":"Orders"}'));
  });

  it("outside a command run, is the plain command line", () => {
    expect(cavelonCommand("harness", "default", "support", "--confirm")).toBe("cavelon harness default support --confirm");
  });
});

/**
 * Whether a `cavelon …` may stay one over MCP: a command a person runs in
 * their terminal (login, secrets set), which has no tool and no tool that
 * stands in, or one this kit does not have (an instance's catalog may name
 * one: there is nothing to make it into).
 */
function staysCommand(line: string): boolean {
  const words = line.split(" ").slice(1);
  if (words[0]?.startsWith("<")) return false;
  for (let n = Math.min(3, words.length); n > 0; n--) {
    const spec = COMMANDS.find((c) => c.name === words.slice(0, n).join(" "));
    if (spec) return !spec.mcpTool && !spec.mcpInstead;
  }
  return true;
}

/** What in a hint names a CLI command where an agent over MCP makes a tool call. */
function cliCommandsIn(hint: string): string[] {
  const named = [...hint.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  return [...(hint.startsWith("cavelon ") ? [hint] : []), ...named.filter((n) => n.startsWith("cavelon ") && !staysCommand(n))];
}

describe("over MCP, no hint names a CLI command", () => {
  const catalog = JSON.parse(readFileSync(new URL("../../contracts/cavelon/meta-error-catalog.json", import.meta.url), "utf8")) as {
    rule_codes?: Array<{ code: string }>;
    api_error_codes?: Array<{ code: string }>;
  };
  const codes = [
    ...KIT_ERROR_CODES.map((e) => e.code),
    ...KIT_CODES.map((e) => e.code),
    ...Object.keys(BY_CODE),
    ...CASE_STATUSES.map((s) => s.status),
    ...KNOWLEDGE_OUTCOMES.map((o) => o.value),
    ...(catalog.rule_codes ?? []).map((e) => e.code),
    ...(catalog.api_error_codes ?? []).map((e) => e.code),
  ];

  it("explain: every code the kit or the instance's catalog knows, with its hint, fix and kit hint", async () => {
    const mcp = mcpClient();
    const found: string[] = [];
    try {
      for (const code of new Set(codes)) {
        const { body } = await mcp.call("explain", { code, tenant: "acme" });
        for (const field of ["hint", "cli_fix", "kit_hint"]) {
          const text = body[field] ?? body.error?.[field];
          if (typeof text === "string") for (const named of cliCommandsIn(text)) found.push(`${code}.${field}: ${named}`);
        }
      }
    } finally {
      await mcp.close();
    }
    expect(found).toEqual([]);
  });

  it("the fixed texts a tool result or the server's instructions carry", () => {
    const mcpTarget: PrintTarget = { mode: "mcp", commands: COMMANDS, tenant: "acme" };
    const texts: Array<[string, string]> = [
      ...KIT_ERROR_CODES.map((e) => [e.code, printingFor(mcpTarget, () => kitErrorEntry(e.code)?.hint) ?? ""] as [string, string]),
      ...KIT_CODES.map((e) => [e.code, e.hint ?? ""] as [string, string]),
      ...Object.entries(BY_CODE),
      ...BY_ROUTE.map((r) => [r.route, cliFix({ code: "", message: r.route }) ?? ""] as [string, string]),
      ...CASE_STATUSES.map((s) => [s.status, s.next] as [string, string]),
      ...KNOWLEDGE_OUTCOMES.map((o) => [o.value, o.hint] as [string, string]),
    ];
    const found = printingFor(mcpTarget, () => texts.flatMap(([name, text]) => cliCommandsIn(spoken(text)).map((named) => `${name}: ${named}`)));
    found.push(...cliCommandsIn(mcpInstructions(COMMANDS)).map((named) => `instructions: ${named}`));
    // A tool without arguments is named alone.
    printingFor({ mode: "mcp", commands: COMMANDS }, () => expect(spoken("`cavelon status` shows its version.")).toBe("`status` shows its version."));
    expect(found).toEqual([]);
    // Spoken as tool calls, with the tenant the tool was given.
    printingFor(mcpTarget, () => {
      expect(spoken(caseStatusNext("not_run"))).toContain('`trace {"run":"<test-run-id>","tenant":"acme"}`');
      expect(spoken("`cavelon harness list` shows them.")).toBe('`harness_list {"tenant":"acme"}` shows them.');
      expect(spoken("`cavelon status` shows its version.")).toBe('`status {"tenant":"acme"}` shows its version.');
      // A person's command stays one, in the same tenant.
      expect(spoken("A person runs `cavelon secrets set <name>`.")).toBe("A person runs `cavelon secrets set <name> --tenant acme`.");
    });
    // The instructions still name the person's commands as commands.
    expect(mcpInstructions(COMMANDS)).toContain("`cavelon login`");
    expect(mcpInstructions(COMMANDS)).toContain("`cavelon secrets set <name>`");
  });

  it("a refusal's hint names the tool call; in a terminal it keeps the --tenant it was given", async () => {
    const mcp = mcpClient();
    try {
      const { isError, body } = await mcp.call("trace", { run: "run_does_not_exist", tenant: "acme" });
      expect(isError).toBe(true);
      expect(cliCommandsIn(body.error.hint ?? "")).toEqual([]);
    } finally {
      await mcp.close();
    }
    printingFor({ mode: "cli", commands: COMMANDS, tenant: "acme" }, () => {
      expect(spoken("`cavelon harness list` shows them.")).toBe("`cavelon harness list --tenant acme` shows them.");
    });
    // Outside a command run, the text is as written.
    expect(spoken("`cavelon harness list` shows them.")).toBe("`cavelon harness list` shows them.");
  });
});

describe("in a coding agent's shell, a confirm line printed before its preview names the token it needs", () => {
  it("activate's default route", async () => {
    solution(acme, "support").status = "draft";
    const activated = await cli(sb, ["activate", "--harness", "support", "--tenant", "acme", "--json"], { env: AGENT });
    expect(activated.code, activated.stderr).toBe(0);
    expect(activated.json()).toMatchObject({
      default_route: {
        preview: "cavelon harness default support --tenant acme",
        confirm: "cavelon harness default support --tenant acme --confirm <confirm_token of its preview>",
      },
    });
  });

  it("a preview's own confirm line for the person carries no token and no placeholder", async () => {
    const preview = await cli(sb, ["harness", "default", "support", "--tenant", "acme", "--json"], { env: AGENT });
    const shown = preview.json<{ confirm: string }>();
    expect(shown.confirm).toBe("cavelon harness default support --tenant acme --confirm (the person runs it in their own terminal: a coding agent cannot confirm this change)");
  });

  it("in a person's terminal the line stays a bare --confirm", () => {
    printingFor({ mode: "cli", commands: COMMANDS }, () => expect(cavelonCommand("loop", "cancel", "run_1", "--confirm")).toBe("cavelon loop cancel run_1 --confirm"));
    printingFor({ mode: "cli", commands: COMMANDS, agentShell: true }, () => {
      expect(cavelonCommand("loop", "cancel", "run_1", "--confirm")).toBe("cavelon loop cancel run_1 --confirm <confirm_token of its preview>");
      expect(cavelonCommand("apply", "--confirm", "pv_1")).toBe("cavelon apply --confirm pv_1");
    });
  });
});

function caseStatusNext(status: string): string {
  return CASE_STATUSES.find((s) => s.status === status)!.next;
}
