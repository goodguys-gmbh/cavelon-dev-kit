import type { ApiClient } from "./http.js";

/**
 * `GET /api/v1/meta/principal`: who the credential of a request is (the
 * person, the personal access token or the API key), its expiry and whether
 * it may activate. Never a secret. Undefined on an instance without the route.
 */

export interface MetaPrincipal {
  kind: "session" | "personal_access_token" | "api_key";
  user: { id: string; email: string } | null;
  token: {
    id: string;
    name: string;
    prefix: string;
    expires_at: string;
    ceiling_role: string;
    platform_mode_allowed: boolean;
    may_activate: boolean;
  } | null;
  api_key: {
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    expires_at: string | null;
    harness_ids: string[] | null;
  } | null;
  tenant_id: string | null;
  /** "none": asked without a tenant, a token that acts only in a tenant it names (its ceiling leaves it no platform role). */
  mode: "tenant" | "platform" | "none";
  /**
   * The request's effective permission names in the tenant it acts in (its
   * global role's in Platform mode). Absent on an
   * older instance: then only an API key's scopes say anything up front.
   */
  permissions?: string[];
  /**
   * The tenant the request acts in, with its name and slug. Absent on an
   * older instance, which names only `tenant_id`.
   */
  tenant?: { id: string; name: string | null; slug: string | null } | null;
  /**
   * The operations `permissions` would allow that this credential still
   * cannot run, because a person runs them. Absent on an older instance,
   * whose `permissions` are also not what the routes accept for an API key
   * nor say whether a token may activate (see access.ts).
   */
  needs_a_person?: OperationNeedingAPerson[];
  /** Conditional identity restrictions; the operation remains usable outside the named case. */
  needs_a_person_when?: OperationNeedingAPerson[];
}

/** An operation the instance says this credential cannot run, because a person runs it. */
export interface OperationNeedingAPerson {
  /** The OpenAPI operationId; null where the instance has none for it. */
  operation: string | null;
  method: string;
  /** The path as the OpenAPI names it (`/api/v1/secrets/{name}`). */
  path: string;
  reason: string;
}

/**
 * Who the credential is. `sendTenant: false` asks without `X-Tenant-Id`, as a
 * Platform-mode request is sent: a personal access token that allows Platform
 * mode then answers in it.
 */
export async function readPrincipal(client: ApiClient, options: { sendTenant?: boolean } = {}): Promise<MetaPrincipal | undefined> {
  const response = await client.get<MetaPrincipal>("/api/v1/meta/principal", { allow: [400, 403, 404, 405], sendTenant: options.sendTenant });
  if (response.status !== 200 || !response.data?.kind) return undefined;
  const { permissions, needs_a_person: needsAPerson, needs_a_person_when: needsAPersonWhen, tenant, ...rest } = response.data;
  const principal: MetaPrincipal = rest;
  if (Array.isArray(permissions)) principal.permissions = permissions.filter((p) => typeof p === "string");
  if (Array.isArray(needsAPerson)) principal.needs_a_person = operationsNeedingAPerson(needsAPerson);
  if (Array.isArray(needsAPersonWhen)) principal.needs_a_person_when = conditionalOperations(needsAPersonWhen);
  if (tenant === null) principal.tenant = null;
  else if (tenant && typeof tenant === "object" && typeof tenant.id === "string") {
    const text = (v: unknown) => (typeof v === "string" && v ? v : null);
    principal.tenant = { id: tenant.id, name: text(tenant.name), slug: text(tenant.slug) };
  }
  return principal;
}

/** Discard malformed guidance rather than turn arbitrary response values into authority. */
function conditionalOperations(value: unknown[]): OperationNeedingAPerson[] {
  return value
    .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === "object" && !Array.isArray(o))
    .filter((o) => typeof o.method === "string" && ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"].includes(o.method.toUpperCase())
      && typeof o.path === "string" && o.path.startsWith("/") && !/[\s?#]/.test(o.path)
      && (o.operation === null || typeof o.operation === "string") && typeof o.reason === "string")
    .map((o) => ({ operation: o.operation as string | null, method: (o.method as string).toUpperCase(), path: o.path as string, reason: o.reason as string }));
}

function operationsNeedingAPerson(value: unknown[]): OperationNeedingAPerson[] {
  return value
    .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === "object")
    .filter((o) => typeof o.method === "string" && typeof o.path === "string")
    .map((o) => ({
      operation: typeof o.operation === "string" && o.operation ? o.operation : null,
      method: (o.method as string).toUpperCase(),
      path: o.path as string,
      reason: typeof o.reason === "string" ? o.reason : "",
    }));
}

/** A tenant a personal access token reaches, as `/meta/principal` without a tenant lists it on a recent instance. */
export interface ReachableTenant {
  id: string;
  slug: string | null;
  name: string | null;
  /** The token's role there: the lesser of the person's role and the token's ceiling. */
  role: string | null;
  /** The tenant the instance places the token in when a request names none. */
  is_default: boolean;
}

