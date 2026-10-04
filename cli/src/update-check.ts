import path from "node:path";
import type { Install } from "./install.js";
import { NPM_PACKAGE, REPOSITORY } from "./install.js";
import type { Io } from "./io.js";
import { readJsonFile, writeFileAtomic } from "./fsutil.js";
import { cacheDir } from "./paths.js";

/**
 * Once a day, look up the latest release where this install updates from (the
 * GitHub release for the executables, the npm registry for npm) and say once
 * when a newer one exists, with the command that updates it. It runs beside
 * the command, never delays it by more than a short timeout, sends nothing but
 * the request, and stays silent on any failure. Only for a person at a
 * terminal: never with --json, in MCP mode, in CI or for npx, which already
 * runs the newest release it may.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 1500;
const MAX_BODY = 1024 * 1024;
const STATE_FILE = "update-check.json";

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
  const source = install.source!;
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
    const latest = await latestVersion(source, version, request.fetch ?? fetch).catch(() => undefined);
    if (latest) state.latest = latest;
  }
  let notice: string | undefined;
  if (state.latest && newer(state.latest, version) && !within(state.notified_at, now)) {
    notice = noticeText(state.latest, version, install);
    state.notified_at = now.toISOString();
  }
  if (JSON.stringify(state) !== before) await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`, 0o600, 0o700);
  return notice;
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
