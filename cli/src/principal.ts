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
  mode: "tenant" | "platform";
  /**
   * The request's effective permission names in the tenant it acts in (its
   * global role's in Platform mode). Absent on an
   * older instance: then only an API key's scopes say anything up front.
   */
  permissions?: string[];
}

/**
 * Who the credential is. `sendTenant: false` asks without `X-Tenant-Id`, as a
 * Platform-mode request is sent: a personal access token that allows Platform
 * mode then answers in it.
 */
export async function readPrincipal(client: ApiClient, options: { sendTenant?: boolean } = {}): Promise<MetaPrincipal | undefined> {
  const response = await client.get<MetaPrincipal>("/api/v1/meta/principal", { allow: [400, 403, 404, 405], sendTenant: options.sendTenant });
  if (response.status !== 200 || !response.data?.kind) return undefined;
  const { permissions, ...rest } = response.data;
  return Array.isArray(permissions) ? { ...rest, permissions: permissions.filter((p) => typeof p === "string") } : rest;
}

/** How the instance answers a personal access token on a request that names no tenant. */
export type Tenantless =
  /** It acts in this tenant (the token reaches only it, or it is the owner's default), or in Platform mode (null). */
  | { refused: false; tenantId: string | null }
  /** The token works only inside a tenant; the instance's own words. */
  | { refused: true; said: string };

/**
 * Asks `/meta/principal` without `X-Tenant-Id`. A token without Platform mode
 * that the instance cannot place in a tenant on its own is refused there, as
 * on every route: no route tells it which tenants it reaches. Undefined on an
 * instance without the route.
 */
export async function readTenantless(client: ApiClient): Promise<Tenantless | undefined> {
  const response = await client.get<{ mode?: unknown; tenant_id?: unknown; detail?: unknown }>("/api/v1/meta/principal", {
    allow: [400, 403, 404, 405],
    sendTenant: false,
  });
  if (response.status === 403) {
    const detail = response.data?.detail;
    return { refused: true, said: typeof detail === "string" && detail ? detail : "403 Forbidden" };
  }
  if (response.status !== 200 || (response.data?.mode !== "tenant" && response.data?.mode !== "platform")) return undefined;
  const tenantId = response.data.tenant_id;
  return { refused: false, tenantId: response.data.mode === "tenant" && typeof tenantId === "string" ? tenantId : null };
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
