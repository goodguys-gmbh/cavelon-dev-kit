import type { Context } from "./command.js";
import { CavelonError, ExitCode } from "./errors.js";
import type { ApiClient } from "./http.js";
import { readPrincipal, readTenantless } from "./principal.js";
import { isUuid, type Session, type Source } from "./session.js";
import { describeTenant, tenantTitle } from "./tenant-choice.js";
import type { TokenKind } from "./user-config.js";

/**
 * Where a command acts: the instance, the tenant and the mode. A preview
 * names all three, so the person who approves a change sees where it goes,
 * also when an agent passed another tenant or a Platform-mode token has no
 * tenant chosen.
 */

export interface ActingTarget {
  instance: string;
  tenant: { id: string; name: string | null; slug: string | null } | null;
  /**
   * tenant: inside `tenant`; platform: Platform mode, outside any tenant;
   * none: no tenant is chosen and the instance places the token in none;
   * unknown: an older instance does not say where the token acts.
   */
  mode: "tenant" | "platform" | "none" | "unknown";
  credential: TokenKind | null;
  /** Where the tenant was named (--tenant, CAVELON_TENANT, env/<name>.yaml, cavelon.yaml, use, session), or null. */
  tenant_from: string | null;
}

/** How a tenant source reads in a message. */
export function sourceName(source: Source | undefined): string {
  switch (source) {
    case "option":
      return "--tenant";
    case "use":
      return "`cavelon use`";
    case "session":
      return "use_tenant in this MCP session";
    default:
      return source ?? "nowhere";
  }
}

/**
 * A change sent in Platform mode, without X-Tenant-Id (an operator's limit):
 * for the one tenant the command names ("tenant"), or for no tenant in
 * particular ("outside").
 */
export interface PlatformTarget {
  platform?: "tenant" | "outside";
}

const targets = new WeakMap<Context, Map<string, Promise<ActingTarget>>>();

/** Where this command's calls go; read once per command. */
export function actingTarget(ctx: Context, options: PlatformTarget = {}): Promise<ActingTarget> {
  const platform = options.platform ?? "";
  let read = targets.get(ctx);
  if (!read) targets.set(ctx, (read = new Map()));
  let target = read.get(platform);
  if (!target) {
    target = readTarget(ctx, platform);
    read.set(platform, target);
  }
  return target;
}

async function readTarget(ctx: Context, platform: PlatformTarget["platform"] | ""): Promise<ActingTarget> {
  const session = await ctx.session();
  const client = await ctx.client();
  const from = ctx.mode === "mcp" && session.tenantSource === "option" ? "the tenant argument" : sourceName(session.tenantSource);
  const base = { instance: client.url, credential: session.tokenKind ?? null, tenant_from: session.tenant ? from : null };
  const named = async (id: string) => ({ id, ...(await tenantNames(session, client, id)) });
  if (platform === "outside") return { ...base, tenant: null, tenant_from: null, mode: "platform" };
  if (platform === "tenant") return { ...base, tenant: client.target.tenantId ? await named(client.target.tenantId) : null, mode: "platform" };
  if (client.target.tenantId) return { ...base, tenant: await named(client.target.tenantId), mode: "tenant" };
  if (session.tokenKind === "api_key") {
    // A key acts in its own tenant, which only the instance knows.
    const principal = await readPrincipal(client).catch(() => undefined);
    return { ...base, tenant: principal?.tenant_id ? await named(principal.tenant_id) : null, mode: "tenant" };
  }
  const tenantless = await readTenantless(client).catch(() => undefined);
  if (!tenantless) return { ...base, tenant: null, mode: "unknown" };
  if (tenantless.refused) return { ...base, tenant: null, mode: "none" };
  if (tenantless.platform) return { ...base, tenant: null, mode: "platform" };
  if (!tenantless.tenantId) return { ...base, tenant: null, mode: "none" };
  const listed = tenantless.tenants?.find((t) => t.id === tenantless.tenantId);
  const tenant = listed ? { id: listed.id, name: listed.name, slug: listed.slug } : await named(tenantless.tenantId);
  return { ...base, tenant, mode: "tenant", tenant_from: "the token's default tenant" };
}

