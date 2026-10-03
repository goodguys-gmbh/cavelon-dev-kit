import {
  boolOption,
  CURSOR_OPTION,
  intOption,
  LIMIT_OPTION,
  pageOf,
  positional,
  stringOption,
  type CommandSpec,
  type Context,
} from "../command.js";
import { CavelonError, ExitCode, usageError } from "../errors.js";
import { keyValues, moreHint, table } from "../format.js";
import { callStable } from "../invoke.js";
import { formatQuota, limitError, limitsOrWarn, readQuotas } from "../limits.js";
import { isUuid, requireInstance } from "../session.js";
import { cavelonCommand } from "../shell.js";
import { rememberTenant } from "./session.js";

/**
 * Tenants and solutions. Each command wraps one stable operation, looked up
 * in the instance's OpenAPI; the request bodies carry only the fields that
 * operation's published schema names.
 */

interface Tenant {
  id: string;
  slug: string;
  name: string;
  plan?: string;
  status?: string;
}

interface Harness {
  id: string;
  slug: string;
  name: string;
  status: string;
  is_default?: boolean;
  description?: string | null;
  readiness?: { ready_to_activate?: boolean } | null;
}

function idempotency(key: string | undefined): Record<string, string> | undefined {
  return key ? { "Idempotency-Key": key } : undefined;
}

const IDEMPOTENCY_OPTION = {
  type: "string" as const,
  value: "<key>",
  description: "Send an Idempotency-Key, so a retry does not create a second one.",
};

export const tenantCreate: CommandSpec = {
  name: "tenant create",
  summary: "Create a tenant (personal access token in Platform mode with tenants.manage).",
  description: "A tenant API key never can. Inviting people and assigning roles stay in the Admin.",
  readOnly: false,
  mcpTool: "tenant_create",
  positionals: [{ name: "slug", description: "Lower-case letters, digits and dashes.", required: true }],
  options: {
    name: { type: "string", value: "<name>", description: "Display name (default: the slug)." },
    plan: { type: "string", value: "<plan>", description: "Licence plan, when the instance knows several." },
    use: { type: "boolean", description: "Switch to the new tenant afterwards (`cavelon use`)." },
    "idempotency-key": IDEMPOTENCY_OPTION,
  },
  async run(ctx, input) {
    const session = await ctx.session();
    if (session.tokenKind === "api_key") {
      throw new CavelonError(ExitCode.unauthorized, {
        code: "api_key_cannot_create_tenants",
        message: "A tenant API key can never create a tenant.",
        hint: "Use a personal access token that allows Platform mode, owned by someone with tenants.manage.",
      });
    }
    const slug = positional(input, "slug")!;
    const body: Record<string, unknown> = { slug, name: stringOption(input, "name") ?? slug };
    const plan = stringOption(input, "plan");
    if (plan) body.plan = plan;
    const tenant = await callStable<Tenant>(ctx, "POST", "/api/v1/tenants", "creating tenants", {
      body,
      sendTenant: false,
      headers: idempotency(stringOption(input, "idempotency-key")),
    });
    if (boolOption(input, "use")) await rememberTenant(ctx, requireInstance(session), { ref: tenant.slug, id: tenant.id, name: tenant.name });
    return {
      data: tenant,
      text: `Created tenant ${tenant.name} (${tenant.slug}, ${tenant.id}).${boolOption(input, "use") ? " Now using it." : " Switch with: " + cavelonCommand("use", tenant.slug)}`,
    };
  },
};

interface Me {
  memberships?: Array<{ tenant_id: string; tenant_name: string; role?: string }>;
}

