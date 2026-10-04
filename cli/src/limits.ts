import type { Context } from "./command.js";
import { CavelonError, ExitCode, type ExitCodeValue } from "./errors.js";
import type { ApiResponse } from "./http.js";
import { readPrincipal } from "./principal.js";
import { cavelonCommand } from "./shell.js";

/**
 * The limits an instance publishes in `/api/v1/meta/capabilities` (`limits`)
 * and the tenant quotas it links to. Every check
 * here reads what the instance says; a limit it does not publish does not
 * bind there, so nothing is assumed and the command just sends.
 */

export interface Limit {
  key: string;
  /** A number in `unit`, a list of file types, or on/off (`unit: boolean`). */
  value: number | string[] | boolean;
  unit: string;
  /** Where the value comes from: platform, tenant or licence. */
  source: string;
  /** Who can raise it: operator or tenant_admin (tenant_owner on a quota value). */
  changeable_by: string;
  /** The environment variable, tenant setting or licence entitlement that changes it. */
  setting: string;
  /** A docs portal path, e.g. /docs/reference/limits-and-quotas#upload-and-storage-quotas. */
  docs: string;
  scope: string;
  description: string;
  /**
   * Where a platform value comes from: platform_setting,
   * environment or default. Only on the run caps, and only on instances that publish it.
   */
  origin?: string;
  /**
   * How a tenant admin changes it: only on a
   * `tenant_admin` entry, and only on instances that publish it.
   */
  change?: LimitChange;
  /**
   * How an operator sets one tenant's own value:
   * only on the per-tenant run cap, whose `change` targets the platform's cap.
   */
  tenant_change?: LimitChange;
  /** The switches an on/off value needs, each with its state. */
  switches?: LimitSwitch[];
  /**
   * The on/off limit this one binds under: the
   * archive caps bind only while `kb_upload_archive_enabled` is on. Absent, it
   * always binds.
   */
  binds_when?: string;
}

/** One switch behind an on/off limit: the platform's or the tenant's. */
export interface LimitSwitch {
  setting: string;
  source: string;
  enabled: boolean;
}

/** The one operation that changes a limit, as the instance publishes it in `change`. */
export interface LimitChange {
  /** The OpenAPI operationId. */
  operation: string;
  method: string;
  path: string;
  /** The body field that carries the value, dotted when nested (`archive_uploads.max_entries`). */
  field: string;
  /** The caller needs one of these. */
  permissions: string[];
  minimum?: number;
  maximum?: number;
  /** The operator's setting behind `maximum`: a tenant only lowers the value. */
  maximum_setting?: string;
  /**
   * An operator's change: the global roles, any
   * one of which the caller needs.
   */
  requires_role?: string[];
  /** `platform`: sent in Platform mode, without `X-Tenant-Id`. */
  mode?: string;
}

/**
 * A quota the quota-usage route does not serve, published with its use in
 * `tenant_quotas.values` (the monthly Processing Step cap).
 */
export interface QuotaValue {
  key: string;
  /** The cap, or null for none. */
  value: number | null;
  unit: string;
  /** This billing month's use, or null when it cannot be counted. */
  used: number | null;
  /** none, ok, reached or unavailable. */
  state: string;
  period: { key: string; start: string; resets_at: string } | null;
  source: string;
  changeable_by: string;
  setting: string;
  docs: string;
  description: string;
  change?: LimitChange;
  /** used / value, when both are known and a cap binds. */
  ratio: number | null;
  near: boolean;
}

/** A tenant quota a tenant admin changes, from `tenant_quotas.changes` (the inference budget). */
export interface QuotaChange extends LimitChange {
  key: string;
}

export interface PublishedLimits {
  /** False on an instance older than the limits: then no limit is known. */
  published: boolean;
  values: Limit[];
  byKey: Map<string, Limit>;
  /** Where the tenant's quotas and their use are served. */
  tenantQuotas?: { path: string; docs?: string; changes: QuotaChange[]; values: QuotaValue[] };
}

export interface Quota {
  key: string;
  current: number | null;
  limit: number | null;
  /** current / limit, when both are known and the limit binds. */
  ratio: number | null;
  /** The ratio from which it counts as close: the quota's own warning_ratio, else 0.8. */
  warning_ratio: number;
  near: boolean;
  /** The quota as the instance sent it. */
  details: Record<string, unknown>;
  /**
   * The change that sets it: its key in
   * `tenant_quotas.changes`, and the field of this row that holds the current value.
   */
  change?: { key: string; field: string };
}

