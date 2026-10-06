import fs from "node:fs/promises";
import path from "node:path";
import { SKILL_ROOTS } from "./agents.js";
import type { Install } from "./install.js";
import { currentInstall, NPM_PACKAGE, REPOSITORY } from "./install.js";
import type { Io } from "./io.js";
import { readJsonFile, readTextFile, writePrivateFile } from "./fsutil.js";
import { isGenerated } from "./markers.js";
import { cacheDir } from "./paths.js";
import { findProject } from "./project.js";
import { KIT_VERSION } from "./version.js";

/**
 * Once a day, look up the latest release where this install updates from (the
 * GitHub release for the executables, the npm registry for npm) and say once
 * when a newer one exists, with the command that updates it. It runs beside
 * the command, never delays it by more than a short timeout, sends nothing but
 * the request, and stays silent on any failure. Only for a person at a
 * terminal: never with --json, in MCP mode, in CI or for npx, which already
 * runs the newest release it may. The MCP server tells the agent instead
 * (startSessionUpdateCheck), from the same lookup and cache.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 1500;
const MAX_BODY = 1024 * 1024;
const STATE_FILE = "update-check.json";
/** The plugin's MCP entry sets it to the plugin's version; nothing else does. */
export const PLUGIN_VERSION_VARIABLE = "CAVELON_PLUGIN_VERSION";
/**
 * Claude Code sets it to the folder of the plugin whose MCP server it starts,
 * so a plugin from before PLUGIN_VERSION_VARIABLE still tells its version
 * through its manifest. Codex sets nothing like it.
 */
export const CLAUDE_PLUGIN_ROOT_VARIABLE = "CLAUDE_PLUGIN_ROOT";
const PLUGIN_NAME = "cavelon";
const UPDATING_DOCS = `https://github.com/${REPOSITORY}/blob/main/docs/installation.md#updating`;

const SOURCES = {
  github: { url: `https://api.github.com/repos/${REPOSITORY}/releases/latest`, field: "tag_name" },
  npm: { url: `https://registry.npmjs.org/${NPM_PACKAGE}/latest`, field: "version" },
} as const;

// The variables CI services set; `CI` alone covers most of them.
const CI_VARIABLES = ["CI", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "RUN_ID", "GITHUB_ACTIONS", "GITLAB_CI", "TF_BUILD", "BUILDKITE", "JENKINS_URL", "TEAMCITY_VERSION", "CODEBUILD_BUILD_ID"];

interface State {
  source?: string;
  checked_at?: string;
  latest?: string;
  notified_at?: string;
}

export interface UpdateCheckOptions {
  /** This process's install; tests name one. */
  install?: Install;
  fetch?: typeof fetch;
}

export interface UpdateCheckRequest {
  io: Io;
  version: string;
  install: Install;
  json: boolean;
  command: string;
  fetch?: typeof fetch;
}

function setTo(value: string | undefined): boolean {
  return value !== undefined && !["", "0", "false", "no"].includes(value.trim().toLowerCase());
}

/** Why there is no check this time, or undefined when there may be one. */
export function quietReason(request: Omit<UpdateCheckRequest, "fetch">): string | undefined {
  const { io, install } = request;
  if (setTo(io.env.CAVELON_NO_UPDATE_CHECK)) return "CAVELON_NO_UPDATE_CHECK";
  if (request.json) return "json";
  if (request.command === "mcp") return "mcp";
  if (CI_VARIABLES.some((name) => setTo(io.env[name]))) return "ci";
  if (!io.stderr.isTTY) return "no terminal";
  if (!install.source) return install.method;
  return undefined;
}

/**
 * Start the check; the promise gives the notice to print after the command,
 * or nothing. It never rejects.
 */
export function startUpdateCheck(request: UpdateCheckRequest): Promise<string | undefined> {
  if (quietReason(request)) return Promise.resolve(undefined);
  return check(request).catch(() => undefined);
}

