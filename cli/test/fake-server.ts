import http from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { handleLongRunning, longRunningState, type LiveView, type LongRunningState } from "./fake-long-running.js";

/**
 * A fake Cavelon instance for tests. It serves the contract snapshots in
 * `contracts/cavelon/` and answers the routes the commands use with
 * the shapes that OpenAPI publishes (checked in contract.test.ts). Tokens are
 * made per test at runtime; no credential is checked in.
 */

export const CONTRACTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../contracts/cavelon");

let openapiText: string | undefined;
export function openapiSnapshot(): string {
  openapiText ??= readFileSync(path.join(CONTRACTS, "openapi.json"), "utf8");
  return openapiText;
}
const readContract = (name: string) => readFileSync(path.join(CONTRACTS, name), "utf8");
export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
/** A small solution package that matches the package schema snapshot (checked in contract.test.ts). */
export function samplePackage(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, "support-package.json"), "utf8")) as Record<string, unknown>;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
  );
}

export type OpStatus = "queued" | "running" | "needs_action" | "succeeded" | "failed" | "cancelled";

export interface TokenInfo {
  kind: "pat" | "key";
  email?: string;
  name?: string;
  /** Tenants a PAT may select; an API key's one tenant. */
  tenantIds: string[];
  /** A PAT's tenant when no X-Tenant-Id is sent; none means Platform mode. */
  defaultTenant?: string;
  platform?: boolean;
  /** What /meta/principal tells about the token or key. */
  tokenName?: string;
  expiresAt?: string | null;
  mayActivate?: boolean;
  /** An API key's scopes, as /meta/principal lists them; ["admin"] by default. */
  scopes?: string[];
  /**
   * A person's permissions in the tenant; every permission by default. /meta/principal
   * publishes them unless `servePermissions` is off.
   */
  permissions?: string[];
  /** A Platform-mode token's owner's global role; platform_admin by default. */
  globalRole?: string;
  /** The token's ceiling role; the global role in Platform mode, tenant_admin otherwise, by default. */
  ceilingRole?: string;
}

export interface TenantConfig {
  pkg: Record<string, unknown>;
  /** Bumped on every change, as the instance's state digest changes. */
  version: number;
}

export interface FakeOperation {
  id: string;
  kind: string;
  tenantId: string;
  /** Statuses it moves through, one per read. */
  steps: OpStatus[];
  reads: number;
  resultRef?: { type: string; id: string; href?: string };
  error?: { code: string; message: string };
  action?: { reason: string; admin_url: string };
  created_at: string;
  /** The state of the record it reads (trigger runs, loops, archive jobs); advance moves the record on. */
  live?: (advance: boolean) => LiveView;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body?: unknown;
}

export interface FakeState {
  tokens: Map<string, TokenInfo>;
  tenants: Array<{ id: string; slug: string; name: string; plan: string; status: string; created_at: string }>;
  harnesses: Array<Record<string, unknown> & { id: string; tenant_id: string; slug: string; name: string }>;
  kbs: Array<{ id: string; tenant_id: string; name: string }>;
  suites: Array<{ id: string; tenant_id: string; name: string; harness_id: string | null; archived_at: string | null }>;
  runs: Array<{ id: string; tenant_id: string; suite_id: string; summary: Record<string, unknown> }>;
  operations: Map<string, FakeOperation>;
  /** By "trigger:<run id>" or "conversation:<conversation id>". */
  traces: Map<string, Array<Record<string, unknown>>>;
  requests: RecordedRequest[];
  features: Record<string, boolean>;
  serveDocs: boolean;
  serveOperations: boolean;
  serveSse: boolean;
  /** Steps a new upload or test-run operation goes through. */
  defaultSteps: OpStatus[];
  /** Replaces top-level keys of the capabilities snapshot; `limits: undefined` makes an instance older than the limits. */
  capsPatch: Record<string, unknown>;
  /** API error codes added to the catalog snapshot, as a newer instance publishes them. */
  catalogCodes: Array<{ code: string; area: string; message: string; hint: string | null; docs: string }>;
  /** API error codes left out of the catalog snapshot, as an older instance lacks them; such an instance answers request_invalid for them. */
  catalogWithout: string[];
  /** The ceilings the routes enforce, by `change.field`, where they differ from the published `maximum` (an operator changed one since). */
  enforcedCeilings: Record<string, number>;
  /** What /tenants/current/quota-usage answers, in TenantQuotaUsage's shape. */
  quotaUsage: Record<string, unknown>;
  /** The summary a new test run finishes with. */
  runSummary: Record<string, unknown>;
  /** The results a test run lists, as fields over the default result; null lists two passed chat cases. */
  runResults: Array<Record<string, unknown> & { name: string; status: string }> | null;
  /**
   * Behind the production proxy, root paths go to the Admin: false sends
   * /openapi.json and /llms.txt there (a redirect, an HTML page), and only the
   * /api paths reach the API.
   */
  rootPathsReachApi: boolean;
  /** Uploads after this many succeed answer 500 (for partial failures). */
  uploadsBeforeFailure: number;
  /** Event streams to cut off after their first frame. */
  dropStreams: number;
  /** Each tenant's configuration, as export returns it and import replaces it. */
  configs: Map<string, TenantConfig>;
  /** Merged into every import preview (impact, target_needs, loop_budgets). */
  previewExtras: Record<string, unknown>;
  previewBlockers: string[];
  /**
   * When set, a confirmed import's own check refuses it as
   * 409 package_requirements_changed: with these
   * `blockers`, or without the field, as an older instance answers.
   */
  importRequirementsChanged: { blockers?: string[] } | null;
  /** Whether readiness lets a solution activate. */
  ready: boolean;
  /** The blockers readiness names while not ready; a missing test run by default. */
  readinessBlockers?: Array<{ key: string; label: string; state: string; detail: string; href: string | null }>;
  /** Every check readiness ran, and its non-blocking warnings; none by default. */
  readinessChecks?: Array<{ key: string; label: string; state: string; detail: string; href: string }>;
  readinessWarnings?: Array<{ key: string; label: string; state: string; detail: string; href: string }>;
  /** An older instance's readiness, without `checks`. */
  readinessWithoutChecks?: boolean;
  servePrincipal: boolean;
  /** False is an instance older than the /api/v1/meta routes: they answer 404 before any check of the caller, as unknown routes do. */
  serveMeta: boolean;
  servePackageSchema: boolean;
  /** Changes the package schema snapshot before it is served, as a development build gains fields under one version. */
  packageSchemaEdit: ((schema: { properties: Record<string, unknown> }) => void) | null;
  /** Whether the package schema is sent with an ETag and answers a matching If-None-Match with 304; off, as instances do today. */
  packageSchemaEtag: boolean;
  /** Triggers, runs, loops, Sandboxes, archive jobs, API keys. */
  lr: LongRunningState;
  /** Each tenant's variables and secrets. */
  values: Map<string, TenantValues>;
  /** Every tenant's Model Registry rows. */
  models: FakeModel[];
  /** Each tenant's own limit values by limit key, set through the routes the limits' `change` names. */
  tenantLimits: Map<string, Map<string, unknown>>;
  /** Each tenant's monthly inference budget, as PATCH /tenants/{tenant_id}/limits sets it. */
  inferenceBudgets: Map<string, number>;
  /** Whether /meta/principal lists `permissions`; off is an older instance. */
  servePermissions: boolean;
  /** Each tenant's monthly Processing Step cap, and its use this month. */
  processingStepCaps: Map<string, number>;
  processingStepsUsed: number;
  /** The platform's run caps as an operator stored them. */
  runCapacity: { per_tenant?: number; global?: number; wait_seconds?: number };
  /** Each tenant's own run cap, as an operator sets it with the tenant_change. */
  tenantRunCaps: Map<string, number>;
  /** Each tenant's feature flags, as PUT /admin/feature-flags/{tenant_id}/{flag_key} sets them. */
  tenantFlags: Map<string, Map<string, boolean>>;
  /** The tenants on Processing-Step terms: the token budget stops nothing there. */
  processingStepTerms: Set<string>;
}

/** A Model Registry row in ModelResponse's shape, with the tenant it belongs to. */
export type FakeModel = Record<string, unknown> & {
  id: string;
  tenant_id: string;
  model_id: string;
  base_url: string | null;
  max_concurrent_requests: number | null;
};

/** A row as the instance lists it; the fields given replace the defaults. */
export function modelRow(tenantId: string, fields: Partial<FakeModel> = {}): FakeModel {
  const at = new Date().toISOString();
  return {
    id: randomUUID(),
    tenant_id: tenantId,
    model_id: "gpt-4.1",
    display_name: "GPT-4.1",
    provider: "openai",
    base_url: null,
    has_api_key: false,
    api_key_masked: null,
    api_key_type: "none",
    capabilities: ["chat"],
    context_window: null,
    served_context_window: null,
    context_budget: null,
    max_output_tokens: null,
    reasoning: null,
    request_defaults: null,
    request_omit: null,
    endpoint_metadata: null,
    max_concurrent_requests: null,
    is_active: true,
    display_order: 0,
    source: "custom",
    created_at: at,
    updated_at: at,
    routes_via_litellm: false,
    missing_config: null,
    temperature_with_reasoning: false,
    ...fields,
  };
}

