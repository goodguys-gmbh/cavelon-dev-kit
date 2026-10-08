import { capacityLimits, capacityNotes } from "../capacity.js";
import { refuseForAgent } from "../agent-env.js";
import { boolOption, positional, type CommandSpec, type Context } from "../command.js";
import { compareContracts, Contracts, type Capabilities } from "../contracts.js";
import { deleteToken, saveToken } from "../credentials.js";
import { CavelonError, ExitCode, usageError } from "../errors.js";
import { clip, keyValues } from "../format.js";
import { callStable } from "../invoke.js";
import { formatQuota, formatValue, limitRef, readLimits, readQuotas, type Limit, type PublishedLimits, type Quota } from "../limits.js";
import { ApiClient, tokensDisabledError } from "../http.js";
import { readAll } from "../io.js";
import { listPreviews, readPull } from "../local-state.js";
import type { Operation } from "../operations.js";
import { solutionState, solutionStateLines, type SolutionState } from "./solution.js";
import { expiryOf, readPrincipal, readTenantless, type Tenantless } from "../principal.js";
import { maySetSecrets } from "../secret-access.js";
import { readHidden } from "../prompt.js";
import { isUuid, knownTenantId, lookupTenantId, requireInstance, requireToken, tenantRequiredError, type FoundTenant, type Session } from "../session.js";
import { cavelonCommand, fill } from "../printed.js";
import { choicesOf, chooseTenant, commandLines, describeTenant, listsTenants, type Reach, noTenantError, tenantOpenError, tenantRef, tenantTitle } from "../tenant-choice.js";
import { loadUserConfig, saveUserConfig, tokenKind, updateInstance, withTenantRefs } from "../user-config.js";
import { checkKeyTenant } from "../acting.js";
import { accessFor, accessOf, mayActivate, operationAccess, type CredentialAccess } from "../access.js";

interface Me {
  id?: string;
  email?: string;
  display_name?: string | null;
  global_role?: string | null;
  role?: string;
  context?: { mode?: string; tenant_id?: string | null; effective_role?: string };
  memberships?: Array<{ tenant_id: string; tenant_name: string; tenant_slug?: string | null; role?: string }>;
  accessible_tenants?: Array<{ tenant_id: string; tenant_name: string; tenant_slug?: string | null; role?: string }>;
}

/** Capabilities, or why they cannot be read yet (a platform token without a tenant). */
async function readCapabilities(contracts: Contracts, refresh: boolean): Promise<{ caps: Capabilities | null; needsTenant: boolean }> {
  const caps = await contracts.capabilities({ refresh });
  return { caps, needsTenant: contracts.needsTenant };
}

async function readMe(client: ApiClient): Promise<Me | undefined> {
  if (!client.target.token?.startsWith("cvpat_")) return undefined;
  const response = await client.get<Me>("/api/v1/auth/me", { allow: [401, 403, 404] });
  if (response.status === 401) {
    if (await client.personalAccessTokensOff()) throw tokensDisabledError(client.url);
    throw new CavelonError(ExitCode.unauthorized, {
      code: "unauthorized",
      status: 401,
      message: `${client.url} refused the token.`,
      hint: "It may be expired or revoked; a person creates a new one on /account/access-tokens and runs `cavelon login`.",
    });
  }
  // An instance without /meta/principal refuses a token that works only inside a tenant here too.
  if (response.status === 403 && !client.target.tenantId) {
    const detail = (response.data as { detail?: unknown } | undefined)?.detail;
    throw tenantRequiredError(client.url, typeof detail === "string" ? detail : "403 Forbidden");
  }
  return response.status === 200 ? response.data : undefined;
}

/** The tenant the instance places a token in when it names none, with the person's other tenants by name. */
function actingTenant(tenantless: Tenantless | undefined, me: Me | undefined): { id: string; name?: string; others: string[] } | undefined {
  const id = tenantless && !tenantless.refused ? tenantless.tenantId : (me?.context?.tenant_id ?? undefined);
  if (!id) return undefined;
  const tenants = [...(me?.memberships ?? []), ...(me?.accessible_tenants ?? [])];
  const others = [...new Set(tenants.filter((t) => t.tenant_id !== id).map((t) => t.tenant_name || t.tenant_id))];
  return { id, name: tenants.find((t) => t.tenant_id === id)?.tenant_name, others };
}

async function readToken(ctx: Context, fromStdin: boolean): Promise<string> {
  let token: string;
  if (fromStdin) {
    token = (await readAll(ctx.io.stdin)).trim();
    if (!token) throw usageError("--token-stdin read nothing from standard input.");
  } else if (ctx.io.stdin.isTTY && ctx.io.stderr.isTTY && !ctx.json) {
    token = (await readHidden(ctx.io, "Token (input hidden): ")).trim();
    if (!token) throw usageError("No token entered.");
  } else {
    throw usageError(
      "No terminal to ask for the token.",
      "Pipe it in: `cavelon login --token-stdin < file`, or set CAVELON_TOKEN for CI. A person does this, not the agent.",
    );
  }
  if (/\s/.test(token)) throw usageError("The token contains whitespace; paste exactly the value the Admin showed.");
  return token;
}