export const tenantList: CommandSpec = {
  name: "tenant list",
  summary: "List the tenants this token can see.",
  readOnly: true,
  idempotent: true,
  mcpTool: "tenant_list",
  options: {
    search: { type: "string", value: "<text>", description: "Only tenants whose name or slug contains the text." },
    limit: LIMIT_OPTION,
    cursor: CURSOR_OPTION,
  },
  async run(ctx, input) {
    const session = await ctx.session();
    if (session.tokenKind === "api_key") {
      throw usageError("A tenant API key sees only its own tenant.", "`cavelon whoami` shows it.");
    }
    const limit = intOption(input, "limit", { min: 1, max: 200, fallback: 50 })!;
    const cursor = stringOption(input, "cursor");
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isInteger(offset) || offset < 0) throw usageError(`--cursor "${cursor}" is not a cursor from a previous page.`);
    const client = await ctx.client({ tenant: false });
    // A platform operator sees every tenant; anyone else sees their memberships.
    const listing = await client.get<{ items: Tenant[]; total: number }>("/api/v1/tenants", {
      query: { limit, offset, search: stringOption(input, "search") },
      sendTenant: false,
      allow: [403],
    });
    let page: { items: Array<Record<string, unknown>>; next_cursor: string | null; total: number; source: string };
    if (listing.status === 200) {
      const items = listing.data.items.map((t) => ({ id: t.id, slug: t.slug, name: t.name, status: t.status ?? null, plan: t.plan ?? null }));
      page = {
        items,
        next_cursor: offset + items.length < listing.data.total ? String(offset + items.length) : null,
        total: listing.data.total,
        source: "platform",
      };
    } else {
      const me = await client.get<Me>("/api/v1/auth/me", { sendTenant: false });
      const search = stringOption(input, "search")?.toLowerCase();
      const all = (me.data.memberships ?? [])
        .filter((m) => !search || m.tenant_name.toLowerCase().includes(search))
        .map((m) => ({ id: m.tenant_id, slug: null, name: m.tenant_name, role: m.role ?? null }));
      page = { ...pageOf(all, limit, cursor), source: "memberships" };
    }
    const columns = page.source === "platform" ? ["slug", "name", "status", "id"] : ["name", "role", "id"];
    return {
      data: page,
      text: (table(page.items, columns) || "No tenants.") + moreHint(page.next_cursor, "cavelon tenant list"),
    };
  },
};

export const harnessList: CommandSpec = {
  name: "harness list",
  summary: "List the tenant's solutions (harnesses).",
  readOnly: true,
  idempotent: true,
  mcpTool: "harness_list",
  options: {
    readiness: { type: "boolean", description: "Include whether each one is ready to activate (slower)." },
    limit: LIMIT_OPTION,
    cursor: CURSOR_OPTION,
  },
  async run(ctx, input) {
    const harnesses = await callStable<Harness[]>(ctx, "GET", "/api/v1/harnesses", "listing solutions", {
      query: { include_readiness: boolOption(input, "readiness") ? true : undefined },
    });
    const limit = intOption(input, "limit", { min: 1, max: 500, fallback: 50 })!;
    const page = pageOf(
      harnesses.map((h) => ({
        id: h.id,
        slug: h.slug,
        name: h.name,
        status: h.status,
        is_default: h.is_default ?? false,
        ...(h.readiness ? { ready_to_activate: h.readiness.ready_to_activate ?? null } : {}),
      })),
      limit,
      stringOption(input, "cursor"),
    );
    const columns = ["slug", "name", "status", ...(boolOption(input, "readiness") ? ["ready_to_activate"] : []), "id"];
    return {
      data: page,
      text: (table(page.items, columns) || "No solutions yet. Create one: cavelon harness new <slug>") + moreHint(page.next_cursor, "cavelon harness list"),
    };
  },
};

/** The quota-usage entry that would count solutions, if the instance publishes one. */
const HARNESS_QUOTA = "harnesses";

/**
 * Refuse a new solution that the published limits already rule out, before
 * sending it: the tenant's solution quota, when its quotas list one, and the
 * licence's `licence_max_harnesses`. The licence counts every tenant's
 * solutions that are not archived and this tenant sees only its own, so the
 * kit refuses only when this tenant alone reaches the cap; below it, the
 * instance decides.
 */
async function checkHarnessCapacity(ctx: Context, slug: string): Promise<void> {
  const published = await limitsOrWarn(ctx);
  if (!published?.published) return;
  const licence = published.byKey.get("licence_max_harnesses");
  const cap = typeof licence?.value === "number" ? licence.value : undefined;
  const quotas = published.tenantQuotas ? await readQuotas(ctx, published).catch(() => undefined) : undefined;
  const quota = quotas?.items.find((q) => q.key === HARNESS_QUOTA);
  const quotaFull = (quota?.ratio ?? 0) >= 1;
  if (!quotaFull && cap === undefined) return;
  const harnesses = await callStable<Harness[]>(ctx, "GET", "/api/v1/harnesses", "listing solutions");
  // An existing slug is the instance's to answer: a replay of the same create, or a conflict.
  if (harnesses.some((h) => h.slug === slug)) return;
  if (quota && quotas && quotaFull) {
    throw new CavelonError(ExitCode.validation, {
      code: "tenant_quota_reached",
      message: `This tenant has used ${formatQuota(quota)} of its solution quota, so nothing was sent.`,
      hint: `A platform administrator raises the tenant's quotas; \`cavelon limits\` shows them${quotas.docs ? ` (docs: ${quotas.docs})` : ""}. Archiving an unused solution frees one.`,
      docs: quotas.docs ?? undefined,
      details: { quota: { key: quota.key, current: quota.current, limit: quota.limit, path: quotas.path }, sent: false },
    });
  }
  if (licence && cap !== undefined) {
    const active = harnesses.filter((h) => h.status !== "archived").length;
    if (active >= cap) {
      // The instance answers this with 403 license_limit_reached; the same code and exit here.
      throw limitError({
        code: "license_limit_reached",
        exitCode: ExitCode.unauthorized,
        message:
          `The licence allows ${cap} solutions that are not archived on the whole instance, and this tenant alone has ${active}, ` +
          "so nothing was sent.",
        limits: [licence],
        details: { active_in_tenant: active },
        hint: "Archive an unused solution, or ask the operator for a renewed licence.",
      });
    }
  }
}