/** A tenant's variables, secrets and the declarations its imports recorded. */
export interface TenantValues {
  variables: Map<string, string>;
  /** Secret values as the instance stores them; never in a response. */
  secrets: Map<string, { value: string; changed_at: string }>;
  declared: { variables: Map<string, string | null>; secrets: Map<string, string | null> };
}

export interface FakeServer {
  url: string;
  state: FakeState;
  close(): Promise<void>;
  /** A new token, made at runtime. */
  addToken(info: Partial<TokenInfo> & { kind: "pat" | "key" }): string;
  addTenant(slug: string, name?: string): string;
  addOperation(kind: string, tenantId: string, steps: OpStatus[], extra?: Partial<FakeOperation>): FakeOperation;
  /** A person edits the tenant's configuration in the Admin. */
  editConfig(tenantId: string, edit: (pkg: Record<string, unknown>) => void): void;
}

const now = () => new Date().toISOString();

/** The tenant feature flag behind concurrent branches. */
const PARALLEL_FLAG = "ORCHESTRATION_PARALLEL_FANOUT_ENABLED";

/** A token's ceiling role, as /meta/principal names it. */
function ceilingRole(info: TokenInfo): string {
  return info.ceilingRole ?? (info.platform ? (info.globalRole ?? "platform_admin") : "tenant_admin");
}

/** A Platform-mode token's role: the lesser of its owner's global role and its ceiling. */
const PLATFORM_ROLES = ["platform_support", "platform_admin", "superadmin"];
function effectiveRole(info: TokenInfo): string | undefined {
  const owner = PLATFORM_ROLES.indexOf(info.globalRole ?? "platform_admin");
  const ceiling = PLATFORM_ROLES.indexOf(ceilingRole(info));
  if (owner < 0 || ceiling < 0) return undefined;
  return PLATFORM_ROLES[Math.min(owner, ceiling)];
}

/** Every permission a published change names that a tenant role may hold: a tenant owner's, by default. */
function tenantPermissions(): string[] {
  const caps = JSON.parse(readContract("meta-capabilities.json")) as { limits: { values: Array<{ change?: { permissions: string[]; requires_role?: string[] } }>; tenant_quotas: { changes: Array<{ permissions: string[] }> } } };
  const named = [...caps.limits.values.flatMap((v) => (v.change && !v.change.requires_role ? v.change.permissions : [])), ...caps.limits.tenant_quotas.changes.flatMap((c) => c.permissions)];
  return [...new Set([...named, "agents.view", "limits.view", "settings.view", "usage.view"])].sort();
}

/** A tenant as GET /tenants/{tenant_id} answers it, in TenantDetailResponse's shape. */
function tenantDetailOf(tenant: FakeState["tenants"][number]) {
  return {
    ...tenant,
    is_system: false,
    is_academy: false,
    last_activity_at: null,
    settings: {},
    agent_max_turns_default: 25,
    context_source_limits: {
      attached_documents: {
        source_kind: "attached_documents",
        configured_value: null,
        effective_value: null,
        mode: "inherited",
        effective_mode: "auto",
        provenance: "built_in",
        persisted_path: "settings.context_source_limits.attached_documents",
      },
    },
    effective_conversation_retention: {},
  };
}

/** What /meta/principal publishes as the request's permissions. */
function permissionsOf(info: TokenInfo, tenantId: string | undefined): string[] {
  if (info.kind === "key") return (info.scopes ?? ["admin"]).includes("admin") ? ["limits.inference_budget.manage", "settings.manage", "settings.uploads.manage"] : [];
  if (info.permissions) return [...info.permissions].sort();
  if (!tenantId) {
    // A Platform-mode token carries its global role's permissions.
    const role = effectiveRole(info);
    return role === "platform_support" ? ["platform.maintenance"] : role ? ["limits.manage", "platform.maintenance"] : [];
  }
  return tenantPermissions();
}

const opId = (kind: string, record: string) => `op_${kind}_${record.replace(/-/g, "")}`;

function operationView(op: FakeOperation, advance: boolean) {
  if (op.live) {
    const live = op.live(advance);
    const terminal = ["succeeded", "failed", "cancelled"].includes(live.status);
    return {
      id: op.id,
      kind: op.kind,
      status: live.status,
      progress: { phase: live.phase, current: null, total: null, fraction: null },
      created_at: op.created_at,
      started_at: op.created_at,
      finished_at: terminal ? now() : null,
      result_ref: live.result_ref ?? null,
      error: live.error ?? null,
      action: live.action ?? null,
    };
  }
  const status = op.steps[Math.min(op.reads, op.steps.length - 1)]!;
  if (advance) op.reads++;
  const terminal = ["succeeded", "failed", "cancelled"].includes(status);
  return {
    id: op.id,
    kind: op.kind,
    status,
    progress: { phase: status, current: terminal ? 1 : 0, total: 1, fraction: terminal ? 1 : 0 },
    created_at: op.created_at,
    started_at: op.created_at,
    finished_at: terminal ? now() : null,
    result_ref: op.resultRef ?? null,
    error: status === "failed" ? (op.error ?? { code: "failed", message: "It failed." }) : null,
    action: status === "needs_action" ? (op.action ?? { reason: "A person must decide.", admin_url: "https://admin.example/approve" }) : null,
  };
}

