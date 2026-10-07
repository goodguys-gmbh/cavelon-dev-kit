import { promises as fs } from "node:fs";
import path from "node:path";
import { boolOption, listOption, type CommandSpec, type Context, type Input } from "../command.js";
import { createContext } from "../context.js";
import { asCavelonError, CavelonError, ExitCode, usageError, type ExitCodeValue } from "../errors.js";
import { readJsonFile, writeFileAtomic } from "../fsutil.js";
import { configDir } from "../paths.js";
import { canAsk, readLine } from "../prompt.js";
import { probeMcpServer } from "../run-program.js";
import { cavelonCommand } from "../printed.js";
import {
  agentByName,
  applyPlan,
  checkAgent,
  findAgent,
  loadSkills,
  planAgent,
  removeAgent,
  serverCommand,
  setupAgents,
  type AgentCheck,
  type AgentPlan,
  type AgentRecord,
  type Change,
  type ServerCommand,
  type SetupAgent,
  type SetupState,
} from "../setup-agents.js";
import { KIT_VERSION } from "../version.js";
import { login, whoami } from "./session.js";

/**
 * `cavelon setup`: from "I have the kit" to "my coding agent can build a
 * Cavelon solution" in one guided step, for a person who knows neither
 * Cavelon nor their system well. It finds the coding agents, shows in plain
 * words what it will change, asks once, does it, and logs in. Every change
 * is recorded, so `--remove` undoes exactly that and `--check` says what
 * works.
 */

const PROBE_TIMEOUT_MS = 120_000;

const EXAMPLE_BRIEF = "Build a Cavelon solution that answers our customers' questions from the FAQ pages in ./faq, and test it.";

function statePath(env: Record<string, string | undefined>): string {
  return path.join(configDir(env), "setup.json");
}

async function loadState(env: Record<string, string | undefined>): Promise<SetupState> {
  const raw = await readJsonFile<Partial<SetupState>>(statePath(env));
  return { agents: raw?.agents && typeof raw.agents === "object" ? raw.agents : {} };
}

async function saveState(env: Record<string, string | undefined>, state: SetupState): Promise<void> {
  for (const [name, record] of Object.entries(state.agents)) if (!Object.keys(record).length) delete state.agents[name];
  if (!Object.keys(state.agents).length) {
    await fs.rm(statePath(env), { force: true });
    return;
  }
  await writeFileAtomic(statePath(env), JSON.stringify(state, null, 2) + "\n", 0o600, 0o700);
}

function namedAgents(input: Input, agents: SetupAgent[]): SetupAgent[] {
  const names = listOption(input, "agents")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  if (names.some((n) => n.toLowerCase() === "all")) return agents;
  const out: SetupAgent[] = [];
  for (const name of names) {
    const agent = agentByName(agents, name);
    if (!agent) throw usageError(`Unknown agent "${name}".`, `Known: ${agents.map((a) => a.name).join(", ")}.`);
    if (!out.includes(agent)) out.push(agent);
  }
  return out;
}

function changeLine(change: Change): string {
  if (change.kind === "plugin" || change.kind === "marketplace") return `${change.summary}: runs \`${change.target}\``;
  return `${change.summary} ${change.target}`;
}

function outcomeLine(change: Change): string {
  const label: Record<Change["outcome"], string> = {
    planned: "to do",
    done: "done",
    unchanged: "already",
    skipped: "left",
    failed: "failed",
    removed: "removed",
  };
  return `    ${label[change.outcome].padEnd(8)} ${changeLine(change)}${change.reason ? ` (${change.reason})` : ""}`;
}

function planJson(plan: AgentPlan, changes: Change[] = plan.changes) {
  return {
    name: plan.agent.name,
    label: plan.agent.label,
    found: { command: plan.found.program ?? null, folder: plan.found.folder ?? null },
    method: plan.method,
    changes: changes.map((c) => ({ kind: c.kind, summary: c.summary, target: c.target, outcome: c.outcome, ...(c.reason ? { reason: c.reason } : {}) })),
  };
}

/** The plan as a person reads it before saying yes. */
function planText(plans: AgentPlan[], notFound: SetupAgent[]): string {
  const lines: string[] = [];
  for (const plan of plans) {
    const todo = plan.changes.filter((c) => c.outcome === "planned");
    const other = plan.changes.filter((c) => c.outcome !== "planned" && c.outcome !== "unchanged");
    if (!todo.length && !other.length) {
      lines.push(`  ${plan.agent.label}: already set up.`);
      continue;
    }
    lines.push(`  ${plan.agent.label}:`);
    for (const change of todo) lines.push(`    - ${changeLine(change)}`);
    for (const change of other) lines.push(`    - not possible: ${changeLine(change)}${change.reason ? ` (${change.reason})` : ""}`);
  }
  if (notFound.length) lines.push(`  Not found on this computer: ${notFound.map((a) => a.label).join(", ")}.`);
  return lines.join("\n");
}

