import http from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { handleLongRunning, longRunningState, type LiveView, type LongRunningState } from "./fake-long-running.js";
import { databaseState, exportQueries, handleDatabase, queryBlockers, type DatabaseState } from "./fake-database.js";
import { tenantWideSections } from "../src/package-files.js";
import type { PackageSchema } from "../src/contracts.js";

/**
 * A fake Cavelon instance for tests. It serves the contract snapshots in
 * `contracts/cavelon/` and answers the routes the commands use with
 * the shapes that OpenAPI publishes (checked in contract.test.ts). Tokens are
 * made per test at runtime; no credential is checked in.
 */

export const CONTRACTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../contracts/cavelon");

/** The docs pages only a platform operator in Platform mode is listed; the snapshot is a tenant member's index. */
export const PLATFORM_DOCS_SECTION =
  "## Platform Operations\n\n" +
  "- [Operating the Platform](https://cavelon.example.com/api/v1/docs/platform/operating-the-platform.md): Tenants, platform settings and model endpoints, for platform operators\n";

let openapiText: string | undefined;
export function openapiSnapshot(): string {
  openapiText ??= readFileSync(path.join(CONTRACTS, "openapi.json"), "utf8");
  return openapiText;
}
/**
 * The snapshot with its person-only markers changed, or without any (null),
 * and the body fields `secrets` names (component schema → its properties)
 * marked as an instance marks a secret value, or without any marked (null).
 */
function withMarkers(marks: Record<string, string | false> | null, secrets: Record<string, string[]> | null): string {
  if (marks && !Object.keys(marks).length && secrets && !Object.keys(secrets).length) return openapiSnapshot();
  const doc = JSON.parse(openapiSnapshot()) as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
    components: { schemas: Record<string, { properties?: Record<string, Record<string, unknown>> }> };
  };
  if (secrets === null) {
    for (const schema of Object.values(doc.components.schemas)) {
      for (const property of Object.values(schema.properties ?? {})) {
        if (!property["x-cavelon-secret"]) continue;
        delete property["x-cavelon-secret"];
        delete property.writeOnly;
      }
    }
  }
  for (const [schema, fields] of Object.entries(secrets ?? {})) {
    for (const field of fields) Object.assign(doc.components.schemas[schema]!.properties![field]!, { "x-cavelon-secret": true, writeOnly: true });
  }
  for (const [route, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (method === "parameters") continue;
      const mark = marks ? marks[`${method.toUpperCase()} ${route}`] : false;
      if (mark === undefined) continue;
      delete op["x-cavelon-person-only"];
      delete op["x-cavelon-person-only-reason"];
      if (mark !== false) Object.assign(op, { "x-cavelon-person-only": true, "x-cavelon-person-only-reason": mark });
    }
  }
  return JSON.stringify(doc);
}
/**
 * The upload as an instance of each kind publishes it: as the snapshot, with
 * `replace_existing` and `replaced_document_ids`, for a recent one; without
 * those for an older one, and also without `replace_doc_ids` for the oldest.
 */
function withUploadReplace(text: string, kind: FakeState["uploadReplace"]): string {
  if (kind === "name") return text;
  const doc = JSON.parse(text) as { components: { schemas: Record<string, { properties: Record<string, unknown>; required?: string[] }> } };
  const form = doc.components.schemas.Body_upload_documents_api_v1_knowledge_bases__kb_id__documents_upload_post!;
  delete form.properties.replace_existing;
  delete doc.components.schemas.DocumentResponse!.properties.replaced_document_ids;
  if (kind === "none") delete form.properties.replace_doc_ids;
  return JSON.stringify(doc);
}
/** The OpenAPI without `include_tenant_wide` on the export and the import, as an instance older than it publishes it. */
function withTenantWideFlag(text: string, on: boolean): string {
  if (on) return text;
  const doc = JSON.parse(text) as {
    paths: Record<string, Record<string, { parameters?: Array<{ name: string }> }>>;
    components: { schemas: Record<string, { properties: Record<string, unknown> }> };
  };
  const exportOp = doc.paths["/api/v1/agent-graph/export"]!.get!;
  exportOp.parameters = exportOp.parameters?.filter((p) => p.name !== "include_tenant_wide");
  delete doc.components.schemas.AgentGraphPackageImportRequest!.properties.include_tenant_wide;
  return JSON.stringify(doc);
}
/** The OpenAPI without the confirmation route and the `x-cavelon-confirmation` marks, as an instance older than them publishes it. */
function withConfirmations(text: string, on: boolean): string {
  if (on) return text;
  const doc = JSON.parse(text) as { paths: Record<string, Record<string, Record<string, unknown>>> };
  delete doc.paths["/api/v1/confirmations"];
  for (const item of Object.values(doc.paths)) {
    for (const op of Object.values(item)) {
      if (!op["x-cavelon-confirmation"]) continue;
      delete op["x-cavelon-confirmation"];
      delete op["x-cavelon-confirmation-when"];
      delete (op.responses as Record<string, unknown> | undefined)?.["428"];
    }
  }
  return JSON.stringify(doc);
}

/** Older instances may have neither reader overrides nor the verified-address flag. */
function withChatReaders(text: string, readers: boolean, verified: boolean): string {
  if (readers && verified) return text;
  const doc = JSON.parse(text) as { components: { schemas: Record<string, { properties: Record<string, unknown> }> } };
  if (!readers) {
    for (const name of ["ChatRequest", "TestRunCreate"]) {
      delete doc.components.schemas[name]!.properties.reader_mode;
      delete doc.components.schemas[name]!.properties.reader_chat_user_id;
    }
  }
  if (!verified) delete doc.components.schemas.EndUserResponse!.properties.email_verified;
  return JSON.stringify(doc);
}

export interface FakeChatUser {
  id: string;
  tenant_id: string;
  email: string | null;
  email_verified: boolean;
}
/** The OpenAPI without these operations ("METHOD /path"), as an instance older than them publishes it. */
function withoutOperations(text: string, operations: string[]): string {
  if (!operations.length) return text;
  const doc = JSON.parse(text) as { paths: Record<string, Record<string, unknown>> };
  for (const entry of operations) {
    const [method, route] = entry.split(" ");
    delete doc.paths[route!]?.[method!.toLowerCase()];
  }
  return JSON.stringify(doc);
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

/**
 * The digest a confirmation binds, as the instance computes it: the method,
 * the decoded path with its query sorted, and the canonical JSON body, where
 * no body and an empty object are one change.
 */
export function changeDigest(method: string, pathWithQuery: string, body: unknown): string {
  const url = new URL(pathWithQuery, "http://fake");
  const query = [...url.searchParams].sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1));
  const search = new URLSearchParams(query).toString();
  const empty = body === undefined || body === "" || (body !== null && typeof body === "object" && !Array.isArray(body) && !Object.keys(body).length);
  const path = `${decodeURIComponent(url.pathname)}${search ? `?${search}` : ""}`;
  return createHash("sha256").update(canonical({ method: method.toUpperCase(), path, body: empty ? null : body })).digest("hex");
}

export type OpStatus = "queued" | "running" | "needs_action" | "succeeded" | "failed" | "cancelled";

