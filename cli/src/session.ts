import path from "node:path";
import { cacheDir, configDir } from "./paths.js";
import { CavelonError, ExitCode, notLoggedIn, usageError } from "./errors.js";
import { ApiClient, TENANT_ID_HINT } from "./http.js";
import { readToken } from "./credentials.js";
import { exactMatch } from "./choose.js";
import { readTenantless, type ReachableTenant } from "./principal.js";
import { listsTenants, searchTenants, tenantMissError, type Reach } from "./tenant-choice.js";
import { findProject, readEnvFile, type EnvFile, type ProjectConfig } from "./project.js";
import {
  cachedTenantRef,
  loadUserConfig,
  tokenKind,
  updateInstance,
  withoutTenantRef,
  withTenantRefs,
  type InstanceSettings,
  type TokenKind,
} from "./user-config.js";
import { cavelonCommand, fill } from "./printed.js";

/**
 * Which instance, credential and tenant a command uses.
 *
 * Precedence, highest first (plan 04, "Login"): command-line options, the
 * CAVELON_* variables, `cavelon.yaml` (instance URL and tenant, never a
 * token), the tenant `use_tenant` chose for an MCP session, the stored
 * login. There is deliberately no option for the token.
 */

export type Source =
  | "option"
  | "CAVELON_URL"
  | "CAVELON_TOKEN"
  | "CAVELON_TENANT"
  | `env/${string}.yaml`
  | "cavelon.yaml"
  | "login"
  | "use"
  | "session";

/**
 * A tenant `use_tenant` chose in one MCP session. It lives as long as the
 * server process and is never written to the person's config, so an agent's
 * choice never moves where the person's own commands go.
 */
export interface SessionTenant {
  ref: string;
  id: string;
  name?: string;
  slug?: string;
}

export interface GlobalOptions {
  json: boolean;
  instance?: string;
  tenant?: string;
  /** `--env <name>`: env/<name>.yaml names the tenant, between CAVELON_TENANT and cavelon.yaml. */
  solutionEnv?: string;
  /** The MCP server's tenants chosen with `use_tenant`, per instance URL; never set in a terminal. */
  sessionTenants?: Map<string, SessionTenant>;
}

export interface Session {
  url?: string;
  urlSource?: Source;
  token?: string;
  tokenSource?: "CAVELON_TOKEN" | "login";
  tokenStore?: "keyring" | "file";
  tokenKind?: TokenKind;
  tenant?: string;
  tenantSource?: Source;
  /** The MCP session's choice, when the tenant came from it. */
  sessionTenant?: SessionTenant;
  project?: ProjectConfig;
  /** The env file `--env` named, read once. */
  envFile?: EnvFile;
  settings: InstanceSettings;
  /** CAVELON_TOKEN is set without CAVELON_URL, so it was not used. */
  ignoredEnvToken?: boolean;
}

