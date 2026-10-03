import { CavelonError, ExitCode, notLoggedIn, usageError } from "./errors.js";
import { ApiClient } from "./http.js";
import { readToken } from "./credentials.js";
import { findProject, readEnvFile, type EnvFile, type ProjectConfig } from "./project.js";
import { loadUserConfig, tokenKind, updateInstance, type InstanceSettings, type TokenKind } from "./user-config.js";

/**
 * Which instance, credential and tenant a command uses.
 *
 * Precedence, highest first (plan 04, "Login"): command-line options, the
 * CAVELON_* variables, `cavelon.yaml` (instance URL and tenant, never a
 * token), the stored login. There is deliberately no option for the token.
 */

export type Source =
  | "option"
  | "CAVELON_URL"
  | "CAVELON_TOKEN"
  | "CAVELON_TENANT"
  | `env/${string}.yaml`
  | "cavelon.yaml"
  | "login"
  | "use";

export interface GlobalOptions {
  json: boolean;
  instance?: string;
  tenant?: string;
  /** `--env <name>`: env/<name>.yaml names the tenant, between CAVELON_TENANT and cavelon.yaml. */
  solutionEnv?: string;
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
  const project = await findProject(cwd);
  const config = await loadUserConfig(env);
  let envFile: EnvFile | undefined;
  if (globals.solutionEnv) {
    if (!project) {
      throw usageError(`--env ${globals.solutionEnv} needs a solution folder.`, "Run it inside a folder with cavelon.yaml, or run `cavelon init` first.");
    }
    envFile = await readEnvFile(project, globals.solutionEnv);
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
  else if (settings.tenant) [session.tenant, session.tenantSource] = [settings.tenant, "use"];
  return session;
}

export function requireInstance(session: Session): string {
  if (!session.url) {
    throw new CavelonError(ExitCode.usage, {
      code: "no_instance",
      message: "No Cavelon instance selected.",
      hint: "Run `cavelon login --instance <url>`, set CAVELON_URL, or work inside a folder with cavelon.yaml.",
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
  memberships?: Array<{ tenant_id: string; tenant_name: string }>;
  accessible_tenants?: Array<{ tenant_id: string; tenant_name: string }>;
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
 * The id behind a tenant slug or name, from what the credential may read:
 * the person's own memberships (by name), the platform's tenant list, then
 * each membership's own detail. Memberships carry no slug and the platform
 * list is an operator's, so for a member the detail is the only published
 * place that names a slug; it needs settings.view in that tenant.
 */
export async function lookupTenantId(client: ApiClient, ref: string): Promise<{ id: string; name?: string } | undefined> {
  if (isUuid(ref)) return { id: ref };
  const wanted = ref.toLowerCase();
  const memberships = new Map<string, string>();
  if (client.target.token?.startsWith("cvpat_")) {
    const me = await client.get<MeResponse>("/api/v1/auth/me", { sendTenant: false, allow: [403, 404] });
    if (me.status === 200 && me.data) {
      const tenants = [...(me.data.memberships ?? []), ...(me.data.accessible_tenants ?? [])];
      const hit = tenants.find((t) => t.tenant_name?.toLowerCase() === wanted || t.tenant_id === ref);
      if (hit) return { id: hit.tenant_id, name: hit.tenant_name };
      for (const t of tenants) if (isUuid(t.tenant_id)) memberships.set(t.tenant_id, t.tenant_name);
    }
  }
  const page = await client.get<TenantPage>("/api/v1/tenants", {
    query: { search: ref, limit: 50 },
    sendTenant: false,
    allow: [400, 403, 404],
  });
  if (page.status === 200) {
    const hit = page.data?.items?.find((t) => t.slug?.toLowerCase() === wanted || t.name?.toLowerCase() === wanted);
    if (hit) return { id: hit.id, name: hit.name };
  }
  for (const [id, name] of [...memberships].slice(0, MAX_SLUG_LOOKUPS)) {
    // An instance without the route, or a member without settings.view there, answers 403 or 404: not this one.
    const detail = await client.get<TenantDetail>(`/api/v1/tenants/${id}`, {
      sendTenant: false,
      headers: { "X-Tenant-Id": id },
      allow: [400, 403, 404, 422],
    });
    if (detail.status === 200 && detail.data?.slug?.toLowerCase() === wanted) return { id, name: detail.data.name ?? name };
  }
  return undefined;
}

/** The tenant id to send, resolving and remembering a slug once per instance. */
export async function resolveTenantId(env: Env, session: Session, client: ApiClient): Promise<string | undefined> {
  if (!session.tenant || !session.url) return undefined;
  if (session.tokenKind === "api_key") return undefined;
  if (isUuid(session.tenant)) return session.tenant;
  const cached = session.settings.tenant_ids?.[session.tenant];
  if (cached) return cached;
  if (session.tenantSource === "use" && session.settings.tenant_id) return session.settings.tenant_id;
  const found = await lookupTenantId(client, session.tenant);
  if (!found) {
    throw new CavelonError(ExitCode.failure, {
      code: "tenant_not_found",
      message: `No tenant "${session.tenant}" that this token can see (from ${session.tenantSource}).`,
      hint: TENANT_REF_HINT,
    });
  }
  const url = session.url;
  const slug = session.tenant;
  await updateInstance(env, url, (current) => ({ ...current, tenant_ids: { ...current.tenant_ids, [slug]: found.id } }));
  return found.id;
}

/** Load the stored settings again, for commands that changed them. */
export async function reloadSettings(env: Env, url: string): Promise<InstanceSettings> {
  return (await loadUserConfig(env)).instances[url] ?? {};
}