export interface TokenInfo {
  kind: "pat" | "key";
  email?: string;
  name?: string;
  /** Tenants a PAT may select; an API key's one tenant. */
  tenantIds: string[];
  /**
   * A PAT's tenant when no X-Tenant-Id is sent (its owner's default tenant). Without
   * one, a PAT limited to one tenant acts in it, a Platform-mode PAT in Platform
   * mode, and any other is refused.
   */
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
  /**
   * The operations /meta/principal lists in `needs_a_person` on a recent
   * instance. By default a key's: setting or deleting a secret, and the
   * import, whose handler admits only a person; none for a token.
   */
  needsAPerson?: Array<{ method: string; path: string; reason: string }>;
  /**
   * An operator's token without a tenant allowlist: with X-Tenant-Id it enters
   * any tenant, and without one /meta/principal says it reaches every tenant
   * and searches them. `tenantIds` are then the person's own memberships.
   */
  reachesAll?: boolean;
  /** The token's role in each tenant, as /meta/principal lists it; tenant_admin by default. */
  roles?: Record<string, string>;
  /** A Platform-mode token's owner's global role; platform_admin by default. */
  globalRole?: string;
  /** The token's ceiling role; the global role in Platform mode, tenant_admin otherwise, by default. */
  ceilingRole?: string;
  /** A Platform-mode token that enters only the tenants it lists, and is not given one it creates. */
  platformOnly?: boolean;
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
  /** Uploaded documents; a replaced one is soft-deleted and no longer listed. */
  documents: Array<{ id: string; tenant_id: string; kb_id: string; filename: string; size: number; is_active: boolean; deleted: boolean; created_at: string; sha256?: string }>;
  /**
   * Whether an upload reuses an active document of the same content instead of
   * creating one, as the instance's content-hash dedup does; off by default.
   */
  uploadDedup: boolean;
  /** Whether each uploaded document says `upload_outcome` (created, replaced, deduplicated); off is an older instance. */
  uploadOutcome: boolean;
  /** Whether the document list publishes `file_sha256`, the hash the upload's dedup compares; off is an older instance. */
  documentHashes: boolean;
  /**
   * How an upload replaces a document named like an existing one: "name" also
   * a same-named active one by default (`replace_existing`), reporting
   * `replaced_document_ids`, as the snapshot's instance; "ids" only the ones
   * `replace_doc_ids` names, as an older instance; "none" neither, as an
   * instance whose upload form has no `replace_doc_ids` either.
   */
  uploadReplace: "none" | "ids" | "name";
  /**
   * Whether a solution's export and import carry its tenant-wide sections only
   * when `include_tenant_wide` asks, as the snapshot's instance; off is an
   * older instance, whose OpenAPI has no such flag and whose solution export
   * and import carry them always.
   */
  tenantWideFlag: boolean;
  /**
   * Whether a solution's preview with tenant-wide sections reports them as
   * `tenant_wide: {sections, applied, reaches_active_solutions}`, as the
   * instance does with the flag; off, a preview that takes the flag but
   * reports nothing.
   */
  tenantWideReport: boolean;
  /**
   * Whether that report also names `would_import` and `left_out`, and the
   * import's result carries its own `tenant_wide` with `imported`, as a recent
   * instance does; off, the snapshot's instance, whose kit reads `applied`.
   * `tenantWideKept` names sections such an instance leaves out even with
   * include_tenant_wide.
   */
  tenantWideLists: boolean;
  tenantWideKept: string[];
  /** The permissions that let a role set or delete secrets; an instance may name them otherwise than today's. */
  secretsPermissions: string[];
  /**
   * How a stale confirm is refused: null as an older instance (the code in
   * `detail`); a list as a recent one (`code` at the top), with `changed`
   * naming what changed when the list is not empty.
   */
  staleChanged: string[] | null;
  suites: Array<{ id: string; tenant_id: string; name: string; harness_id: string | null; archived_at: string | null; settings?: Record<string, unknown> }>;
  chatUsers: FakeChatUser[];
  readerOverrides: boolean;
  chatUserEmailVerified: boolean;
  runs: Array<{ id: string; tenant_id: string; suite_id: string; summary: Record<string, unknown>; harness_id?: string | null }>;
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
  /** False answers 404 for the OpenAPI at both paths, as an instance that does not serve it. */
  serveOpenapi: boolean;
  /**
   * The `x-cavelon-person-only` marker over the snapshot's, by "METHOD /path":
   * a reason marks the operation, false leaves it unmarked. `null` serves the
   * OpenAPI without any marker, as an instance older than the marker.
   */
  personOnly: Record<string, string | false> | null;
  /** Operations ("METHOD /path") the served OpenAPI leaves out, as an instance older than them. */
  openapiWithout: string[];
  /** The chat turns the instance answered: the solution, the message and the session. */
  chats: Array<{ harness_id: string; message: string; session_id: string }>;
  /**
   * Body fields marked `x-cavelon-secret` beside the snapshot's own, by
   * component schema; `null` serves the OpenAPI without any, as an instance
   * older than the marker.
   */
  secretFields: Record<string, string[]> | null;
  /**
   * Answers that break off after the status and part of the body, as a proxy
   * or a dropped connection leaves them: "cut" closes the connection, "stall"
   * sends nothing more. The request is handled first. `skip` lets that many
   * matching requests through whole.
   */
  interruptions: Array<{ method: string; path: RegExp; mode: "cut" | "stall"; skip?: number }>;
  /** Routes that answer this status instead, as a failing route of an otherwise working instance. */
  failures: Array<{ method: string; path: RegExp; status: number; detail?: string; code?: string }>;
  /** Uploads after this many succeed answer 500 (for partial failures). */
  uploadsBeforeFailure: number;
  /** Event streams to cut off after their first frame. */
  dropStreams: number;
  /** Each tenant's configuration, as export returns it and import replaces it. */
  configs: Map<string, TenantConfig>;
  /**
   * Whether the export fills in the package schema's non-null defaults and
   * orders each object's fields as the schema lists them, as an instance's
   * export does. Off returns a package as it was imported, the fixture the
   * tests that compare pulled bytes rely on.
   */
  exportFillsDefaults: boolean;
  /** Each solution's persona, by harness id, as GET/PUT /bot-persona read and write it. */
  personas: Map<string, Record<string, unknown>>;
  /** An older instance whose solution list has no is_default. */
  harnessesWithoutDefault: boolean;
  /** Merged into every import preview (impact, target_needs, loop_budgets). */
  previewExtras: Record<string, unknown>;
  previewBlockers: string[];
  /**
   * When set, a confirmed import's own check refuses it as
   * 409 package_requirements_changed: with these
   * `blockers`, or without the field, as an older instance answers; and with
   * `blocker_details` (code, message, path, hint) beside them, as a preview
   * sends them, where a test sets them. The published contracts describe
   * neither field (the OpenAPI leaves the body open, and the error catalog's
   * hint names `blockers` only), so this body follows the catalog's entry.
   */
  importRequirementsChanged: { blockers?: string[]; blocker_details?: Array<Record<string, unknown>> } | null;
  /** Whether readiness lets a solution activate. */
  ready: boolean;
  /** The blockers readiness names while not ready; a missing test run by default. */
  readinessBlockers?: Array<{ key: string; label: string; state: string; detail: string; href: string | null; items?: Array<Record<string, unknown>> }>;
  /** Every check readiness ran, and its non-blocking warnings; none by default. */
  readinessChecks?: Array<{ key: string; label: string; state: string; detail: string; href: string }>;
  readinessWarnings?: Array<{ key: string; label: string; state: string; detail: string; href: string }>;
  /** An older instance's readiness, without `checks`. */
  readinessWithoutChecks?: boolean;
  /** The latest test run readiness names; none by default. */
  latestTestRun?: Record<string, unknown> | null;
  /** An instance whose /meta/principal does not say whether a token allows Platform mode. */
  principalWithoutPlatformMode?: boolean;
  /**
   * A recent instance's docs: the platform pages are listed to a person with a
   * platform role whatever the token may do, each line ending in
   * `(audience: platform)`, and every page is sent with `X-Docs-Audience`. Off
   * is an older instance, which lists them only in Platform mode and says
   * neither.
   */
  docsAudience?: boolean;
  /** An instance whose readiness does not name the latest test run. */
  readinessWithoutLatestRun?: boolean;
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
  /** Database connections, saved queries and their runs. */
  db: DatabaseState;
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
  /**
   * Whether /meta/principal publishes what it accepts from every kind of
   * credential: `needs_a_person`, the acting `tenant`, a key's permissions
   * from its scopes and `harnesses.activate` for a token that may activate.
   * Off is an older instance, whose key permissions are the tenant admin's
   * settings ones alone and whose tokens never carry `harnesses.activate`.
   */
  serveCredentialAccess: boolean;
  /**
   * Whether the instance refuses a personal access token, as it does a key, on
   * setting or deleting a secret: only a person signed in to
   * the Admin does it, and /meta/principal lists both operations in a token's
   * `needs_a_person` too. Off by default, so a token sets secrets as on an
   * instance before it.
   */
  tokensRefusedOnSecrets: boolean;
  /**
   * Whether /meta/principal answers a personal access token without a tenant
   * and lists the tenants it reaches, and /auth/me memberships carry
   * tenant_slug; off is an older instance, which refuses such a token there.
   */
  serveTenantReach: boolean;
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
  /**
   * The confirmation a personal access token's guarded change carries:
   * `enforced`, as the snapshot's instance; published but off (`enforced:
   * false`), as an operator who turned CONFIRMATION_NONCE_REQUIRED off; null,
   * an older instance, which publishes no `confirmations`, no
   * `x-cavelon-confirmation` marks and no route, and asks for nothing.
   */
  confirmations: { enforced: boolean } | null;
  /** The confirmation ids issued, by id: bound to the token, the tenant and the change's digest; a test expires one through `expiresAt`. */
  confirmationIds: Map<string, FakeConfirmation>;
  /** How long an issued id lasts; the instance's is 10 minutes, 0 issues ids that have expired by the time they are sent. */
  confirmationTtlMs: number;
}

