import { capacityLimits, capacityNotes } from "../capacity.js";
import { boolOption, positional, type CommandSpec, type Context } from "../command.js";
import { compareContracts, Contracts, type Capabilities } from "../contracts.js";
import { deleteToken, saveToken } from "../credentials.js";
import { CavelonError, ExitCode, usageError } from "../errors.js";
import { keyValues } from "../format.js";
import { formatQuota, formatValue, limitRef, readLimits, readQuotas, type Limit, type PublishedLimits, type Quota } from "../limits.js";
import { ApiClient, tokensDisabledError } from "../http.js";
import { readAll } from "../io.js";
import { listPreviews, readPull } from "../local-state.js";
import type { Operation } from "../operations.js";
import { expiryOf, readPrincipal } from "../principal.js";
import { readHidden } from "../prompt.js";
import { lookupTenantId, requireInstance, requireToken, TENANT_REF_HINT, type Session } from "../session.js";
import { loadUserConfig, saveUserConfig, tokenKind, updateInstance } from "../user-config.js";

interface Me {
  id?: string;
  email?: string;
  display_name?: string | null;
  global_role?: string | null;
  role?: string;
  context?: { mode?: string; tenant_id?: string | null; effective_role?: string };
  memberships?: Array<{ tenant_id: string; tenant_name: string; role?: string }>;
  accessible_tenants?: Array<{ tenant_id: string; tenant_name: string; role?: string }>;
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
  return response.status === 200 ? response.data : undefined;
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
  summary: "Store a token for an instance (a person runs this, never the agent).",
  description:
    "Asks for the token without echoing it, or reads it from standard input with --token-stdin. It is never an argument.\n" +
    "Create a personal access token (cvpat_…) on /account/access-tokens; a tenant API key (cbp_…) also works.\n" +
    "The token is kept in the operating system's credential store, or in a file only you can read.",
  readOnly: false,
  mcpTool: false,
  options: {
    "token-stdin": { type: "boolean", description: "Read the token from standard input." },
  },
  examples: ["cavelon login --instance https://cavelon.example.com", "op read op://dev/cavelon/token | cavelon login --token-stdin"],
  async run(ctx, input) {
    const session = await ctx.session();
    const url = session.url;
    if (!url) throw usageError("Which instance?", "Pass --instance <url> (or set CAVELON_URL).");
    const token = await readToken(ctx, boolOption(input, "token-stdin"));
    const kind = tokenKind(token);
    if (kind === "unknown") ctx.warn("The token starts with neither cvpat_ nor cbp_; the instance may refuse it.");

    const client = new ApiClient({ url, token }, ctx.io.env);
    const contracts = new Contracts(client, ctx.io.env, ctx.io.now);
    let tenant: { ref: string; id: string; name?: string } | undefined;
    if (session.tenant && kind !== "api_key") {
      const found = await lookupTenantId(client, session.tenant);
      if (!found) {
        throw new CavelonError(ExitCode.failure, { code: "tenant_not_found", message: `No tenant "${session.tenant}" for this token.`, hint: TENANT_REF_HINT });
      }
      tenant = { ref: session.tenant, ...found };
      client.target.tenantId = found.id;
    }
    // Check the token before storing it: a refused token is never kept.
    const { caps, needsTenant } = await readCapabilities(contracts, true);
    const me = await readMe(client);
    // An instance older than the /meta routes answers them 404 before it checks
    // the caller, so neither read above proved the token. One authenticated read
    // of a long-standing route does: its 401 is thrown as a refusal.
    if (!caps && !needsTenant && !me) {
      await client.get("/api/v1/knowledge-bases", { query: { page_size: 1 }, allow: [400, 403, 404, 422] });
    }
    if (needsTenant && !me) {
      throw new CavelonError(ExitCode.validation, {
        code: "tenant_required",
        message: "The instance needs a tenant for this token.",
        hint: "Pass --tenant <slug-or-id>.",
      });
    }
    const store = await saveToken(ctx.io.env, url, token);
    await updateInstance(
      ctx.io.env,
      url,
      (current) => ({
        ...current,
        credential_store: store.kind,
        token_kind: kind,
        logged_in_at: ctx.io.now().toISOString(),
        ...(tenant && session.tenantSource === "option" ? { tenant: tenant.ref, tenant_id: tenant.id, tenant_name: tenant.name } : {}),
      }),
      { makeCurrent: true },
    );

    if (needsTenant) {
      ctx.warn("This token works in Platform mode; choose a tenant with `cavelon use <tenant>` before tenant commands.");
    } else {
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
    if (ctx.io.env.CAVELON_TOKEN) ctx.warn("CAVELON_TOKEN is set and takes precedence over this login.");
    if (store.kind === "file") ctx.warn("No operating-system credential store; the token is in a file only you can read (0600).");

    const data = {
      instance: url,
      credential: { kind, store: store.kind },
      owner: me ? { email: me.email, name: me.display_name ?? null } : null,
      tenant: tenant ? { ref: tenant.ref, id: tenant.id, name: tenant.name ?? null } : null,
      instance_version: caps?.instance.version ?? null,
      contracts: caps?.contracts ?? null,
    };
    const who = me?.email ? ` as ${me.email}` : kind === "api_key" ? " with a tenant API key" : "";
    return {
      data,
      text: `Logged in to ${url}${who}. Token stored in the ${store.kind === "keyring" ? "credential store" : "user-only file"}.`,
    };
  },
};

export const logout: CommandSpec = {
  name: "logout",
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

function credentialSource(session: Session): string {
  if (session.tokenSource === "CAVELON_TOKEN") return "CAVELON_TOKEN";
  return session.tokenStore === "file" ? "login (user-only file)" : "login (credential store)";
}

export const whoami: CommandSpec = {
  name: "whoami",
  summary: "Show who the token acts as, in which tenant, and where the token came from.",
  readOnly: true,
  idempotent: true,
  mcpTool: "whoami",
  async run(ctx) {
    const session = await ctx.session();
    requireToken(session);
    const client = await ctx.client();
    const { caps, needsTenant } = await readCapabilities(await ctx.contracts(), false);
    const me = await readMe(client);
    const principal = needsTenant ? undefined : await readPrincipal(client);
    const contextTenant = me?.context?.tenant_id ?? principal?.tenant_id ?? client.target.tenantId ?? null;
    const tenants = [...(me?.memberships ?? []), ...(me?.accessible_tenants ?? [])];
    const tenantName = tenants.find((t) => t.tenant_id === contextTenant)?.tenant_name ?? session.settings.tenant_name ?? null;
    const expiry = expiryOf(principal, ctx.io.now());
    if (expiry.warning) ctx.warn(expiry.warning);
    const data = {
      instance: { url: session.url, source: session.urlSource, version: caps?.instance.version ?? null },
      credential: {
        kind: principal?.kind ?? session.tokenKind,
        source: session.tokenSource,
        store: session.tokenSource === "login" ? session.tokenStore : null,
        name: principal?.token?.name ?? principal?.api_key?.name ?? null,
        prefix: principal?.token?.prefix ?? principal?.api_key?.prefix ?? null,
        expires_at: expiry.expires_at,
        expires_in_days: expiry.days_left,
        may_activate: principal?.token ? principal.token.may_activate : null,
        ceiling_role: principal?.token?.ceiling_role ?? null,
        scopes: principal?.api_key?.scopes ?? null,
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
        ref: session.tenant ?? null,
        source: session.tenant ? session.tenantSource : null,
        mode: me?.context?.mode ?? principal?.mode ?? (session.tokenKind === "api_key" ? "tenant" : null),
      },
      role: me?.context?.effective_role ?? me?.role ?? null,
    };
    if (needsTenant) ctx.warn("No tenant selected; this token is in Platform mode. Choose one with `cavelon use <tenant>`.");
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
        ["tenant", contextTenant ? `${tenantName ?? contextTenant}${tenantName ? ` (${contextTenant})` : ""}` : "none (Platform mode)"],
        ["tenant from", session.tenant ? session.tenantSource : "the token's default"],
        ["role", data.role ?? undefined],
        ["credential", `${session.tokenKind === "api_key" ? "tenant API key" : session.tokenKind === "personal_access_token" ? "personal access token" : "token"}${tokenName} from ${credentialSource(session)}`],
        ["expires", expires],
        ["may activate", principal?.token ? (principal.token.may_activate ? "yes" : "no (a person activates in the Admin)") : undefined],
        ["version", data.instance.version ?? undefined],
      ]),
    };
  },
};