export const login: CommandSpec = {
  name: "login",
  storesTarget: true,
  tenantless: true,
  summary: "Store a token for an instance (a person runs this, never the agent).",
  description:
    "Asks for the token without echoing it, or reads it from standard input with --token-stdin. It is never an argument.\n" +
    "A coding agent's shell is refused before reading input or contacting the instance; log in from your own terminal.\n" +
    "Create a personal access token (cvpat_…) on /account/access-tokens; a tenant API key (cbp_…) also works.\n" +
    "The token is kept in the operating system's credential store, or in a file only you can read.\n" +
    "Without --tenant, login finds the tenants the token reaches: one is used; from several, a person chooses on a terminal by number or name; " +
    "without a terminal the token is stored and login prints one `cavelon use` line per tenant (exit 2). " +
    "An operator's token that reaches every tenant asks for part of the tenant's name to start in; Enter leaves the choice for later (`cavelon use`). " +
    "--tenant takes the tenant's name, slug or id. An older instance that lists no tenants places the token itself, or needs --tenant <tenant-id>.",
  readOnly: false,
  mcpTool: false,
  options: {
    "token-stdin": { type: "boolean", description: "Read the token from standard input." },
  },
  examples: [
    "cavelon login --instance https://cavelon.example.com",
    "cavelon login --instance https://cavelon.example.com --tenant \"Acme Support\"",
    "op read op://dev/cavelon/token | cavelon login --token-stdin --tenant acme-support",
  ],
  async run(ctx, input) {
    refuseForAgent(ctx, "Logging in with a token", cavelonCommand("login"));
    const session = await ctx.session();
    const url = session.url;
    if (!url) throw usageError("Which instance?", "Pass --instance <url> (or set CAVELON_URL).");
    const token = await readToken(ctx, boolOption(input, "token-stdin"));
    const kind = tokenKind(token);
    if (kind === "unknown") ctx.warn("The token starts with neither cvpat_ nor cbp_; the instance may refuse it.");

    const client = new ApiClient({ url, token }, ctx.io.env);
    const contracts = new Contracts(client, ctx.io.env, ctx.io.now);
    // A key acts only in its own tenant: one that --tenant (or the folder) names otherwise is refused before the key is stored.
    if (kind === "api_key") await checkKeyTenant(client, { ...session, token, tokenKind: kind }, (m) => ctx.warn(m));
    let tenant: (FoundTenant & { ref: string }) | undefined;
    /** How the tenant was decided: an option, the only one the token reaches, or a person's pick. */
    let chosen: "option" | "only" | "picked" | undefined;
    if (session.tenant && kind !== "api_key") {
      try {
        const found = await lookupTenantId(client, session.tenant);
        tenant = { ref: session.tenant, ...found };
        chosen = session.tenantSource === "option" ? "option" : undefined;
        client.target.tenantId = found.id;
      } catch (error) {
        // A tenant chosen with an earlier token that this one does not reach is chosen again, not a dead end.
        if (session.tenantSource !== "use" || !(error instanceof CavelonError) || error.code !== "tenant_not_found") throw error;
        ctx.warn(`The tenant chosen before (${session.tenant}) is not one this token reaches; choosing again.`);
      }
    }
    // Without a tenant, ask who the token is first: an older instance refuses
    // a token without Platform mode that it cannot place in a tenant on every
    // route, and a recent one lists the tenants the token reaches.
    const tenantless = !tenant && kind === "personal_access_token" ? await readTenantless(client) : undefined;
    if (tenantless?.refused) throw tenantRequiredError(url, tenantless.said, "No tenant was given");
    const reach = listsTenants(tenantless) && !tenantless.platform ? tenantless : undefined;
    /** Several tenants, nobody to ask, and none the instance chooses: stored, then refused with one line per tenant. */
    let open = false;
    /** Every tenant, and the person chose to pick one later: stored without a tenant, as without a terminal, but not refused. */
    let later = false;
    if (reach) {
      const choice = await chooseTenant(ctx, client, reach, { later: true });
      if (choice.kind === "none") throw noTenantError(url);
      if (choice.kind === "chosen") {
        const t = choice.tenant;
        tenant = { ref: tenantRef(t), id: t.id, ...(t.name ? { name: t.name } : {}), ...(t.slug ? { slug: t.slug } : {}) };
        chosen = choice.how;
        client.target.tenantId = t.id;
      } else if (!reach.tenantId) {
        open = true;
        later = choice.kind === "later";
      }
    }
    // Check the token before storing it: a refused token is never kept. Who it
    // is comes first, so a token refused without a tenant is named as that.
    // A token that acts nowhere yet answered /meta/principal, which proves it;
    // the other reads need a tenant.
    const me = open ? undefined : await readMe(client);
    const { caps, needsTenant } = open ? { caps: null, needsTenant: false } : await readCapabilities(contracts, true);
    const acting = tenant || open ? undefined : actingTenant(tenantless, me);
    // An instance older than the /meta routes answers them 404 before it checks
    // the caller, so neither read above proved the token. One authenticated read
    // of a long-standing route does: its 401 is thrown as a refusal.
    if (!open && !caps && !needsTenant && !me) {
      await client.get("/api/v1/knowledge-bases", { query: { page_size: 1 }, allow: [400, 403, 404, 422] });
    }
    if (needsTenant && !me) {
      throw new CavelonError(ExitCode.usage, {
        code: "tenant_required",
        message: "The instance needs a tenant for this token.",
        hint: "Pass --tenant <name, slug or id>.",
      });
    }
    const store = await saveToken(ctx.io.env, url, token);
    const remember = tenant && chosen;
    await updateInstance(
      ctx.io.env,
      url,
      (current) => ({
        // Names and slugs resolved with an earlier login's token hold for that token only, so they are never reused for this one.
        ...withTenantRefs(current, remember ? [tenant!.ref, tenant!.slug] : [], tenant?.id ?? "", token, ctx.io.now()),
        credential_store: store.kind,
        token_kind: kind,
        logged_in_at: ctx.io.now().toISOString(),
        ...(remember
          ? {
              // A slug reads better than a name or an id wherever the choice is shown again.
              tenant: tenant!.slug ?? tenant!.ref,
              tenant_id: tenant!.id,
              tenant_name: tenant!.name,
              tenant_slug: tenant!.slug,
            }
          : {}),
      }),
      { makeCurrent: true },
    );
    if (ctx.io.env.CAVELON_TOKEN) ctx.warn("CAVELON_TOKEN is set and takes precedence over this login.");
    if (store.kind === "file") ctx.warn("No operating-system credential store; the token is in a file only you can read (0600).");
    if (open && !later) throw tenantOpenError(url, reach!, `The token is stored for ${url}, but no tenant is chosen yet. `);
    if (later) {
      return {
        data: { instance: url, credential: { kind, store: store.kind }, owner: null, tenant: null, instance_version: null, contracts: null },
        text:
          `Logged in to ${url}. Token stored in the ${store.kind === "keyring" ? "credential store" : "user-only file"}. ` +
          `No tenant is chosen yet: \`${cavelonCommand("use", fill("name or slug"))}\` chooses one; ` +
          `\`${cavelonCommand("tenant", "list", "--search", fill("part of the name"))}\` finds its slug.`,
      };
    }

    if (needsTenant) {
      ctx.warn(`This token works in Platform mode; choose a tenant with \`${cavelonCommand("use", fill("tenant"))}\` before tenant commands.`);
    } else {
      if (acting && reach) {
        const others = reach.tenants.filter((t) => t.id !== acting.id);
        if (others.length) ctx.warn(`Without a tenant this token acts in ${acting.name ?? acting.id}. To work in another tenant, run:\n${commandLines(others, (r) => cavelonCommand("use", r))}`);
      } else if (acting && acting.others.length) {
        ctx.warn(`Without a tenant this token acts in ${acting.name ?? acting.id}. Your other tenants: ${acting.others.join(", ")}; \`${cavelonCommand("use", fill("tenant"))}\` chooses one this token reaches.`);
      }
      for (const warning of compareContracts(caps)) ctx.warn(warning);
      // Fill the contract cache now, so `api` and `docs` work offline-first.
      try {
        await contracts.openapi();
      } catch (error) {
        ctx.warn(`Could not cache the OpenAPI: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await contracts.errorCatalog();
      } catch (error) {
        ctx.warn(`Could not cache the error catalog: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!needsTenant) {
      const expiry = expiryOf(await readPrincipal(client), ctx.io.now());
      if (expiry.warning) ctx.warn(expiry.warning);
    }

    const actingNamed = acting && reach ? reach.tenants.find((t) => t.id === acting.id) : undefined;
    const data = {
      instance: url,
      credential: { kind, store: store.kind },
      owner: me ? { email: me.email, name: me.display_name ?? null } : null,
      tenant: tenant
        ? { ref: tenant.ref, id: tenant.id, name: tenant.name ?? null, slug: tenant.slug ?? null, chosen: chosen ?? session.tenantSource ?? null }
        : acting
          ? { ref: null, id: acting.id, name: acting.name ?? actingNamed?.name ?? null, slug: actingNamed?.slug ?? null, chosen: "instance" }
          : null,
      instance_version: caps?.instance.version ?? null,
      contracts: caps?.contracts ?? null,
    };
    const who = me?.email ? ` as ${me.email}` : kind === "api_key" ? " with a tenant API key" : "";
    let where = "";
    if (tenant && chosen === "only") where = ` Using tenant ${tenantTitle(tenant)}, the only one this token reaches.`;
    else if (tenant && chosen === "picked") where = ` Using tenant ${tenantTitle(tenant)}; \`${cavelonCommand("use")}\` chooses another.`;
    else if (acting) {
      const named = { id: acting.id, name: acting.name ?? actingNamed?.name, slug: actingNamed?.slug };
      where = ` Acting in tenant ${tenantTitle(named)}, the one the instance chooses for this token.`;
    }
    return {
      data,
      text: `Logged in to ${url}${who}. Token stored in the ${store.kind === "keyring" ? "credential store" : "user-only file"}.${where}`,
    };
  },
};

export const logout: CommandSpec = {
  name: "logout",
  tenantless: true,
  summary: "Delete the stored token for an instance.",
  readOnly: false,
  destructive: true,
  idempotent: true,
  mcpTool: false,
  options: { all: { type: "boolean", description: "Log out of every instance." } },
  async run(ctx, input) {
    const env = ctx.io.env;
    const config = await loadUserConfig(env);
    let urls: string[];
    if (boolOption(input, "all")) urls = Object.keys(config.instances);
    else urls = [requireInstance(await ctx.session())];
    const results = [];
    for (const url of urls) {
      const deleted = await deleteToken(env, url);
      delete config.instances[url];
      if (config.current_instance === url) config.current_instance = undefined;
      results.push({ instance: url, deleted });
    }
    await saveUserConfig(env, config);
    if (env.CAVELON_TOKEN) ctx.warn("CAVELON_TOKEN is still set in the environment.");
    const text = results.map((r) => (r.deleted ? `Logged out of ${r.instance}.` : `No stored token for ${r.instance}.`)).join("\n");
    return { data: { logged_out: results }, text: text || "No stored logins." };
  },
};

/**
 * Where the tenant a command acts in came from, in words. The tenant chosen
 * with `cavelon use` holds in every folder whose cavelon.yaml names none, so
 * outside a solution folder that is said.
 */
function tenantSourceText(session: Session): string | undefined {
  switch (session.tenantSource) {
    case undefined:
      return undefined;
    case "option":
      return "--tenant";
    case "CAVELON_TENANT":
      return "the CAVELON_TENANT variable";
    case "use":
      return session.project
        ? "`cavelon use` (this folder's cavelon.yaml names no tenant for this instance)"
        : "`cavelon use`, for every folder without a cavelon.yaml (--tenant chooses another for one command)";
    case "session":
      return "use_tenant, for this MCP session only (the tenant stored for your user is unchanged)";
    default:
      return session.tenantSource;
  }
}

function credentialSource(session: Session): string {
  if (session.tokenSource === "CAVELON_TOKEN") return "CAVELON_TOKEN";
  return session.tokenStore === "file" ? "login (user-only file)" : "login (credential store)";
}

/** Whether the token may enter Platform mode, with the ceiling that bounds it. */
function platformModeText(token: { platform_mode_allowed: boolean; ceiling_role: string }): string {
  const ceiling = token.ceiling_role ? ` (ceiling ${token.ceiling_role})` : "";
  return token.platform_mode_allowed
    ? `allowed${ceiling}`
    : `not allowed${ceiling}; creating tenants and other platform routes need a token that allows it`;
}

/** Which tenants the token reaches, as the instance lists them. */
function reachText(reach: Reach): string {
  if (reach.reachesAll) {
    const own = reach.tenants.length;
    return `every tenant (as operator; ${own ? `${own} membership${own === 1 ? "" : "s"} of your own` : "no memberships of your own"})`;
  }
  return `${reach.tenants.length} tenant${reach.tenants.length === 1 ? "" : "s"} (\`${cavelonCommand("tenant", "list")}\`)`;
}

export const whoami: CommandSpec = {
  name: "whoami",
  summary: "Show who the token acts as, in which tenant, and where the token came from.",
  description: "Shows needs_a_person and the optional needs_a_person_when separately. Conditional identity guidance leaves ordinary requests usable; an omitted list stays unknown.",
  readOnly: true,
  idempotent: true,
  mcpTool: "whoami",
  async run(ctx) {
    const session = await ctx.session();
    requireToken(session);
    const client = await ctx.client();
    const pat = session.tokenKind === "personal_access_token";
    let reach: Reach | undefined;
    if (!client.target.tenantId && pat) {
      const tenantless = await readTenantless(client);
      if (tenantless?.refused) throw tenantRequiredError(client.url, tenantless.said);
      if (listsTenants(tenantless)) reach = tenantless;
    }
    // A token that acts in no tenant yet: only /meta/principal answers it.
    const nowhere = Boolean(reach && !reach.tenantId && !reach.platform);
    const me = nowhere ? undefined : await readMe(client);
    const contracts = await ctx.contracts();
    const { caps, needsTenant } = nowhere ? { caps: null, needsTenant: false } : await readCapabilities(contracts, false);
    const versionCachedAt = caps ? contracts.cachedAt : undefined;
    const principal = needsTenant ? undefined : await readPrincipal(client);
    const contextTenant = me?.context?.tenant_id ?? principal?.tenant_id ?? client.target.tenantId ?? null;
    const tenants = [...(me?.memberships ?? []), ...(me?.accessible_tenants ?? [])];
    const membership = tenants.find((t) => t.tenant_id === contextTenant);
    // The slug from the token's tenants, where neither /auth/me nor the stored choice names it.
    if (contextTenant && pat && !reach && !membership?.tenant_slug && session.settings.tenant_id !== contextTenant) {
      const tenantless = await readTenantless(client);
      if (listsTenants(tenantless)) reach = tenantless;
    }
    // Which tenants the token reaches, for its own line; an older instance does not say.
    if (pat && !reach) {
      const tenantless = await readTenantless(client).catch(() => undefined);
      if (listsTenants(tenantless)) reach = tenantless;
    }
    const listed = reach?.tenants.find((t) => t.id === contextTenant);
    const stored = session.settings.tenant_id === contextTenant ? session.settings : undefined;
    // A recent instance names the tenant the request acts in, an API key's own included.
    const acting = principal?.tenant?.id === contextTenant ? principal.tenant : undefined;
    let tenantName = acting?.name ?? listed?.name ?? membership?.tenant_name ?? stored?.tenant_name ?? null;
    let tenantSlug = acting?.slug ?? listed?.slug ?? membership?.tenant_slug ?? stored?.tenant_slug ?? null;
    // A tenant named by id in cavelon.yaml or --tenant that is none of the person's memberships (an operator's): ask for it.
    if (contextTenant && (!tenantName || !tenantSlug)) {
      const described = await describeTenant(client, contextTenant);
      tenantName ??= described.name ?? null;
      tenantSlug ??= described.slug ?? null;
    }
    if (nowhere && reach) {
      ctx.warn(
        reach.tenants.length
          ? `No tenant is chosen. Choose one with \`${cavelonCommand("use")}\`, or run the line for the tenant you want:\n${commandLines(reach.tenants, (r) => cavelonCommand("use", r))}`
          : `No tenant is chosen. This token reaches every tenant: \`${cavelonCommand("use", fill("name or slug"))}\` chooses one.`,
      );
    }
    const expiry = expiryOf(principal, ctx.io.now());
    if (expiry.warning) ctx.warn(expiry.warning);
    const access = accessOf(principal);
    const data = {
      instance: {
        url: session.url,
        source: session.urlSource,
        version: caps?.instance.version ?? null,
        // When the version is the cached one, when it was read; it may be behind the instance by up to the cache's time-to-live.
        ...(versionCachedAt ? { version_cached_at: versionCachedAt } : {}),
      },
      credential: {
        kind: principal?.kind ?? session.tokenKind,
        source: session.tokenSource,
        store: session.tokenSource === "login" ? session.tokenStore : null,
        name: principal?.token?.name ?? principal?.api_key?.name ?? null,
        prefix: principal?.token?.prefix ?? principal?.api_key?.prefix ?? null,
        expires_at: expiry.expires_at,
        expires_in_days: expiry.days_left,
        // Null where the instance does not say (an API key on an older instance).
        may_activate: mayActivate(access),
        // Null where the instance does not publish the token's permissions in the tenant.
        may_set_secrets: maySetSecrets(principal),
        may_set_variables: maySetVariables(access),
        ceiling_role: principal?.token?.ceiling_role ?? null,
        platform_mode_allowed: principal?.token?.platform_mode_allowed ?? null,
        scopes: principal?.api_key?.scopes ?? null,
        // What the routes accept from it where it acts; null where the instance does not publish it for this credential.
        permissions: access?.permissions ?? null,
        // The operations those permissions would allow that a person still runs; null on an instance that does not say.
        needs_a_person: access?.complete ? access.needsAPerson : null,
        needs_a_person_when: access?.needsAPersonWhen ?? null,
        // False only when the instance is too old to say who the credential is.
        published: Boolean(principal),
      },
      owner: me
        ? { id: me.id ?? null, email: me.email ?? null, name: me.display_name ?? null }
        : principal?.user
          ? { id: principal.user.id, email: principal.user.email, name: null }
          : null,
      tenant: {
        id: contextTenant,
        name: tenantName,
        slug: tenantSlug,
        ref: session.tenant ?? null,
        source: session.tenant ? session.tenantSource : null,
        mode: nowhere ? "none" : (me?.context?.mode ?? principal?.mode ?? (session.tokenKind === "api_key" ? "tenant" : null)),
      },
      ...(reach ? { reaches: { tenants: reach.tenants.length, every_tenant: reach.reachesAll } } : {}),
      role: me?.context?.effective_role ?? me?.role ?? null,
    };
    if (needsTenant) ctx.warn(`No tenant selected; this token is in Platform mode. Choose one with \`${cavelonCommand("use", fill("tenant"))}\`.`);
    const owner =
      session.tokenKind === "api_key"
        ? principal?.api_key
          ? `the tenant API key "${principal.api_key.name}"`
          : "a tenant API key (the instance does not tell a key its name)"
        : me?.email
          ? `${me.display_name ? `${me.display_name} <${me.email}>` : me.email}`
          : (principal?.user?.email ?? "unknown");
    const tokenName = data.credential.name ? ` "${data.credential.name}"` : "";
    const expires = !principal
      ? "not published by this instance"
      : expiry.expires_at
        ? `${expiry.expires_at} (${expiry.days_left! < 0 ? "expired" : `in ${expiry.days_left} day${expiry.days_left === 1 ? "" : "s"}`})`
        : "never";
    return {
      data,
      text: keyValues([
        ["instance", `${session.url} (${session.urlSource})`],
        ["acting as", owner],
        ["tenant", contextTenant ? tenantTitle({ id: contextTenant, name: tenantName, slug: tenantSlug }) : nowhere ? "none chosen (`cavelon use` chooses one)" : "none (Platform mode)"],
        ["tenant from", session.tenant ? tenantSourceText(session) : nowhere ? undefined : "the token's default"],
        ["role", data.role ?? undefined],
        ["credential", `${session.tokenKind === "api_key" ? "tenant API key" : session.tokenKind === "personal_access_token" ? "personal access token" : "token"}${tokenName} from ${credentialSource(session)}`],
        ["expires", expires],
        ["may activate", activateText(data.credential.may_activate, access)],
        ["may set secrets", secretsText(data.credential.may_set_secrets, access?.complete === true)],
        ["may set variables", variablesText(data.credential.may_set_variables)],
        ["scopes", data.credential.scopes ? data.credential.scopes.join(", ") || "none" : undefined],
        ["permissions", permissionsText(access)],
        ["needs a person", needsAPersonText(access)],
        ["needs a person when", needsAPersonWhenText(access)],
        // An instance that does not say whether the token allows Platform mode gets no line.
        ["platform mode", typeof principal?.token?.platform_mode_allowed === "boolean" ? platformModeText(principal.token) : undefined],
        ["reaches", reach ? reachText(reach) : undefined],
        ["version", data.instance.version ? `${data.instance.version}${versionCachedAt ? ` (cached at ${versionCachedAt})` : ""}` : undefined],
      ]),
    };
  },
};

/** The most permissions or operations a text line names; --json lists them all. */
const LISTED = 12;

function activateText(may: boolean | null, access: CredentialAccess | undefined): string | undefined {
  if (may === null) return undefined;
  if (may) return "yes";
  return access?.principal.token && !access.principal.token.may_activate
    ? "no (the token was created without \"may activate\"; a person activates in the Admin)"
    : "no (a person whose role may activate does it, in the Admin)";
}

/** Whether the credential may set the tenant's plain-text variables; null where the instance does not say. */
export function maySetVariables(access: CredentialAccess | undefined): boolean | null {
  return operationAccess(access, "PUT /api/v1/variables/{name}").allowed;
}

function variablesText(may: boolean | null): string | undefined {
  if (may === null) return undefined;
  return may ? "yes" : "no (a tenant Owner sets them, in the Admin or with their own token)";
}

function permissionsText(access: CredentialAccess | undefined): string | undefined {
  if (!access?.permissions) return access ? "not published for this credential by this instance" : undefined;
  const all = access.permissions;
  if (!all.length) return "none";
  return `${all.slice(0, LISTED).join(", ")}${all.length > LISTED ? `, … ${all.length - LISTED} more (--json)` : ""}`;
}

function needsAPersonText(access: CredentialAccess | undefined): string | undefined {
  if (!access?.complete || !access.needsAPerson.length) return undefined;
  const all = access.needsAPerson;
  const shown = all.slice(0, LISTED).map((o) => `\n  ${o.method} ${o.path}${o.reason ? ` (${clip(o.reason, 80)})` : ""}`);
  return `${all.length} operation${all.length === 1 ? "" : "s"} a person runs, not this credential:${shown.join("")}${all.length > LISTED ? `\n  … ${all.length - LISTED} more (--json)` : ""}`;
}

function needsAPersonWhenText(access: CredentialAccess | undefined): string | undefined {
  const all = access?.needsAPersonWhen;
  if (!all?.length) return undefined;
  const shown = all.slice(0, LISTED).map(o => `\n  ${o.method} ${o.path}: ${clip(o.reason, 160)}`);
  return `Only in these cases; ordinary requests remain usable:${shown.join("")}${all.length > LISTED ? `\n  … ${all.length - LISTED} more (--json)` : ""}`;
}

/** `inAdmin`: the instance publishes `needs_a_person`, and since that release lets only a person signed in to the Admin set a secret. */
function secretsText(may: boolean | null, inAdmin: boolean): string | undefined {
  if (may === null) return undefined;
  if (may) return "yes";
  return inAdmin ? "no (a tenant Owner sets them, signed in to the Admin under Settings › Secrets)" : "no (a tenant Owner sets them, in the Admin or with their own token)";
}

export const use: CommandSpec = {
  name: "use",
  summary: "Choose the tenant this instance's commands act in.",
  description:
    "Stored per instance for your user. CAVELON_TENANT, --tenant and a cavelon.yaml tenant take precedence over it.\n" +
    "Without a tenant, it lists the tenants the token reaches: a person chooses one on a terminal by number or part of its name; " +
    "without a terminal it prints one `cavelon use` line per tenant, and as an MCP tool it returns them as choices and changes nothing.\n" +
    "As an MCP tool it never changes the tenant stored for your user: it chooses the tenant for that MCP session only, " +
    "until the session ends or it is cleared, so an agent's choice never moves where your own commands go.",
  readOnly: false,
  idempotent: true,
  mcpTool: "use_tenant",
  positionals: [{ name: "tenant", description: "The tenant's name, slug or id; leave it out to choose from a list.", required: false }],
  options: { clear: { type: "boolean", description: "Forget the chosen tenant." } },
  examples: ["cavelon use", "cavelon use acme-support", "cavelon use \"Acme Support\""],
  async run(ctx, input) {
    const session = await ctx.session();
    const url = requireInstance(session);
    requireToken(session);
    const inSession = ctx.mode === "mcp";
    if (inSession && !ctx.globals.sessionTenants) throw usageError("This MCP server keeps no session, so use_tenant cannot choose a tenant; pass tenant to each tool instead.");
    if (boolOption(input, "clear")) {
      if (inSession) {
        ctx.globals.sessionTenants!.delete(url);
        return {
          data: { instance: url, tenant: null, scope: "session" },
          text: `No tenant chosen for ${url} in this MCP session; tools act in the tenant chosen for this folder or with \`cavelon use\` again.`,
        };
      }
      await updateInstance(ctx.io.env, url, (c) => ({ ...c, tenant: undefined, tenant_id: undefined, tenant_name: undefined, tenant_slug: undefined }));
      return { data: { instance: url, tenant: null }, text: `No tenant chosen for ${url}.` };
    }
    if (session.tokenKind === "api_key") {
      throw usageError("A tenant API key is bound to its own tenant; `use` applies to personal access tokens.");
    }
    const client = await ctx.client({ tenant: false });
    let ref = positional(input, "tenant");
    let found: FoundTenant;
    if (ref) {
      found = await lookupTenantId(client, ref);
    } else {
      const tenantless = await readTenantless(client);
      if (!listsTenants(tenantless)) {
        throw usageError(
          "Which tenant? This instance does not list the tenants a token reaches.",
          `Run \`${cavelonCommand("use", fill("name, slug or id"))}\`; \`${cavelonCommand("tenant", "list")}\` shows the tenants this token can see.`,
        );
      }
      const command = (r: string) => cavelonCommand("use", r);
      if (ctx.mode === "mcp" && (tenantless.reachesAll || tenantless.tenants.length !== 1)) {
        const choices = choicesOf(tenantless.tenants, command);
        return {
          data: { instance: url, tenant: null, chosen: false, choices, reaches_all_tenants: tenantless.reachesAll },
          text: tenantless.reachesAll
            ? "Nothing changed: this token reaches every tenant; call use_tenant again with the tenant's name or slug (tenant_list with search finds it)."
            : "Nothing changed: choose one of the tenants and call use_tenant again with its slug.",
        };
      }
      const choice = await chooseTenant(ctx, client, tenantless);
      if (choice.kind === "none") throw noTenantError(url, false);
      if (choice.kind !== "chosen") throw tenantOpenError(url, tenantless, "");
      const t = choice.tenant;
      ref = tenantRef(t);
      found = { id: t.id, ...(t.name ? { name: t.name } : {}), ...(t.slug ? { slug: t.slug } : {}) };
    }
    // Ask the instance once with that tenant, so a tenant the token cannot reach fails here.
    const probe = new ApiClient({ ...client.target, tenantId: found.id }, ctx.io.env);
    await probe.get("/api/v1/meta/capabilities", { allow: [404] });
    // A slug reads better than a name or an id wherever the choice is shown again.
    const stored = found.slug ?? ref;
    const title = tenantTitle({ id: found.id, name: found.name, slug: found.slug ?? (isUuid(ref!) ? undefined : ref) });
    if (session.tenantSource && session.tenantSource !== "use" && session.tenantSource !== "session") {
      ctx.warn(`${session.tenantSource} names tenant "${session.tenant}" and takes precedence over \`use\` here.`);
    }
    const shown = { ref: stored, id: found.id, name: found.name ?? null, slug: found.slug ?? null };
    if (inSession) {
      // The person's stored tenant stays as it is: only this server's later tool calls act here.
      ctx.globals.sessionTenants!.set(url, { ref: stored, id: found.id, ...(found.name ? { name: found.name } : {}), ...(found.slug ? { slug: found.slug } : {}) });
      return {
        data: { instance: url, tenant: shown, scope: "session" },
        text: `Using tenant ${title} on ${url} for this MCP session; the tenant stored for your user (\`cavelon use\` in a terminal) is unchanged.`,
      };
    }
    const token = requireToken(session);
    await updateInstance(ctx.io.env, url, (c) => ({
      ...withTenantRefs(c, [ref, stored], found.id, token, ctx.io.now()),
      tenant: stored,
      tenant_id: found.id,
      tenant_name: found.name ?? (c.tenant_id === found.id ? c.tenant_name : undefined),
      tenant_slug: found.slug ?? (c.tenant_id === found.id ? c.tenant_slug : undefined),
    }));
    return { data: { instance: url, tenant: shown }, text: `Using tenant ${title} on ${url}.` };
  },
};

interface OperationPage {
  items: Operation[];
  next_cursor?: string | null;
}

/** The tenant's quotas that are close to their limit; a failure here never fails `status`. */
async function nearQuotas(ctx: Context): Promise<{ near: Quota[]; capacity: Limit[]; published?: PublishedLimits; data: Record<string, unknown> }> {
  try {
    const published = await readLimits(ctx);
    if (!published.published) return { near: [], capacity: [], data: { published: false } };
    const quotas = await readQuotas(ctx, published);
    const near = quotas?.items.filter((q) => q.near) ?? [];
    const capacity = capacityLimits(published);
    return {
      near,
      capacity,
      published,
      data: {
        published: true,
        near: near.map((q) => ({ key: q.key, current: q.current, limit: q.limit, ratio: q.ratio })),
        capacity: capacity.map(limitRef),
        ...(quotas?.unavailable ? { quotas_unavailable: quotas.unavailable } : {}),
      },
    };
  } catch (error) {
    return { near: [], capacity: [], data: { published: null, unavailable: error instanceof Error ? error.message : String(error) } };
  }
}

/** "max_concurrent_agent_runs_per_tenant 20 (platform, platform setting); …"; an entry without origin shows its source only. */
function capacityLine(capacity: Limit[]): string {
  return capacity
    .map((l) => `${l.key} ${formatValue(l)} (${[l.source, l.origin?.replace(/_/g, " ")].filter(Boolean).join(", ")})`)
    .join("; ");
}

type LimitsState = { published: boolean | null; unavailable?: string; quotas_unavailable?: string };

function limitsLine(state: LimitsState, near: Quota[]): string {
  if (state.published === null) return `not readable: ${state.unavailable}`;
  if (!state.published) return "not published by this instance";
  const quotas = state.quotas_unavailable ? `\n  quotas not readable: ${state.quotas_unavailable}` : "";
  if (!near.length) return `${state.quotas_unavailable ? "quotas unknown" : "none close to a quota"} (\`${cavelonCommand("limits")}\` lists them)${quotas}`;
  return `close to a quota: ${near.map((q) => `${q.key} ${formatQuota(q)}`).join("; ")}${quotas}`;
}

export const status: CommandSpec = {
  name: "status",
  summary: "Show the instance, tenant, solution, running operations and quotas close to full for this directory.",
  description: "For the folder's solution, shows readiness and whether activation would take the default chat and widget route. An omitted route flag is unknown. Readiness reserves no route state; activation reports the actual effect.",
  readOnly: true,
  idempotent: true,
  mcpTool: "status",
  options: { offline: { type: "boolean", description: "Do not contact the instance." } },
  async run(ctx, input) {
    const session = await ctx.session();
    const offline = boolOption(input, "offline");
    const data: Record<string, unknown> = {
      instance: session.url ? { url: session.url, source: session.urlSource } : null,
      credential: session.token
        ? { kind: session.tokenKind, source: session.tokenSource, store: session.tokenStore ?? null }
        : null,
      tenant: session.tenant ? { ref: session.tenant, source: session.tenantSource } : null,
      solution: session.project
        ? {
            file: session.project.file,
            root: session.project.root,
            harness: session.project.harness ?? null,
            last_pull: (await readPull(session.project.root)) ?? null,
            open_previews: await listPreviews(session.project.root, ctx.io.now()),
          }
        : null,
      logged_in_at: session.settings.logged_in_at ?? null,
    };
    let operations: OperationPage["items"] | undefined;
    let near: Quota[] | undefined;
    let capacity: Limit[] = [];
    let published: PublishedLimits | undefined;
    let reachError: string | undefined;
    let client: ApiClient | undefined;
    let access: CredentialAccess | undefined;
    if (offline && session.url) {
      // Offline, the version is the one cached last, and says so. The
      // capabilities are cached per tenant, so the client names the tenant it
      // would send, without asking the instance for a slug's id.
      const target = { url: session.url, token: session.token, tenantId: knownTenantId(session, ctx.io.now()) };
      const cached = await new Contracts(new ApiClient(target, ctx.io.env), ctx.io.env, ctx.io.now)
        .cachedOnly<Capabilities>("capabilities.json")
        .catch(() => undefined);
      if (cached?.value?.instance?.version) {
        data.instance_version = cached.value.instance.version;
        data.instance_version_cached_at = cached.fetched_at;
      }
    }
    if (!offline && session.url && session.token) {
      try {
        client = await ctx.client();
        const tenantId = client.target.tenantId;
        if (tenantId) {
          const shown = data.tenant as Record<string, unknown>;
          shown.id = tenantId;
          // The tenant's name and slug, also for one named by id in cavelon.yaml or --tenant.
          const stored = session.settings.tenant_id === tenantId ? session.settings : undefined;
          const described = stored?.tenant_name && stored.tenant_slug ? {} : await describeTenant(client, tenantId);
          shown.name = stored?.tenant_name ?? described.name ?? null;
          shown.slug = stored?.tenant_slug ?? described.slug ?? null;
        }
        access = await accessFor(client);
        if (access && data.credential) {
          Object.assign(data.credential as Record<string, unknown>, {
            scopes: access.scopes,
            permissions: access.permissions,
            may_activate: mayActivate(access),
            needs_a_person: access.complete ? access.needsAPerson.length : null,
          });
        }
        const contracts = await ctx.contracts();
        // Read now, never from the cache: status is where a person checks which version the instance runs.
        const caps = await contracts.liveCapabilities();
        data.instance_version = caps?.instance.version ?? null;
        if (contracts.needsTenant) {
          data.operations = { unavailable: "No tenant chosen; operations belong to a tenant." };
        } else if (caps?.features?.operations_api_enabled !== false) {
          const page = await client.get<OperationPage>("/api/v1/operations", {
            query: { status: ["queued", "running", "needs_action"], limit: 10 },
            allow: [404],
          });
          operations = page.status === 200 ? page.data.items : undefined;
          data.operations = operations
            ? { items: operations, more: Boolean(page.data.next_cursor), scope: "tenant" }
            : { unavailable: "This instance does not offer /api/v1/operations." };
        } else {
          data.operations = { unavailable: "The operations API is turned off on this instance." };
        }
        if (!contracts.needsTenant) {
          const limits = await nearQuotas(ctx);
          near = limits.near;
          capacity = limits.capacity;
          published = limits.published;
          data.limits = limits.data;
          const ref = session.envFile?.harness ?? session.project?.harness;
          if (session.project && ref) {
            const state = await solutionState(ctx, ref);
            (data.solution as Record<string, unknown>).state = state;
            // The operations list is the tenant's: leave out what belongs to another solution, and say how many.
            if (operations && state.harness) {
              const owners = await operationSolutions(ctx, operations);
              const others = operations.filter((o) => owners.get(o.id) && owners.get(o.id) !== state.harness!.id);
              if (others.length) {
                operations = operations.filter((o) => !others.includes(o));
                data.operations = { ...(data.operations as Record<string, unknown>), items: operations, other_solutions: others.length };
              }
              data.operations = { ...(data.operations as Record<string, unknown>), scope: "solution", harness: state.harness.slug };
            }
          }
        }
      } catch (error) {
        reachError = error instanceof Error ? error.message : String(error);
        data.error = error instanceof CavelonError ? error.toJSON() : { message: reachError };
      }
    }
    const shownTenant = data.tenant as { id?: string; name?: string | null; slug?: string | null } | null;
    const tenantText = session.tenant
      ? `${shownTenant?.id && (shownTenant.name || shownTenant.slug) ? tenantTitle({ id: shownTenant.id, name: shownTenant.name, slug: shownTenant.slug }) : session.tenant}, from ${tenantSourceText(session)}`
      : session.tokenKind === "api_key"
        ? "the API key's tenant"
        : `not chosen (\`${cavelonCommand("use")}\` lists your tenants to choose from)`;
    const lines: Array<[string, unknown]> = [
      ["instance", session.url ? `${session.url} (${session.urlSource})` : `none (\`${cavelonCommand("login", "--instance", fill("url"))}\`)`],
      ["credential", session.token ? `${session.tokenKind} from ${credentialSource(session)}` : "none"],
      ["scopes", access?.scopes ? access.scopes.join(", ") || "none" : undefined],
      ["permissions", permissionsText(access)],
      ["tenant", tenantText],
      ["solution", session.project ? session.project.file : "none (no cavelon.yaml here or above)"],
    ];
    if (session.project) {
      const solution = data.solution as {
        last_pull: { at: string; harness: { slug: string } | null } | null;
        open_previews: Array<{ preview_id: string; env: string | null; created_at: string; expires_at: string | null; expired: boolean }>;
        state?: SolutionState;
      };
      if (session.project.harness) lines.push(["harness", session.project.harness]);
      if (solution.state) lines.push(...solutionStateLines(solution.state));
      lines.push(["last pull", solution.last_pull ? `${solution.last_pull.at}${solution.last_pull.harness ? ` (${solution.last_pull.harness.slug})` : ""}` : "never"]);
      lines.push([
        "open previews",
        solution.open_previews.length
          ? solution.open_previews
              .map((p) => `\n  ${p.preview_id}${p.env ? `  env ${p.env}` : ""}  ${p.created_at}  ${p.expired ? `expired (\`${cavelonCommand("apply", "--discard", "all")}\` removes it)` : `expires ${p.expires_at}`}`)
              .join("")
          : "none",
      ]);
    }
    if (data.instance_version) {
      const cachedAt = data.instance_version_cached_at as string | null | undefined;
      lines.push(["version", `${data.instance_version}${cachedAt !== undefined ? ` (cached at ${cachedAt ?? "an unknown time"}; not read now)` : ""}`]);
    }
    if (data.limits) lines.push(["limits", limitsLine(data.limits as LimitsState, near ?? [])]);
    if (capacity.length) lines.push(["run capacity", capacityLine(capacity)]);
    if (reachError) lines.push(["instance error", reachError]);
    let text = keyValues(lines);
    if (operations && client) {
      // A queued run that waits for run capacity, as its run says, or, on an
      // older instance, still queued after a normal start.
      const note = capacityNotes(ctx, client, published);
      const waits = await Promise.all(operations.map(async (o) => (await note(o))?.capacity_wait));
      const waiting = waits.flatMap((wait, i) => (wait ? [{ operation_id: operations![i]!.id, ...wait }] : []));
      if (waiting.length) data.capacity_waits = waiting;
      const ops = data.operations as { scope?: string; harness?: string; other_solutions?: number };
      const others = ops.other_solutions
        ? ` (${ops.other_solutions} operation${ops.other_solutions === 1 ? "" : "s"} of other solutions not shown; \`${cavelonCommand("api", "list_operations_route")}\` lists all)`
        : "";
      const heading = ops.scope === "solution" ? `Running operations of ${ops.harness} and the tenant's shared work${others}` : "Running operations in the tenant";
      text += operations.length
        ? `\n\n${heading}:\n${operations
            .map((o, i) => {
              const wait = waits[i];
              return `  ${o.id}  ${o.kind}  ${o.status}${o.progress?.phase ? ` (${o.progress.phase})` : ""}${wait ? `  ${wait.note}` : ""}`;
            })
            .join("\n")}`
        : `\n\nNo running operations${ops.scope === "solution" ? ` of ${ops.harness}${others}` : " in the tenant"}.`;
    }
    return { data, text };
  },
};

/**
 * Which solution each running operation belongs to, where the kit can tell:
 * a test run names its solution (`harness_id`); a trigger run (a loop) names
 * its trigger, and the trigger its solution, unless the run names the
 * solution itself. Other kinds (an upload into a knowledge base, which
 * solutions share) stay unattributed, as does one whose record cannot be
 * read. Bounded: the list is one page of at most ten, and each trigger is
 * read once.
 */
async function operationSolutions(ctx: Context, operations: OperationPage["items"]): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  const triggers = new Map<string, Promise<string | undefined>>();
  const triggerSolution = (id: string) => {
    if (!triggers.has(id)) {
      triggers.set(
        id,
        callStable<{ harness_id?: string | null }>(ctx, "GET", "/api/v1/triggers/{trigger_id}", "reading triggers", { params: { trigger_id: [id] } }).then(
          (t) => t.harness_id ?? undefined,
          () => undefined,
        ),
      );
    }
    return triggers.get(id)!;
  };
  for (const op of operations) {
    const harnessId = (op as { harness_id?: unknown }).harness_id;
    if (typeof harnessId === "string" && harnessId) {
      owners.set(op.id, harnessId);
      continue;
    }
    const ref = op.result_ref;
    if (!ref?.id) continue;
    try {
      if (ref.type === "test_run") {
        const run = await callStable<{ harness_id?: string | null }>(ctx, "GET", "/api/v1/test-runs/{run_id}", "test runs", { params: { run_id: [ref.id] } });
        if (run.harness_id) owners.set(op.id, run.harness_id);
      } else if (ref.type === "agent_run") {
        const run = await callStable<{ harness_id?: string | null; trigger_definition_id?: string | null }>(ctx, "GET", "/api/v1/triggers/runs/{run_id}", "reading runs", {
          params: { run_id: [ref.id] },
        });
        const owner = run.harness_id ?? (run.trigger_definition_id ? await triggerSolution(run.trigger_definition_id) : undefined);
        if (owner) owners.set(op.id, owner);
      }
    } catch {
      // Unattributed: it stays in the list.
    }
  }
  return owners;
}

/**
 * Exposed for `tenant create --use`. Over MCP the tenant is chosen for the
 * session only, as `use_tenant` does: the person's stored tenant stays.
 * Says which.
 */
export async function rememberTenant(ctx: Context, url: string, tenant: { ref: string; id: string; name?: string; slug?: string }): Promise<"session" | "user"> {
  if (ctx.mode === "mcp") {
    if (!ctx.globals.sessionTenants) throw usageError("This MCP server keeps no session to choose the new tenant in; pass tenant to each tool instead.");
    ctx.globals.sessionTenants.set(url, tenant);
    return "session";
  }
  const token = requireToken(await ctx.session());
  await updateInstance(ctx.io.env, url, (c) => ({
    ...withTenantRefs(c, [tenant.ref], tenant.id, token, ctx.io.now()),
    tenant: tenant.ref,
    tenant_id: tenant.id,
    tenant_name: tenant.name,
    tenant_slug: tenant.slug,
  }));
  return "user";
}
