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
import { confirmation } from "../confirm-token.js";
import { keyValues, moreHint, table } from "../format.js";
import { callStable } from "../invoke.js";
import { formatQuota, limitError, limitsOrWarn, readQuotas } from "../limits.js";
import { containing } from "../choose.js";
import { readPrincipal, readTenantless, type MetaPrincipal } from "../principal.js";
import type { ApiClient } from "../http.js";
import { requireInstance } from "../session.js";
import { listsTenants, searchTenants } from "../tenant-choice.js";
import { harnessNotFoundError, lookupHarness, resolveHarnessId } from "../harness-ref.js";
import { defaultChangeLine, defaultCommands, named, readDefaultRoute, setDefaultRoute } from "../default-route.js";
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

/** The permission creating a tenant needs, in Platform mode. */
const TENANTS_MANAGE = "tenants.manage";

/** What a person does instead, when this token cannot create a tenant. */
const CREATE_TENANT_REMEDY =
  "Create a personal access token with Allow Platform mode and a platform ceiling on /account/access-tokens " +
  `(its owner needs ${TENANTS_MANAGE}) and run \`cavelon login\` with it, or create the tenant in the Admin (Platform › Tenants).`;

/**
 * Refuse a tenant the token cannot create, before sending it: `/meta/principal`
 * says whether the token may enter Platform mode at all and, in Platform mode,
 * which permissions it carries. An instance without the route, or one that
 * refuses the question, leaves the decision to the instance.
 */
function checkCanCreateTenant(principal: MetaPrincipal | undefined): void {
  const token = principal?.token;
  if (!token) return;
  const ceiling = token.ceiling_role ? ` (ceiling ${token.ceiling_role})` : "";
  // An instance that does not publish the field leaves the decision to the route.
  if (token.platform_mode_allowed === false) {
    throw new CavelonError(ExitCode.unauthorized, {
      code: "platform_mode_not_allowed",
      message:
        `The personal access token "${token.name}" may not enter Platform mode${ceiling}, and creating a tenant needs Platform mode ` +
        `with ${TENANTS_MANAGE}, so nothing was sent.`,
      hint: CREATE_TENANT_REMEDY,
      details: { platform_mode_allowed: false, ceiling_role: token.ceiling_role ?? null, sent: false },
    });
  }
  if (principal.mode === "platform" && principal.permissions && !principal.permissions.includes(TENANTS_MANAGE)) {
    throw new CavelonError(ExitCode.unauthorized, {
      code: "permission_missing",
      message: `The personal access token "${token.name}" enters Platform mode${ceiling}, but without ${TENANTS_MANAGE}, so it cannot create a tenant; nothing was sent.`,
      hint: `A token whose ceiling and owner's global role grant ${TENANTS_MANAGE} can; or create the tenant in the Admin (Platform › Tenants).`,
      details: { permission: TENANTS_MANAGE, ceiling_role: token.ceiling_role ?? null, sent: false },
    });
  }
}

/**
 * Whether the token acts in a tenant: `/meta/principal` asked with that
 * tenant answers for it. Undefined when the instance does not say (no such
 * route); a refusal's own words otherwise.
 */
async function entersTenant(client: ApiClient, tenantId: string): Promise<{ ok: boolean; said?: string } | undefined> {
  const before = client.target.tenantId;
  client.target.tenantId = tenantId;
  try {
    const response = await client.get<{ tenant_id?: unknown; detail?: unknown }>("/api/v1/meta/principal", { allow: [400, 403, 404, 405] });
    if (response.status === 404 || response.status === 405) return undefined;
    // An answer without `tenant_id` tells nothing; the switch goes ahead as before.
    if (response.status === 200) return { ok: response.data?.tenant_id === undefined || response.data.tenant_id === tenantId };
    const detail = response.data?.detail;
    return { ok: false, said: typeof detail === "string" && detail ? detail : `${response.status}` };
  } finally {
    client.target.tenantId = before;
  }
}

