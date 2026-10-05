import { closest, displayName, MAX_LISTED, pick } from "./choose.js";
import type { Context } from "./command.js";
import { CavelonError, ExitCode } from "./errors.js";
import type { ApiClient } from "./http.js";
import { readTenantless, type ReachableTenant, type Tenantless } from "./principal.js";
import { canAsk } from "./prompt.js";
import { cavelonCommand } from "./shell.js";

/**
 * Which tenant a personal access token works in, chosen from the tenants a
 * recent instance says it reaches: the only one, the one a person picks on a
 * terminal, or none yet, with one ready command per tenant. An older instance
 * lists none; the callers keep their behaviour there.
 */

/** A tenantless answer that lists the token's tenants. */
export type Reach = Extract<Tenantless, { refused: false }> & { tenants: ReachableTenant[] };

export function listsTenants(tenantless: Tenantless | undefined): tenantless is Reach {
  return Boolean(tenantless && !tenantless.refused && tenantless.tenants);
}

export type TenantChoice =
  /** One tenant: the only one the token reaches, or the one the person picked. */
  | { kind: "chosen"; tenant: ReachableTenant; how: "only" | "picked" }
  /** The token reaches no tenant. */
  | { kind: "none" }
  /** Several, and nobody to ask. */
  | { kind: "open" }
  /** Every tenant, and the person chose to pick one later. */
  | { kind: "later" };

/** What a person types to work in this tenant: its slug, else its id. */
export function tenantRef(tenant: Pick<ReachableTenant, "slug" | "id">): string {
  return tenant.slug ?? tenant.id;
}

/** "Acme Support (acme-support, 4f61…)": everything that names the tenant. */
export function tenantTitle(tenant: { id: string; name?: string | null; slug?: string | null }): string {
  const names = [tenant.slug && tenant.slug !== tenant.name ? tenant.slug : undefined, tenant.id].filter(Boolean).join(", ");
  return tenant.name ? `${tenant.name} (${names})` : tenant.slug ? `${tenant.slug} (${tenant.id})` : tenant.id;
}

/** The tenants an operator's token finds by part of a name or slug, up to the instance's bound. */
export async function searchTenants(client: ApiClient, text: string): Promise<ReachableTenant[]> {
  const found = await readTenantless(client, { search: text });
  return found && !found.refused ? (found.tenants ?? []) : [];
}

/**
 * `later`: a token that reaches every tenant may leave the choice for later
 * (Enter), for `login`, where any tenant stays one `cavelon use` away. A
 * token for a list of tenants still chooses one: Enter there takes the
 * default the instance marks.
 */
export async function chooseTenant(ctx: Context, client: ApiClient, reach: Reach, options: { later?: boolean } = {}): Promise<TenantChoice> {
  const { tenants, reachesAll } = reach;
  if (!reachesAll && tenants.length === 1) return { kind: "chosen", tenant: tenants[0]!, how: "only" };
  if (!reachesAll && tenants.length === 0) return { kind: "none" };
  if (!canAsk(ctx)) return { kind: "open" };
  const later = reachesAll && options.later;
  const intro = later
    ? `This token works in every tenant on ${client.url}, one at a time: \`cavelon use\` switches, ` +
      `and --tenant or \`tenant:\` in cavelon.yaml choose one per command or per solution folder.${tenants.length ? "\nYours:" : ""}`
    : reachesAll
      ? `This token reaches every tenant on ${client.url}.${tenants.length ? " Yours:" : ""}`
      : `This token reaches ${tenants.length} tenants on ${client.url}:`;
  const picked = await pick(ctx, {
    intro,
    question: later ? "Which tenant to start in?" : "Which tenant?",
    items: tenants,
    extra: (t) => t.role ?? undefined,
    preferred: tenants.find((t) => t.is_default),
    search: reachesAll ? (text) => searchTenants(client, text) : undefined,
    ...(later ? { later: "choose later" } : {}),
  });
  if ("later" in picked) return { kind: "later" };
  if (!("item" in picked)) throw new Error("unreachable: the tenant list offers no other entry");
  return { kind: "chosen", tenant: picked.item, how: "picked" };
}

/** One ready command per tenant, e.g. "  cavelon use acme-support    Acme Support". */
export function commandLines(tenants: ReachableTenant[], command: (ref: string) => string): string {
  const shown = tenants.slice(0, MAX_LISTED).map((t) => ({ text: command(tenantRef(t)), name: t.name && t.name !== t.slug ? t.name : "" }));
  const width = Math.max(...shown.map((s) => s.text.length));
  const lines = shown.map((s) => `  ${s.name ? `${s.text.padEnd(width)}    ${s.name}` : s.text}`);
  if (tenants.length > shown.length) lines.push(`  … and ${tenants.length - shown.length} more (\`cavelon tenant list\` lists them)`);
  return lines.join("\n");
}