export const use: CommandSpec = {
  name: "use",
  summary: "Choose the tenant this instance's commands act in.",
  description:
    "Stored per instance for your user. CAVELON_TENANT, --tenant and a cavelon.yaml tenant take precedence over it.",
  readOnly: false,
  idempotent: true,
  mcpTool: "use_tenant",
  positionals: [{ name: "tenant", description: "Tenant slug, name or id.", required: false }],
  options: { clear: { type: "boolean", description: "Forget the chosen tenant." } },
  async run(ctx, input) {
    const session = await ctx.session();
    const url = requireInstance(session);
    requireToken(session);
    if (boolOption(input, "clear")) {
      await updateInstance(ctx.io.env, url, (c) => ({ ...c, tenant: undefined, tenant_id: undefined, tenant_name: undefined }));
      return { data: { instance: url, tenant: null }, text: `No tenant chosen for ${url}.` };
    }
    const ref = positional(input, "tenant");
    if (!ref) throw usageError("Missing <tenant>.", "Usage: cavelon use <tenant>  (or --clear)");
    if (session.tokenKind === "api_key") {
      throw usageError("A tenant API key is bound to its own tenant; `use` applies to personal access tokens.");
    }
    const client = await ctx.client({ tenant: false });
    const found = await lookupTenantId(client, ref);
    if (!found) {
      throw new CavelonError(ExitCode.failure, {
        code: "tenant_not_found",
        message: `No tenant "${ref}" that this token can see.`,
        hint: TENANT_REF_HINT,
      });
    }
    // Ask the instance once with that tenant, so a tenant the token cannot reach fails here.
    const probe = new ApiClient({ ...client.target, tenantId: found.id }, ctx.io.env);
    await probe.get("/api/v1/meta/capabilities", { allow: [404] });
    await updateInstance(ctx.io.env, url, (c) => ({
      ...c,
      tenant: ref,
      tenant_id: found.id,
      tenant_name: found.name ?? c.tenant_name,
      tenant_ids: { ...c.tenant_ids, [ref]: found.id },
    }));
    if (session.tenantSource && session.tenantSource !== "use") {
      ctx.warn(`${session.tenantSource} names tenant "${session.tenant}" and takes precedence over \`use\` here.`);
    }
    return {
      data: { instance: url, tenant: { ref, id: found.id, name: found.name ?? null } },
      text: `Using tenant ${found.name ?? ref} (${found.id}) on ${url}.`,
    };
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

type LimitsState = { published: boolean | null; unavailable?: string };

function limitsLine(state: LimitsState, near: Quota[]): string {
  if (state.published === null) return `not readable: ${state.unavailable}`;
  if (!state.published) return "not published by this instance";
  if (!near.length) return "none close to a quota (`cavelon limits` lists them)";
  return `close to a quota: ${near.map((q) => `${q.key} ${formatQuota(q)}`).join("; ")}`;
}

export const status: CommandSpec = {
  name: "status",
  summary: "Show the instance, tenant, solution, running operations and quotas close to full for this directory.",
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
            open_previews: await listPreviews(session.project.root),
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
    if (!offline && session.url && session.token) {
      try {
        client = await ctx.client();
        if (client.target.tenantId) (data.tenant as Record<string, unknown>).id = client.target.tenantId;
        const contracts = await ctx.contracts();
        const caps = await contracts.capabilities();
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
            ? { items: operations, more: Boolean(page.data.next_cursor) }
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
        }
      } catch (error) {
        reachError = error instanceof Error ? error.message : String(error);
        data.error = error instanceof CavelonError ? error.toJSON() : { message: reachError };
      }
    }
    const tenantText = session.tenant
      ? `${session.tenant} (${session.tenantSource})`
      : session.tokenKind === "api_key"
        ? "the API key's tenant"
        : "not chosen (`cavelon use <tenant>`)";
    const lines: Array<[string, unknown]> = [
      ["instance", session.url ? `${session.url} (${session.urlSource})` : "none (`cavelon login --instance <url>`)"],
      ["credential", session.token ? `${session.tokenKind} from ${credentialSource(session)}` : "none"],
      ["tenant", tenantText],
      ["solution", session.project ? session.project.file : "none (no cavelon.yaml here or above)"],
    ];
    if (session.project) {
      const solution = data.solution as { last_pull: { at: string; harness: { slug: string } | null } | null; open_previews: Array<{ preview_id: string; env: string | null; created_at: string }> };
      if (session.project.harness) lines.push(["harness", session.project.harness]);
      lines.push(["last pull", solution.last_pull ? `${solution.last_pull.at}${solution.last_pull.harness ? ` (${solution.last_pull.harness.slug})` : ""}` : "never"]);
      lines.push([
        "open previews",
        solution.open_previews.length
          ? solution.open_previews.map((p) => `\n  ${p.preview_id}${p.env ? `  env ${p.env}` : ""}  ${p.created_at}`).join("")
          : "none",
      ]);
    }
    if (data.instance_version) lines.push(["version", data.instance_version]);
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
      text += operations.length
        ? `\n\nRunning operations:\n${operations
            .map((o, i) => {
              const wait = waits[i];
              return `  ${o.id}  ${o.kind}  ${o.status}${o.progress?.phase ? ` (${o.progress.phase})` : ""}${wait ? `  ${wait.note}` : ""}`;
            })
            .join("\n")}`
        : "\n\nNo running operations.";
    }
    return { data, text };
  },
};

/** Exposed for `tenant create --use`. */
export async function rememberTenant(ctx: Context, url: string, tenant: { ref: string; id: string; name?: string }): Promise<void> {
  await updateInstance(ctx.io.env, url, (c) => ({
    ...c,
    tenant: tenant.ref,
    tenant_id: tenant.id,
    tenant_name: tenant.name,
    tenant_ids: { ...c.tenant_ids, [tenant.ref]: tenant.id },
  }));
}