/** How the instance answers a personal access token on a request that names no tenant. */
export type Tenantless =
  | {
      refused: false;
      /** The tenant it acts in (the token reaches only it, or it is the owner's default); null in Platform mode or nowhere. */
      tenantId: string | null;
      platform: boolean;
      /**
       * The tenants the token reaches. Undefined on an instance that does not
       * list them; then only an id or a membership's name finds a tenant.
       */
      tenants?: ReachableTenant[];
      /** An operator's token without a tenant allowlist: it reaches every tenant, and `search` finds them. */
      reachesAll: boolean;
    }
  /** The token works only inside a tenant, and the instance tells it nothing without one; its own words. */
  | { refused: true; said: string };

/** Tenants per page of the list, the most an instance serves at once. */
const TENANT_PAGE = 200;
/** A list longer than this many pages is cut there, so a lookup stays bounded; a search finds the rest. */
const MAX_TENANT_PAGES = 5;

function reachableTenants(value: unknown): ReachableTenant[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = (v: unknown) => (typeof v === "string" && v ? v : null);
  return value
    .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object" && typeof (t as { id?: unknown }).id === "string")
    .map((t) => ({ id: t.id as string, slug: text(t.slug), name: text(t.name), role: text(t.role), is_default: t.is_default === true }));
}

/**
 * Asks `/meta/principal` without `X-Tenant-Id`. A recent instance answers
 * every personal access token there and lists the tenants it reaches; with
 * `search`, an operator's token that reaches every tenant gets the tenants
 * whose name or slug holds the text. An older one refuses a token without
 * Platform mode that it cannot place in a tenant on its own, as on every
 * route. Undefined on an instance without the route.
 */
export async function readTenantless(client: ApiClient, options: { search?: string } = {}): Promise<Tenantless | undefined> {
  type Answer = { mode?: unknown; tenant_id?: unknown; detail?: unknown; tenants?: unknown; reaches_all_tenants?: unknown; next_cursor?: unknown; token?: { platform_mode_allowed?: unknown } | null };
  const read = (cursor?: string) =>
    client.get<Answer>("/api/v1/meta/principal", {
      allow: [400, 403, 404, 405, 422],
      sendTenant: false,
      // One page answers a search; the whole list is read in the largest pages the instance serves.
      query: options.search !== undefined ? { search: options.search } : { limit: TENANT_PAGE, cursor },
    });
  const response = await read();
  if (response.status === 403) {
    const detail = response.data?.detail;
    return { refused: true, said: typeof detail === "string" && detail ? detail : "403 Forbidden" };
  }
  if (response.status !== 200 || !response.data) return undefined;
  const { mode, tenant_id: tenantId } = response.data;
  let tenants = reachableTenants(response.data.tenants);
  let next = response.data.next_cursor;
  for (let pages = 1; tenants && options.search === undefined && typeof next === "string" && next && pages < MAX_TENANT_PAGES; pages++) {
    const page = await read(next);
    const more = page.status === 200 ? reachableTenants(page.data?.tenants) : undefined;
    if (!more) break;
    tenants = [...tenants, ...more];
    next = page.data?.next_cursor;
  }
  const reachesAll = response.data.reaches_all_tenants === true;
  if (mode === "tenant" && typeof tenantId === "string") return { refused: false, tenantId, platform: false, tenants, reachesAll };
  // A token that does not allow Platform mode is never in it, whatever an instance calls the state of acting nowhere.
  if (mode === "platform" && response.data.token?.platform_mode_allowed !== false) return { refused: false, tenantId: null, platform: true, tenants, reachesAll };
  if (!tenants) return undefined;
  return { refused: false, tenantId: null, platform: false, tenants, reachesAll };
}

/** The person's global role from `/api/v1/auth/me` (a platform operator's), or undefined when it is not readable. */
export async function readGlobalRole(client: ApiClient): Promise<string | null | undefined> {
  const response = await client.get<{ global_role?: unknown }>("/api/v1/auth/me", { allow: [400, 401, 403, 404], sendTenant: false });
  if (response.status !== 200 || !response.data) return undefined;
  const role = response.data.global_role;
  return typeof role === "string" && role ? role : null;
}

export const EXPIRY_WARNING_DAYS = 7;

/** The credential's expiry, and a warning when it is within a week or past. */
export function expiryOf(principal: MetaPrincipal | undefined, now: Date): { expires_at: string | null; days_left: number | null; warning?: string } {
  const expiresAt = principal?.token?.expires_at ?? principal?.api_key?.expires_at ?? null;
  if (!expiresAt) return { expires_at: null, days_left: null };
  const ms = new Date(expiresAt).getTime() - now.getTime();
  const days = Math.floor(ms / 86_400_000);
  const what = principal?.token ? `The personal access token "${principal.token.name}"` : `The API key "${principal?.api_key?.name}"`;
  if (ms <= 0) return { expires_at: expiresAt, days_left: days, warning: `${what} has expired.` };
  if (ms <= EXPIRY_WARNING_DAYS * 86_400_000) {
    const when = days < 1 ? "within a day" : `in ${days} day${days === 1 ? "" : "s"}`;
    const renew = principal?.token
      ? "A person creates a new one on /account/access-tokens and runs `cavelon login`."
      : "A tenant administrator issues a new key in Settings → API keys.";
    return { expires_at: expiresAt, days_left: days, warning: `${what} expires ${when} (${expiresAt}). ${renew}` };
  }
  return { expires_at: expiresAt, days_left: days };
}