export interface FakeConfirmation {
  token: string;
  tenantId: string;
  method: string;
  path: string;
  digest: string;
  expiresAt: number;
  used: boolean;
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

const PLATFORM_ROLES = ["platform_support", "platform_admin", "superadmin"];

/** Whether a token's owner has a platform role: a Platform-mode token's owner always does here. */
function ownerHasPlatformRole(info: TokenInfo): boolean {
  return info.kind === "pat" && (Boolean(info.platform) || PLATFORM_ROLES.includes(info.globalRole ?? ""));
}

/** A Platform-mode token's role: the lesser of its owner's global role and its ceiling. */
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

/** What a tenant role grants in a solution's lifecycle beyond the settings a published change names. */
const WORKFLOW_PERMISSIONS = [
  "agents.edit",
  "agents.manage_llm_config",
  "harnesses.manage",
  "harnesses.view",
  "knowledge_bases.manage_documents",
  "knowledge_bases.view",
  "end_users.read",
  "chat_users.view",
  "playground.use",
  "sandboxes.manage",
  "sandboxes.write",
  "settings.secrets.manage",
  "triggers.manage",
];

/** What a `knowledge_base` key's routes let it pass, on a recent instance. */
const KNOWLEDGE_BASE_KEY_PERMISSIONS = ["knowledge_bases.manage", "knowledge_bases.manage_documents", "knowledge_bases.view"];

/** A tenant owner's permissions as the fake knows them; a recent instance adds `harnesses.activate`. */
function ownerPermissions(recent: boolean): string[] {
  return [...new Set([...tenantPermissions(), ...WORKFLOW_PERMISSIONS, ...(recent ? ["harnesses.activate"] : [])])].sort();
}

/** What /meta/principal publishes as the request's permissions. */
function permissionsOf(info: TokenInfo, tenantId: string | undefined, recent: boolean): string[] {
  if (info.kind === "key") {
    const scopes = info.scopes ?? ["admin"];
    if (!recent) return scopes.includes("admin") ? ["limits.inference_budget.manage", "settings.manage", "settings.uploads.manage", "settings.view"] : [];
    if (info.permissions) return [...info.permissions].sort();
    if (scopes.includes("admin")) return ownerPermissions(true);
    return [...new Set([...(scopes.includes("knowledge_base") ? KNOWLEDGE_BASE_KEY_PERMISSIONS : []), ...scopes.filter((s) => s.includes("."))])].sort();
  }
  if (info.permissions) return [...info.permissions].sort();
  if (!tenantId) {
    // A Platform-mode token carries its global role's permissions.
    const role = effectiveRole(info);
    return role === "platform_support" ? ["platform.maintenance"] : role ? ["limits.manage", "platform.maintenance", "tenants.manage"] : [];
  }
  // A recent instance's token carries activation only when it was issued with may_activate.
  return ownerPermissions(false).concat(recent && info.mayActivate ? ["harnesses.activate"] : []).sort();
}

/** What a recent instance's /meta/principal lists as the operations a person runs, not this credential. */
function needsAPersonOf(info: TokenInfo, tokensRefusedOnSecrets: boolean): Array<{ operation: string | null; method: string; path: string; reason: string }> {
  const listed =
    info.needsAPerson ??
    (info.kind === "key"
      ? [
          { method: "POST", path: "/api/v1/agent-graph/import", reason: "Runs only for a person: a dashboard session or a personal access token" },
          { method: "DELETE", path: "/api/v1/secrets/{name}", reason: "Sets or deletes a secret value" },
          { method: "PUT", path: "/api/v1/secrets/{name}", reason: "Sets or deletes a secret value" },
        ]
      : tokensRefusedOnSecrets
        ? [
            { method: "DELETE", path: "/api/v1/secrets/{name}", reason: "Sets or deletes a secret value" },
            { method: "PUT", path: "/api/v1/secrets/{name}", reason: "Sets or deletes a secret value" },
          ]
        : []);
  const doc = JSON.parse(readContract("openapi.json")) as { paths: Record<string, Record<string, { operationId?: string }>> };
  return listed.map((o) => ({ operation: doc.paths[o.path]?.[o.method.toLowerCase()]?.operationId ?? null, ...o }));
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
    documents: [],
    uploadReplace: "name",
    tenantWideFlag: true,
    tenantWideReport: true,
    tenantWideLists: false,
    tenantWideKept: [],
    secretsPermissions: ["settings.manage", "settings.secrets.manage"],
    staleChanged: null,
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
    serveOpenapi: true,
    chatUsers: [],
    readerOverrides: true,
    chatUserEmailVerified: true,
    personOnly: {},
    openapiWithout: [],
    chats: [],
    secretFields: {},
    interruptions: [],
    failures: [],
    uploadsBeforeFailure: Infinity,
    uploadDedup: false,
    uploadOutcome: false,
    documentHashes: false,
    dropStreams: 0,
    configs: new Map(),
    exportFillsDefaults: false,
    previewExtras: {},
    previewBlockers: [],
    personas: new Map(),
    harnessesWithoutDefault: false,
    importRequirementsChanged: null,
    ready: true,
    servePrincipal: true,
    serveMeta: true,
    servePackageSchema: true,
    packageSchemaEdit: null,
    packageSchemaEtag: false,
    lr: longRunningState(),
    db: databaseState(),
    values: new Map(),
    models: [],
    tenantLimits: new Map(),
    inferenceBudgets: new Map(),
    servePermissions: true,
    serveCredentialAccess: true,
    tokensRefusedOnSecrets: false,
    serveTenantReach: true,
    processingStepCaps: new Map(),
    processingStepsUsed: 0,
    runCapacity: {},
    tenantRunCaps: new Map(),
    tenantFlags: new Map(),
    processingStepTerms: new Set(),
    confirmations: { enforced: true },
    confirmationIds: new Map(),
    confirmationTtlMs: 600_000,
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
    const failure = state.failures.find((f) => f.method === method && f.path.test(p));
    if (failure) return send(res, failure.status, { detail: failure.detail ?? "Internal Server Error", ...(failure.code ? { code: failure.code } : {}) });
    const interruption = state.interruptions.find((i) => i.method === method && i.path.test(p));
    if (interruption && (interruption.skip ?? 0) > 0) interruption.skip!--;
    else if (interruption) {
      res.end = ((chunk?: unknown) => {
        const whole = chunk === undefined || typeof chunk === "function" ? "" : String(chunk);
        res.write(whole.slice(0, Math.max(1, Math.floor(whole.length / 2))), () => {
          if (interruption.mode === "cut") res.destroy();
        });
        return res;
      }) as typeof res.end;
    }

    if (!state.serveOpenapi && (p === "/openapi.json" || p === "/api/v1/openapi.json")) return send(res, 404, { detail: "Not Found" });
    if (!state.rootPathsReachApi && (p === "/openapi.json" || p === "/llms.txt")) {
      if (p === "/openapi.json") {
        res.writeHead(307, { location: "/login" });
        return res.end();
      }
      return send(res, 200, "<!DOCTYPE html><html><body>Admin</body></html>", "text/html");
    }
    if (p === "/openapi.json" || (p === "/api/v1/openapi.json" && !state.rootPathsReachApi)) {
      res.writeHead(200, { "content-type": "application/json" });
      const marked = withChatReaders(withConfirmations(withMarkers(state.personOnly, state.secretFields), state.confirmations !== null), state.readerOverrides, state.chatUserEmailVerified);
      return res.end(withoutOperations(withTenantWideFlag(withUploadReplace(marked, state.uploadReplace), state.tenantWideFlag), state.openapiWithout));
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
      if (!info.tenantIds.includes(headerTenant) && !(info.platform && !info.platformOnly) && !info.reachesAll) {
        return send(res, 403, { detail: "This personal access token does not reach this tenant" });
      }
      tenantId = headerTenant;
    } else if (info.defaultTenant) tenantId = info.defaultTenant;
    // A token limited to one tenant selects it when the request names none.
    else if (!info.platform && info.tenantIds.length === 1) tenantId = info.tenantIds[0];
    // A token without Platform mode is refused before any route. An older
    // instance refuses it on /meta/principal too, so no route says which
    // tenants it reaches; a recent one answers it there.
    const reachRead = state.serveTenantReach && p === "/api/v1/meta/principal" && method === "GET";
    if (info.kind === "pat" && !tenantId && !info.platform && !isDocs && !reachRead) {
      return send(res, 403, { detail: "This personal access token does not work in Platform mode; select a tenant with X-Tenant-Id" });
    }
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
        const index = readContract("docs/llms.txt").replaceAll("https://cavelon.example.com", host);
        // The index lists only the pages the caller may read: a platform
        // operator in Platform mode also gets the platform pages.
        // A recent instance lists them to anyone whose owner has a platform role, marked by audience.
        const listed = state.docsAudience ? ownerHasPlatformRole(info) : info.platform && !tenantId;
        let section = PLATFORM_DOCS_SECTION.replaceAll("https://cavelon.example.com", host);
        if (state.docsAudience) section = section.replace(/\n$/, " (audience: platform)\n");
        return send(res, 200, index + (listed ? `\n${section}` : ""), "text/plain; charset=utf-8");
      }
      const m = /^\/api\/v1\/docs\/([^/]+)\/([^/]+)\.md$/.exec(p);
      if (m && state.docsAudience) res.setHeader("x-docs-audience", m[1] === "platform" ? "platform" : "tenant");
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
      const schema = packageSchema();
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
                ...(state.principalWithoutPlatformMode ? {} : { platform_mode_allowed: Boolean(info.platform) }),
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
        // A token whose ceiling holds no platform role is answered in no mode, with no permission, as the instance does.
        mode: tenantId ? "tenant" : info.kind === "key" || (info.platform && effectiveRole(info)) ? "platform" : "none",
        ...(state.servePermissions ? { permissions: permissionsOf(info, tenantId, state.serveCredentialAccess) } : {}),
        ...(state.serveCredentialAccess
          ? {
              tenant: (() => {
                const t = tenantId ? state.tenants.find((x) => x.id === tenantId) : undefined;
                return t ? { id: t.id, name: t.name, slug: t.slug } : null;
              })(),
              needs_a_person: needsAPersonOf(info, state.tokensRefusedOnSecrets),
            }
          : {}),
        ...(info.kind === "pat" && state.serveTenantReach ? reachOf(info, url.searchParams) : {}),
      });
    }
    if (p === "/api/v1/auth/me") {
      if (info.kind !== "pat") return send(res, 401, { detail: "Not authenticated" });
      const memberships = info.tenantIds.map((id, i) => ({
        tenant_id: id,
        tenant_name: state.tenants.find((t) => t.id === id)?.name ?? id,
        ...(state.serveTenantReach ? { tenant_slug: state.tenants.find((t) => t.id === id)?.slug ?? null } : {}),
        role: "tenant_admin",
        is_primary: i === 0,
      }));
      return send(res, 200, {
        id: "00000000-0000-4000-8000-000000000001",
        email: info.email ?? "dev@example.com",
        display_name: info.name ?? "Dev Person",
        account_status: "active",
        global_role: info.platform ? (info.globalRole ?? "platform_admin") : (info.globalRole ?? null),
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
      if (!effectiveRole(info)) return send(res, 403, { detail: "This personal access token's ceiling leaves no access here" });
      if (method === "POST") {
        const b = body.json as { slug: string; name: string; plan?: string };
        if (!b?.slug || !/^[a-z0-9-]+$/.test(b.slug)) return send(res, 422, { detail: [{ loc: ["body", "slug"], msg: "invalid slug", type: "value_error" }] });
        if (state.tenants.some((t) => t.slug === b.slug)) return send(res, 409, { detail: "Tenant slug already exists" });
        const tenant = { id: randomUUID(), slug: b.slug, name: b.name, plan: b.plan ?? "starter", status: "active", created_at: now() };
        state.tenants.push(tenant);
        if (!info.platformOnly) info.tenantIds.push(tenant.id);
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
      if (!platformRead && (tenantId !== tenantDetail[1] || !permissionsOf(info, tenantId, state.serveCredentialAccess).includes("settings.view"))) {
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

    const chatUserList = /^\/api\/v1\/tenants\/([^/]+)\/chat-users$/.exec(p);
    if (chatUserList && method === "GET") {
      if (chatUserList[1] !== tid) return send(res, 403, { detail: "The Chat User directory belongs to the acting tenant." });
      if (!permissionsOf(info, tid, true).includes("chat_users.view")) return send(res, 403, { detail: "Missing permission: chat_users.view" });
      const search = url.searchParams.get("search")?.toLowerCase();
      const users = state.chatUsers.filter((u) => u.tenant_id === tid && (!search || u.email?.toLowerCase().includes(search)));
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return send(res, 200, {
        items: users.slice(offset, offset + limit).map(({ email_verified, ...u }) => ({
          ...u, display_name: null, issuer: null, external_subject: null, source: "manual", created_at: "2026-10-07T00:00:00Z", updated_at: "2026-10-07T00:00:00Z",
          ...(state.chatUserEmailVerified ? { email_verified } : {}),
        })),
        total: users.length, limit, offset,
      });
    }

    if (p === "/api/v1/confirmations" && method === "POST" && state.confirmations) return issueConfirmation(res, token!, info, tid, body.json);
    // A personal access token's guarded change carries its confirmation, checked before the change and used once it succeeds.
    const guarded = state.confirmations?.enforced && info.kind === "pat" ? guardedChange(method, p, tid, body.json) : undefined;
    if (guarded) {
      const refused = checkConfirmation(req, res, url, token!, tid, method, body.json);
      if (refused) return send(res, 428, refused);
    }

    if (p === "/api/v1/tenants/current/quota-usage" && method === "GET") return send(res, 200, quotaUsageFor(tid));
    if (p === "/api/v1/tenants/current/processing-step-cap" && method === "PATCH") return handleProcessingStepCap(res, tid, body.json, info);
    if (method === "PATCH" && p.startsWith("/api/v1/tenants/current/")) return handleTenantLimits(res, p, tid, body.json, info);
    const tenantLimitsRoute = /^\/api\/v1\/tenants\/([^/]+)\/limits$/.exec(p);
    if (tenantLimitsRoute && method === "PATCH") return handleInferenceBudget(res, tenantLimitsRoute[1]!, tid, body.json, info);

    if (p === "/api/v1/harnesses" && method === "GET") {
      const listed = state.harnesses.filter((h) => h.tenant_id === tid);
      if (state.harnessesWithoutDefault) return send(res, 200, listed.map(({ is_default: _d, ...h }) => h));
      return send(res, 200, listed);
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
        ...(state.readinessWithoutLatestRun ? {} : { latest_test_run: state.latestTestRun ?? null }),
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
    m = /^\/api\/v1\/harnesses\/([0-9a-f-]{36})\/deactivate$/.exec(p);
    if (m && method === "POST") {
      const h = state.harnesses.find((x) => x.tenant_id === tid && x.id === m![1]);
      if (!h) return send(res, 404, { detail: "Harness not found." });
      // As the instance: out of service, not back to draft.
      h.status = "inactive";
      return send(res, 200, h);
    }
    if (p === "/api/v1/chat" && method === "POST") {
      const b = (body.json ?? {}) as { message?: string; harness_id?: string | null; session_id?: string | null };
      if (!admitReader(res, info, tid, body.json, true)) return;
      if (!b.message) return send(res, 422, { detail: [{ loc: ["body", "message"], msg: "Field required", type: "missing" }] });
      const h = b.harness_id
        ? state.harnesses.find((x) => x.tenant_id === tid && x.id === b.harness_id)
        : state.harnesses.find((x) => x.tenant_id === tid && x.is_default);
      if (!h) return send(res, 404, { detail: "Harness not found." });
      if (!b.harness_id && h.status !== "active") {
        return send(res, 409, { detail: "Nothing in this tenant is live to answer yet.", code: "chat_route_not_live" });
      }
      // A draft answers a person as a Playground run, never an API key.
      if (h.status !== "active" && info.kind !== "pat") return send(res, 409, { detail: "The selected solution is not active." });
      const session = b.session_id ?? randomUUID();
      state.chats.push({ harness_id: h.id, message: b.message, session_id: session });
      return send(res, 200, { response: `${h.name} answers: ${b.message}`, session_id: session, conversation_id: randomUUID(), agent_run_id: null, ui_directives: null });
    }
    m = /^\/api\/v1\/harnesses\/by-slug\/([^/]+)$/.exec(p);
    if (m) {
      const h = state.harnesses.find((x) => x.tenant_id === tid && x.slug === decodeURIComponent(m![1]!));
      return h ? send(res, 200, h) : send(res, 404, { detail: "Harness not found" });
    }
    m = /^\/api\/v1\/harnesses\/([^/]+)\/default$/.exec(p);
    if (m && method === "POST") {
      const h = state.harnesses.find((x) => x.tenant_id === tid && x.id === m![1]);
      if (!h) return send(res, 404, { detail: "Harness not found." });
      // Only an active solution answers the tenant's chat, as the instance refuses a draft.
      if (h.status !== "active") return send(res, 409, { detail: `Harness '${h.slug}' is ${String(h.status)}, not active.` });
      // One default route per tenant: the instance moves it.
      for (const other of state.harnesses) if (other.tenant_id === tid) other.is_default = other.id === h.id;
      return send(res, 200, h);
    }
    if (p === "/api/v1/bot-persona" && (method === "GET" || method === "PUT")) {
      // Without harness_id, the tenant's default route, as the instance answers.
      const wanted = url.searchParams.get("harness_id") ?? state.harnesses.find((h) => h.tenant_id === tid && h.is_default)?.id;
      const h = state.harnesses.find((x) => x.tenant_id === tid && x.id === wanted);
      if (!h) return send(res, 404, { detail: "Harness not found." });
      if (method === "PUT") state.personas.set(h.id, { ...(body.json as Record<string, unknown>) });
      return send(res, 200, { harness_id: h.id, ...(state.personas.get(h.id) ?? {}) });
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
      const mappedRaw = state.uploadReplace !== "none" ? body.form?.get("replace_doc_ids") : null;
      const mapped = typeof mappedRaw === "string" ? (JSON.parse(mappedRaw) as Record<string, string>) : {};
      const byName = state.uploadReplace === "name" && body.form?.get("replace_existing") !== "false";
      const before = state.documents.filter((d) => d.kb_id === kb.id && !d.deleted);
      const hashes = await Promise.all(files.map(async (file) => createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex")));
      const docs = files.map((file, index) => {
        const same = state.uploadDedup ? before.find((d) => d.is_active && d.sha256 === hashes[index]) : undefined;
        if (same) {
          // Identical content is already active: the instance answers with that document, and the operation that once ingested it, and creates none.
          const view = { ...documentView(same.id, same.filename, same.size, opId("document_ingestion", same.id)), status: "ready" };
          return state.uploadOutcome ? { ...view, upload_outcome: "deduplicated" } : view;
        }
        const id = randomUUID();
        const op = addOperation("document_ingestion", tid, [...state.defaultSteps], {
          id: opId("document_ingestion", id),
          resultRef: { type: "document", id, href: `/api/v1/knowledge-bases/${kb.id}/documents/${id}/content` },
        });
        // A name replace_doc_ids maps is replaced by that id only, never by name.
        const replaced = mapped[file.name]
          ? before.filter((d) => d.id === mapped[file.name])
          : byName
            ? before.filter((d) => d.filename === file.name && d.is_active).sort((a, b) => b.created_at.localeCompare(a.created_at))
            : [];
        for (const d of replaced) d.deleted = true;
        state.documents.push({ id, tenant_id: tid, kb_id: kb.id, filename: file.name, size: file.size, is_active: true, deleted: false, created_at: now(), sha256: hashes[index] });
        const view = documentView(id, file.name, file.size, state.serveOperations ? op.id : null);
        const outcome = state.uploadOutcome ? { upload_outcome: replaced.length ? "replaced" : "created" } : {};
        return state.uploadReplace === "name" ? { ...view, replaced_document_ids: replaced.map((d) => d.id), ...outcome } : { ...view, ...outcome };
      });
      return send(res, 202, docs);
    }
    m = /^\/api\/v1\/knowledge-bases\/([^/]+)\/documents$/.exec(p);
    if (m && method === "GET") {
      const kb = state.kbs.find((k) => k.tenant_id === tid && k.id === m![1]);
      if (!kb) return send(res, 404, { detail: "Knowledge base not found" });
      const listed = state.documents.filter((d) => d.kb_id === kb.id && !d.deleted);
      return send(
        res,
        200,
        listed.map((d) => ({
          ...documentView(d.id, d.filename, d.size, null),
          status: "ready",
          is_active: d.is_active,
          created_at: d.created_at,
          ...(state.documentHashes ? { file_sha256: d.sha256 ?? null } : {}),
        })),
      );
    }
    m = /^\/api\/v1\/knowledge-bases\/([^/]+)\/documents\/active$/.exec(p);
    if (m && method === "PATCH") {
      const kb = state.kbs.find((k) => k.tenant_id === tid && k.id === m![1]);
      if (!kb) return send(res, 404, { detail: "Knowledge base not found" });
      const updates = ((body.json ?? {}) as { updates?: Array<{ id: string; is_active: boolean }> }).updates ?? [];
      if (!updates.length) return send(res, 422, { detail: [{ loc: ["body", "updates"], msg: "List should have at least 1 item", type: "too_short" }] });
      let activated = 0;
      let deactivated = 0;
      for (const u of updates) {
        const d = state.documents.find((x) => x.kb_id === kb.id && x.id === u.id && !x.deleted);
        if (!d) return send(res, 404, { detail: `Document ${u.id} not found` });
        if (d.is_active !== u.is_active) {
          if (u.is_active) activated++;
          else deactivated++;
        }
        d.is_active = u.is_active;
      }
      return send(res, 200, { activated, deactivated });
    }

    if (p === "/api/v1/test-suites" && method === "GET") {
      const harness = url.searchParams.get("harness_id");
      return send(res, 200, state.suites.filter((s) => s.tenant_id === tid && (!harness || s.harness_id === harness)).map(suiteView));
    }
    m = /^\/api\/v1\/test-suites\/([^/]+)\/runs$/.exec(p);
    if (m && method === "POST") {
      const suite = state.suites.find((s) => s.tenant_id === tid && s.id === m![1]);
      if (!suite) return send(res, 404, { detail: "Suite not found" });
      const readerRequest = body.json as { reader_mode?: string } | undefined;
      if (!admitReader(res, info, tid, readerRequest?.reader_mode ? body.json : suite.settings)) return;
      const id = randomUUID();
      const asked = (body.json as { harness_id?: unknown } | undefined)?.harness_id;
      const run = { id, tenant_id: tid, suite_id: suite.id, summary: { ...state.runSummary }, harness_id: typeof asked === "string" ? asked : suite.harness_id };
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
    // The skills the tenant holds: the ones of its configuration.
    if (p === "/api/v1/skills" && method === "GET") {
      const skills = state.configs.get(tid)?.pkg.skills;
      return send(res, 200, Array.isArray(skills) ? skills.map((sk: { slug?: string; name?: string }) => ({ id: randomUUID(), slug: sk.slug, name: sk.name })) : []);
    }
    if (p === "/api/v1/model-registry" || p.startsWith("/api/v1/model-registry/")) {
      return handleModel(res, method, tid, p.slice("/api/v1/model-registry".length + 1), body.json);
    }
    for (const kind of ["variables", "secrets"] as const) {
      const base = `/api/v1/${kind}`;
      if (p !== base && !p.startsWith(`${base}/`)) continue;
      const rest = p.slice(base.length + 1);
      if (rest.includes("/")) return send(res, 404, { detail: "Not Found" });
      return kind === "variables"
        ? handleVariable(res, method, tid, decodeURIComponent(rest), body.json, info)
        : handleSecret(res, method, tid, decodeURIComponent(rest), body.json, info);
    }
    const caps = capabilitiesFor(tid) as { features?: Record<string, boolean> };
    if (handleDatabase(state.db, { method, path: p, url, json: body.json, tenantId: tid, enabled: caps.features?.database_connector_enabled === true, mayManage: info.kind !== "key" && (!info.permissions || info.permissions.includes("database_connectors.manage")), send: (status, payload) => send(res, status, payload) })) return;
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
      const pkg = state.exportFillsDefaults ? withSchemaDefaults(packageSchema(), config.pkg) : structuredClone(config.pkg);
      pkg.manifest = { ...(pkg.manifest as object), exported_at: now(), scope };
      // A query tool's definition comes from the query, which only a superadmin writes.
      exportQueries(state.db, tid, pkg);
      // A recent instance's solution export leaves what the whole tenant shares out unless asked.
      if (state.tenantWideFlag && scope === "agent_graph" && url.searchParams.get("include_tenant_wide") !== "true") {
        for (const section of tenantWideSections(packageSchema() as PackageSchema)) delete pkg[section];
      }
      return send(res, 200, pkg);
    }
    if ((p === "/api/v1/agent-graph/import/preview" || p === "/api/v1/agent-graph/import") && method === "POST") {
      const b = body.json as {
        package: Record<string, unknown>;
        mode?: string;
        harness_id?: string | null;
        runtime_bindings?: Record<string, string>;
        preview_id?: string | null;
        include_tenant_wide?: boolean;
      };
      const config = configFor(tid);
      const schema = JSON.parse(readContract("meta-package-schema-v3.json")) as { properties: Record<string, unknown> };
      const request = {
        package: b.package,
        mode: b.mode ?? "overwrite",
        harness_id: b.harness_id ?? null,
        runtime_bindings: b.runtime_bindings ?? {},
        ...(state.tenantWideFlag ? { include_tenant_wide: b.include_tenant_wide === true } : {}),
      };
      // A recent instance's solution import keeps the tenant's shared sections as they are unless asked.
      const sharedKept =
        state.tenantWideFlag && request.harness_id && !b.include_tenant_wide
          ? [...tenantWideSections(packageSchema() as PackageSchema)].filter((section) => section in b.package)
          : [];
      // The tenant-wide sections of a solution's package, and the active solutions they reach when applied.
      const shared = [...tenantWideSections(packageSchema() as PackageSchema)].filter((section) => section in b.package);
      const sharedApplied = b.include_tenant_wide === true;
      const reaches = sharedApplied
        ? state.harnesses.filter((h) => h.tenant_id === tid && h.status === "active").map((h) => ({ id: h.id, slug: h.slug, name: h.name }))
        : [];
      const wouldImport = sharedApplied ? shared.filter((section) => !state.tenantWideKept.includes(section)) : [];
      const lists = state.tenantWideLists ? { would_import: wouldImport, left_out: shared.filter((section) => !wouldImport.includes(section)) } : {};
      const tenantWide =
        state.tenantWideFlag && state.tenantWideReport && request.harness_id && shared.length
          ? { tenant_wide: { sections: shared, applied: sharedApplied, ...lists, reaches_active_solutions: reaches } }
          : {};
      const previewId = `pv_${createHash("sha256").update(`${tid}:${config.version}:${canonical(request)}`).digest("hex").slice(0, 32)}`;
      const ignored = Object.keys(b.package).filter((k) => !(k in schema.properties));
      // The query gate: what a credential that may not write queries cannot import, coded as the instance codes it.
      const offer = (capabilitiesFor(tid) as { database_connector?: { may_write_queries?: boolean } }).database_connector;
      const catalogHint = (code: string) =>
        (JSON.parse(readContract("meta-error-catalog.json")) as { api_error_codes: Array<{ code: string; hint: string }> }).api_error_codes.find((e) => e.code === code)?.hint ?? "";
      const queryBlocked = queryBlockers(state.db, tid, b.package, offer?.may_write_queries === true, catalogHint);
      const blockers = [...state.previewBlockers, ...queryBlocked.map((q) => q.message)];
      const preview = {
        ready: blockers.length === 0,
        text_blocks: [],
        mode: request.mode,
        summary: { creates: { agents: 1 }, updates: { knowledge_bases: 1 }, deletes: {}, references: {}, warnings: 0, blockers: blockers.length },
        warnings: [
          ...sharedKept.map(
            (section) => `This solution import leaves ${section} out: they hold what the whole tenant shares, so every solution would see the change. Import with include_tenant_wide to apply them.`,
          ),
          ...(state.tenantWideFlag && request.harness_id && sharedApplied && shared.length
            ? [`This import changes ${shared.join(", ")} for every solution of the tenant (include_tenant_wide).`]
            : []),
        ],
        blockers,
        ...(queryBlocked.length ? { blocker_details: queryBlocked } : {}),
        ignored: { sections: ignored, fields: [], count: ignored.length },
        impact: { changed_tools: [], changed_knowledge_bases: [], active_harnesses: [], sandbox_writers: [] },
        loop_budgets: [],
        target_needs: { ...valueNeeds(tid, b.package), oauth_grants: [], runtime_bindings: [], trigger_identities: [] },
        ...tenantWide,
        ...state.previewExtras,
      };
      if (p.endsWith("/preview")) return send(res, 200, { ...preview, preview_id: previewId });
      if (info.kind === "key") {
        const catalog = JSON.parse(readContract("meta-error-catalog.json")) as { api_error_codes: Array<{ code: string; hint: string; docs: string }> };
        const entry = catalog.api_error_codes.find((e) => e.code === "forbidden")!;
        return send(res, 403, { ...entry, detail: "Agent graph import requires admin authentication (JWT), not API key" });
      }
      if (blockers.length) return send(res, 422, { detail: preview });
      if (b.preview_id && b.preview_id !== previewId) {
        // A recent instance answers at the top level and names what changed where it still knows.
        if (state.staleChanged) {
          const what = state.staleChanged;
          return send(res, 409, {
            code: "import_preview_stale",
            message: `The target changed since this preview${what.length ? `: ${what.join("; ")}` : ""}; nothing was imported.`,
            hint: "Preview again, show the new result, and import with the new preview_id.",
            ...(what.length ? { changed: what } : {}),
          });
        }
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
        const { blockers, blocker_details } = state.importRequirementsChanged;
        return send(res, 409, {
          ...(blockers ? { blockers } : {}),
          ...(blocker_details ? { blocker_details } : {}),
          detail: said,
          code: entry.code,
          message: said,
          hint: blockers ? entry.hint : "Preview the import again, then apply it.",
          docs: `http://${req.headers.host}${entry.docs}`,
        });
      }
      const leftOut = state.tenantWideLists && sharedApplied ? state.tenantWideKept : [];
      const kept = Object.fromEntries(Object.entries(b.package).filter(([k]) => k in schema.properties && !sharedKept.includes(k) && !leftOut.includes(k)));
      for (const section of sharedKept) if (section in config.pkg) kept[section] = config.pkg[section];
      state.configs.set(tid, { pkg: kept, version: config.version + 1 });
      // Like the instance: an import adds the names a package declares, and never forgets one.
      const values = valuesFor(tid);
      for (const kind of ["variables", "secrets"] as const) {
        for (const row of declarations(b.package, kind)) values.declared[kind].set(row.name, row.description ?? values.declared[kind].get(row.name) ?? null);
      }
      const importedShared =
        state.tenantWideLists && "tenant_wide" in tenantWide
          ? {
              tenant_wide: {
                sections: shared,
                applied: sharedApplied,
                imported: wouldImport,
                left_out: shared.filter((section) => !wouldImport.includes(section)),
                reaches_active_solutions: reaches,
              },
            }
          : {};
      return send(res, 200, { applied: true, mode: request.mode, summary: preview.summary, imported_agents: ["helper"], warnings: [], ...importedShared });
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

  /** The chosen reader is admitted inside the acting tenant, as on the instance. */
  function admitReader(res: http.ServerResponse, info: TokenInfo, tid: string, body: unknown, chat = false): boolean {
    const reader = body as { reader_mode?: string; reader_chat_user_id?: string } | undefined;
    if (!reader?.reader_mode) return true;
    if (reader.reader_mode !== "as_chat_user") return true;
    if (!state.readerOverrides) {
      send(res, 422, { detail: "Reader overrides are not supported." });
      return false;
    }
    if (chat && info.kind !== "pat") {
      send(res, 403, { detail: "Only an operator test surface may choose its reader; omit reader_mode." });
      return false;
    }
    const missing = ["knowledge_bases.view", "end_users.read"].filter((p) => !permissionsOf(info, tid, true).includes(p));
    if (missing.length) {
      send(res, 403, { detail: `Reading as a Chat User needs: ${missing.join(", ")}` });
      return false;
    }
    if (!state.chatUsers.some((u) => u.tenant_id === tid && u.id === reader.reader_chat_user_id)) {
      send(res, 422, { detail: "reader_chat_user_id names no Chat User of this tenant." });
      return false;
    }
    return true;
  }

  /** A coded refusal as the instance sends one: the fields beside its code, message, catalog hint and docs link. */
  function coded(code: string, detail: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
    const catalog = JSON.parse(readContract("meta-error-catalog.json")) as { api_error_codes: Array<{ code: string; hint?: string; docs?: string }> };
    const entry = catalog.api_error_codes.find((e) => e.code === code);
    return { ...fields, detail, code, message: detail, hint: entry?.hint ?? null, docs: entry?.docs ?? null };
  }

  /**
   * The guarded change a request makes, as the instance's handlers decide it:
   * the operation, when its condition holds; undefined for any other request
   * and for one whose condition does not hold (a draft nothing reaches).
   */
  function guardedChange(method: string, p: string, tid: string, json: unknown): string | undefined {
    const harnessOf = (re: RegExp) => {
      const m = re.exec(p);
      return m ? state.harnesses.find((h) => h.tenant_id === tid && h.id === m[1]) : undefined;
    };
    if (method === "POST") {
      const toDefault = harnessOf(/^\/api\/v1\/harnesses\/([^/]+)\/default$/);
      if (toDefault) return toDefault.is_default ? undefined : "default";
      const activated = harnessOf(/^\/api\/v1\/harnesses\/([^/]+)\/activate$/);
      if (activated) {
        const reached = Number(activated.channel_count ?? 0) > 0 || state.lr.triggers.some((t) => t.tenant_id === tid && t.harness_id === activated.id && t.is_active);
        return activated.status !== "active" && reached ? "activate" : undefined;
      }
      const deactivated = harnessOf(/^\/api\/v1\/harnesses\/([^/]+)\/deactivate$/);
      if (deactivated) return deactivated.status === "active" && !deactivated.is_default ? "deactivate" : undefined;
      if (p === "/api/v1/agent-graph/import") {
        const b = (json ?? {}) as { include_tenant_wide?: boolean; package?: { manifest?: { scope?: string } } };
        return b.include_tenant_wide === true || b.package?.manifest?.scope === "full_config" ? "import" : undefined;
      }
    }
    if (method === "DELETE") {
      const m = /^\/api\/v1\/variables\/([^/]+)$/.exec(p);
      if (m) return valuesFor(tid).variables.has(decodeURIComponent(m[1]!)) ? "delete_variable" : undefined;
    }
    if (method === "PUT") {
      const m = /^\/api\/v1\/triggers\/([^/]+)\/execution-identity$/.exec(p);
      const trigger = m ? state.lr.triggers.find((t) => t.tenant_id === tid && t.id === m[1]) : undefined;
      if (trigger) return trigger.identity.api_key_id !== ((json as { api_key_id?: string | null } | undefined)?.api_key_id ?? null) ? "execution_identity" : undefined;
    }
    return undefined;
  }

  /** The operation a confirmation names, by its method and path, as the published marks list them. */
  function markedOperation(method: string, p: string): boolean {
    const routes: Array<[string, RegExp]> = [
      ["POST", /^\/api\/v1\/harnesses\/[^/]+\/(default|activate|deactivate)$/],
      ["POST", /^\/api\/v1\/agent-graph\/import$/],
      ["DELETE", /^\/api\/v1\/variables\/[^/]+$/],
      ["PUT", /^\/api\/v1\/triggers\/[^/]+\/execution-identity$/],
    ];
    return routes.some(([m, re]) => m === method && re.test(p));
  }

  function issueConfirmation(res: http.ServerResponse, token: string, info: TokenInfo, tid: string, json: unknown) {
    if (info.kind !== "pat") return send(res, 400, coded("confirmation_needs_a_token", "Only a personal access token's change needs a confirmation."));
    const b = (json ?? {}) as { method?: string; path?: string; body?: unknown };
    if (!b.method || !["POST", "PUT", "PATCH", "DELETE"].includes(b.method) || typeof b.path !== "string" || !b.path.startsWith("/")) {
      return send(res, 422, { detail: [{ loc: ["body"], msg: "invalid confirmation request", type: "value_error" }], code: "request_invalid" });
    }
    const target = new URL(b.path, "http://fake");
    if (!markedOperation(b.method, target.pathname)) return send(res, 422, coded("confirmation_not_needed", "This operation needs no confirmation."));
    const id = `cfm_${randomBytes(16).toString("hex")}`;
    const expiresAt = Date.now() + state.confirmationTtlMs;
    state.confirmationIds.set(id, { token, tenantId: tid, method: b.method, path: target.pathname, digest: changeDigest(b.method, b.path, b.body), expiresAt, used: false });
    return send(res, 201, { confirmation_id: id, expires_at: new Date(expiresAt).toISOString(), summary: `${b.method} ${target.pathname}, confirmed by its person.` });
  }

  /** The 428 body for a guarded change without its confirmation, or undefined when it carries the right one, which is used once the change succeeds. */
  function checkConfirmation(req: http.IncomingMessage, res: http.ServerResponse, url: URL, token: string, tid: string, method: string, json: unknown): Record<string, unknown> | undefined {
    const next = { confirmations: "/api/v1/confirmations", header: "X-Cavelon-Confirmation" };
    const given = String(req.headers["x-cavelon-confirmation"] ?? "").trim();
    if (!given) return coded("confirmation_required", "This change needs a person's confirmation. Nothing was changed.", next);
    const refuse = (reason: string) => coded("confirmation_invalid", `The confirmation id is ${reason}. Nothing was changed.`, { reason, ...next });
    const issued = state.confirmationIds.get(given);
    if (!issued) return refuse("unknown");
    if (issued.tenantId !== tid || issued.token !== token || issued.digest !== changeDigest(method, `${url.pathname}${url.search}`, json)) return refuse("other_change");
    if (issued.expiresAt <= Date.now()) return refuse("expired");
    if (issued.used) return refuse("used");
    // Used in the change's own transaction: a change that fails leaves it unused.
    res.on("finish", () => {
      if (res.statusCode < 400) issued.used = true;
    });
    return undefined;
  }

  /** The capabilities snapshot with the test's patch, and the tenant's own limit values in its limits. */
  function capabilitiesFor(tenantId: string): Record<string, unknown> {
    const caps = JSON.parse(readContract("meta-capabilities.json"));
    caps.features = { ...caps.features, ...state.features };
    if (state.confirmations) caps.confirmations = { ...caps.confirmations, enforced: state.confirmations.enforced };
    else delete caps.confirmations;
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
    // The provider key is write-only: accepted, never stored or answered here.
    const { api_key: _key, ...changes } = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
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

  function handleVariable(res: http.ServerResponse, method: string, tid: string, name: string, json: unknown, info: TokenInfo) {
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
    // Like the instance, a variable is changed with the permissions a secret is: a Builder's role holds neither.
    if ((method === "PUT" || method === "DELETE") && !permissionsOf(info, tid, true).some((p) => state.secretsPermissions.includes(p))) {
      return send(res, 403, { detail: `Missing one of permissions: ${state.secretsPermissions.join(", ")}` });
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
    if (info.kind === "key" || state.tokensRefusedOnSecrets) {
      return send(res, 403, {
        detail: "Sets or deletes a secret value: a person does this signed in to the Admin",
        code: "secret_needs_a_person",
        message: "A personal access token or an API key cannot set or delete a secret value.",
        hint: "A person sets it, signed in to the Admin under Settings › Secrets.",
        docs: "/docs/reference/api-endpoints#errors-and-retries",
      });
    }
    // Like the instance, a role without either permission is refused, naming them.
    if (!permissionsOf(info, tid, state.serveCredentialAccess).some((p) => state.secretsPermissions.includes(p))) {
      return send(res, 403, { detail: `Missing one of permissions: ${state.secretsPermissions.join(", ")}` });
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

  /** The package schema as the instance serves it, with the test's edit. */
  function packageSchema(): { properties: Record<string, unknown> } {
    const schema = JSON.parse(readContract("meta-package-schema-v3.json")) as { properties: Record<string, unknown> };
    state.packageSchemaEdit?.(schema);
    return schema;
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

  /**
   * What /meta/principal adds for a personal access token asked without a
   * tenant: the tenants it reaches with its role there, and for an operator's
   * token without an allowlist, that it reaches every tenant; `search` then
   * finds up to 50 tenants by name or slug.
   */
  function reachOf(info: TokenInfo, query: URLSearchParams) {
    const placed = info.defaultTenant ?? (!info.platform && info.tenantIds.length === 1 ? info.tenantIds[0] : undefined);
    const row = (t: FakeState["tenants"][number]) => ({ id: t.id, slug: t.slug, name: t.name, role: info.roles?.[t.id] ?? "tenant_admin", is_default: t.id === placed });
    const wanted = query.get("search")?.toLowerCase();
    const matches = (t: FakeState["tenants"][number]) => !wanted || t.slug.includes(wanted) || t.name.toLowerCase().includes(wanted) || t.id === wanted;
    const own = info.tenantIds.flatMap((id) => state.tenants.filter((t) => t.id === id));
    const all = (info.reachesAll && wanted ? state.tenants : own).filter(matches).sort((a, b) => a.slug.localeCompare(b.slug));
    const limit = Math.min(Number(query.get("limit") ?? 50), 200);
    const offset = Number(query.get("cursor") ?? 0);
    const next = offset + limit < all.length ? String(offset + limit) : null;
    return { tenants: all.slice(offset, offset + limit).map(row), reaches_all_tenants: Boolean(info.reachesAll), next_cursor: next };
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
type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * A package as an instance's export gives it: the instance reads an import
 * into its models and writes them back out, so each object comes back with
 * every field the schema lists, in that order. A field it was sent without
 * holds its non-null default; else a free-form config `{}`, a nullable field
 * null, and a list or object field without a published default `[]` or `{}`.
 * Test cases come back by sort_order, then by name. Written apart from the
 * kit's own `fmt`, so a test of `fmt` against it proves something.
 */
function withSchemaDefaults(schema: { properties: Record<string, unknown> }, pkg: Record<string, unknown>): Record<string, unknown> {
  const defs = ((schema as Node).$defs ?? {}) as Record<string, Node>;
  const deref = (node: unknown): Node | undefined => {
    let at = isNode(node) ? node : undefined;
    for (let i = 0; at && typeof at.$ref === "string" && i < 10; i++) at = defs[(at.$ref as string).replace("#/$defs/", "")];
    return at;
  };
  const options = (node: Node): Node[] => {
    const list = (node.anyOf ?? node.oneOf) as unknown[] | undefined;
    return list ? list.flatMap((b) => (deref(b) ? options(deref(b)!) : [])) : [node];
  };
  const fill = (node: unknown, value: unknown, depth: number): unknown => {
    const at = deref(node);
    if (!at || depth > 40) return structuredClone(value);
    if (Array.isArray(value)) {
      const list = options(at).filter((b) => b.type === "array");
      return list.length === 1 && list[0]!.items ? value.map((v) => fill(list[0]!.items, v, depth + 1)) : structuredClone(value);
    }
    if (!isNode(value)) return value;
    // An object field with several shapes is passed through, as the models keep a plain dict.
    const objects = options(at).filter((b) => isNode(b.properties));
    if (objects.length !== 1) return structuredClone(value);
    const props = objects[0]!.properties as Record<string, unknown>;
    const required = new Set((objects[0]!.required as string[] | undefined) ?? []);
    const out: Record<string, unknown> = {};
    for (const [key, sub] of Object.entries(props)) {
      const field = deref(sub);
      if (key in value) out[key] = fill(sub, value[key], depth + 1);
      else if (!field || required.has(key)) continue;
      else if (field.default != null) out[key] = structuredClone(field.default);
      else if (options(field).some((b) => b.type === "object" && b.additionalProperties === true)) out[key] = {};
      else if (options(field).some((b) => b.type === "null")) out[key] = null;
      else if (field.type === "array") out[key] = [];
      else if (field.type === "object" || isNode(field.properties)) out[key] = {};
    }
    for (const [key, inner] of Object.entries(value)) if (!(key in props)) out[key] = structuredClone(inner);
    if (Array.isArray(out.test_cases)) {
      const order = (c: unknown) => (isNode(c) && typeof c.sort_order === "number" ? c.sort_order : 0);
      const name = (c: unknown) => (isNode(c) && typeof c.name === "string" ? c.name : "");
      out.test_cases = [...out.test_cases].sort((a, b) => order(a) - order(b) || name(a).localeCompare(name(b), "en"));
    }
    return out;
  };
  return Object.fromEntries(Object.entries(pkg).map(([section, value]) => [section, fill(schema.properties[section], value, 0)]));
}

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

function runView(run: { id: string; suite_id: string; summary: Record<string, unknown>; harness_id?: string | null }, suiteName: string | null, status: string, operationId: string | null) {
  return {
    id: run.id,
    suite_id: run.suite_id,
    harness_id: run.harness_id ?? null,
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

/**
 * A row of a test result's `tool_calls`, as the instance records it; a recent
 * instance adds the knowledge search's `knowledge_outcome`, an older one
 * leaves it out.
 */
export function toolCallRow(knowledgeOutcome?: string, name = "search_documents") {
  return {
    name,
    type: "builtin",
    status: "ok",
    arguments: { query: "opening hours" },
    result_count: knowledgeOutcome === "content_gap" ? 0 : 3,
    duration_ms: 85,
    error: null,
    ...(knowledgeOutcome ? { knowledge_outcome: knowledgeOutcome } : {}),
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
    // An older instance's row: no knowledge_outcome.
    tool_calls: [toolCallRow()],
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

/**
 * A trace of three spans: the agent, a model call, and a search that failed.
 * `knowledgeOutcome` adds the search's retrieval span with the outcome the
 * agent recorded on it, as a recent instance writes it.
 */
export function traceFixture(
  id: string,
  conversationId: string | null,
  options: { knowledgeOutcome?: string; retrievalAttributes?: unknown; failedSearch?: boolean } = {},
) {
  const span = (n: number, type: string, name: string, status = "ok", parent = 1, attributes: unknown = {}) => ({
    id: `${id}-span-${n}`,
    parent_span_id: n === 1 ? null : `${id}-span-${parent}`,
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
    // A retrieval span records its search in its attributes only.
    input_json: type === "retrieval" ? null : { prompt: "x".repeat(5000) },
    output_json: type === "retrieval" ? null : { text: "done" },
    attributes_json: attributes,
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
    total_spans: options.knowledgeOutcome || options.retrievalAttributes !== undefined ? 4 : 3,
    total_tool_calls: 1,
    total_llm_calls: 1,
    total_input_tokens: 10,
    total_output_tokens: 5,
    total_cached_tokens: 0,
    total_reasoning_tokens: 0,
    has_retrieval: false,
    created_at: now(),
    spans: [
      span(1, "agent", "Main"),
      span(2, "llm", "generate"),
      span(3, "tool", "search_documents", options.failedSearch === false ? "ok" : "error"),
      ...(options.retrievalAttributes !== undefined
        ? [span(4, "retrieval", "retrieval", "ok", 3, options.retrievalAttributes)]
        : options.knowledgeOutcome
          ? [span(4, "retrieval", "retrieve", "ok", 3, { knowledge_outcome: options.knowledgeOutcome })]
          : []),
    ],
  };
}