async function check(request: UpdateCheckRequest): Promise<string | undefined> {
  const { io, install, version } = request;
  return withState(io, install.source!, version, request.fetch ?? fetch, (state, now) => {
    if (!state.latest || !newer(state.latest, version) || within(state.notified_at, now)) return undefined;
    state.notified_at = now.toISOString();
    return noticeText(state.latest, version, install);
  });
}

/**
 * The cached state, looked up again when it is a day old, handed to `use`;
 * written back when `use` or the lookup changed it.
 */
async function withState<T>(io: Io, source: "github" | "npm", version: string, fetchImpl: typeof fetch, use: (state: State, now: Date) => T): Promise<T> {
  const file = path.join(cacheDir(io.env), STATE_FILE);
  const state = (await readJsonFile<State>(file)) ?? {};
  const now = io.now();
  const before = JSON.stringify(state);
  if (state.source !== source) {
    delete state.latest;
    delete state.checked_at;
    state.source = source;
  }
  if (!within(state.checked_at, now)) {
    // A failed check counts as one, so a machine offline does not try on every run.
    state.checked_at = now.toISOString();
    const latest = await latestVersion(source, version, fetchImpl).catch(() => undefined);
    if (latest) state.latest = latest;
  }
  const result = use(state, now);
  if (JSON.stringify(state) !== before) await writePrivateFile(cacheDir(io.env), file, `${JSON.stringify(state, null, 2)}\n`);
  return result;
}

function within(stamp: string | undefined, now: Date): boolean {
  const at = stamp ? Date.parse(stamp) : NaN;
  // A stamp in the future (a clock set back) does not silence the check for good.
  return Number.isFinite(at) && at <= now.getTime() && now.getTime() - at < DAY_MS;
}

async function latestVersion(source: "github" | "npm", version: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  const { url, field } = SOURCES[source];
  const response = await fetchImpl(url, {
    headers: { accept: source === "github" ? "application/vnd.github+json" : "application/json", "user-agent": `cavelon/${version}` },
    redirect: "follow",
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (!response.ok) return undefined;
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BODY) return undefined;
  const text = await response.text();
  if (text.length > MAX_BODY) return undefined;
  const value = (JSON.parse(text) as Record<string, unknown>)[field];
  if (typeof value !== "string") return undefined;
  const parsed = parseVersion(value);
  // Only a release, never a pre-release, is offered.
  return parsed && !parsed.pre ? parsed.text : undefined;
}

interface Version {
  parts: [number, number, number];
  pre?: string;
  text: string;
}

export function parseVersion(value: string): Version | undefined {
  let text = value.trim();
  if (text.startsWith("v")) text = text.slice(1);
  const dash = text.indexOf("-");
  const pre = dash < 0 ? undefined : text.slice(dash + 1);
  const match = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(dash < 0 ? text : text.slice(0, dash));
  if (!match || (pre !== undefined && !/^[0-9A-Za-z.-]{1,64}$/.test(pre))) return undefined;
  const parts: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return { parts, pre, text: `${parts.join(".")}${pre ? `-${pre}` : ""}` };
}

/** Whether `candidate` is a later version than `current`; a release is later than its pre-releases. */
export function newer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i]! > b.parts[i]!;
  }
  return !a.pre && b.pre !== undefined;
}

export function noticeText(latest: string, version: string, install: Install): string {
  const head = `cavelon ${latest} is out; this is ${version}.`;
  if (install.update) return `${head} Update with:\n  ${install.update}\n`;
  return `${head}${install.advice ? ` ${install.advice}` : ""}\n`;
}

// ---------------------------------------------------------------------------
// The MCP server's warning
// ---------------------------------------------------------------------------

export interface SessionUpdateOptions extends UpdateCheckOptions {
  /** This cavelon's version; tests name another. */
  version?: string;
}

/**
 * What a session learnt: the latest release, the plugin's version when the
 * plugin started the server, and the oldest kit version of the skills
 * `init --agents` wrote.
 */
interface SessionFacts {
  latest?: string;
  plugin?: string;
  skills?: string;
}