export const harnessNew: CommandSpec = {
  name: "harness new",
  summary: "Create an empty draft solution (harness).",
  readOnly: false,
  mcpTool: "harness_new",
  positionals: [{ name: "slug", description: "The new solution's slug.", required: true }],
  options: {
    name: { type: "string", value: "<name>", description: "Display name (default: the slug)." },
    description: { type: "string", value: "<text>", description: "What the solution is for." },
    "idempotency-key": IDEMPOTENCY_OPTION,
  },
  async run(ctx, input) {
    const slug = positional(input, "slug")!;
    const body: Record<string, unknown> = { slug, name: stringOption(input, "name") ?? slug };
    const description = stringOption(input, "description");
    if (description) body.description = description;
    await checkHarnessCapacity(ctx, slug);
    const harness = await callStable<Harness>(ctx, "POST", "/api/v1/harnesses", "creating solutions", {
      body,
      headers: idempotency(stringOption(input, "idempotency-key")),
    });
    return {
      data: harness,
      text: keyValues([
        ["created", `${harness.name} (${harness.slug})`],
        ["id", harness.id],
        ["status", harness.status],
      ]),
    };
  },
};

/** A harness id from an id or a slug. */
export async function resolveHarnessId(ctx: Parameters<CommandSpec["run"]>[0], ref: string): Promise<string> {
  if (isUuid(ref)) return ref;
  const harness = await callStable<Harness>(ctx, "GET", "/api/v1/harnesses/by-slug/{slug}", "finding solutions by slug", {
    params: { slug: [ref] },
  });
  return harness.id;
}

export const harnessClone: CommandSpec = {
  name: "harness clone",
  summary: "Copy a solution into a new draft solution.",
  readOnly: false,
  mcpTool: "harness_clone",
  positionals: [{ name: "source", description: "Slug or id of the solution to copy.", required: true }],
  options: {
    slug: { type: "string", value: "<slug>", description: "The copy's slug." },
    name: { type: "string", value: "<name>", description: "The copy's display name." },
    description: { type: "string", value: "<text>", description: "The copy's description." },
    suffix: { type: "string", value: "<suffix>", description: "Appended to the slugs of copied elements." },
    "no-tests": { type: "boolean", description: "Do not copy the test suites." },
    "no-triggers": { type: "boolean", description: "Do not copy the triggers." },
    "idempotency-key": IDEMPOTENCY_OPTION,
  },
  async run(ctx, input) {
    const source = positional(input, "source")!;
    const id = await resolveHarnessId(ctx, source);
    const body: Record<string, unknown> = {};
    for (const [option, field] of [
      ["slug", "slug"],
      ["name", "name"],
      ["description", "description"],
      ["suffix", "element_slug_suffix"],
    ] as const) {
      const value = stringOption(input, option);
      if (value !== undefined) body[field] = value;
    }
    if (boolOption(input, "no-tests")) body.include_tests = false;
    if (boolOption(input, "no-triggers")) body.include_triggers = false;
    const harness = await callStable<Harness>(ctx, "POST", "/api/v1/harnesses/{harness_id}/clone", "cloning solutions", {
      params: { harness_id: [id] },
      body,
      headers: idempotency(stringOption(input, "idempotency-key")),
    });
    return {
      data: harness,
      text: keyValues([
        ["cloned", `${source} → ${harness.name} (${harness.slug})`],
        ["id", harness.id],
        ["status", harness.status],
      ]),
    };
  },
};