type Env = Record<string, string | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/** The canonical form of an instance URL; tokens are stored under it. */
export function normalizeUrl(input: string, env: Env = {}): string {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw usageError(`"${input}" is not an instance URL.`, "Pass it as https://cavelon.example.com.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw usageError(`"${input}" is not an http(s) URL.`);
  if (url.username || url.password) throw usageError("The instance URL must not contain credentials.");
  if (url.protocol === "http:" && !isLocalHost(url.hostname) && env.CAVELON_ALLOW_HTTP !== "1") {
    throw usageError(
      `Refusing to send a token over plain http to ${url.host}.`,
      "Use https. For a test instance on a private network, set CAVELON_ALLOW_HTTP=1.",
    );
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host.toLowerCase()}${pathname}`;
}

/** Whether `input` names the instance `url`; an unusable input names none. */
function sameUrl(input: string | undefined, url: string, env: Env): boolean {
  if (!input) return false;
  try {
    return normalizeUrl(input, env) === url;
  } catch {
    return false;
  }
}

export async function resolveSession(env: Env, cwd: string, globals: GlobalOptions): Promise<Session> {
  const privateDirs = [configDir(env), cacheDir(env)].map(dir => path.resolve(cwd, dir));
  const project = await findProject(cwd, privateDirs);
  const config = await loadUserConfig(env);
  let envFile: EnvFile | undefined;
  if (globals.solutionEnv) {
    if (!project) {
      throw usageError(`--env ${globals.solutionEnv} needs a solution folder.`, `Run it inside a folder with cavelon.yaml, or run \`${cavelonCommand("init")}\` first.`);
    }
    envFile = await readEnvFile(project, globals.solutionEnv, privateDirs);
  }

  // A source is normalised (and refused) only where it is the one chosen: an
  // unusable CAVELON_URL or cavelon.yaml instance never blocks --instance.
  let url: string | undefined;
  let urlSource: Source | undefined;
  if (globals.instance) [url, urlSource] = [normalizeUrl(globals.instance, env), "option"];
  else if (env.CAVELON_URL) [url, urlSource] = [normalizeUrl(env.CAVELON_URL, env), "CAVELON_URL"];
  else if (project?.instance) [url, urlSource] = [normalizeUrl(project.instance, env), "cavelon.yaml"];
  else if (config.current_instance) [url, urlSource] = [config.current_instance, "login"];

  const settings = (url && config.instances[url]) || {};
  const session: Session = { url, urlSource, project, envFile, settings };
  if (!url) return session;

  // CAVELON_TOKEN belongs to CAVELON_URL and is used only with it: it is never
  // sent to an instance that an option or a (possibly foreign) cavelon.yaml names.
  if (env.CAVELON_TOKEN && !env.CAVELON_URL) session.ignoredEnvToken = true;
  if (env.CAVELON_TOKEN && sameUrl(env.CAVELON_URL, url, env)) {
    session.token = env.CAVELON_TOKEN.trim();
    session.tokenSource = "CAVELON_TOKEN";
  } else {
    const stored = await readToken(env, url, settings.credential_store);
    if (stored) {
      session.token = stored.token;
      session.tokenSource = "login";
      session.tokenStore = stored.store;
    }
  }
  if (session.token) session.tokenKind = tokenKind(session.token);

  const projectMatches = project && (!project.instance || sameUrl(project.instance, url, env));
  if (globals.tenant) [session.tenant, session.tenantSource] = [globals.tenant, "option"];
  else if (env.CAVELON_TENANT) [session.tenant, session.tenantSource] = [env.CAVELON_TENANT.trim(), "CAVELON_TENANT"];
  else if (projectMatches && envFile?.tenant) [session.tenant, session.tenantSource] = [envFile.tenant, `env/${envFile.name}.yaml`];
  else if (projectMatches && project?.tenant) [session.tenant, session.tenantSource] = [project.tenant, "cavelon.yaml"];
  else if (globals.sessionTenants?.get(url)) {
    session.sessionTenant = globals.sessionTenants.get(url)!;
    [session.tenant, session.tenantSource] = [session.sessionTenant.ref, "session"];
  } else if (settings.tenant) [session.tenant, session.tenantSource] = [settings.tenant, "use"];
  return session;
}

export function requireInstance(session: Session): string {
  if (!session.url) {
    throw new CavelonError(ExitCode.usage, {
      code: "no_instance",
      message: "No Cavelon instance selected.",
      hint: `Run \`${cavelonCommand("login", "--instance", fill("url"))}\`, set CAVELON_URL, or work inside a folder with cavelon.yaml.`,
    });
  }
  return session.url;
}

export function requireToken(session: Session): string {
  const url = requireInstance(session);
  if (!session.token) {
    if (session.ignoredEnvToken) {
      throw new CavelonError(ExitCode.unauthorized, {
        code: "not_logged_in",
        message: `No token for ${url}: CAVELON_TOKEN is set, but CAVELON_URL is not.`,
        hint: "Set CAVELON_URL to the instance the token belongs to; CAVELON_TOKEN is sent only there.",
      });
    }
    throw notLoggedIn(url);
  }
  return session.token;
}

interface MeResponse {
  memberships?: Array<{ tenant_id: string; tenant_name: string; tenant_slug?: string | null }>;
  accessible_tenants?: Array<{ tenant_id: string; tenant_name: string; tenant_slug?: string | null }>;
}

interface TenantPage {
  items?: Array<{ id: string; slug: string; name: string }>;
}

interface TenantDetail {
  id?: string;
  slug?: string;
  name?: string;
}

/** At most this many of a person's tenants are asked for their slug, so a lookup stays bounded. */
const MAX_SLUG_LOOKUPS = 25;