export async function startFakeServer(): Promise<FakeServer> {
  const state: FakeState = {
    tokens: new Map(),
    tenants: [],
    harnesses: [],
    kbs: [],
    suites: [],
    runs: [],
    operations: new Map(),
    traces: new Map(),
    requests: [],
    features: { personal_access_tokens_enabled: true, operations_api_enabled: true },
    serveDocs: true,
    serveOperations: true,
    serveSse: true,
    defaultSteps: ["queued", "running", "succeeded"],
    capsPatch: {},
    catalogCodes: [],
    catalogWithout: [],
    enforcedCeilings: {},
    quotaUsage: defaultQuotaUsage(),
    runSummary: { passed: 2, failed: 0, pass_rate: 1 },
    runResults: null,
    rootPathsReachApi: true,
    uploadsBeforeFailure: Infinity,
    dropStreams: 0,
    configs: new Map(),
    previewExtras: {},
    previewBlockers: [],
    importRequirementsChanged: null,
    ready: true,
    servePrincipal: true,
    serveMeta: true,
    servePackageSchema: true,
    packageSchemaEdit: null,
    packageSchemaEtag: false,
    lr: longRunningState(),
    values: new Map(),
    models: [],
    tenantLimits: new Map(),
    inferenceBudgets: new Map(),
    servePermissions: true,
    processingStepCaps: new Map(),
    processingStepsUsed: 0,
    runCapacity: {},
    tenantRunCaps: new Map(),
    tenantFlags: new Map(),
    processingStepTerms: new Set(),
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: String(error) }));
    });
  });

  const send = (res: http.ServerResponse, status: number, body: unknown, type = "application/json") => {
    res.writeHead(status, { "content-type": type });
    res.end(type === "application/json" ? JSON.stringify(body) : String(body));
  };

  async function readBody(req: http.IncomingMessage): Promise<{ raw: Buffer; json?: unknown; form?: FormData }> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const type = req.headers["content-type"] ?? "";
    if (type.includes("application/json") && raw.length) return { raw, json: JSON.parse(raw.toString("utf8")) };
    if (type.includes("multipart/form-data")) {
      const form = await new Response(raw, { headers: { "content-type": type } }).formData();
      return { raw, form };
    }
    return { raw };
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://fake");
    const p = url.pathname;
    const method = req.method ?? "GET";
    const body = method === "GET" ? { raw: Buffer.alloc(0) } : await readBody(req);
    state.requests.push({ method, path: p, query: url.searchParams, headers: req.headers, body: body.json ?? (body.form ? "multipart" : undefined) });

    if (!state.rootPathsReachApi && (p === "/openapi.json" || p === "/llms.txt")) {
      if (p === "/openapi.json") {
        res.writeHead(307, { location: "/login" });
        return res.end();
      }
      return send(res, 200, "<!DOCTYPE html><html><body>Admin</body></html>", "text/html");
    }
    if (p === "/openapi.json" || (p === "/api/v1/openapi.json" && !state.rootPathsReachApi)) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(openapiSnapshot());
    }

    // Auth: every API and docs route needs a known bearer token.
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const info = token ? state.tokens.get(token) : undefined;
    const isDocs = p === "/llms.txt" || p.startsWith("/api/v1/docs/");
    if (isDocs && !state.serveDocs) return send(res, 404, { detail: "Not Found" });
    if (!state.serveMeta && p.startsWith("/api/v1/meta/")) return send(res, 404, { detail: "Not Found" });
    // With personal access tokens off, their routes answer 404 before any check of
    // the caller, and every cvpat_ bearer is refused.
    if (state.features.personal_access_tokens_enabled === false) {
      if (p.startsWith("/api/v1/personal-access-tokens")) return send(res, 404, { detail: "Not Found" });
      if (token?.startsWith("cvpat_")) return send(res, 401, { detail: "Personal access tokens are not enabled" });
    }
    if (!info) return send(res, 401, { detail: token ? "Invalid personal access token" : "Not authenticated" });

    const headerTenant = req.headers["x-tenant-id"] as string | undefined;
    let tenantId: string | undefined;
    if (info.kind === "key") tenantId = info.tenantIds[0];
    else if (headerTenant) {
      if (!info.tenantIds.includes(headerTenant) && !info.platform) {
        return send(res, 403, { detail: "This personal access token does not reach this tenant" });
      }
      tenantId = headerTenant;
    } else tenantId = info.defaultTenant;
    const needTenant = () => {
      if (!tenantId) {
        send(res, 400, { detail: "No tenant context — select a tenant first" });
        return false;
      }
      return true;
    };

    if (isDocs) {
      if (p === "/llms.txt" || p === "/api/v1/docs/llms.txt") {
        const host = `http://${req.headers.host}`;
        return send(res, 200, readContract("docs/llms.txt").replaceAll("https://cavelon.example.com", host), "text/plain; charset=utf-8");
      }
      const m = /^\/api\/v1\/docs\/([^/]+)\/([^/]+)\.md$/.exec(p);
      // The pages the snapshot holds are served as the instance renders them.
      if (m && existsSync(path.join(CONTRACTS, "docs", `${m[1]}__${m[2]}.md`))) {
        return send(res, 200, readContract(`docs/${m[1]}__${m[2]}.md`), "text/markdown; charset=utf-8");
      }
      if (m) return send(res, 200, `# ${m[2]}\n\n> A page.\n\nBody of ${m[1]}/${m[2]}.\n`, "text/markdown; charset=utf-8");
      return send(res, 404, { detail: "Not Found" });
    }

    if (p === "/api/v1/meta/capabilities") {
      if (!needTenant()) return;
      return send(res, 200, capabilitiesFor(tenantId!));
    }
    if (p === "/api/v1/meta/error-catalog") {
      if (!needTenant()) return;
      const catalog = JSON.parse(readContract("meta-error-catalog.json")) as { api_error_codes: unknown[] };
      const kept = (catalog.api_error_codes as Array<{ code: string }>).filter((e) => !state.catalogWithout.includes(e.code));
      return send(res, 200, { ...catalog, api_error_codes: [...kept, ...state.catalogCodes] });
    }
    if (p === "/api/v1/meta/package-schema" && state.servePackageSchema) {
      const version = url.searchParams.get("version") ?? "v3";
      if (version !== "v3") return send(res, 404, { detail: "package_version_unsupported" });
      const schema = JSON.parse(readContract("meta-package-schema-v3.json")) as { properties: Record<string, unknown> };
      state.packageSchemaEdit?.(schema);
      if (!state.packageSchemaEtag) return send(res, 200, schema);
      const text = JSON.stringify(schema);
      const etag = `"${createHash("sha256").update(text).digest("hex").slice(0, 16)}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag });
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json", etag });
      return res.end(text);
    }
    if (p === "/api/v1/meta/principal" && state.servePrincipal) {
      const prefix = token!.slice(0, 12);
      return send(res, 200, {
        kind: info.kind === "pat" ? "personal_access_token" : "api_key",
        user: info.kind === "pat" ? { id: "00000000-0000-4000-8000-000000000001", email: info.email ?? "dev@example.com" } : null,
        token:
          info.kind === "pat"
            ? {
                id: "00000000-0000-4000-8000-0000000000c1",
                name: info.tokenName ?? "laptop",
                prefix,
                expires_at: info.expiresAt ?? new Date(Date.now() + 60 * 86_400_000).toISOString(),
                ceiling_role: ceilingRole(info),
                platform_mode_allowed: Boolean(info.platform),
                may_activate: info.mayActivate ?? false,
              }
            : null,
        api_key:
          info.kind === "key"
            ? {
                id: "00000000-0000-4000-8000-0000000000c2",
                name: info.tokenName ?? "ci",
                prefix,
                scopes: info.scopes ?? ["admin"],
                expires_at: info.expiresAt ?? null,
                harness_ids: null,
              }
            : null,
        tenant_id: tenantId ?? null,
        mode: tenantId ? "tenant" : "platform",
        ...(state.servePermissions ? { permissions: permissionsOf(info, tenantId) } : {}),
      });
    }
    if (p === "/api/v1/auth/me") {
      if (info.kind !== "pat") return send(res, 401, { detail: "Not authenticated" });
      const memberships = info.tenantIds.map((id, i) => ({
        tenant_id: id,
        tenant_name: state.tenants.find((t) => t.id === id)?.name ?? id,
        role: "tenant_admin",
        is_primary: i === 0,
      }));
      return send(res, 200, {
        id: "00000000-0000-4000-8000-000000000001",
        email: info.email ?? "dev@example.com",
        display_name: info.name ?? "Dev Person",
        account_status: "active",
        global_role: info.platform ? (info.globalRole ?? "platform_admin") : null,
        context: { mode: tenantId ? "tenant" : "platform", tenant_id: tenantId ?? null, effective_role: "tenant_admin", role_scope: "tenant", permissions: [] },
        memberships,
        entitlements: { academy_access: false },
        role: "tenant_admin",
        is_active: true,
        tenant_id: tenantId ?? null,
        created_at: now(),
      });
    }

    // Platform routes: a PAT in Platform mode only.
    if (p === "/api/v1/tenants") {
      if (info.kind === "key") return send(res, 403, { detail: "API keys cannot manage tenants" });
      if (!info.platform || headerTenant) return send(res, 403, { detail: "Insufficient permissions" });
      if (method === "POST") {
        const b = body.json as { slug: string; name: string; plan?: string };
        if (!b?.slug || !/^[a-z0-9-]+$/.test(b.slug)) return send(res, 422, { detail: [{ loc: ["body", "slug"], msg: "invalid slug", type: "value_error" }] });
        if (state.tenants.some((t) => t.slug === b.slug)) return send(res, 409, { detail: "Tenant slug already exists" });
        const tenant = { id: randomUUID(), slug: b.slug, name: b.name, plan: b.plan ?? "starter", status: "active", created_at: now() };
        state.tenants.push(tenant);
        info.tenantIds.push(tenant.id);
        return send(res, 201, tenant);
      }
      const search = url.searchParams.get("search")?.toLowerCase();
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const all = state.tenants.filter((t) => !search || t.slug.includes(search) || t.name.toLowerCase().includes(search));
      return send(res, 200, { items: all.slice(offset, offset + limit), total: all.length });
    }

    // A tenant's detail: tenants.view (Platform mode) reads any; otherwise settings.view in the tenant the caller acts in, and only that one.
    const tenantDetail = /^\/api\/v1\/tenants\/([0-9a-f-]{36})$/.exec(p);
    if (tenantDetail && method === "GET") {
      const tenant = state.tenants.find((t) => t.id === tenantDetail[1]);
      const platformRead = info.platform && !tenantId;
      if (!platformRead && (tenantId !== tenantDetail[1] || !permissionsOf(info, tenantId).includes("settings.view"))) {
        return send(res, 403, { detail: "Insufficient permissions" });
      }
      if (!tenant) return send(res, 404, { detail: "Tenant not found" });
      return send(res, 200, tenantDetailOf(tenant));
    }

    // An operator's changes: a Platform-mode token of a role, without X-Tenant-Id.
    if (p === "/api/v1/platform-settings/runs/capacity" && method === "PATCH") return handleRunCapacity(res, body.json, info, tenantId);
    const tenantLimitsPlatform = /^\/api\/v1\/tenants\/([^/]+)\/limits$/.exec(p);
    if (tenantLimitsPlatform && method === "PATCH" && !tenantId) return handleTenantRunCap(res, tenantLimitsPlatform[1]!, body.json, info);
    const flagRoute = /^\/api\/v1\/admin\/feature-flags\/([^/]+)\/([^/]+)$/.exec(p);
    if (flagRoute && method === "PUT") return handleFeatureFlag(res, flagRoute[1]!, flagRoute[2]!, body.json, info, tenantId);

    if (!needTenant()) return;
    const tid = tenantId!;

    if (p === "/api/v1/tenants/current/quota-usage" && method === "GET") return send(res, 200, quotaUsageFor(tid));
    if (p === "/api/v1/tenants/current/processing-step-cap" && method === "PATCH") return handleProcessingStepCap(res, tid, body.json, info);
    if (method === "PATCH" && p.startsWith("/api/v1/tenants/current/")) return handleTenantLimits(res, p, tid, body.json, info);
    const tenantLimitsRoute = /^\/api\/v1\/tenants\/([^/]+)\/limits$/.exec(p);
    if (tenantLimitsRoute && method === "PATCH") return handleInferenceBudget(res, tenantLimitsRoute[1]!, tid, body.json, info);

    if (p === "/api/v1/harnesses" && method === "GET") {
      return send(res, 200, state.harnesses.filter((h) => h.tenant_id === tid));
    }
    if (p === "/api/v1/harnesses" && method === "POST") {
      const b = body.json as Record<string, unknown>;
      if (state.harnesses.some((h) => h.tenant_id === tid && h.slug === b.slug)) return send(res, 409, { detail: "Slug taken" });
      const harness = makeHarness(tid, String(b.slug), String(b.name), (b.description as string | undefined) ?? null);
      state.harnesses.push(harness);
      return send(res, 201, harness);
    }
    let m = /^\/api\/v1\/harnesses\/([0-9a-f-]{36})(\/readiness|\/activate)?$/.exec(p);
    if (m) {
      const h = state.harnesses.find((x) => x.tenant_id === tid && x.id === m![1]);
      if (!h) return send(res, 404, { detail: "Harness not found." });
      if (!m[2] && method === "GET") return send(res, 200, h);
      const readiness = {
        harness_id: h.id,
        status: h.status,
        ready_to_activate: state.ready,
        ...(state.readinessWithoutChecks ? {} : { checks: state.readinessChecks ?? [] }),
        blockers: state.ready ? [] : (state.readinessBlockers ?? [{ key: "test_run", label: "A passing test run", state: "missing", detail: "Run the regression suite.", href: null }]),
        warnings: state.readinessWarnings ?? [],
        latest_test_run: null,
        activation_override: null,
      };
      if (m[2] === "/readiness" && method === "GET") return send(res, 200, readiness);
      if (m[2] === "/activate" && method === "POST") {
        const b = (body.json ?? {}) as { force?: boolean };
        if (info.kind === "pat" && b.force) return send(res, 403, { detail: "A personal access token never forces activation; resolve the readiness checks first." });
        if (info.kind === "pat" && !info.mayActivate) return send(res, 403, { detail: "This personal access token may not activate solutions." });
        if (!state.ready && !b.force) {
          return send(res, 409, { detail: { code: "solution_not_ready", message: "Resolve the required readiness actions before activating this solution.", readiness } });
        }
        h.status = "active";
        return send(res, 200, h);
      }
    }
    m = /^\/api\/v1\/harnesses\/by-slug\/([^/]+)$/.exec(p);
    if (m) {
      const h = state.harnesses.find((x) => x.tenant_id === tid && x.slug === decodeURIComponent(m![1]!));
      return h ? send(res, 200, h) : send(res, 404, { detail: "Harness not found" });
    }
    m = /^\/api\/v1\/harnesses\/([^/]+)\/clone$/.exec(p);
    if (m && method === "POST") {
      const source = state.harnesses.find((x) => x.tenant_id === tid && x.id === m![1]);
      if (!source) return send(res, 404, { detail: "Harness not found" });
      const b = (body.json ?? {}) as Record<string, unknown>;
      const copy = makeHarness(tid, String(b.slug ?? `${source.slug}-copy`), String(b.name ?? `${source.name} (copy)`), (b.description as string) ?? null);
      state.harnesses.push(copy);
      return send(res, 201, copy);
    }

    if (p === "/api/v1/knowledge-bases" && method === "GET") {
      const search = url.searchParams.get("search")?.toLowerCase();
      const items = state.kbs.filter((k) => k.tenant_id === tid && (!search || k.name.toLowerCase().includes(search))).map(kbView);
      return send(res, 200, { items, page_size: 50, has_more: false, next_cursor: null });
    }
    m = /^\/api\/v1\/knowledge-bases\/([^/]+)\/documents\/upload$/.exec(p);
    if (m && method === "POST") {
      const kb = state.kbs.find((k) => k.tenant_id === tid && k.id === m![1]);
      if (!kb) return send(res, 404, { detail: "Knowledge base not found" });
      if (state.uploadsBeforeFailure <= 0) return send(res, 500, { detail: "Storage unavailable" });
      state.uploadsBeforeFailure--;
      const files = (body.form?.getAll("files") ?? []) as File[];
      if (!files.length) return send(res, 422, { detail: [{ loc: ["body", "files"], msg: "Field required", type: "missing" }] });
      const docs = files.map((file) => {
        const id = randomUUID();
        const op = addOperation("document_ingestion", tid, [...state.defaultSteps], {
          id: opId("document_ingestion", id),
          resultRef: { type: "document", id, href: `/api/v1/knowledge-bases/${kb.id}/documents/${id}/content` },
        });
        return documentView(id, file.name, file.size, state.serveOperations ? op.id : null);
      });
      return send(res, 202, docs);
    }

    if (p === "/api/v1/test-suites" && method === "GET") {
      const harness = url.searchParams.get("harness_id");
      return send(res, 200, state.suites.filter((s) => s.tenant_id === tid && (!harness || s.harness_id === harness)).map(suiteView));
    }
    m = /^\/api\/v1\/test-suites\/([^/]+)\/runs$/.exec(p);
    if (m && method === "POST") {
      const suite = state.suites.find((s) => s.tenant_id === tid && s.id === m![1]);
      if (!suite) return send(res, 404, { detail: "Suite not found" });
      const id = randomUUID();
      const run = { id, tenant_id: tid, suite_id: suite.id, summary: { ...state.runSummary } };
      state.runs.push(run);
      const op = addOperation("test_run", tid, [...state.defaultSteps], {
        id: opId("test_run", id),
        resultRef: { type: "test_run", id, href: `/api/v1/test-runs/${id}/results` },
      });
      return send(res, 201, runView(run, suite.name, "pending", state.serveOperations ? op.id : null));
    }
    m = /^\/api\/v1\/test-runs\/([^/]+)$/.exec(p);
    if (m) {
      const run = state.runs.find((r) => r.tenant_id === tid && r.id === m![1]);
      if (!run) return send(res, 404, { detail: "Run not found" });
      const suite = state.suites.find((s) => s.id === run.suite_id);
      return send(res, 200, runView(run, suite?.name ?? null, "completed", opId("test_run", run.id)));
    }
    m = /^\/api\/v1\/test-runs\/([^/]+)\/results$/.exec(p);
    if (m) {
      const run = state.runs.find((r) => r.tenant_id === tid && r.id === m![1]);
      // Like the instance: an unknown run's results are an empty list, not a 404.
      if (!run) return send(res, 200, []);
      if (state.runResults) {
        return send(res, 200, state.runResults.map(({ name, status, ...fields }) => ({ ...resultView(run.id, name, status, null), ...fields })));
      }
      return send(res, 200, [resultView(run.id, "Greets", "pass", "11111111-1111-4111-8111-111111111111"), resultView(run.id, "Answers", "pass", null)]);
    }

    if (p === "/api/v1/tools" && method === "GET") return send(res, 200, []);
    if (p === "/api/v1/model-registry" || p.startsWith("/api/v1/model-registry/")) {
      return handleModel(res, method, tid, p.slice("/api/v1/model-registry".length + 1), body.json);
    }
    for (const kind of ["variables", "secrets"] as const) {
      const base = `/api/v1/${kind}`;
      if (p !== base && !p.startsWith(`${base}/`)) continue;
      const rest = p.slice(base.length + 1);
      if (rest.includes("/")) return send(res, 404, { detail: "Not Found" });
      return kind === "variables"
        ? handleVariable(res, method, tid, decodeURIComponent(rest), body.json)
        : handleSecret(res, method, tid, decodeURIComponent(rest), body.json, info);
    }
    const handled = handleLongRunning(state.lr, {
      method,
      path: p,
      url,
      headers: req.headers,
      raw: body.raw,
      json: body.json,
      tenantId: tid,
      actor: info.kind === "pat" ? { kind: "user", name: info.email ?? "dev@example.com" } : { kind: "key", name: info.tokenName ?? "ci" },
      send: (status, payload) => send(res, status, payload),
      sendBytes: (status, bytes, headers) => {
        res.writeHead(status, headers);
        res.end(bytes);
      },
      liveOperation: (kind, recordId, tenant, view) => addOperation(kind, tenant, ["running"], { id: opId(kind, recordId), live: view }).id,
    });
    if (handled) return;

    if (p === "/api/v1/agent-graph/export" && method === "GET") {
      const scope = url.searchParams.get("scope") ?? "agent_graph";
      if (scope === "full_config" && info.kind === "key") {
        return send(res, 403, { detail: "full_config export requires admin authentication (JWT), not API key" });
      }
      const config = configFor(tid);
      const pkg = structuredClone(config.pkg);
      pkg.manifest = { ...(pkg.manifest as object), exported_at: now(), scope };
      return send(res, 200, pkg);
    }
    if ((p === "/api/v1/agent-graph/import/preview" || p === "/api/v1/agent-graph/import") && method === "POST") {
      const b = body.json as { package: Record<string, unknown>; mode?: string; harness_id?: string | null; runtime_bindings?: Record<string, string>; preview_id?: string | null };
      const config = configFor(tid);
      const schema = JSON.parse(readContract("meta-package-schema-v3.json")) as { properties: Record<string, unknown> };
      const request = { package: b.package, mode: b.mode ?? "overwrite", harness_id: b.harness_id ?? null, runtime_bindings: b.runtime_bindings ?? {} };
      const previewId = `pv_${createHash("sha256").update(`${tid}:${config.version}:${canonical(request)}`).digest("hex").slice(0, 32)}`;
      const ignored = Object.keys(b.package).filter((k) => !(k in schema.properties));
      const preview = {
        ready: state.previewBlockers.length === 0,
        text_blocks: [],
        mode: request.mode,
        summary: { creates: { agents: 1 }, updates: { knowledge_bases: 1 }, deletes: {}, references: {}, warnings: 0, blockers: state.previewBlockers.length },
        warnings: [],
        blockers: state.previewBlockers,
        ignored: { sections: ignored, fields: [], count: ignored.length },
        impact: { changed_tools: [], changed_knowledge_bases: [], active_harnesses: [], sandbox_writers: [] },
        loop_budgets: [],
        target_needs: { ...valueNeeds(tid, b.package), oauth_grants: [], runtime_bindings: [], trigger_identities: [] },
        ...state.previewExtras,
      };
      if (p.endsWith("/preview")) return send(res, 200, { ...preview, preview_id: previewId });
      if (info.kind === "key") return send(res, 403, { detail: "Agent graph import requires admin authentication (JWT), not API key" });
      if (state.previewBlockers.length) return send(res, 422, { detail: preview });
      if (b.preview_id && b.preview_id !== previewId) {
        return send(res, 409, {
          detail: {
            error: "import_preview_stale",
            message: "The target changed since this preview; nothing was imported.",
            hint: "Preview again, show the new result, and import with the new preview_id.",
          },
        });
      }
      if (state.importRequirementsChanged) {
        // The published body: `blockers` beside the unchanged detail, code, message and hint.
        const catalog = JSON.parse(readContract("meta-error-catalog.json")) as { api_error_codes: Array<{ code: string; message: string; hint: string; docs: string }> };
        const entry = catalog.api_error_codes.find((e) => e.code === "package_requirements_changed")!;
        const said = "Import requirements changed. Preview again; no changes were saved.";
        const blockers = state.importRequirementsChanged.blockers;
        return send(res, 409, {
          ...(blockers ? { blockers } : {}),
          detail: said,
          code: entry.code,
          message: said,
          hint: blockers ? entry.hint : "Preview the import again, then apply it.",
          docs: `http://${req.headers.host}${entry.docs}`,
        });
      }
      const kept = Object.fromEntries(Object.entries(b.package).filter(([k]) => k in schema.properties));
      state.configs.set(tid, { pkg: kept, version: config.version + 1 });
      // Like the instance: an import adds the names a package declares, and never forgets one.
      const values = valuesFor(tid);
      for (const kind of ["variables", "secrets"] as const) {
        for (const row of declarations(b.package, kind)) values.declared[kind].set(row.name, row.description ?? values.declared[kind].get(row.name) ?? null);
      }
      return send(res, 200, { applied: true, mode: request.mode, summary: preview.summary, imported_agents: ["helper"], warnings: [] });
    }

    if (p === "/api/v1/operations" && state.serveOperations) {
      const statuses = url.searchParams.getAll("status");
      const items = [...state.operations.values()]
        .filter((o) => o.tenantId === tid)
        .map((o) => operationView(o, false))
        .filter((o) => !statuses.length || statuses.includes(o.status));
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return send(res, 200, { items: items.slice(0, limit), next_cursor: items.length > limit ? "next" : null });
    }
    m = /^\/api\/v1\/operations\/([^/]+)(\/events)?$/.exec(p);
    if (m && state.serveOperations) {
      const op = state.operations.get(m[1]!);
      if (!op || op.tenantId !== tid) return send(res, 404, { detail: "Operation not found" });
      if (!m[2]) return send(res, 200, operationView(op, true));
      if (!state.serveSse) return send(res, 404, { detail: "Not Found" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (state.dropStreams > 0) {
        state.dropStreams--;
        res.write(`data: ${JSON.stringify({ type: "operation", operation: operationView(op, true) })}\n\n`);
        return res.destroy();
      }
      for (;;) {
        const view = operationView(op, true);
        res.write(`data: ${JSON.stringify({ type: "operation", operation: view })}\n\n`);
        if (["succeeded", "failed", "cancelled"].includes(view.status)) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      res.write(`data: ${JSON.stringify({ type: "end", reason: "terminal" })}\n\n`);
      return res.end();
    }

    m = /^\/api\/v1\/(triggers\/runs|conversations)\/([^/]+)\/traces(?:\/([^/]+))?$/.exec(p);
    if (m) {
      const traces = state.traces.get(`${m[1] === "conversations" ? "conversation" : "trigger"}:${m[2]}`);
      if (!traces) return send(res, 404, { detail: "Not found" });
      if (!m[3]) return send(res, 200, traces.map(({ spans: _spans, ...t }) => t));
      const t = traces.find((x) => x.id === m![3]);
      return t ? send(res, 200, t) : send(res, 404, { detail: "Trace not found" });
    }

    return send(res, 404, { detail: "Not Found" });
  }

  /** The capabilities snapshot with the test's patch, and the tenant's own limit values in its limits. */
  function capabilitiesFor(tenantId: string): Record<string, unknown> {
    const caps = JSON.parse(readContract("meta-capabilities.json"));
    caps.features = { ...caps.features, ...state.features };
    const merged = { ...caps, ...structuredClone(state.capsPatch) } as Record<string, unknown> & { limits?: { values?: Array<Record<string, unknown>> } };
    const own = state.tenantLimits.get(tenantId);
    const stored: Record<string, number | undefined> = {
      max_concurrent_agent_runs_per_tenant: state.runCapacity.per_tenant,
      max_concurrent_agent_runs_global: state.runCapacity.global,
      agent_run_slot_wait_seconds: state.runCapacity.wait_seconds,
    };
    const flag = state.tenantFlags.get(tenantId)?.get(PARALLEL_FLAG);
    for (const entry of merged.limits?.values ?? []) {
      const key = String(entry.key);
      if (own?.has(key)) Object.assign(entry, { value: own.get(key), source: "tenant" });
      // An operator's stored run cap wins over the default; a tenant's own cap over the platform's.
      if (stored[key] !== undefined) Object.assign(entry, { value: stored[key], origin: "platform_setting" });
      if (key === "max_concurrent_agent_runs_per_tenant" && state.tenantRunCaps.has(tenantId)) {
        Object.assign(entry, { value: state.tenantRunCaps.get(tenantId), source: "tenant", setting: "max_concurrent_agent_runs" });
        delete entry.origin;
      }
      if (key === "orchestration_parallel_branches" && flag !== undefined && Array.isArray(entry.switches)) {
        const switches = entry.switches as Array<Record<string, unknown>>;
        for (const item of switches) if (item.source === "tenant") item.enabled = flag;
        const platformOn = switches.find((item) => item.source === "platform")?.enabled !== false;
        const deciding = platformOn ? switches.find((item) => item.source === "tenant") : switches.find((item) => item.source === "platform");
        Object.assign(entry, { value: platformOn && flag, source: deciding?.source, setting: deciding?.setting });
      }
    }
    // The operator's archive formats, listed while the tenant's switch is on.
    const values = merged.limits?.values ?? [];
    const archiveSwitch = values.find((e) => e.key === "kb_upload_archive_enabled");
    const formats = values.find((e) => e.key === "kb_upload_archive_formats" && e.changeable_by === "operator");
    if (archiveSwitch && formats && own?.has("kb_upload_archive_enabled")) formats.value = archiveSwitch.value === true ? ["zip"] : [];
    const quotas = (merged.limits as { tenant_quotas?: { values?: Array<Record<string, unknown>>; changes?: Array<Record<string, unknown>> } } | undefined)?.tenant_quotas;
    // Under Processing-Step terms the inference budget's change is not offered.
    if (quotas?.changes && state.processingStepTerms.has(tenantId)) quotas.changes = quotas.changes.filter((c) => c.key !== "monthly_inference_token_budget");
    for (const value of quotas?.values ?? []) {
      if (value.key !== "monthly_processing_step_cap") continue;
      const cap = state.processingStepCaps.get(tenantId) ?? null;
      const used = state.processingStepsUsed;
      Object.assign(value, { value: cap, used, state: cap === null ? "none" : used >= cap ? "reached" : "ok" });
    }
    return merged;
  }

  /** The quota usage, with the Processing Step row as the tenant's cap and use make it. */
  function quotaUsageFor(tenantId: string): Record<string, unknown> {
    const usage = structuredClone(state.quotaUsage);
    const row = usage.monthly_processing_steps as Record<string, unknown> | undefined;
    if (row && "cap" in row) {
      const cap = state.processingStepCaps.get(tenantId) ?? 0;
      Object.assign(row, { cap, current: state.processingStepsUsed, state: cap <= 0 ? "none" : state.processingStepsUsed >= cap ? "reached" : "ok" });
    }
    const budget = usage.monthly_inference_tokens as Record<string, unknown> | undefined;
    if (budget && "platform_budget" in budget && state.inferenceBudgets.has(tenantId)) budget.platform_budget = state.inferenceBudgets.get(tenantId);
    if (state.processingStepTerms.has(tenantId)) {
      // The token allocation stops nothing under these terms: the row reports 0 and names no change.
      usage.commercial_model = "processing_steps";
      if (budget) {
        budget.platform_budget = 0;
        delete budget.change;
      }
    }
    return usage;
  }

  /** Whether a request is an operator's Platform-mode token with one of the roles; else the refusal is sent. */
  function platformCaller(res: http.ServerResponse, info: TokenInfo, tenantId: string | undefined, roles: string[]): boolean {
    if (info.kind === "key") {
      send(res, 401, { detail: "Not authenticated" });
      return false;
    }
    const role = effectiveRole(info);
    if (!info.platform || tenantId || !role || !roles.includes(role)) {
      refuse(res, 403, "forbidden", "Insufficient permissions");
      return false;
    }
    return true;
  }

  /** PATCH /platform-settings/runs/capacity: only the caps sent; null clears one (a superadmin). */
  function handleRunCapacity(res: http.ServerResponse, json: unknown, info: TokenInfo, tenantId: string | undefined) {
    if (!platformCaller(res, info, tenantId, ["superadmin"])) return;
    const bounds: Record<string, [number, number]> = { per_tenant: [1, 100_000], global: [1, 1_000_000], wait_seconds: [0, 600] };
    const sent = (json ?? {}) as Record<string, unknown>;
    for (const [field, value] of Object.entries(sent)) {
      const bound = bounds[field];
      if (!bound) return send(res, 422, { detail: [{ type: "extra_forbidden", loc: ["body", field], msg: "Extra inputs are not permitted" }] });
      if (value !== null && (typeof value !== "number" || value < bound[0] || value > bound[1])) {
        return send(res, 422, { detail: [{ type: "less_than_equal", loc: ["body", field], msg: "out of bounds" }] });
      }
    }
    const caps = state.runCapacity as Record<string, number | undefined>;
    for (const [field, value] of Object.entries(sent)) caps[field] = value === null ? undefined : (value as number);
    // The snapshot's defaults.
    const baseline = { per_tenant: 20, global: 200, wait_seconds: 30 };
    const view = Object.fromEntries(
      (Object.keys(baseline) as Array<keyof typeof baseline>).flatMap((field) => [
        [field, caps[field] ?? baseline[field]],
        [`${field}_origin`, caps[field] === undefined ? "default" : "platform_setting"],
      ]),
    );
    return send(res, 200, {
      ...view,
      baseline,
      baseline_origin: { per_tenant: "default", global: "default", wait_seconds: "default" },
      environment_variables: { per_tenant: "MAX_CONCURRENT_AGENT_RUNS_PER_TENANT", global: "MAX_CONCURRENT_AGENT_RUNS_GLOBAL", wait_seconds: "AGENT_RUN_SLOT_WAIT_SECONDS" },
      stored: { per_tenant: caps.per_tenant ?? null, global: caps.global ?? null, wait_seconds: caps.wait_seconds ?? null },
    });
  }

  /** PATCH /tenants/{tenant_id}/limits in Platform mode: one tenant's own run cap (a platform admin or superadmin). */
  function handleTenantRunCap(res: http.ServerResponse, target: string, json: unknown, info: TokenInfo) {
    if (!platformCaller(res, info, undefined, ["platform_admin", "superadmin"])) return;
    const tenant = state.tenants.find((t) => t.id === target);
    if (!tenant) return send(res, 404, { detail: "Tenant not found" });
    const value = (json as { max_concurrent_agent_runs?: unknown } | null)?.max_concurrent_agent_runs;
    if (value !== null && value !== undefined && !(Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 100_000)) {
      return send(res, 422, { detail: [{ type: "greater_than_equal", loc: ["body", "max_concurrent_agent_runs"], msg: "Input should be greater than or equal to 1" }] });
    }
    if (value === null) state.tenantRunCaps.delete(target);
    else if (typeof value === "number") state.tenantRunCaps.set(target, value);
    return send(res, 200, tenantDetail(target, { max_concurrent_agent_runs: state.tenantRunCaps.get(target) ?? null }));
  }

  /** PUT /admin/feature-flags/{tenant_id}/{flag_key}: an operator switches one tenant's flag. */
  function handleFeatureFlag(res: http.ServerResponse, target: string, flag: string, json: unknown, info: TokenInfo, tenantId: string | undefined) {
    if (!platformCaller(res, info, tenantId, ["platform_admin", "superadmin"])) return;
    const enabled = (json as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== "boolean") return send(res, 422, { detail: [{ type: "bool_type", loc: ["body", "enabled"], msg: "Input should be a valid boolean" }] });
    const flags = state.tenantFlags.get(target) ?? new Map<string, boolean>();
    flags.set(flag, enabled);
    state.tenantFlags.set(target, flags);
    return send(res, 200, { tenant_id: target, flag_key: flag, enabled, metadata: null, updated_at: now(), updated_by: info.email ?? "dev@example.com" });
  }

  /** PATCH /tenants/current/processing-step-cap: settings.manage, a whole number from 0; 0 or null removes it. */
  function handleProcessingStepCap(res: http.ServerResponse, tid: string, json: unknown, info: TokenInfo) {
    if (!holds(info, ["settings.manage"])) return refuse(res, 403, "forbidden", "This credential may not change the Processing Step cap.");
    const sent = (json ?? {}) as Record<string, unknown>;
    if (!("monthly_processing_step_cap" in sent) || Object.keys(sent).length !== 1) {
      return send(res, 422, { detail: [{ type: "missing", loc: ["body", "monthly_processing_step_cap"], msg: "Field required" }], code: "request_invalid" });
    }
    const value = sent.monthly_processing_step_cap;
    if (value !== null && !(Number.isInteger(value) && (value as number) >= 0)) return refuse(res, 422, "request_invalid", "monthly_processing_step_cap: a whole number from 0");
    const old = state.processingStepCaps.get(tid) ?? null;
    if (value === null || value === 0) state.processingStepCaps.delete(tid);
    else state.processingStepCaps.set(tid, value as number);
    const quota = ((capabilitiesFor(tid).limits as { tenant_quotas: { values: Array<Record<string, unknown>> } }).tenant_quotas.values ?? []).find(
      (v) => v.key === "monthly_processing_step_cap",
    );
    return send(res, 200, { changed: [{ setting: "monthly_processing_step_cap", old, new: state.processingStepCaps.get(tid) ?? null }], quota });
  }

  /** A kit operation's coded refusal, as the instance answers it. */
  const refuse = (res: http.ServerResponse, status: number, code: string, message: string) =>
    send(res, status, { detail: message, code, message, docs: "/docs/reference/api-endpoints#errors-and-retries" });

  /** A switch takes a boolean, a list of file types a list, any other limit a whole number. */
  function fitsType(field: string, published: unknown, value: unknown): boolean {
    if (field.endsWith("enabled")) return typeof value === "boolean";
    if (Array.isArray(published)) return Array.isArray(value);
    return Number.isInteger(value);
  }

  /** Whether the credential holds one of the permissions: an admin key, or a person with one of them. */
  function holds(info: TokenInfo, permissions: string[]): boolean {
    if (info.kind === "key") return (info.scopes ?? ["admin"]).includes("admin");
    return !info.permissions || permissions.some((p) => info.permissions!.includes(p));
  }

  /**
   * PATCH /tenants/current/{upload-defaults,agent-defaults,rate-limits}:
   * the fields are the ones the published limits' `change` names for this path, with their bounds.
   */
  function handleTenantLimits(res: http.ServerResponse, p: string, tid: string, json: unknown, info: TokenInfo) {
    type Entry = Record<string, unknown> & { key: string; setting: string; change: { path: string; field: string; permissions: string[]; minimum?: number; maximum?: number; maximum_setting?: string } };
    const entries = ((capabilitiesFor(tid).limits as { values?: Entry[] } | undefined)?.values ?? []).filter((e) => e.change?.path === p);
    if (!entries.length) return send(res, 404, { detail: "Not Found" });
    if (!holds(info, entries[0]!.change.permissions)) return refuse(res, 403, "forbidden", "This credential may not change these settings.");
    // The body's fields, flattened to the dotted names `change.field` uses.
    const sent: Array<[string, unknown]> = [];
    const flatten = (value: unknown, prefix: string) => {
      for (const [k, v] of Object.entries((value ?? {}) as Record<string, unknown>)) {
        if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, `${prefix}${k}.`);
        else sent.push([`${prefix}${k}`, v]);
      }
    };
    flatten(json, "");
    const invalid = (field: string, msg: string) => refuse(res, 422, "request_invalid", `${field}: ${msg}`);
    const own = state.tenantLimits.get(tid) ?? new Map<string, unknown>();
    const updates: Array<[Entry, unknown]> = [];
    for (const [field, value] of sent) {
      const entry = entries.find((e) => e.change.field === field);
      if (!entry) return send(res, 422, { detail: [{ type: "extra_forbidden", loc: ["body", ...field.split(".")], msg: "Extra inputs are not permitted" }], code: "request_invalid" });
      const { minimum, maximum: published, maximum_setting: ceiling } = entry.change;
      const maximum = state.enforcedCeilings[field] ?? published;
      if (value !== null) {
        if (!fitsType(field, entry.value, value)) return invalid(field, "wrong type");
        if (typeof value === "number" && ceiling && maximum !== undefined && value > maximum) {
          const said = `${entry.setting} may only lower the platform ceiling of ${maximum} requests per minute; an operator raises ${ceiling}`;
          if (state.catalogWithout.includes("limit_above_platform_ceiling")) return refuse(res, 422, "request_invalid", said);
          // The coded refusal, its fields beside the catalog's hint.
          return send(res, 422, {
            setting: entry.setting,
            value,
            maximum,
            maximum_setting: ceiling,
            detail: said,
            code: "limit_above_platform_ceiling",
            message: said,
            hint: "Send at most `maximum`. Only an operator raises the ceiling, through `maximum_setting`.",
            docs: "/docs/reference/api-endpoints#errors-and-retries",
          });
        }
        if (typeof value === "number" && ((minimum !== undefined && value < minimum) || (maximum !== undefined && value > maximum))) return invalid(field, "out of bounds");
      }
      updates.push([entry, value]);
    }
    const changed = updates.map(([entry, value]) => {
      const old = own.has(entry.key) ? own.get(entry.key) : null;
      // On an older instance, archive_uploads.enabled switched the archive formats the entry listed; a current one has its own boolean entry.
      const shown = entry.change.field.endsWith("enabled") && entry.unit !== "boolean" ? (value ? ["zip"] : []) : value;
      if (value === null) own.delete(entry.key);
      else own.set(entry.key, shown);
      return { setting: entry.setting, old, new: value };
    });
    state.tenantLimits.set(tid, own);
    const now = ((capabilitiesFor(tid).limits as { values?: Entry[] }).values ?? []).filter((e) => e.change?.path === p);
    return send(res, 200, { changed, limits: now });
  }

  /** A tenant as PATCH /tenants/{tenant_id}/limits answers it (TenantDetailResponse). */
  function tenantDetail(tid: string, fields: Record<string, unknown>): Record<string, unknown> {
    const tenant = state.tenants.find((t) => t.id === tid)!;
    return {
      ...tenant,
      monthly_inference_token_budget: state.inferenceBudgets.get(tid) ?? 1_000_000,
      agent_max_turns_default: 25,
      context_source_limits: {
        attached_documents: {
          source_kind: "attached_documents",
          configured_value: null,
          effective_value: 20,
          mode: "inherited",
          effective_mode: "capped",
          provenance: "built_in",
          persisted_path: "settings.context_sources.attached_documents",
        },
      },
      effective_conversation_retention: {},
      ...fields,
    };
  }

  /** PATCH /tenants/{tenant_id}/limits: a tenant credential changes only its own tenant's inference budget. */
  function handleInferenceBudget(res: http.ServerResponse, target: string, tid: string, json: unknown, info: TokenInfo) {
    if (target !== tid) return refuse(res, 403, "forbidden", "This credential may not change another tenant's limits.");
    const fields = Object.keys((json ?? {}) as Record<string, unknown>);
    if (fields.some((f) => f !== "monthly_inference_token_budget")) return refuse(res, 403, "forbidden", "Only limits.manage changes these limits.");
    if (!holds(info, ["limits.inference_budget.manage", "limits.manage"])) return refuse(res, 403, "forbidden", "This credential may not change the inference budget.");
    const value = (json as { monthly_inference_token_budget?: unknown }).monthly_inference_token_budget;
    if (value !== undefined && value !== null && !(Number.isInteger(value) && (value as number) >= 0)) {
      return send(res, 422, { detail: [{ type: "greater_than_equal", loc: ["body", "monthly_inference_token_budget"], msg: "Input should be greater than or equal to 0" }] });
    }
    if (typeof value === "number") state.inferenceBudgets.set(tid, value);
    return send(res, 200, tenantDetail(tid, {}));
  }

  /** The Model Registry list and a row's update, as model_registry.py answers them (agents.manage_llm_config). */
  function handleModel(res: http.ServerResponse, method: string, tid: string, rest: string, json: unknown) {
    const view = ({ tenant_id: _tenant, ...row }: FakeModel) => row;
    if (!rest) {
      if (method !== "GET") return send(res, 405, { detail: "Method Not Allowed" });
      return send(res, 200, state.models.filter((m) => m.tenant_id === tid).map(view));
    }
    if (rest.includes("/") || method !== "PATCH") return send(res, 404, { detail: "Not Found" });
    const row = state.models.find((m) => m.tenant_id === tid && m.id === rest);
    if (!row) return send(res, 404, { detail: "Model not found" });
    const changes = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
    const extra = Object.keys(changes).filter((k) => !["max_concurrent_requests", "base_url", "display_name", "is_active"].includes(k));
    if (extra.length) return send(res, 422, { detail: extra.map((k) => ({ type: "extra_forbidden", loc: ["body", k], msg: "Extra inputs are not permitted" })) });
    const limit = changes.max_concurrent_requests;
    if (limit !== undefined && limit !== null && !(Number.isInteger(limit) && (limit as number) >= 1 && (limit as number) <= 100_000)) {
      return send(res, 422, { detail: [{ type: "int_type", loc: ["body", "max_concurrent_requests"], msg: "Input should be a valid integer between 1 and 100000" }] });
    }
    const merged = { ...row, ...changes } as FakeModel;
    if (merged.max_concurrent_requests !== null && !(merged.base_url ?? "").trim()) {
      return send(res, 422, { detail: "max_concurrent_requests needs a base_url: it limits requests to that endpoint" });
    }
    Object.assign(row, changes, { updated_at: new Date().toISOString() });
    return send(res, 200, view(row));
  }

  function valuesFor(tenantId: string): TenantValues {
    let values = state.values.get(tenantId);
    if (!values) {
      values = { variables: new Map(), secrets: new Map(), declared: { variables: new Map(), secrets: new Map() } };
      state.values.set(tenantId, values);
    }
    return values;
  }

  /** A name the routes take: what the published path parameter's pattern and length allow. */
  const validName = (name: string) => name.length >= 1 && name.length <= 128 && [...name].every((c) => /[\w.-]/.test(c));
  const badName = (res: http.ServerResponse) =>
    send(res, 422, { detail: [{ type: "string_pattern_mismatch", loc: ["path", "name"], msg: String.raw`String should match pattern '^[\w.\-]+$'` }], code: "request_invalid" });

  function handleVariable(res: http.ServerResponse, method: string, tid: string, name: string, json: unknown) {
    const values = valuesFor(tid);
    if (!name) {
      if (method !== "GET") return send(res, 405, { detail: "Method Not Allowed" });
      const items = [...values.variables].sort(([a], [b]) => a.localeCompare(b)).map(([n, value]) => ({ name: n, value, source: null }));
      return send(res, 200, { items });
    }
    if (!validName(name)) return badName(res);
    if (method === "GET") {
      const value = values.variables.get(name);
      return value === undefined ? send(res, 404, { detail: `Variable '${name}' is not set` }) : send(res, 200, { name, value, source: null });
    }
    if (method === "PUT") {
      const value = (json as { value?: unknown } | undefined)?.value;
      if (typeof value !== "string" || value.length > 10_000) {
        return send(res, 422, { detail: [{ type: "string_type", loc: ["body", "value"], msg: "Input should be a valid string" }] });
      }
      values.variables.set(name, value);
      return send(res, 200, { name, value, source: null });
    }
    if (method === "DELETE") {
      if (!values.variables.delete(name)) return send(res, 404, { detail: `Variable '${name}' is not set` });
      res.writeHead(204);
      return res.end();
    }
    return send(res, 405, { detail: "Method Not Allowed" });
  }

  function handleSecret(res: http.ServerResponse, method: string, tid: string, name: string, json: unknown, info: TokenInfo) {
    const values = valuesFor(tid);
    if (!name) {
      if (method !== "GET") return send(res, 405, { detail: "Method Not Allowed" });
      const names = new Set([...values.secrets.keys(), ...values.declared.secrets.keys()]);
      return send(res, 200, { items: [...names].sort((a, b) => a.localeCompare(b)).map((n) => secretStatus(values, n)) });
    }
    if (!validName(name)) return badName(res);
    if (method === "GET") return send(res, 200, secretStatus(values, name));
    if (method !== "PUT" && method !== "DELETE") return send(res, 405, { detail: "Method Not Allowed" });
    if (info.kind === "key") {
      return send(res, 403, {
        detail: "A tenant API key cannot set or delete a secret value.",
        code: "secret_needs_a_person",
        message: "A tenant API key cannot set or delete a secret value.",
        hint: "A person sets it: in the Admin under Settings › Secrets, or with a personal access token.",
        docs: "/docs/reference/api-endpoints#errors-and-retries",
      });
    }
    if (method === "PUT") {
      const value = (json as { value?: unknown } | undefined)?.value;
      // Like the instance, a refusal never repeats the submitted value.
      if (typeof value !== "string" || value.length < 1 || value.length > 16_384) {
        return send(res, 422, { detail: [{ type: "string_too_long", loc: ["body", "value"], msg: "String should have at most 16384 characters" }], code: "request_invalid" });
      }
      values.secrets.set(name, { value, changed_at: now() });
      return send(res, 200, secretStatus(values, name));
    }
    if (!values.secrets.delete(name)) return send(res, 404, { detail: `Secret '${name}' has no value` });
    res.writeHead(204);
    return res.end();
  }

  /** The variables and secrets a package declares or names that the tenant has no value for, as the preview lists them. */
  function valueNeeds(tid: string, pkg: Record<string, unknown>) {
    const values = valuesFor(tid);
    const content = JSON.stringify(Object.fromEntries(Object.entries(pkg).filter(([k]) => !["manifest", "required_variables", "required_secrets"].includes(k))));
    const named = (marker: string) => new Set([...content.matchAll(new RegExp(String.raw`\{\{${marker}:([\w.-]+)\}\}`, "g"))].map((m) => m[1]!));
    const needs = (kind: "variables" | "secrets", marker: string, isSet: (name: string) => boolean) => {
      const declared = new Map(declarations(pkg, kind).map((row) => [row.name, row.description ?? null]));
      return [...new Set([...named(marker), ...declared.keys()])]
        .sort((a, b) => a.localeCompare(b))
        .filter((name) => !isSet(name))
        .map((name) => ({ name, references: [], declared: declared.has(name), description: declared.get(name) ?? null, ...(kind === "secrets" ? { redacted_on_export: false } : {}) }));
    };
    return {
      secrets: needs("secrets", "secret", (name) => values.secrets.has(name)),
      variables: needs("variables", "var", (name) => values.variables.has(name)),
    };
  }

  function configFor(tenantId: string): TenantConfig {
    let config = state.configs.get(tenantId);
    if (!config) {
      config = { pkg: samplePackage(), version: 1 };
      state.configs.set(tenantId, config);
    }
    return config;
  }

  function addOperation(kind: string, tenantId: string, steps: OpStatus[], extra: Partial<FakeOperation> = {}): FakeOperation {
    const record = randomUUID();
    const op: FakeOperation = { id: opId(kind, record), kind, tenantId, steps, reads: 0, created_at: now(), ...extra };
    state.operations.set(op.id, op);
    return op;
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    addToken(info) {
      const token = `${info.kind === "pat" ? "cvpat_" : "cbp_"}${randomBytes(18).toString("hex")}`;
      state.tokens.set(token, { tenantIds: [], ...info });
      return token;
    },
    addTenant(slug, name) {
      const id = randomUUID();
      state.tenants.push({ id, slug, name: name ?? slug, plan: "starter", status: "active", created_at: now() });
      return id;
    },
    addOperation,
    editConfig(tenantId, edit) {
      const config = configFor(tenantId);
      edit(config.pkg);
      config.version++;
    },
  };
}