/** The tenant's name and slug: from the stored choice, the MCP session's, or the instance. */
async function tenantNames(session: Session, client: ApiClient, id: string): Promise<{ name: string | null; slug: string | null }> {
  const chosen = session.sessionTenant?.id === id ? session.sessionTenant : undefined;
  const stored = session.settings.tenant_id === id ? session.settings : undefined;
  let name = chosen?.name ?? stored?.tenant_name ?? null;
  let slug = chosen?.slug ?? stored?.tenant_slug ?? null;
  if (!name || !slug) {
    const described = await describeTenant(client, id);
    name ??= described.name ?? null;
    slug ??= described.slug ?? null;
  }
  return { name, slug };
}

/** "https://cavelon.example.com, tenant Acme (acme, 4f61…), tenant mode": the target in one line. */
export function targetText(target: ActingTarget): string {
  const where =
    target.mode === "platform"
      ? target.tenant
        ? `Platform mode, for tenant ${tenantTitle(target.tenant)}${target.tenant_from ? ` from ${target.tenant_from}` : ""}`
        : "Platform mode, outside any tenant"
      : target.mode === "none"
        ? "no tenant (none is chosen, and the instance places this token in none)"
        : target.tenant
          ? `tenant ${tenantTitle(target.tenant)}${target.tenant_from ? ` from ${target.tenant_from}` : ""}, tenant mode`
          : target.mode === "tenant"
            ? "the API key's own tenant (the instance does not say which), tenant mode"
            : "a tenant the instance does not name (it is too old to say where the token acts)";
  return `${target.instance}, ${where}`;
}

/** The line a preview and its confirm line carry. */
export function targetLine(target: ActingTarget): string {
  return `acts on: ${targetText(target)}`;
}

/**
 * The tenant a tenant API key acts in, checked against the tenant the
 * command was told to act in (--tenant, CAVELON_TENANT, an env file or
 * cavelon.yaml). A key is bound to its own tenant and the instance ignores
 * X-Tenant-Id for it, so a key for tenant A asked to work in tenant B would
 * act in A without a word: refused, naming both. Where the instance does not
 * say which tenant the key is in, or not its name or slug, the kit cannot
 * check, and says so. A tenant chosen with `cavelon use` belongs to an
 * earlier personal access token and is not checked; a key ignores it.
 */
export async function checkKeyTenant(client: ApiClient, session: Session, warn: (message: string) => void): Promise<string | undefined> {
  const ref = session.tenant;
  if (!ref || session.tenantSource === "use" || session.tenantSource === "session") return undefined;
  const from = sourceName(session.tenantSource);
  const principal = await readPrincipal(client);
  const own = principal?.tenant_id ?? undefined;
  if (!own) {
    warn(`The tenant API key acts in its own tenant, and this instance does not say which, so the kit cannot check that it is "${ref}" (from ${from}).`);
    return undefined;
  }
  if (isUuid(ref)) {
    if (ref.toLowerCase() !== own.toLowerCase()) throw keyTenantMismatch(ref, from, { id: own }, principal?.api_key?.name);
    return own;
  }
  const described = await describeTenant(client, own);
  const wanted = ref.toLowerCase();
  if (described.slug?.toLowerCase() === wanted || described.name?.toLowerCase() === wanted) return own;
  if (described.slug || described.name) throw keyTenantMismatch(ref, from, { id: own, ...described }, principal?.api_key?.name);
  warn(
    `The tenant API key acts in its own tenant ${own}; the instance does not tell the key that tenant's slug or name, so the kit cannot check that it is "${ref}" (from ${from}). ` +
      "Name the tenant by its id to have it checked.",
  );
  return own;
}

function keyTenantMismatch(ref: string, from: string, own: { id: string; name?: string; slug?: string }, keyName?: string): CavelonError {
  const key = keyName ? `The tenant API key "${keyName}"` : "The tenant API key";
  return new CavelonError(ExitCode.usage, {
    code: "tenant_mismatch",
    message: `${key} acts only in tenant ${tenantTitle(own)}, but ${from} names tenant "${ref}"; nothing was sent there.`,
    hint:
      "A key is bound to its own tenant and cannot act in another. Use a key of the tenant you name (CAVELON_TOKEN), " +
      `or name the key's tenant, or leave the tenant out where the key is meant.`,
    details: { named: { ref, from }, key_tenant: { id: own.id, name: own.name ?? null, slug: own.slug ?? null } },
  });
}