/** Said wherever a slug was not found: a member's token finds a slug only where it may read the tenant's settings. */
export const TENANT_REF_HINT =
  "Use the tenant's name or id instead: a member's token finds a tenant by its slug only where it may view the tenant's settings. `cavelon tenant list` shows the names and ids.";

/**
 * The refusal of a personal access token that works only inside a tenant,
 * asked without one. `said` is the instance's own words.
 */
export function tenantRequiredError(url: string, said: string, lead = "No tenant is chosen"): CavelonError {
  return new CavelonError(ExitCode.usage, {
    code: "tenant_required",
    status: 403,
    message: `${lead}, and ${url} answers this token only inside a tenant: ${said}`,
    hint: TENANT_ID_HINT,
  });
}

/** A tenant found by name, slug or id; name and slug when the instance told them. */
export interface FoundTenant {
  id: string;
  name?: string;
  slug?: string;
}

/**
 * The tenant behind a name, slug or id. A recent instance lists the tenants
 * a personal access token reaches without a tenant, and an operator's token
 * that reaches every tenant searches them, so the match comes from there. An
 * older instance lists none: then from what the credential may read, the
 * person's own memberships (by name), the platform's tenant list, then each
 * membership's own detail, where a member finds a slug only with
 * settings.view in that tenant.
 */
export async function lookupTenantId(client: ApiClient, ref: string, from?: string): Promise<FoundTenant> {
  if (isUuid(ref)) return { id: ref };
  if (client.target.token?.startsWith("cvpat_")) {
    const reach = await readTenantless(client);
    // A Platform-mode token lists only its owner's memberships here, and finds every tenant in the platform's list below.
    if (listsTenants(reach) && !reach.platform) return findInReach(client, reach, ref, from);
  }
  const lookup = await findTenant(client, ref);
  if (lookup.found) return lookup.found;
  throw tenantNotFoundError(ref, lookup.known, from);
}

function foundOf(tenant: ReachableTenant): FoundTenant {
  return { id: tenant.id, ...(tenant.name ? { name: tenant.name } : {}), ...(tenant.slug ? { slug: tenant.slug } : {}) };
}

async function findInReach(client: ApiClient, reach: Reach, ref: string, from?: string): Promise<FoundTenant> {
  const own = exactMatch(reach.tenants, ref);
  if (own) return foundOf(own);
  const pool = [...reach.tenants];
  if (reach.reachesAll) {
    // Each word too, so "acme support" still finds "acme-support" through its name.
    const words = [ref, ...ref.split(/[\s_-]+/).filter((w) => w.length >= 3 && w !== ref)].slice(0, 4);
    for (const word of words) {
      const found = await searchTenants(client, word);
      const hit = exactMatch(found, ref);
      if (hit) return foundOf(hit);
      for (const t of found) if (!pool.some((p) => p.id === t.id)) pool.push(t);
      if (pool.length > reach.tenants.length) break;
    }
  }
  throw tenantMissError(ref, pool, reach.reachesAll, from);
}

/** At most this many of a person's tenants are named in a refusal. */
const MAX_NAMED_TENANTS = 20;

/** A tenant not found by its name or slug, naming the person's tenants where the instance told them. */
function tenantNotFoundError(ref: string, known: Map<string, string>, from?: string): CavelonError {
  const tenants = [...known].map(([id, name]) => ({ id, name: name || null }));
  const named = tenants.slice(0, MAX_NAMED_TENANTS).map((t) => (t.name ? `${t.name} (${t.id})` : t.id));
  if (tenants.length > MAX_NAMED_TENANTS) named.push(`and ${tenants.length - MAX_NAMED_TENANTS} more`);
  return new CavelonError(ExitCode.failure, {
    code: "tenant_not_found",
    message: `No tenant "${ref}" that this token can see${from ? ` (from ${from})` : ""}.${named.length ? ` Your tenants: ${named.join(", ")}.` : ""}`,
    hint: TENANT_REF_HINT,
    details: tenants.length ? { tenants } : undefined,
  });
}