export interface SessionUpdateNotice {
  /**
   * Called as a tool call starts; the promise, awaited once the tool is done,
   * gives the warning for its result, once a session. Only the first call
   * waits for the lookup, and never past CHECK_TIMEOUT_MS; a later call takes
   * it when it has arrived.
   */
  forCall(client: () => string | undefined): Promise<string | undefined>;
  /** A result that cannot carry the warning hands it back for the next one. */
  keep(): void;
}

/** Why an MCP session says nothing, or undefined when it may. */
export function sessionQuietReason(io: Pick<Io, "env">, install: Install): string | undefined {
  if (setTo(io.env.CAVELON_NO_UPDATE_CHECK)) return "CAVELON_NO_UPDATE_CHECK";
  if (CI_VARIABLES.some((name) => setTo(io.env[name]))) return "ci";
  // A build from a clone is a kit developer's, who updates it with git.
  if (install.method === "source") return "source";
  return undefined;
}

/**
 * For `cavelon mcp`: a coding agent runs the kit without a terminal, so the
 * terminal notice never reaches the person. The server looks the latest
 * release up as it starts (the same lookup, cache and opt-out), reads which
 * version the plugin that started it is (pluginVersion) and which
 * version wrote the skills of this solution folder, and adds one warning to
 * the first tool result of the session for the agent to pass on. It looks up
 * nothing for npx, which runs the newest release of its range, unless the
 * plugin's version needs comparing; it never fails a tool call.
 */
export function startSessionUpdateCheck(io: Io, options: SessionUpdateOptions = {}): SessionUpdateNotice {
  const install = options.install ?? currentInstall(io.env);
  const version = options.version ?? KIT_VERSION;
  if (sessionQuietReason(io, install)) return { forCall: async () => undefined, keep: () => undefined };
  let facts: SessionFacts | undefined;
  let settled = false;
  const gathered = Promise.all([
    pluginVersion(io.env)
      .catch(() => undefined)
      .then((plugin) => {
        // The plugin updates from the GitHub release whichever way cavelon came.
        const source = install.source ?? (plugin ? "github" : undefined);
        const latest = source ? withState(io, source, version, options.fetch ?? fetch, (state) => state.latest).catch(() => undefined) : undefined;
        return Promise.all([plugin, latest]);
      }),
    initSkillsVersion(io.cwd).catch(() => undefined),
  ]).then(([[plugin, latest], skills]) => {
    facts = { plugin, latest, skills };
    settled = true;
  });
  let first = true;
  let delivered = false;
  return {
    async forCall(client) {
      if (delivered) return undefined;
      if (first) {
        first = false;
        await bounded(gathered, CHECK_TIMEOUT_MS);
      }
      if (delivered || !settled) return undefined;
      delivered = true;
      return facts && sessionWarning({ ...facts, version, install, client: client() });
    },
    keep() {
      delivered = false;
    },
  };
}

function bounded(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise.then(() => undefined), timeout]).finally(() => clearTimeout(timer));
}

/**
 * The version of the plugin that started the server: what its MCP entry says
 * (PLUGIN_VERSION_VARIABLE), else what the manifest in the folder Claude Code
 * names says. Unknown stays unknown; the warning never guesses a version.
 */
export async function pluginVersion(env: Io["env"]): Promise<string | undefined> {
  const said = parseVersion(env[PLUGIN_VERSION_VARIABLE] ?? "")?.text;
  if (said) return said;
  const root = env[CLAUDE_PLUGIN_ROOT_VARIABLE];
  if (!root || !path.isAbsolute(root)) return undefined;
  const manifest = await readJsonFile<{ name?: unknown; version?: unknown }>(path.join(root, ".claude-plugin", "plugin.json"));
  // Another plugin's folder says nothing about this one.
  if (manifest?.name !== PLUGIN_NAME || typeof manifest.version !== "string") return undefined;
  return parseVersion(manifest.version)?.text;
}