/** A secret's name and status, as the instance answers; never its value. */
function secretStatus(values: TenantValues, name: string) {
  const stored = values.secrets.get(name);
  const declared = values.declared.secrets.has(name);
  return {
    name,
    status: stored ? "set" : "not_set",
    changed_at: stored?.changed_at ?? null,
    declared,
    description: values.declared.secrets.get(name) ?? null,
  };
}

/** The rows a package's required_variables or required_secrets section declares. */
function declarations(pkg: Record<string, unknown>, kind: "variables" | "secrets"): Array<{ name: string; description?: string | null }> {
  const rows = pkg[`required_${kind}`];
  return Array.isArray(rows) ? rows.filter((r): r is { name: string; description?: string | null } => Boolean(r) && typeof r.name === "string" && r.name !== "") : [];
}

/** A tenant's quotas and their use, as /tenants/current/quota-usage serves them. */
export function defaultQuotaUsage(): Record<string, unknown> {
  return {
    commercial_model: "legacy_unassigned",
    knowledge_bases: { current: 1, limit: 10 },
    documents_per_kb: { current_total: 3, limit_per_kb: 2000 },
    storage_bytes: { current: 1_048_576, limit: 5_368_709_120, measurement_status: "verified", blocking_reason: null },
    // The rows a Tenant Owner changes name their change.
    monthly_inference_tokens: {
      current: 1200,
      limit: 1_000_000,
      platform_budget: 1_000_000,
      state: "ok",
      warning_ratio: 0.8,
      exhausted_since: null,
      change: { key: "monthly_inference_token_budget", field: "platform_budget" },
    },
    monthly_ingestion_tokens: { current: 0, limit: 0 },
    monthly_processing_steps: {
      cap: 0,
      current: 0,
      included: null,
      remaining: null,
      state: "none",
      period_key: "2026-10",
      period_start: "2026-10-01T00:00:00+00:00",
      resets_at: "2026-11-01T00:00:00+00:00",
      billing_timezone: "UTC",
      change: { key: "monthly_processing_step_cap", field: "cap" },
    },
    agents: { current: 2, limit: 20 },
    tools: { current: 0, limit: 50 },
  };
}