export const tenantCreate: CommandSpec = {
  name: "tenant create",
  summary: "Create a tenant (personal access token in Platform mode with tenants.manage).",
  description:
    "A tenant API key never can. Before sending, the token is checked: one that may not enter Platform mode, or enters it\n" +
    "without tenants.manage, is refused with exit 7 and nothing is sent. With --use, the new tenant is chosen only once the\n" +
    "instance confirms the token acts in it. Inviting people and assigning roles stay in the Admin.",
  readOnly: false,
  mcpTool: "tenant_create",
  positionals: [{ name: "slug", description: "Lower-case letters, digits and dashes.", required: true }],
  options: {
    name: { type: "string", value: "<name>", description: "Display name (default: the slug)." },
    plan: { type: "string", value: "<plan>", description: "Licence plan, when the instance knows several." },
    use: { type: "boolean", description: "Switch to the new tenant afterwards (`cavelon use`), once the token is known to act in it." },
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
    const client = await ctx.client({ tenant: false });
    checkCanCreateTenant(await readPrincipal(client, { sendTenant: false }));
    const slug = positional(input, "slug")!;
    const body: Record<string, unknown> = { slug, name: stringOption(input, "name") ?? slug };
    const plan = stringOption(input, "plan");
    if (plan) body.plan = plan;
    const tenant = await callStable<Tenant>(ctx, "POST", "/api/v1/tenants", "creating tenants", {
      body,
      sendTenant: false,
      headers: idempotency(stringOption(input, "idempotency-key")),
    });
    const created = `Created tenant ${tenant.name} (${tenant.slug}, ${tenant.id}).`;
    if (!boolOption(input, "use")) return { data: tenant, text: `${created} Switch with: ${cavelonCommand("use", tenant.slug)}` };
    // The instance does not say ahead which tenants a token will reach, so the new one is asked right after.
    const enters = await entersTenant(client, tenant.id);
    if (enters && !enters.ok) {
      ctx.warn(
        `This token does not act in the new tenant${enters.said ? ` (the instance said: ${enters.said})` : ""}, so the tenant chosen before stays. ` +
          "A token that reaches the new tenant (an operator's token that reaches every tenant, or one that lists it) can switch with " +
          `\`${cavelonCommand("use", tenant.slug)}\`.`,
      );
      return { data: { ...tenant, used: false }, text: `${created} Not switched: this token does not act in it.` };
    }
    await rememberTenant(ctx, requireInstance(session), { ref: tenant.slug, id: tenant.id, name: tenant.name });
    return { data: { ...tenant, used: true }, text: `${created} Now using it.` };
  },
};

interface Me {
  memberships?: Array<{ tenant_id: string; tenant_name: string; tenant_slug?: string | null; role?: string }>;
}