async function findTenant(client: ApiClient, ref: string): Promise<{ found?: FoundTenant; known: Map<string, string> }> {
  const wanted = ref.toLowerCase();
  const memberships = new Map<string, string>();
  if (client.target.token?.startsWith("cvpat_")) {
    const me = await client.get<MeResponse & { detail?: unknown }>("/api/v1/auth/me", { sendTenant: false, allow: [403, 404] });
    // Refused without a tenant: no route names this token's tenants, so only an id finds one.
    if (me.status === 403) {
      const said = typeof me.data?.detail === "string" ? me.data.detail : "403 Forbidden";
      throw tenantRequiredError(client.url, said, `Cannot find tenant "${ref}" by its name or slug`);
    }
    if (me.status === 200 && me.data) {
      const tenants = [...(me.data.memberships ?? []), ...(me.data.accessible_tenants ?? [])];
      const hit = tenants.find((t) => t.tenant_name?.toLowerCase() === wanted || t.tenant_slug?.toLowerCase() === wanted || t.tenant_id === ref);
      for (const t of tenants) if (isUuid(t.tenant_id)) memberships.set(t.tenant_id, t.tenant_name);
      if (hit) return { found: { id: hit.tenant_id, name: hit.tenant_name, ...(hit.tenant_slug ? { slug: hit.tenant_slug } : {}) }, known: memberships };
    }
  }
  const page = await client.get<TenantPage>("/api/v1/tenants", {
    query: { search: ref, limit: 50 },
    sendTenant: false,
    allow: [400, 403, 404],
  });
  if (page.status === 200) {
    const hit = page.data?.items?.find((t) => t.slug?.toLowerCase() === wanted || t.name?.toLowerCase() === wanted);
    if (hit) return { found: { id: hit.id, name: hit.name, slug: hit.slug }, known: memberships };
  }
  for (const [id, name] of [...memberships].slice(0, MAX_SLUG_LOOKUPS)) {
    // An instance without the route, or a member without settings.view there, answers 403 or 404: not this one.
    const detail = await client.get<TenantDetail>(`/api/v1/tenants/${id}`, {
      sendTenant: false,
      headers: { "X-Tenant-Id": id },
      allow: [400, 403, 404, 422],
    });
    if (detail.status === 200 && detail.data?.slug?.toLowerCase() === wanted) return { found: { id, name: detail.data.name ?? name, slug: detail.data.slug }, known: memberships };
  }
  return { known: memberships };
}

/** The tenant id to send as far as it is known without asking the instance; undefined also for a slug not resolved yet. */
export function knownTenantId(session: Session, now: Date = new Date()): string | undefined {
  if (!session.tenant || !session.url) return undefined;
  if (session.tokenKind === "api_key") return undefined;
  if (isUuid(session.tenant)) return session.tenant;
  if (session.tenantSource === "session" && session.sessionTenant) return session.sessionTenant.id;
  if (session.tenantSource === "use" && session.settings.tenant_id) return session.settings.tenant_id;
  return cachedTenantRef(session.settings, session.tenant, session.token, now);
}

/**
 * The tenant id to send. A name or slug is resolved once per credential and
 * day, and remembered; one taken from that cache is resolved again when the
 * instance refuses a request in it with 403 or 404 (ApiClient.revalidateTenant),
 * so a renamed or reused slug never keeps sending the old tenant's id.
 */
export async function resolveTenantId(env: Env, session: Session, client: ApiClient, now: Date = new Date()): Promise<string | undefined> {
  if (!session.tenant || !session.url) return undefined;
  if (session.tokenKind === "api_key") return undefined;
  const known = knownTenantId(session, now);
  const url = session.url;
  const slug = session.tenant;
  const fromCache = known !== undefined && !isUuid(slug) && session.tenantSource !== "use" && session.tenantSource !== "session";
  const resolve = async (): Promise<string> => {
    const found = await lookupTenantId(client, slug, session.tenantSource);
    if (client.target.token) {
      const token = client.target.token;
      await updateInstance(env, url, (current) => withTenantRefs(current, [slug], found.id, token, now));
    }
    return found.id;
  };
  if (!fromCache) return known ?? resolve();
  client.revalidateTenant = async () => {
    await updateInstance(env, url, (current) => withoutTenantRef(current, slug));
    const fresh = await resolve().catch(() => undefined);
    if (!fresh || fresh === client.target.tenantId) return false;
    client.target.tenantId = fresh;
    return true;
  };
  return known;
}

/** Load the stored settings again, for commands that changed them. */
export async function reloadSettings(env: Env, url: string): Promise<InstanceSettings> {
  return (await loadUserConfig(env)).instances[url] ?? {};
}