function makeHarness(tenantId: string, slug: string, name: string, description: string | null) {
  return {
    id: randomUUID(),
    tenant_id: tenantId,
    slug,
    name,
    description,
    status: "draft",
    is_default: false,
    harness_type: "custom",
    global_instructions: null,
    run_state_model_id: null,
    memory_config: {},
    settings: {},
    created_at: now(),
    updated_at: now(),
    agent_count: 0,
    channel_count: 0,
    readiness: null,
    order_binding: [],
    iteration_of: [],
  };
}

function kbView(kb: { id: string; name: string }) {
  return {
    id: kb.id,
    name: kb.name,
    description: null,
    status: "active",
    document_count: 0,
    total_chunks: 0,
    sync_interval_hours: null,
    last_sync_at: null,
    created_at: now(),
    legacy_office_uploads: false,
  };
}

function documentView(id: string, filename: string, size: number, operationId: string | null) {
  return {
    id,
    filename,
    source_type: "upload",
    status: "pending",
    chunk_count: 0,
    error_message: null,
    created_at: now(),
    file_size_bytes: size,
    has_original: true,
    operation_id: operationId,
  };
}

function suiteView(s: { id: string; name: string; harness_id: string | null; archived_at: string | null }) {
  return {
    id: s.id,
    harness_id: s.harness_id,
    archived_at: s.archived_at,
    name: s.name,
    description: null,
    tags: [],
    case_count: 2,
    created_at: now(),
    updated_at: now(),
  };
}