export const tenantList: CommandSpec = {
  name: "tenant list",
  summary: "List the tenants this token can see, with name, slug and id.",
  description:
    "A personal access token in Platform mode sees every tenant; any other sees the tenants it reaches. " +
    "An operator's token that reaches every tenant lists the person's own and finds any other with --search.",
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
    const search = stringOption(input, "search");
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isInteger(offset) || offset < 0) throw usageError(`--cursor "${cursor}" is not a cursor from a previous page.`);
    const client = await ctx.client({ tenant: false });
    // A platform operator sees every tenant; anyone else sees the tenants the token reaches.
    const listing = await client.get<{ items: Tenant[]; total: number }>("/api/v1/tenants", {
      query: { limit, offset, search },
      sendTenant: false,
      allow: [403],
    });
    let page: {
      items: Array<Record<string, unknown>>;
      next_cursor: string | null;
      total: number;
      source: string;
      reaches_all_tenants?: boolean;
      listed?: string;
      note?: string;
    };
    let note = "";
    const reach = listing.status === 200 ? undefined : await readTenantless(client);
    if (listing.status === 200) {
      const items = listing.data.items.map((t) => ({ id: t.id, slug: t.slug, name: t.name, status: t.status ?? null, plan: t.plan ?? null }));
      page = {
        items,
        next_cursor: offset + items.length < listing.data.total ? String(offset + items.length) : null,
        total: listing.data.total,
        source: "platform",
      };
    } else if (listsTenants(reach)) {
      const found = search && reach.reachesAll ? await searchTenants(client, search) : search ? containing(reach.tenants, search) : reach.tenants;
      const all = found.map((t) => ({ id: t.id, slug: t.slug, name: t.name, role: t.role, is_default: t.is_default }));
      page = { ...pageOf(all, limit, cursor), source: "token", reaches_all_tenants: reach.reachesAll };
      if (reach.reachesAll && !search) {
        // Without a search, the list holds the person's own memberships only; `total` counts those, not the instance's tenants.
        page.listed = "own_memberships";
        page.note = "This token reaches every tenant; items and total count only your own memberships. Find any tenant with --search <part of the name>.";
        note = all.length
          ? `\nThese are your own memberships; this token reaches every tenant on ${client.url}. Find any other: cavelon tenant list --search <part of the name>`
          : `No memberships of your own; this token reaches every tenant on ${client.url}. Find any tenant with: cavelon tenant list --search <part of the name>`;
      }
    } else {
      const me = await client.get<Me>("/api/v1/auth/me", { sendTenant: false });
      const wanted = search?.toLowerCase();
      const all = (me.data.memberships ?? [])
        .filter((m) => !wanted || m.tenant_name.toLowerCase().includes(wanted) || Boolean(m.tenant_slug?.toLowerCase().includes(wanted)))
        .map((m) => ({ id: m.tenant_id, slug: m.tenant_slug ?? null, name: m.tenant_name, role: m.role ?? null }));
      page = { ...pageOf(all, limit, cursor), source: "memberships" };
    }
    const columns = page.source === "platform" ? ["name", "slug", "status", "id"] : ["name", "slug", "role", "id"];
    const empty = search ? `No tenant's name or slug contains "${search}".` : note ? "" : "No tenants.";
    const next = page.items.length ? `\nChoose one: cavelon use <slug>  (or \`cavelon use\` to pick from a list)` : "";
    return {
      data: page,
      text: ((table(page.items, columns) || empty) + moreHint(page.next_cursor, "cavelon tenant list") + note + next).trimStart(),
    };
  },
};

export const harnessList: CommandSpec = {
  name: "harness list",
  summary: "List the tenant's solutions (harnesses), marking the default route.",
  description:
    "DEFAULT marks the tenant's default route: the solution that answers where a conversation names none (the tenant's chat\n" +
    "and widget). An instance that does not say which one it is leaves the column out; `is_default` in --json is null then.",
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
    // An older instance does not mark the default route; then nobody is shown as it.
    const marksDefault = harnesses.some((h) => typeof h.is_default === "boolean");
    const page = pageOf(
      harnesses.map((h) => ({
        id: h.id,
        slug: h.slug,
        name: h.name,
        status: h.status,
        is_default: marksDefault ? h.is_default === true : null,
        ...(h.readiness ? { ready_to_activate: h.readiness.ready_to_activate ?? null } : {}),
      })),
      limit,
      stringOption(input, "cursor"),
    );
    const rows = page.items.map((h) => ({ ...h, default: h.is_default ? "yes" : "" }));
    const columns = ["slug", "name", "status", ...(marksDefault ? ["default"] : []), ...(boolOption(input, "readiness") ? ["ready_to_activate"] : []), "id"];
    return {
      data: page,
      text: (table(rows, columns) || "No solutions yet. Create one: cavelon harness new <slug>") + moreHint(page.next_cursor, "cavelon harness list"),
    };
  },
};