export interface TenantQuotas {
  path: string;
  docs: string | null;
  items: Quota[];
  /** Why the quotas could not be read; the limits still stand. */
  unavailable?: string;
  /** The instance's status when it refused to show them (403: the token may not read them). */
  unavailable_status?: number;
}

const NEAR = 0.8;

/** Who may change a limit, in words. */
export function changedBy(limit: Pick<Limit, "changeable_by" | "source">): string {
  if (limit.changeable_by === "tenant_admin") return "a tenant admin";
  if (limit.changeable_by === "tenant_owner") return "a Tenant Owner";
  if (limit.changeable_by === "operator") return limit.source === "licence" ? "the operator (licence)" : "the instance operator";
  return limit.changeable_by;
}

/** The `cavelon docs get` page of a docs portal path, without its section anchor. */
export function docsPage(docs: string): string {
  const page = docs.split("#")[0]!;
  return page.startsWith("/docs/") ? page.slice("/docs/".length) : page.replace(/^\//, "");
}

/** "25 MB", "120 s", "29 file types (adoc, asc, …)", "none"; `--json` has every type. */
export function formatValue(limit: Pick<Limit, "value" | "unit">): string {
  if (typeof limit.value === "boolean") return limit.value ? "on" : "off";
  if (Array.isArray(limit.value)) {
    if (limit.value.length === 0) return "none";
    const shown = limit.value.slice(0, 4).join(", ");
    return `${limit.value.length} file types (${shown}${limit.value.length > 4 ? ", …" : ""})`;
  }
  const units: Record<string, string> = {
    megabytes: "MB",
    bytes: "bytes",
    characters: "characters",
    seconds: "s",
    count: "",
    requests_per_minute: "requests/min",
    processing_steps: "Processing Steps",
  };
  const unit = units[limit.unit] ?? limit.unit;
  return unit ? `${limit.value} ${unit}` : String(limit.value);
}

/** The on/off limits whose names the kit says in words; any other reads "<key> is on". */
const GATE_TEXT: Record<string, string> = {
  kb_upload_archive_enabled: "archive uploads are on",
};

/** "applies while archive uploads are on (kb_upload_archive_enabled)", for a limit with `binds_when`. */
export function bindsWhenText(limit: Pick<Limit, "binds_when">): string | undefined {
  if (!limit.binds_when) return undefined;
  const gate = GATE_TEXT[limit.binds_when];
  return gate ? `applies while ${gate} (${limit.binds_when})` : `applies while ${limit.binds_when} is on`;
}

/**
 * Whether a limit binds now: always, unless the limit it binds under
 * (`binds_when`) is published and off. An older instance publishes no
 * `binds_when`, so every limit binds.
 */
export function bindsNow(limit: Pick<Limit, "binds_when">, published: Pick<PublishedLimits, "byKey">): boolean {
  if (!limit.binds_when) return true;
  return published.byKey.get(limit.binds_when)?.value !== false;
}

/** One sentence naming the limit, its source and who changes it with which setting. */
export function describeLimit(limit: Limit): string {
  const value = Array.isArray(limit.value) && limit.value.length ? `${limit.value.length} file types` : formatValue(limit);
  const binds = bindsWhenText(limit);
  return (
    `${limit.key} is ${value} (source: ${limit.source}${limit.origin ? `, origin: ${limit.origin}` : ""}); ${changedBy(limit)} changes it with ${limit.setting}. ` +
    (binds ? `It ${binds}. ` : "") +
    `Docs: ${cavelonCommand("docs", "get", docsPage(limit.docs))}`
  );
}

/** The fields of a limit worth carrying into an error's details. */
export function limitRef(limit: Limit): Record<string, unknown> {
  const { key, value, unit, source, changeable_by, setting, docs, scope, origin, binds_when } = limit;
  return { key, value, unit, source, changeable_by, setting, docs, scope, ...(origin ? { origin } : {}), ...(binds_when ? { binds_when } : {}) };
}

/** The refusal of a value above a platform ceiling; a tenant only lowers such a limit. */
export const LIMIT_ABOVE_CEILING = "limit_above_platform_ceiling";

/**
 * What a `limit_above_platform_ceiling` refusal names, from the fields the
 * instance sends with it (`setting`, `value`, `maximum`, `maximum_setting`):
 * the hint with the numbers filled in, and the fields as details.
 */
export function ceilingRefusal(body: unknown): { hint: string; details: Record<string, unknown> } | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const fields = body as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  const number = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const setting = text(fields.setting);
  const value = number(fields.value);
  const maximum = number(fields.maximum);
  const ceiling = text(fields.maximum_setting);
  const details = {
    ...(setting ? { setting } : {}),
    ...(value === undefined ? {} : { value }),
    ...(maximum === undefined ? {} : { maximum }),
    ...(ceiling ? { maximum_setting: ceiling } : {}),
  };
  const what = setting ?? "This limit";
  const most = maximum === undefined ? "a value up to the platform's ceiling" : `at most ${maximum}`;
  const raise = ceiling ? `Only the instance operator raises the ceiling, with ${ceiling}; ask them.` : "Only the instance operator raises the ceiling; ask them.";
  return { hint: `${what} may only be lowered: send ${most}. ${raise}`, details };
}