function runView(run: { id: string; suite_id: string; summary: Record<string, unknown> }, suiteName: string | null, status: string, operationId: string | null) {
  return {
    id: run.id,
    suite_id: run.suite_id,
    harness_id: null,
    suite_name: suiteName,
    status,
    started_at: now(),
    completed_at: status === "completed" ? now() : null,
    config: {},
    summary: status === "completed" ? run.summary : {},
    triggered_by: "cavelon",
    notes: null,
    compare_run_id: null,
    progress_current: status === "completed" ? 2 : 0,
    progress_total: 2,
    created_at: now(),
    covers_suite: true,
    operation_id: operationId,
  };
}

function resultView(runId: string, name: string, status: string, conversationId: string | null) {
  return {
    id: randomUUID(),
    run_id: runId,
    test_case_id: randomUUID(),
    step_id: randomUUID(),
    test_case_name: name,
    step_order: 1,
    evaluate: true,
    generated_answer: "Hello",
    agent_slug: "main",
    conversation_id: conversationId,
    response_latency_ms: 120,
    token_count: 42,
    retrieval_chunks: null,
    tool_calls: null,
    guardrail_events: null,
    llm_judge_score: 0.9,
    llm_judge_reasoning: null,
    similarity_score: null,
    manual_verdict: null,
    manual_comment: null,
    status,
    error_message: null,
    created_at: now(),
  };
}