const INIT_MARK = /written by `cavelon init --agents` \(cavelon ([0-9][0-9A-Za-z.-]{0,80})\)/;
const SKILL_FOLDER = /^cavelon-[a-z0-9-]{1,64}$/;

/** The oldest kit version among the skill files `init --agents` wrote in the solution folder. */
async function initSkillsVersion(cwd: string): Promise<string | undefined> {
  const root = (await findProject(cwd))?.root ?? cwd;
  let oldest: string | undefined;
  for (const skillRoot of SKILL_ROOTS) {
    let names: string[];
    try {
      names = await fs.readdir(path.join(root, skillRoot));
    } catch {
      continue;
    }
    for (const name of names.filter((n) => SKILL_FOLDER.test(n))) {
      const text = await readTextFile(path.join(root, skillRoot, name, "SKILL.md"));
      if (!isGenerated(text)) continue;
      const found = parseVersion(INIT_MARK.exec(text!)?.[1] ?? "")?.text;
      if (found && (!oldest || newer(oldest, found))) oldest = found;
    }
  }
  return oldest;
}

const PLUGIN_UPDATE = {
  claude: "`claude plugin marketplace update cavelon-dev-kit` and `claude plugin update cavelon@cavelon-dev-kit`",
  codex: "`codex plugin marketplace upgrade cavelon-dev-kit` and `codex plugin add cavelon@cavelon-dev-kit`",
};

/** The plugin's update commands for the client that started the server (MCP's clientInfo.name), or for both. */
function pluginUpdate(client: string | undefined): string | undefined {
  const name = client?.toLowerCase() ?? "";
  if (name.includes("claude")) return PLUGIN_UPDATE.claude;
  if (name.includes("codex")) return PLUGIN_UPDATE.codex;
  return undefined;
}

export interface SessionWarningFacts extends SessionFacts {
  version: string;
  install: Install;
  client?: string;
}

/** One warning for what is behind (cavelon, the plugin, this folder's skills), or nothing. */
export function sessionWarning(facts: SessionWarningFacts): string | undefined {
  const { version, install, plugin, skills } = facts;
  const latest = facts.latest && install.source && newer(facts.latest, version) ? facts.latest : undefined;
  const newest = facts.latest && newer(facts.latest, version) ? facts.latest : version;
  const pluginBehind = plugin !== undefined && newer(newest, plugin);
  const skillsBehind = skills !== undefined && newer(latest ?? version, skills);
  if (!latest && !pluginBehind && !skillsBehind) return undefined;
  const said: string[] = [];
  const asks: string[] = [];
  if (latest) {
    said.push(`cavelon ${latest} is out; this is ${version}.`);
    asks.push(install.update ? `Update cavelon with \`${install.update}\`.` : (install.advice ?? `Update cavelon to ${latest}.`));
  }
  if (pluginBehind) {
    said.push(`The Cavelon plugin is ${plugin}${latest ? "" : `, older than cavelon ${newest}`}.`);
    const commands = pluginUpdate(facts.client);
    asks.push(commands ? `Update the plugin with ${commands}.` : `Update the plugin: in Claude Code with ${PLUGIN_UPDATE.claude}; in Codex with ${PLUGIN_UPDATE.codex}.`);
  } else if (latest && plugin === undefined && pluginUpdate(facts.client)) {
    // The plugin's version is unknown: Codex started a plugin from before
    // PLUGIN_VERSION_VARIABLE, or the person configured the server themselves.
    asks.push(`If they use the Cavelon plugin, also update it with ${pluginUpdate(facts.client)}.`);
  }
  if (skillsBehind) {
    said.push(`The skills \`cavelon init --agents\` wrote in this solution folder are from cavelon ${skills}.`);
    asks.push(`Run \`cavelon init --update\` in it${latest ? " after updating cavelon" : ""}, and commit the result.`);
  }
  if (latest || pluginBehind) asks.push("Then start a new agent session.");
  return `${said.join(" ")} Tell the user: ${asks.join(" ")} More: ${UPDATING_DOCS}`;
}