/**
 * The ceilings a tenant may only stay under, from the published changes that
 * name a `maximum_setting`, and who raises them; for `explain
 * limit_above_platform_ceiling`.
 */
export function ceilingHint(published: PublishedLimits | undefined): string {
  const lower = "A tenant admin sets a value up to the ceiling with `cavelon limits set <key> <value>`; only the instance operator raises a ceiling, with the setting named.";
  const capped = (published?.values ?? []).filter((l) => l.change?.maximum_setting && l.change.maximum !== undefined);
  if (!capped.length) return lower;
  const each = capped.map((l) => `${l.key} up to ${formatValue({ value: l.change!.maximum!, unit: l.unit })} (${l.change!.maximum_setting})`);
  return `The ceilings here: ${each.join(", ")}. ${lower}`;
}

/** A published `change`, or undefined when it is absent or not in the shape the kit can send. */
export function parseChange(raw: unknown): LimitChange | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const entry = raw as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  const operation = text(entry.operation);
  const method = text(entry.method)?.toUpperCase();
  const path = text(entry.path);
  const field = text(entry.field);
  if (!operation || !method || !path?.startsWith("/api/") || !field) return undefined;
  const permissions = Array.isArray(entry.permissions) ? entry.permissions.filter((p): p is string => typeof p === "string" && p !== "") : [];
  const bound = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const minimum = bound(entry.minimum);
  const maximum = bound(entry.maximum);
  const maximumSetting = text(entry.maximum_setting);
  const roles = Array.isArray(entry.requires_role) ? entry.requires_role.filter((r): r is string => typeof r === "string" && r !== "") : [];
  const mode = text(entry.mode);
  return {
    operation,
    method,
    path,
    field,
    permissions,
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
    ...(maximumSetting ? { maximum_setting: maximumSetting } : {}),
    ...(roles.length ? { requires_role: roles } : {}),
    ...(mode ? { mode } : {}),
  };
}

/** An operator's change: sent in Platform mode, by a token of one of the roles it names. */
export function isOperatorChange(change: LimitChange): boolean {
  return Boolean(change.requires_role?.length) || change.mode === "platform";
}

function parseSwitches(raw: unknown): LimitSwitch[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.setting !== "string" || typeof item.enabled !== "boolean") return [];
    return [{ setting: item.setting, source: String(item.source ?? ""), enabled: item.enabled }];
  });
}

function isLimit(raw: unknown): raw is Limit {
  if (!raw || typeof raw !== "object") return false;
  const entry = raw as Record<string, unknown>;
  const valueOk =
    typeof entry.value === "number" || typeof entry.value === "boolean" || (Array.isArray(entry.value) && entry.value.every((v) => typeof v === "string"));
  return typeof entry.key === "string" && valueOk && typeof entry.unit === "string" && typeof entry.source === "string";
}