export const harnessDefault: CommandSpec = {
  name: "harness default",
  summary: "Make a solution the tenant's default route; previews first, --confirm changes it.",
  description:
    "The default route is the solution that answers where a conversation names none: the tenant's chat and widget. A new\n" +
    "tenant's default is an empty `default` solution, so a solution built beside it answers nobody there until it becomes the\n" +
    "default. Without --confirm nothing changes: the preview names the current default and the one that would replace it.\n" +
    "This changes live traffic, so show the preview to a person and confirm only with their yes. `is_default` in\n" +
    "harnesses.yaml is not applied by `apply`; this is the way to set it.",
  readOnly: false,
  idempotent: true,
  mcpTool: "harness_default",
  positionals: [{ name: "solution", description: "Name, slug or id of the solution; default: cavelon.yaml's harness." }],
  options: {
    confirm: { type: "boolean", mcpToken: true, description: "Change the default route (after a person saw the preview)." },
  },
  examples: ["cavelon harness default support", "cavelon harness default support --confirm"],
  async run(ctx, input) {
    const session = await ctx.session();
    const ref = positional(input, "solution") ?? session.envFile?.harness ?? session.project?.harness;
    if (!ref) throw usageError("Which solution?", "Pass its name or slug (`cavelon harness list` shows them), or run it in a folder whose cavelon.yaml names one.");
    const { harness, candidates } = await lookupHarness<Harness>(ctx, ref);
    if (!harness) throw harnessNotFoundError(ref, candidates, undefined, (slug) => cavelonCommand("harness", "default", slug));
    const route = await readDefaultRoute(ctx);
    const target = { id: harness.id, slug: harness.slug, name: harness.name, status: harness.status };
    const current = route.current ? { id: route.current.id, slug: route.current.slug, name: route.current.name } : null;
    if (route.current?.id === harness.id) {
      return { data: { changed: false, already_default: true, harness: target, default_route: current }, text: `${named(harness)} is already the tenant's default route.` };
    }
    const commands = defaultCommands(harness.slug);
    const draft = harness.status !== "active" ? `${named(harness)} is ${harness.status}; activate it first (\`cavelon activate --harness ${harness.slug}\`), or the instance may refuse.` : undefined;
    const gate = await confirmation(ctx, input, "harness_default", { harness: harness.id, from: current?.id ?? null });
    if (!gate.confirmed) {
      return {
        data: {
          changed: false,
          harness: target,
          default_route: current,
          default_known: route.known,
          confirm: gate.confirm(commands.confirm),
          ...gate.fields,
          ...(draft ? { note: draft } : {}),
        },
        text: [
          defaultChangeLine(harness, route),
          ...(draft ? [draft] : []),
          ...(gate.mismatch ? [gate.mismatch] : []),
          `Show this to a person; with their yes: ${commands.confirm}`,
        ].join("\n"),
        ...(gate.exitCode ? { exitCode: gate.exitCode } : {}),
      };
    }
    const updated = await setDefaultRoute<Harness>(ctx, harness.id);
    return {
      data: { changed: true, harness: { ...target, status: updated?.status ?? target.status }, previous_default: current },
      text: `Default route: ${named(harness)}${current ? ` (was ${named(current)})` : ""}.`,
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

/** A new draft solution, refused before sending when the published limits already rule it out. */
export async function createHarness(ctx: Context, body: { slug: string; name: string; description?: string }, idempotencyKey?: string): Promise<Harness> {
  await checkHarnessCapacity(ctx, body.slug);
  return callStable<Harness>(ctx, "POST", "/api/v1/harnesses", "creating solutions", { body, headers: idempotency(idempotencyKey) });
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
    const body: { slug: string; name: string; description?: string } = { slug, name: stringOption(input, "name") ?? slug };
    const description = stringOption(input, "description");
    if (description) body.description = description;
    const harness = await createHarness(ctx, body, stringOption(input, "idempotency-key"));
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

export const harnessClone: CommandSpec = {
  name: "harness clone",
  summary: "Copy a solution into a new draft solution.",
  readOnly: false,
  mcpTool: "harness_clone",
  positionals: [{ name: "source", description: "Name, slug or id of the solution to copy.", required: true }],
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