async function confirm(ctx: Context, question: string, defaultYes: boolean): Promise<boolean> {
  const answer = (await readLine(ctx.io, `${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `, "Cancelled; nothing was changed.")).toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith("y") || answer.startsWith("j");
}

function confirmationRequired(what: string, details: unknown): CavelonError {
  return new CavelonError(ExitCode.usage, {
    code: "yes_required",
    message: `Nothing was changed: ${what}, and there is no terminal to ask.`,
    hint: "Read the plan in details, then run the same command with --yes.",
    details,
  });
}

// ---------------------------------------------------------------------------
// Logging in
// ---------------------------------------------------------------------------

interface LoginReport {
  status: "logged_in" | "already" | "skipped" | "not_logged_in" | "failed";
  instance: string | null;
  text?: string;
  next?: string;
  error?: Record<string, unknown>;
  exitCode?: ExitCodeValue;
}

function normalizeAddress(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Log in through `login` itself, so the tenant is chosen by name as `login` chooses it. */
async function loginStep(ctx: Context): Promise<LoginReport> {
  const session = await ctx.session();
  if (session.url && session.token) return { status: "already", instance: session.url, text: `Already logged in to ${session.url}.` };
  if (!canAsk(ctx)) {
    return {
      status: "not_logged_in",
      instance: session.url ?? null,
      next: `Log in from your own terminal: ${cavelonCommand("login", "--instance", session.url ?? "https://cavelon.example.com")}`,
    };
  }
  let url = session.url;
  const err = ctx.io.stderr;
  err.write("\nLog in to Cavelon.\n");
  if (!url) {
    err.write("Your Cavelon address is the one you open Cavelon at in the browser, for example https://cavelon.example.com.\n");
    for (let tries = 0; tries < 3 && !url; tries++) {
      const typed = await readLine(ctx.io, "Cavelon address (Enter to log in later): ", "Cancelled; the agents are set up, logging in is not.");
      if (!typed) return { status: "skipped", instance: null, next: `Log in later: ${cavelonCommand("login", "--instance", "https://cavelon.example.com")}` };
      url = normalizeAddress(typed);
      if (!url) err.write(`"${typed}" is not a web address. Type it as it shows in the browser's address bar.\n`);
    }
    if (!url) return { status: "skipped", instance: null, next: `Log in later: ${cavelonCommand("login", "--instance", "https://cavelon.example.com")}` };
  }
  err.write(
    `In Cavelon (${url}), open your user menu, then Personal access tokens, then Create token. Copy the token and paste it below.\n` +
      "It is not shown while you paste, and it is kept in your system's credential store, never in a file of your project.\n",
  );
  const sub = createContext(ctx.io, { ...ctx.globals, json: ctx.json, instance: url });
  try {
    const result = await login.run(sub, { positionals: {}, options: {} });
    for (const warning of sub.warnings) ctx.warn(warning);
    return { status: "logged_in", instance: url, text: result.text, ...(result.exitCode ? { exitCode: result.exitCode } : {}) };
  } catch (error) {
    for (const warning of sub.warnings) ctx.warn(warning);
    const err = asCavelonError(error);
    return {
      status: "failed",
      instance: url,
      error: err.toJSON(),
      text: `Not logged in: ${err.message}${err.hint ? `\n  ${err.hint}` : ""}`,
      next: `Log in again: ${cavelonCommand("login", "--instance", url)}`,
      exitCode: err.exitCode,
    };
  }
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

async function runSetup(ctx: Context, input: Input) {
  const env = ctx.io.env;
  const agents = setupAgents(env);
  const named = namedAgents(input, agents);
  const found = await Promise.all(agents.map(async (agent) => ({ agent, found: await findAgent(agent, env) })));
  const isFound = (f: { found: { program?: string; folder?: string } }) => Boolean(f.found.program || f.found.folder);
  const chosen = named.length ? found.filter((f) => named.includes(f.agent)) : found.filter(isFound);
  const notFound = named.length ? [] : found.filter((f) => !isFound(f)).map((f) => f.agent);
  const skills = await loadSkills();
  if (!skills.length) {
    throw new CavelonError(ExitCode.failure, { code: "skills_missing", message: "This cavelon has no skills to install (its package is incomplete).", hint: "Reinstall @cavelon/cli." });
  }
  const command = await serverCommand(env);
  const plans: AgentPlan[] = [];
  for (const { agent, found: where } of chosen) plans.push(await planAgent(agent, where, env, command, skills));
  const pending = plans.some((p) => p.changes.some((c) => c.outcome === "planned"));

  let results = plans.map((plan) => ({ plan, changes: plan.changes }));
  let declined = false;
  if (pending) {
    if (!boolOption(input, "yes")) {
      if (!canAsk(ctx)) {
        if (!ctx.json) ctx.io.stderr.write(`cavelon setup would change this:\n${planText(plans, notFound)}\n`);
        throw confirmationRequired("setup changes your coding agents' settings only when you agree", { agents: plans.map((p) => planJson(p)), server: command });
      }
      ctx.io.stderr.write(`cavelon setup will change this for you:\n${planText(plans, notFound)}\nNothing else in these files changes, and \`cavelon setup --remove\` undoes it.\n`);
      declined = !(await confirm(ctx, "Make these changes?", true));
    }
    if (!declined) {
      const state = await loadState(env);
      results = [];
      for (const plan of plans) {
        const record: AgentRecord = (state.agents[plan.agent.name] ??= {});
        results.push({ plan, changes: await applyPlan(plan, env, command, skills, record) });
        // Saved after each agent, so an interrupted run can still be undone.
        await saveState(env, state);
      }
    }
  }

  const loginReport = declined ? undefined : await loginStep(ctx);
  const failed = results.some((r) => r.changes.some((c) => c.outcome === "failed"));
  const ready = results.filter((r) => r.changes.length && r.changes.every((c) => c.outcome === "done" || c.outcome === "unchanged"));
  const changed = results.filter((r) => r.changes.some((c) => c.outcome === "done"));
  const next: string[] = [];
  if (declined) next.push(`Nothing was changed. Run ${cavelonCommand("setup")} again when you are ready.`);
  else {
    if (loginReport?.next) next.push(loginReport.next);
    if (changed.length) next.push(`Restart ${joinLabels(changed.map((r) => r.plan.agent.label))} if ${changed.length > 1 ? "they are" : "it is"} open, so ${changed.length > 1 ? "they load" : "it loads"} Cavelon.`);
    if (ready.length) {
      next.push(`Open an empty folder in ${joinLabels(ready.map((r) => r.plan.agent.label), "or")} and describe what to build, for example:`, `  "${EXAMPLE_BRIEF}"`);
      next.push(`Or start a solution yourself in an empty folder: ${cavelonCommand("init")}`);
    } else if (!chosen.length) {
      next.push(
        "No coding agent was found. Install one (Claude Code, Codex, Cursor, VS Code with GitHub Copilot, Gemini CLI or Kiro) and run cavelon setup again,",
        `  or name yours: ${cavelonCommand("setup", "--agents", "cursor")}`,
      );
    }
  }

  const lines: string[] = [];
  if (!chosen.length) lines.push("No coding agent found on this computer.");
  for (const { plan, changes } of results) {
    lines.push(`${plan.agent.label}:`);
    lines.push(...changes.map(outcomeLine));
  }
  if (notFound.length && chosen.length) lines.push(`Not found: ${notFound.map((a) => a.label).join(", ")}.`);
  if (loginReport?.text) lines.push("", loginReport.text);
  if (next.length) lines.push("", "Next:", ...next.map((n) => `  ${n}`));

  const exitCode: ExitCodeValue = failed ? ExitCode.failure : (loginReport?.exitCode ?? ExitCode.ok);
  return {
    data: {
      agents: results.map((r) => planJson(r.plan, r.changes)),
      not_found: notFound.map((a) => a.name),
      server: command,
      declined,
      login: loginReport ? { status: loginReport.status, instance: loginReport.instance, ...(loginReport.error ? { error: loginReport.error } : {}) } : null,
      next,
    },
    text: lines.join("\n"),
    exitCode,
  };
}

function joinLabels(labels: string[], word = "and"): string {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} ${word} ${labels[labels.length - 1]}`;
}

// ---------------------------------------------------------------------------
// setup --check
// ---------------------------------------------------------------------------

async function runCheck(ctx: Context, input: Input) {
  const env = ctx.io.env;
  const agents = setupAgents(env);
  const named = namedAgents(input, agents);
  const state = await loadState(env);
  const strict = boolOption(input, "strict");
  const checks: Array<AgentCheck & { skipped?: true }> = [];
  for (const agent of named.length ? named : agents) {
    const record = state.agents[agent.name];
    const check = await checkAgent(agent, env, record);
    if (!named.length && !check.found && !record) continue;
    // Found on this computer, but neither set up by setup nor working: an agent the person does not use with
    // Cavelon. It is reported and skipped, unless named with --agents or --strict asks for every agent found.
    const skipped = !named.length && !strict && !record && !check.ok;
    checks.push(skipped ? { ...check, skipped: true } : check);
  }
  const counted = checks.filter((c) => !c.skipped);
  const servers: ServerCommand[] = [];
  for (const server of counted.flatMap((c) => c.servers)) {
    if (!servers.some((s) => JSON.stringify(s) === JSON.stringify(server))) servers.push(server);
  }
  if (!servers.length) servers.push(await serverCommand(env));
  const probes = [];
  for (const server of servers) {
    const probe = await probeMcpServer(server.command, server.args, { env, cwd: ctx.io.cwd, timeoutMs: PROBE_TIMEOUT_MS, clientVersion: KIT_VERSION });
    probes.push({ command: [server.command, ...server.args].join(" "), ...probe });
  }

  const session = await ctx.session();
  let loginCheck: { ok: boolean; instance: string | null; who?: string; tenant?: string | null; problem?: string };
  if (!session.url || !session.token) {
    loginCheck = { ok: false, instance: session.url ?? null, problem: `not logged in; run ${cavelonCommand("login", "--instance", session.url ?? "https://cavelon.example.com")}` };
  } else {
    try {
      const result = await whoami.run(ctx, { positionals: {}, options: {} });
      const data = result.data as { owner?: { email?: string | null } | null; tenant?: { name?: string | null; id?: string | null } };
      loginCheck = { ok: true, instance: session.url, who: data.owner?.email ?? undefined, tenant: data.tenant?.name ?? data.tenant?.id ?? null };
    } catch (error) {
      const err = asCavelonError(error);
      loginCheck = { ok: false, instance: session.url, problem: `${err.message}${err.hint ? ` ${err.hint}` : ""}` };
    }
  }

  const ok = counted.length > 0 && counted.every((c) => c.ok) && probes.every((p) => p.ok) && loginCheck.ok;
  const mark = (good: boolean) => (good ? ctx.style.green("ok  ") : ctx.style.red("no  "));
  const lines: string[] = [];
  if (!checks.length) lines.push(`${mark(false)}No coding agent found, and setup has set up none.`);
  else if (!counted.length) lines.push(`${mark(false)}No coding agent is set up for Cavelon.`);
  for (const check of checks) {
    if (check.skipped) {
      lines.push(`skip  ${check.label}: found, not set up for Cavelon (${cavelonCommand("setup", "--agents", check.name)} sets it up)`);
      continue;
    }
    lines.push(`${mark(check.ok)}${check.label}${check.found ? "" : " (not found on this computer)"}`);
    for (const detail of check.details) lines.push(`      ${detail}`);
  }
  for (const probe of probes) {
    lines.push(`${mark(probe.ok)}The Cavelon tools start: ${probe.command}${probe.ok ? (probe.server ? ` (${probe.server})` : "") : ` (${probe.error})`}`);
  }
  lines.push(
    loginCheck.ok
      ? `${mark(true)}Logged in to ${loginCheck.instance}${loginCheck.who ? ` as ${loginCheck.who}` : ""}${loginCheck.tenant ? `, tenant ${loginCheck.tenant}` : ""}`
      : `${mark(false)}Login: ${loginCheck.problem}`,
  );
  if (!ok) lines.push("", `Run ${cavelonCommand("setup")} to set up what is missing.`);
  return {
    data: {
      ok,
      agents: checks.map(({ servers: _servers, ...c }) => c),
      server: probes,
      login: loginCheck,
    },
    text: lines.join("\n"),
    exitCode: ok ? ExitCode.ok : ExitCode.failure,
  };
}

// ---------------------------------------------------------------------------
// setup --remove
// ---------------------------------------------------------------------------

function removalLines(agent: SetupAgent, record: AgentRecord): string[] {
  const lines: string[] = [];
  if (record.plugin_installed) lines.push("uninstall the Cavelon plugin");
  if (record.marketplace_added) lines.push("remove the Cavelon plugin marketplace");
  if (record.mcp) lines.push(`remove the "cavelon" tools server from ${record.mcp.file}`);
  if (record.skills) lines.push(`remove the Cavelon skills from ${record.skills.dir}${path.sep}`);
  return lines.length ? [`  ${agent.label}:`, ...lines.map((l) => `    - ${l}`)] : [];
}

async function runRemove(ctx: Context, input: Input) {
  const env = ctx.io.env;
  const agents = setupAgents(env);
  const named = namedAgents(input, agents);
  const state = await loadState(env);
  const targets = (named.length ? named : agents).filter((a) => state.agents[a.name] && Object.keys(state.agents[a.name]!).length);
  if (!targets.length) {
    return { data: { agents: [], removed: false }, text: "Nothing to remove: cavelon setup has not changed anything here." };
  }
  const plan = targets.flatMap((a) => removalLines(a, state.agents[a.name]!));
  if (!boolOption(input, "yes")) {
    if (!canAsk(ctx)) {
      throw confirmationRequired("--remove undoes what setup did only when you agree", { agents: targets.map((a) => ({ name: a.name, label: a.label, recorded: state.agents[a.name] })) });
    }
    ctx.io.stderr.write(`cavelon setup --remove will undo this:\n${plan.join("\n")}\n`);
    if (!(await confirm(ctx, "Undo these changes?", false))) {
      return { data: { agents: [], removed: false, declined: true }, text: "Nothing was changed." };
    }
  }
  const skills = await loadSkills();
  const removing = new Set(targets.map((a) => a.name));
  const shared = new Set(
    Object.entries(state.agents)
      .filter(([name]) => !removing.has(name))
      .flatMap(([, record]) => (record.skills ? [record.skills.dir] : [])),
  );
  const results: Array<{ agent: SetupAgent; changes: Change[] }> = [];
  for (const agent of targets) {
    results.push({ agent, changes: await removeAgent(agent, state.agents[agent.name]!, env, skills, shared) });
    await saveState(env, state);
  }
  const failed = results.some((r) => r.changes.some((c) => c.outcome === "failed" || c.outcome === "skipped"));
  const lines = results.flatMap((r) => [`${r.agent.label}:`, ...r.changes.map(outcomeLine)]);
  lines.push("", `Your login stays; ${cavelonCommand("logout")} removes it.`);
  if (results.some((r) => r.changes.some((c) => c.outcome === "removed"))) lines.push(`Restart ${joinLabels(results.map((r) => r.agent.label))} if ${results.length > 1 ? "they are" : "it is"} open.`);
  return {
    data: {
      agents: results.map((r) => ({ name: r.agent.name, label: r.agent.label, changes: r.changes })),
      removed: true,
    },
    text: lines.join("\n"),
    exitCode: failed ? ExitCode.failure : ExitCode.ok,
  };
}

export const setup: CommandSpec = {
  name: "setup",
  storesTarget: true,
  tenantless: true,
  summary: "Set up your coding agents for Cavelon and log in, in one guided step.",
  description:
    "Finds Claude Code, Codex, Cursor, VS Code with GitHub Copilot, Gemini CLI and Kiro, shows what it will change for each, asks once\n" +
    "and does it: Claude Code and Codex get the Cavelon plugin through their own plugin command; the others get the `cavelon` MCP\n" +
    "server in their user MCP configuration and the skills in their user skills folder. It touches nothing else in those files and\n" +
    "records what it did, so --remove undoes exactly that. Then it logs in if needed, choosing the tenant by name as `login` does.\n" +
    "The server starts as `cavelon mcp` when cavelon is installed, otherwise through npx. --check reports what is set up and\n" +
    "working: each agent's entry, the MCP server starting, and the login. An agent found but never set up for Cavelon is\n" +
    "reported and skipped (exit 0 when the rest works); --strict, or naming it with --agents, counts it.\n" +
    "Without a terminal it changes nothing unless --yes.",
  readOnly: false,
  destructive: true,
  idempotent: true,
  mcpTool: false,
  options: {
    agents: {
      type: "string",
      value: "<list>",
      multiple: true,
      description: "Only these agents: claude, codex, cursor, copilot, gemini, kiro, or all (comma-separated). Default: every agent found.",
    },
    yes: { type: "boolean", short: "y", description: "Make the changes without asking." },
    check: { type: "boolean", description: "Report what is set up and working; change nothing." },
    strict: { type: "boolean", description: "With --check: fail for every agent found that is not set up, not only the ones setup set up." },
    remove: { type: "boolean", description: "Undo what setup did (your login stays)." },
  },
  examples: [
    "cavelon setup",
    "cavelon setup --agents claude,codex --instance https://cavelon.example.com --yes",
    "cavelon setup --check",
    "cavelon setup --remove",
  ],
  async run(ctx, input) {
    if (boolOption(input, "check") && boolOption(input, "remove")) throw usageError("--check and --remove do not go together.");
    if (boolOption(input, "strict") && !boolOption(input, "check")) throw usageError("--strict goes with --check.");
    if (boolOption(input, "check")) return runCheck(ctx, input);
    if (boolOption(input, "remove")) return runRemove(ctx, input);
    return runSetup(ctx, input);
  },
};