/** The `limits` section of capabilities, as published or absent. */
export function parseLimits(caps: Record<string, unknown> | null | undefined): PublishedLimits {
  const section = caps?.limits as { values?: unknown; tenant_quotas?: { path?: unknown; docs?: unknown; changes?: unknown; values?: unknown } } | undefined;
  if (!section || typeof section !== "object" || !Array.isArray(section.values)) {
    return { published: false, values: [], byKey: new Map() };
  }
  const values = section.values.filter(isLimit).map(({ origin, change: rawChange, tenant_change: rawTenantChange, switches: rawSwitches, binds_when: bindsWhen, ...entry }) => {
    const change = parseChange(rawChange);
    const tenantChange = parseChange(rawTenantChange);
    const switches = parseSwitches(rawSwitches);
    return {
      ...entry,
      // An older instance leaves out origin, change, tenant_change, switches or binds_when;
      // an entry without one keeps the shape it had before the instance published it.
      ...(typeof origin === "string" && origin ? { origin } : {}),
      ...(typeof bindsWhen === "string" && bindsWhen ? { binds_when: bindsWhen } : {}),
      ...(change ? { change } : {}),
      ...(tenantChange ? { tenant_change: tenantChange } : {}),
      ...(switches ? { switches } : {}),
      changeable_by: String(entry.changeable_by ?? ""),
      setting: String(entry.setting ?? ""),
      docs: String(entry.docs ?? ""),
      scope: String(entry.scope ?? "tenant"),
      description: String(entry.description ?? ""),
    };
  });
  const link = section.tenant_quotas;
  const tenantQuotas =
    link && typeof link.path === "string" && link.path.startsWith("/api/")
      ? { path: link.path, docs: typeof link.docs === "string" ? link.docs : undefined, changes: quotaChanges(link.changes), values: quotaValues(link.values) }
      : undefined;
  return { published: true, values, byKey: new Map(values.map((v) => [v.key, v])), tenantQuotas };
}

/** The quotas published with their use (the Processing Step cap); none on an older instance. */
function quotaValues(raw: unknown): QuotaValue[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.key !== "string" || !item.key) return [];
    const number = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const value = number(item.value);
    const used = number(item.used);
    const period = item.period && typeof item.period === "object" ? (item.period as QuotaValue["period"]) : null;
    const ratio = value !== null && value > 0 && used !== null ? used / value : null;
    const change = parseChange(item.change);
    return [
      {
        key: item.key,
        value,
        unit: String(item.unit ?? "count"),
        used,
        state: String(item.state ?? ""),
        period,
        source: String(item.source ?? "tenant"),
        changeable_by: String(item.changeable_by ?? ""),
        setting: String(item.setting ?? item.key),
        docs: String(item.docs ?? ""),
        description: String(item.description ?? ""),
        ...(change ? { change } : {}),
        ratio,
        near: ratio !== null && ratio >= NEAR,
      },
    ];
  });
}

function quotaChanges(raw: unknown): QuotaChange[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const change = parseChange(entry);
    const key = (entry as { key?: unknown } | null)?.key;
    return change && typeof key === "string" && key ? [{ key, ...change }] : [];
  });
}

/**
 * The instance's limits for the current tenant. A tenant may override some,
 * and the capabilities cache is per instance, so they are read live once per
 * command.
 */
export async function readLimits(ctx: Context): Promise<PublishedLimits> {
  const contracts = await ctx.contracts();
  return parseLimits(await contracts.liveCapabilities());
}