export function choicesOf(tenants: ReachableTenant[], command: (ref: string) => string) {
  return tenants.map((t) => ({ id: t.id, slug: t.slug, name: t.name, role: t.role, is_default: t.is_default, command: command(tenantRef(t)) }));
}

/**
 * The token reaches several tenants (or every one) and there is no terminal
 * to ask which: one ready command per tenant. `lead` says what already
 * happened, for example that the token was stored.
 */
export function tenantOpenError(
  url: string,
  reach: Reach,
  lead: string,
  command: { line(ref: string): string; template: string } = { line: (ref) => cavelonCommand("use", ref), template: "cavelon use <name or slug>" },
): CavelonError {
  const { tenants, reachesAll } = reach;
  const what = reachesAll ? "every tenant" : `${tenants.length} tenants`;
  const lines = tenants.length ? `Run the line for the tenant you want:\n${commandLines(tenants, command.line)}` : "";
  const search = reachesAll
    ? `${lines ? "\nAny other tenant: " : "Choose one: "}\`${command.template}\`; \`cavelon tenant list --search <part of the name>\` finds its slug.`
    : "";
  return new CavelonError(ExitCode.usage, {
    code: "tenant_required",
    message: `${lead}This token reaches ${what} on ${url}, and there is no terminal to ask which one to use.`,
    hint: `${lines}${search}`,
    details: { tenants: choicesOf(tenants, command.line), reaches_all_tenants: reachesAll },
  });
}

/** The token reaches no tenant at all. */
export function noTenantError(url: string, atLogin = true): CavelonError {
  return new CavelonError(ExitCode.unauthorized, {
    code: "no_tenant_reached",
    message: `This token reaches no tenant on ${url}${atLogin ? ", so nothing was stored" : ""}.`,
    hint:
      `Open ${url}/account/access-tokens, create a token for the tenant you work in (or ask a tenant administrator to add you to one), ` +
      "then run `cavelon login` again with the new token.",
  });
}

/** A tenant not found by name, slug or id among those the token reaches, naming the closest ones. */
export function tenantMissError(ref: string, pool: ReachableTenant[], reachesAll: boolean, from?: string): CavelonError {
  const near = closest(pool, ref);
  const listed = near.length ? near : pool.slice(0, MAX_LISTED);
  const label = near.length ? "Closest" : "This token reaches";
  const names = listed.map(displayName).join(", ");
  const hints: string[] = [];
  if (listed.length) hints.push(`Run the line for the tenant you mean:\n${commandLines(listed, (r) => cavelonCommand("use", r))}`);
  hints.push(
    reachesAll
      ? "This token reaches every tenant: `cavelon tenant list --search <part of the name>` finds one."
      : "`cavelon tenant list` shows the tenants this token reaches with name, slug and id; `cavelon use` alone lets you choose.",
  );
  return new CavelonError(ExitCode.failure, {
    code: "tenant_not_found",
    message: `No tenant "${ref}" that this token reaches${from ? ` (from ${from})` : ""}.${names ? ` ${label}: ${names}.` : ""}`,
    hint: hints.join("\n"),
    details: { tenants: listed.map((t) => ({ id: t.id, slug: t.slug, name: t.name })) },
  });
}

/**
 * The name and slug of a tenant known only by its id (from cavelon.yaml,
 * --tenant or CAVELON_TENANT): the tenant's own record where the token may
 * read it, else the tenants `/meta/principal` lists for that id. Empty when
 * the instance tells neither; nothing is ever guessed.
 */
export async function describeTenant(client: ApiClient, id: string): Promise<{ name?: string; slug?: string }> {
  try {
    const detail = await client.get<{ name?: unknown; slug?: unknown }>(`/api/v1/tenants/${encodeURIComponent(id)}`, {
      sendTenant: false,
      headers: { "X-Tenant-Id": id },
      allow: [400, 401, 403, 404, 405, 422],
    });
    const name = typeof detail.data?.name === "string" && detail.data.name ? detail.data.name : undefined;
    const slug = typeof detail.data?.slug === "string" && detail.data.slug ? detail.data.slug : undefined;
    if (detail.status === 200 && (name || slug)) return { ...(name ? { name } : {}), ...(slug ? { slug } : {}) };
    const found = await readTenantless(client, { search: id });
    const hit = found && !found.refused ? found.tenants?.find((t) => t.id === id) : undefined;
    return hit ? { ...(hit.name ? { name: hit.name } : {}), ...(hit.slug ? { slug: hit.slug } : {}) } : {};
  } catch {
    return {};
  }
}