export function traceFixture(id: string, conversationId: string | null) {
  const span = (n: number, type: string, name: string, status = "ok") => ({
    id: `${id}-span-${n}`,
    parent_span_id: n === 1 ? null : `${id}-span-1`,
    span_key: `k${n}`,
    span_type: type,
    name,
    agent_name: "Main",
    agent_slug: "main",
    model: type === "llm" ? "model-x" : null,
    tool_name: type === "tool" ? name : null,
    tool_type: type === "tool" ? "builtin" : null,
    skill_slug: null,
    skill_name: null,
    status,
    sequence: n,
    started_at: now(),
    ended_at: now(),
    duration_ms: 10 * n,
    input_json: { prompt: "x".repeat(5000) },
    output_json: { text: "done" },
    attributes_json: {},
    token_usage_json: { input: 10, output: 5 },
    error_json: status === "error" ? { message: "tool exploded" } : null,
  });
  return {
    id,
    conversation_id: conversationId,
    message_id: null,
    agent_run_id: null,
    workflow_name: "support",
    source: "chat",
    status: "completed",
    root_span_id: `${id}-span-1`,
    openai_trace_id: null,
    openai_trace_url: null,
    started_at: now(),
    ended_at: now(),
    duration_ms: 60,
    error_summary: null,
    total_spans: 3,
    total_tool_calls: 1,
    total_llm_calls: 1,
    total_input_tokens: 10,
    total_output_tokens: 5,
    total_cached_tokens: 0,
    total_reasoning_tokens: 0,
    has_retrieval: false,
    created_at: now(),
    spans: [span(1, "agent", "Main"), span(2, "llm", "generate"), span(3, "tool", "search_documents", "error")],
  };
}