/** The limits, or nothing (with a warning) when they cannot be read; for checks that must not stop a command. */
export async function limitsOrWarn(ctx: Context): Promise<PublishedLimits | undefined> {
  try {
    return await readLimits(ctx);
  } catch (error) {
    ctx.warn(`Could not read the instance's limits, so they were not checked: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function quotaOf(key: string, raw: Record<string, unknown>): Quota {
  const current = typeof raw.current === "number" ? raw.current : null;
  // A limit of 0 or none caps nothing.
  const limit = typeof raw.limit === "number" ? raw.limit : null;
  const ratio = current !== null && limit !== null && limit > 0 ? current / limit : null;
  const warning = typeof raw.warning_ratio === "number" && raw.warning_ratio > 0 ? raw.warning_ratio : NEAR;
  const link = raw.change as { key?: unknown; field?: unknown } | undefined;
  const change = link && typeof link.key === "string" && typeof link.field === "string" ? { key: link.key, field: link.field } : undefined;
  return { key, current, limit, ratio, warning_ratio: warning, near: ratio !== null && ratio >= warning, details: raw, ...(change ? { change } : {}) };
}

/**
 * The tenant's quotas and their use, from the path the limits link to. A row
 * that names the change of a quota published with its use (the Processing Step
 * cap) is that quota: `tenant_quotas.values` shows it, so the row is left out.
 */
export async function readQuotas(ctx: Context, limits: PublishedLimits): Promise<TenantQuotas | undefined> {
  const link = limits.tenantQuotas;
  if (!link) return undefined;
  const client = await ctx.client();
  const base = { path: link.path, docs: link.docs ?? null };
  let response: ApiResponse<Record<string, unknown>>;
  try {
    response = await client.get<Record<string, unknown>>(link.path, { allow: [400, 403, 404] });
  } catch (error) {
    // The quotas add to the limits already read; a failing quota route must not hide them.
    if (!(error instanceof CavelonError)) throw error;
    return { ...base, items: [], unavailable: `${link.path}: ${error.message}` };
  }
  if (response.status === 403) {
    // The read permission is not published; the token's ceiling is the likely reason, and the person can act on it.
    const ceiling = (await readPrincipal(client).catch(() => undefined))?.token?.ceiling_role;
    return {
      ...base,
      items: [],
      unavailable_status: 403,
      unavailable:
        `this token${ceiling ? ` (ceiling ${ceiling})` : ""} may not read the tenant's quota usage (${link.path} answered 403). ` +
        "A token whose ceiling includes it, such as a tenant owner's or administrator's, sees the quotas, and so does the Admin; the limits still stand.",
    };
  }
  if (response.status !== 200 || !response.data || typeof response.data !== "object") {
    return { ...base, items: [], unavailable: `${link.path} answered ${response.status}.`, unavailable_status: response.status };
  }
  const items = Object.entries(response.data)
    .filter((entry): entry is [string, Record<string, unknown>] => Boolean(entry[1]) && typeof entry[1] === "object" && !Array.isArray(entry[1]))
    .map(([key, raw]) => quotaOf(key, raw))
    .filter((q) => !(q.change && link.values.some((v) => v.key === q.change!.key)));
  return { ...base, items };
}

/** The current value of the setting a quota change sets, from the quota row that names it. */
export async function quotaSetting(ctx: Context, limits: PublishedLimits, key: string): Promise<{ value: unknown } | undefined> {
  const link = limits.tenantQuotas;
  if (!link) return undefined;
  const client = await ctx.client();
  const response = await client.get<Record<string, unknown>>(link.path, { allow: [400, 403, 404] });
  if (response.status !== 200 || !response.data || typeof response.data !== "object") return undefined;
  for (const raw of Object.values(response.data)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const change = row.change as { key?: unknown; field?: unknown } | undefined;
    if (change?.key === key && typeof change.field === "string" && change.field in row) return { value: row[change.field] };
  }
  return undefined;
}

/** "31200 of 39950 (78%)", "0 (no cap)". */
export function formatQuotaValue(quota: QuotaValue): string {
  const used = quota.used === null ? "?" : String(quota.used);
  if (quota.value === null || quota.value <= 0) return `${used} (no cap)`;
  return `${used} of ${quota.value}${quota.ratio === null ? "" : ` (${Math.round(quota.ratio * 100)}%)`}`;
}

/** "9 of 10 (90%)". */
export function formatQuota(quota: Quota): string {
  if (quota.current === null && quota.limit === null) return "-";
  const used = quota.current === null ? "?" : String(quota.current);
  if (quota.limit === null || quota.limit <= 0) return `${used} (no limit)`;
  return `${used} of ${quota.limit}${quota.ratio === null ? "" : ` (${Math.round(quota.ratio * 100)}%)`}`;
}

/**
 * A refusal before anything is sent, naming each limit, its source and who
 * changes it; `code` is the instance's own code for the same refusal.
 */
export function limitError(options: {
  code: string;
  message: string;
  limits: Limit[];
  details: Record<string, unknown>;
  hint?: string;
  exitCode?: ExitCodeValue;
}): CavelonError {
  const { code, message, limits, details } = options;
  const described = limits.map(describeLimit).join(" ");
  return new CavelonError(options.exitCode ?? ExitCode.validation, {
    code,
    message,
    hint: [options.hint, described].filter(Boolean).join(" ") || undefined,
    docs: limits[0]?.docs || undefined,
    details: { ...details, limits: limits.map(limitRef), sent: false },
  });
}
