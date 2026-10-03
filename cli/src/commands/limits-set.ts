import { originText } from "../capacity.js";
import { boolOption, positional, type CommandSpec, type Context } from "../command.js";
import type { OpenApiDoc } from "../contracts.js";
import { CavelonError, ExitCode, usageError } from "../errors.js";
import type { ApiClient } from "../http.js";
import { callOperation, openapiOrWarn, workflowOperation } from "../invoke.js";
import {
  changedBy,
  docsPage,
  formatValue,
  isOperatorChange,
  LIMIT_ABOVE_CEILING,
  limitRef,
  quotaSetting,
  readLimits,
  type Limit,
  type LimitChange,
  type LimitSwitch,
  type PublishedLimits,
  type QuotaValue,
} from "../limits.js";
import { deref, jsonBodySchema, operationForPath, validateBody, type Operation } from "../openapi.js";
import { readGlobalRole, readPrincipal, type MetaPrincipal } from "../principal.js";
import type { Session } from "../session.js";
import { cavelonCommand, shellWord } from "../shell.js";
import { ENV_OPTION, targetFlags } from "./values.js";

/**
 * `cavelon limits set <key> <value>`: change one limit through the operation
 * the instance names in the entry's `change`, a
 * tenant quota it lists in `tenant_quotas.changes` (the inference budget, the
 * Processing Step cap), or an operator's run cap or tenant flag in
 * Platform mode. Everything the kit checks comes from
 * what the instance publishes: who changes the limit, the operation, the body
 * field, its bounds and type, the permissions and the roles. An environment or
 * licence limit, a value out of bounds, an entry without `change`, a credential
 * whose published permissions or scopes hold none of the change's, and an
 * operator's change without a Platform-mode token of its role are refused
 * before anything is sent.
 */

type Value = number | string[] | boolean | null;
type Kind = "integer" | "number" | "list" | "boolean";

/** What `limits set` changes: a published limit, or a tenant quota from `tenant_quotas.changes`. */
interface Target {
  key: string;
  kind: "limit" | "quota";
  change: LimitChange;
  limit?: Limit;
  /** The quota as `tenant_quotas.values` publishes it with its use (the Processing Step cap). */
  quota?: QuotaValue;
  /**
   * The switch an on/off limit's change sets (the tenant's feature flag behind `orchestration_parallel_branches`).
   */
  flag?: LimitSwitch;
  /**
   * What the change sets: the tenant's own value (a tenant's credential), the
   * platform's value for every tenant, or one tenant's own value (an operator's
   * change whose path names the tenant).
   */
  scope: "tenant" | "platform" | "one_tenant";
}

/** The suffixes a value may carry for its unit ("50MB", "30 s"); none is needed. */
const UNIT_WORDS: Record<string, string[]> = {
  megabytes: ["mb", "megabytes"],
  bytes: ["b", "bytes"],
  seconds: ["s", "sec", "seconds"],
  characters: ["chars", "characters"],
  requests_per_minute: ["rpm", "/min", "requests/min"],
};
const TRUE_WORDS = new Set(["true", "on", "yes", "enabled"]);
const FALSE_WORDS = new Set(["false", "off", "no", "disabled"]);
const CLEAR_WORDS = new Set(["none", "null"]);

/** Where an operator changes a value in the Admin, by what it is (the docs name the pages). */
const RUN_CAPS_PAGE = "Platform › Operations › Rate limits › Run caps";
const TENANT_LIMITS_PAGE = "the tenant's Limits section (Concurrent Agent Runs)";
const FEATURE_FLAGS_PAGE = "Configure › Feature Flags";

function notPublished(message: string, hint: string, details: Record<string, unknown> = {}): CavelonError {
  return new CavelonError(ExitCode.failure, { code: "operation_unavailable", message, hint, details: { ...details, sent: false } });
}

/** An operator's list a tenant's switch turns on: the archive formats. */
const SWITCHED_BY: Record<string, string> = { kb_upload_archive_formats: "kb_upload_archive_enabled" };

/** The tenant's switch that turns an operator's list on, where the instance publishes how to change it. */
function switchFor(published: PublishedLimits, key: string): Limit | undefined {
  const name = SWITCHED_BY[key];
  const limit = name ? published.byKey.get(name) : undefined;
  return limit?.change && !isOperatorChange(limit.change) ? limit : undefined;
}

/** Who changes an operator's or the licence's limit that has no change, and where, as the entry says; `switched` is the tenant's switch that turns it on. */
function operatorRefusal(limit: Limit, switched?: Limit): CavelonError {
  const where = limit.source === "licence" ? `the licence entitlement ${limit.setting}` : (originText(limit) ?? `${limit.setting} (source: ${limit.source})`);
  // A platform value without an origin is the environment's (or a default's): no operation changes it while the instance runs.
  const who =
    limit.source === "licence"
      ? "The instance operator installs a renewed licence."
      : limit.origin
        ? "Ask the instance operator; the API does not change it."
        : `It cannot be changed at runtime: the instance operator changes ${limit.setting} with a deploy.`;
  return new CavelonError(ExitCode.unauthorized, {
    code: "limit_changed_by_operator",
    message: `${limit.key} is not the tenant's to change: ${changedBy(limit)} sets it, with ${where}. Nothing was sent.`,
    hint:
      (switched ? `A tenant admin turns it on with ${cavelonCommand("limits", "set", switched.key, "true")} (${switched.setting}). ` : `${who} `) +
      `Docs: ${cavelonCommand("docs", "get", docsPage(limit.docs))}`,
    docs: limit.docs || undefined,
    details: { limit: limitRef(limit), ...(switched ? { switch: switched.key } : {}), sent: false },
  });
}

/** An operator's change sets one tenant's value when its path names the tenant; else the platform's. */
function scopeOf(change: LimitChange): Target["scope"] {
  if (!isOperatorChange(change)) return "tenant";
  return change.path.includes("{tenant_id}") ? "one_tenant" : "platform";
}

/**
 * The switch an on/off limit's change sets: the tenant's for a change that
 * names the tenant, the platform's otherwise. Its state is the value the
 * change replaces; the limit's own value is both switches together.
 */
function flagOf(limit: Limit, scope: Target["scope"]): LimitSwitch | undefined {
  if (typeof limit.value !== "boolean" || !limit.switches?.length) return undefined;
  const source = scope === "platform" ? "platform" : "tenant";
  const matching = limit.switches.filter((s) => s.source === source);
  return matching.length === 1 ? matching[0] : undefined;
}

function limitTarget(key: string, limit: Limit, change: LimitChange): Target {
  const scope = scopeOf(change);
  const flag = flagOf(limit, scope);
  return { key, kind: "limit", change, limit, scope, ...(flag ? { flag } : {}) };
}

/** Every key this instance lets someone change through the API: a tenant's, and an operator's in Platform mode. */
function changeableKeys(published: PublishedLimits): { tenant: string[]; operator: string[] } {
  const tenant: string[] = [];
  const operator: string[] = [];
  for (const limit of published.values) {
    const changes = [limit.change, limit.tenant_change].filter((c): c is LimitChange => Boolean(c));
    if (!changes.length) continue;
    (changes.some(isOperatorChange) ? operator : tenant).push(limit.key);
  }
  for (const quota of published.tenantQuotas?.changes ?? []) (isOperatorChange(quota) ? operator : tenant).push(quota.key);
  return { tenant, operator };
}

/**
 * The limit or quota named by `key`, refused when the instance does
 * not let anyone change it through the API. `--tenant` picks a limit's
 * `tenant_change` (one tenant's own run cap) over its `change`.
 */
function findTarget(published: PublishedLimits, key: string, explicitTenant: boolean): Target {
  const limit = published.byKey.get(key);
  if (limit) {
    if (explicitTenant && limit.tenant_change) return limitTarget(key, limit, limit.tenant_change);
    if (limit.change) return limitTarget(key, limit, limit.change);
    if (limit.changeable_by !== "tenant_admin") throw operatorRefusal(limit, switchFor(published, key));
    throw notPublished(
      `This instance does not publish how to change ${key}, so nothing was sent.`,
      `It runs an older Cavelon version. A tenant admin changes ${limit.setting} in the Admin's settings. ` +
        `Docs: ${cavelonCommand("docs", "get", docsPage(limit.docs))}`,
      { limit: limitRef(limit) },
    );
  }
  const quotaChange = published.tenantQuotas?.changes.find((c) => c.key === key);
  const quota = published.tenantQuotas?.values.find((v) => v.key === key);
  if (quotaChange || quota?.change) {
    const change = quotaChange ? (({ key: _key, ...rest }) => rest)(quotaChange) : quota!.change!;
    return { key, kind: "quota", change, ...(quota ? { quota } : {}), scope: scopeOf(change) };
  }
  const { tenant, operator } = changeableKeys(published);
  const lines = [
    ...(tenant.length ? [`A tenant admin or owner changes these: ${tenant.join(", ")}.`] : []),
    ...(operator.length ? [`An operator changes these in Platform mode: ${operator.join(", ")}.`] : []),
  ];
  throw new CavelonError(ExitCode.failure, {
    code: "limit_not_found",
    message: `This instance lists no limit ${key}.`,
    hint: lines.length
      ? `${lines.join(" ")} \`cavelon limits\` lists every limit.`
      : "`cavelon limits` lists every limit; this instance names none that changes through the API.",
    details: { key, changeable: [...tenant, ...operator], sent: false },
  });
}

/**
 * The operation a change names, and the path parameters its path already
 * fills: an instance may publish a path with some parameters in place
 * (`/api/v1/admin/feature-flags/{tenant_id}/ORCHESTRATION_PARALLEL_FANOUT_ENABLED`
 * for `/api/v1/admin/feature-flags/{tenant_id}/{flag_key}`).
 */
async function changeOperation(ctx: Context, change: LimitChange, key: string): Promise<{ doc?: OpenApiDoc; op: Operation; fixed: Record<string, string[]> }> {
  const doc = await openapiOrWarn(ctx);
  const found = doc ? operationForPath(doc, change.method, change.path) : undefined;
  if (found) return { doc, ...found };
  const { doc: none, op } = await workflowOperation(ctx, change.method, change.path, `changing ${key}`);
  return { doc: none, op, fixed: {} };
}

/** The schema of a dotted body field, without its null branch; undefined when the body does not take it. */
function fieldSchema(doc: OpenApiDoc, op: Operation, field: string): Record<string, unknown> | undefined {
  let schema = deref(doc, jsonBodySchema(op)) as Record<string, unknown> | undefined;
  for (const part of field.split(".")) {
    const properties = nonNull(doc, schema)?.properties as Record<string, unknown> | undefined;
    if (!properties || !(part in properties)) return undefined;
    schema = deref(doc, properties[part]) as Record<string, unknown> | undefined;
  }
  return nonNull(doc, schema);
}

function nonNull(doc: OpenApiDoc, schema: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const branches = schema?.anyOf ?? schema?.oneOf;
  if (!Array.isArray(branches)) return schema;
  const kept = branches.map((b) => deref(doc, b) as Record<string, unknown>).filter((b) => b && b.type !== "null");
  return kept.length === 1 ? kept[0] : schema;
}

/** What kind of value the field takes: from the operation's schema, else from the published value. */
function kindOf(schema: Record<string, unknown> | undefined, target: Target): Kind {
  const type = schema?.type;
  if (type === "boolean") return "boolean";
  if (type === "array") return "list";
  if (type === "integer") return "integer";
  if (type === "number") return "number";
  if (typeof target.limit?.value === "boolean") return "boolean";
  return Array.isArray(target.limit?.value) ? "list" : "integer";
}

/** Leading digits (with a fraction when `fraction`) and what follows them, without a regex. */
function splitNumber(raw: string, fraction: boolean): { digits: string; rest: string } {
  const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
  let i = 0;
  while (isDigit(raw[i])) i++;
  if (fraction && i > 0 && raw[i] === "." && isDigit(raw[i + 1])) {
    i++;
    while (isDigit(raw[i])) i++;
  }
  return { digits: raw.slice(0, i), rest: raw.slice(i).trim().toLowerCase() };
}

/** A file type as the instance lists them: without leading dots. */
function bareExtension(word: string): string {
  let start = 0;
  while (start < word.length && word[start] === ".") start++;
  return word.slice(start);
}

/** Whether `none` clears the value: a limit's own value, an operator's cap, or a quota published with "no cap" as a state. */
function clears(target: Target): boolean {
  if (target.flag) return false;
  return target.kind === "limit" || Boolean(target.quota);
}

function parseValue(raw: string, kind: Kind, target: Target): Value {
  const word = raw.trim();
  const lower = word.toLowerCase();
  if (CLEAR_WORDS.has(lower)) {
    if (!clears(target)) {
      throw usageError(
        target.flag
          ? `${target.key} is switched on or off (${target.flag.setting}): give on or off; got "${raw}".`
          : `${target.key} takes a whole number; it has no value of the tenant's own to clear.`,
      );
    }
    return null;
  }
  if (kind === "boolean") {
    if (TRUE_WORDS.has(lower)) return true;
    if (FALSE_WORDS.has(lower)) return false;
    const clear = clears(target) ? ", or none to clear it" : "";
    throw usageError(`${target.key} is switched on or off (${target.change.field}): give true or false${clear}; got "${raw}".`);
  }
  if (kind === "list") {
    const items = [...new Set(word.split(",").map((w) => bareExtension(w.trim())).filter(Boolean))];
    if (!items.length) throw usageError(`${target.key} takes a comma-separated list (e.g. pdf,docx), or none to clear it; got "${raw}".`);
    return items;
  }
  const { digits, rest } = splitNumber(word, kind === "number");
  const unit = target.limit?.unit ?? target.quota?.unit ?? "count";
  const units = unit === "count" || unit === "processing_steps" ? "" : ` of ${unit}`;
  if (!digits) throw usageError(`${target.key} takes a ${kind === "number" ? "number" : "whole number"}${units}${clears(target) ? ", or none to clear it" : ""}; got "${raw}".`);
  if (rest && !(UNIT_WORDS[unit] ?? []).includes(rest)) {
    throw usageError(`${target.key} is in ${unit}; "${raw}" is not. Give the number of ${unit}${UNIT_WORDS[unit] ? ` (e.g. ${digits} or ${digits}${UNIT_WORDS[unit]![0]})` : ""}.`);
  }
  return Number(digits);
}

/** Whether a value is above the platform ceiling the change names (`maximum` with `maximum_setting`). */
function aboveCeiling(change: LimitChange, value: Value): boolean {
  return typeof value === "number" && Boolean(change.maximum_setting) && change.maximum !== undefined && value > change.maximum;
}

/**
 * The instance's code for a value above a platform ceiling:
 * `limit_above_platform_ceiling` where its error catalog lists it,
 * the generic `request_invalid` an older
 * instance answers otherwise.
 */
async function ceilingCode(ctx: Context): Promise<string> {
  const catalog = await (await ctx.contracts()).errorCatalog().catch(() => null);
  return catalog?.api_error_codes?.some((e) => e.code === LIMIT_ABOVE_CEILING) ? LIMIT_ABOVE_CEILING : "request_invalid";
}

/** The instance's bounds from `change`, before anything is sent; `aboveCode` is the code of a value above a platform ceiling. */
function checkBounds(target: Target, value: Value, aboveCode = "request_invalid"): void {
  if (typeof value !== "number") return;
  const { minimum, maximum, maximum_setting: ceiling } = target.change;
  const unit = target.limit ? (v: number) => formatValue({ value: v, unit: target.limit!.unit }) : String;
  const refuse = (message: string, hint: string, code = "request_invalid") =>
    new CavelonError(ExitCode.validation, {
      code,
      message: `${message} Nothing was sent.`,
      hint,
      docs: target.limit?.docs || target.quota?.docs || undefined,
      details: {
        key: target.key,
        // The fields the instance's own refusal names.
        ...(target.limit?.setting ? { setting: target.limit.setting } : {}),
        value,
        minimum: minimum ?? null,
        maximum: maximum ?? null,
        ...(ceiling ? { maximum_setting: ceiling } : {}),
        sent: false,
      },
    });
  if (minimum !== undefined && value < minimum) throw refuse(`${target.key} is at least ${unit(minimum)}; ${unit(value)} is below it.`, `Give a value from ${unit(minimum)}${maximum === undefined ? "" : ` to ${unit(maximum)}`}.`);
  if (maximum !== undefined && value > maximum) {
    throw ceiling
      ? refuse(
          `${target.key} may only be lowered: the platform ceiling is ${unit(maximum)} (${ceiling}), and ${unit(value)} is above it.`,
          `Only the instance operator raises the ceiling, with ${ceiling}; ask them. A tenant admin sets a value up to ${unit(maximum)}.`,
          aboveCode,
        )
      : refuse(`${target.key} is at most ${unit(maximum)}; ${unit(value)} is above it.`, `Give a value from ${unit(minimum ?? 0)} to ${unit(maximum)}.`);
  }
}

/** `{"archive_uploads": {"max_entries": 20}}` for the field `archive_uploads.max_entries`. */
function bodyFor(field: string, value: Value): Record<string, unknown> {
  const parts = field.split(".");
  let body: Record<string, unknown> = { [parts.pop()!]: value };
  while (parts.length) body = { [parts.pop()!]: body };
  return body;
}

/** "the personal access token "laptop"", "the API key "ci"", "this session". */
function credentialName(principal: MetaPrincipal): string {
  if (principal.token) return `the personal access token "${principal.token.name}"`;
  if (principal.api_key) return `the API key "${principal.api_key.name}"`;
  return "this session";
}

/** "settings.uploads.manage or settings.manage". */
function anyOf(names: string[], none = "a permission the instance does not name"): string {
  if (names.length <= 1) return names[0] ?? none;
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/** The Admin page where an operator makes the same change. */
function adminPage(target: Target): string {
  if (target.flag) return FEATURE_FLAGS_PAGE;
  return target.scope === "one_tenant" ? TENANT_LIMITS_PAGE : RUN_CAPS_PAGE;
}

/**
 * A credential whose published permissions, or on
 * an older instance an API key whose scopes, hold none of the change's is
 * refused before sending. An older instance says nothing about a person's
 * permissions, so the instance decides for them.
 */
function permissionRefusal(principal: MetaPrincipal | undefined, target: Target): CavelonError | undefined {
  const permissions = target.change.permissions;
  if (!principal || !permissions.length) return undefined;
  if (principal.permissions) {
    if (permissions.some((p) => principal.permissions!.includes(p))) return undefined;
    return new CavelonError(ExitCode.unauthorized, {
      code: "forbidden",
      message: `${capitalized(credentialName(principal))} may not change ${target.key}: it needs ${anyOf(permissions)}, which this credential does not hold. Nothing was sent.`,
      hint:
        `${capitalized(changedByTarget(target))} with ${anyOf(permissions)} runs the command, or changes it in the Admin.` +
        (principal.token ? " A personal access token holds at most its ceiling role's permissions." : ""),
      details: { key: target.key, permissions, held: principal.permissions, sent: false },
    });
  }
  const key = principal.kind === "api_key" ? principal.api_key : null;
  if (!key) return undefined;
  const scopes = key.scopes ?? [];
  if (scopes.includes("admin") || permissions.some((p) => scopes.includes(p))) return undefined;
  return new CavelonError(ExitCode.unauthorized, {
    code: "forbidden",
    message: `The API key "${key.name}" may not change ${target.key}: its scopes (${scopes.join(", ") || "none"}) hold none of ${permissions.join(", ")}. Nothing was sent.`,
    hint:
      "The operation takes a person's session or personal access token with one of these permissions, or an admin API key of the tenant. " +
      "A person runs the command, or a tenant administrator issues an admin key in Settings → API keys.",
    details: { key: target.key, permissions, scopes, sent: false },
  });
}

/** Who changes the target, in words: a tenant admin, a Tenant Owner. */
function changedByTarget(target: Target): string {
  if (target.quota) return changedBy(target.quota);
  if (target.limit) return changedBy(target.limit);
  return "a person with the permission";
}

/**
 * An operator's change is sent only with a personal access token in Platform
 * mode whose role is one the change names:
 * `/meta/principal`, asked without `X-Tenant-Id`, must answer in Platform mode
 * with the token's ceiling role among `requires_role`, and the person's own
 * global role, where `/auth/me` names it, too (a token acts as the lesser).
 */
async function operatorCheck(client: ApiClient, target: Target): Promise<{ principal?: MetaPrincipal; refusal?: CavelonError }> {
  const roles = target.change.requires_role ?? [];
  const principal = await readPrincipal(client, { sendTenant: false });
  let why: string | undefined;
  if (!principal) why = "The instance does not say who this credential is (/api/v1/meta/principal)";
  else if (principal.kind === "api_key") why = `${capitalized(credentialName(principal))} is a tenant's key, and a key never works in Platform mode`;
  else if (principal.kind !== "personal_access_token" || !principal.token) why = "This credential is not a personal access token";
  else if (!principal.token.platform_mode_allowed || principal.mode !== "platform") {
    why = `${capitalized(credentialName(principal))} does not work in Platform mode (it was created without "Platform mode")`;
  } else if (roles.length && !roles.includes(principal.token.ceiling_role)) {
    why = `${capitalized(credentialName(principal))} has the ceiling role ${principal.token.ceiling_role}`;
  } else if (roles.length) {
    const global = await readGlobalRole(client);
    if (global === null) why = "This person holds no platform role";
    else if (global !== undefined && !roles.includes(global)) why = `This person's global role is ${global}`;
  }
  if (!why) return { principal };
  const role = anyOf(roles, "a platform role");
  return {
    principal,
    refusal: new CavelonError(ExitCode.unauthorized, {
      code: "platform_role_required",
      message: `${target.key} is an operator's change: it needs a personal access token in Platform mode of a ${role}. ${why}. Nothing was sent.`,
      hint:
        `An operator with that role changes it in the Admin (${adminPage(target)}), or runs this command with a personal access token ` +
        `created with "Platform mode" on /account/access-tokens. Docs: ${cavelonCommand("docs", "get", docsPage(target.limit?.docs ?? ""))}`,
      docs: target.limit?.docs || undefined,
      details: { key: target.key, requires_role: roles, mode: target.change.mode ?? null, sent: false },
    }),
  };
}

function capitalized(text: string): string {
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

/** A path parameter the kit fills: only the tenant the request acts in, or the one `--tenant` names. */
async function pathParams(ctx: Context, change: LimitChange, principal: MetaPrincipal | undefined): Promise<Record<string, string[]>> {
  const params: Record<string, string[]> = {};
  for (const match of change.path.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1]!;
    if (name !== "tenant_id") {
      throw notPublished(`${change.method} ${change.path} needs ${name}, which the kit cannot fill, so nothing was sent.`, "The instance names an operation this kit does not know how to call; `cavelon api describe` shows it.");
    }
    const tenantId = (await ctx.client()).target.tenantId ?? principal?.tenant_id ?? undefined;
    if (!tenantId) throw usageError("Which tenant? Choose one with `cavelon use <tenant>` or --tenant.");
    params[name] = [tenantId];
  }
  return params;
}

function valueText(target: Target, value: Value | undefined, kind: Kind): string {
  if (value === undefined) return "not published";
  if (value === null) {
    if (target.quota) return "none (no cap)";
    if (target.scope === "one_tenant") return "none (the platform's cap applies)";
    if (target.scope === "platform") return "none (the baseline applies)";
    return "none (the platform's value applies)";
  }
  if (typeof value === "boolean") return target.flag || target.limit?.unit === "boolean" ? (value ? "on" : "off") : `${target.change.field} ${value}`;
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  if (target.limit && kind !== "list") return formatValue({ value, unit: target.limit.unit });
  return String(value);
}

function argText(value: Value): string {
  if (value === null) return "none";
  return Array.isArray(value) ? value.join(",") : String(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  const sorted = (list: unknown[]) => list.map(String).sort((x, y) => x.localeCompare(y)).join("\n");
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && sorted(a) === sorted(b);
  return a === b;
}

/** The value the change replaces, as far as the instance publishes it. */
async function previousValue(ctx: Context, published: PublishedLimits, target: Target): Promise<Value | undefined> {
  if (target.flag) return target.flag.enabled;
  if (target.kind === "quota") {
    // The quota row that names this change holds the setting's current value.
    const row = await quotaSetting(ctx, published, target.key).catch(() => undefined);
    if (row && (typeof row.value === "number" || row.value === null)) return row.value;
    return target.quota ? target.quota.value : undefined;
  }
  const limit = target.limit!;
  // One tenant's own cap: the entry's value when it is the tenant's, else it has none.
  if (target.scope === "one_tenant") return limit.source === "tenant" ? (limit.value as Value) : null;
  // The platform's value is published only while no tenant value replaces it.
  if (target.scope === "platform") return limit.source === "tenant" ? undefined : (limit.value as Value);
  return limit.value as Value;
}

/** Why the change would change nothing, or undefined. */
function noChange(target: Target, previous: Value | undefined, value: Value, from: string): string | undefined {
  if (target.flag) return previous === value ? `${target.key} is already ${from} (${target.flag.setting})` : undefined;
  if (target.kind === "quota") return previous !== undefined && sameValue(previous, value) ? `${target.key} is already ${from}` : undefined;
  const limit = target.limit!;
  if (target.scope === "one_tenant") {
    if (value === null && previous === null) return `${target.key} has no cap of this tenant's own to clear (source: ${limit.source})`;
    return previous !== null && sameValue(previous, value) ? `${target.key} is already ${from} (source: tenant)` : undefined;
  }
  if (target.scope !== "tenant") return undefined;
  // An on/off limit of the tenant's (kb_upload_archive_enabled).
  if (typeof value === "boolean") return previous === value ? `${target.key} is already ${from} (source: ${limit.source})` : undefined;
  const own = limit.source === "tenant";
  if (value === null && !own) return `${target.key} has no value of this tenant's own to clear (source: ${limit.source})`;
  if (own && sameValue(previous, value)) return `${target.key} is already ${from} (source: tenant)`;
  return undefined;
}

/** A field of an answer, dotted when nested. */
function dig(answer: Record<string, unknown>, field: string): { found: boolean; value?: unknown } {
  let node: unknown = answer;
  for (const part of field.split(".")) {
    if (!node || typeof node !== "object" || !(part in (node as Record<string, unknown>))) return { found: false };
    node = (node as Record<string, unknown>)[part];
  }
  return { found: true, value: node };
}

/** What the instance answered: the limit as it now stands, the quota, or the field it stores. */
function answeredValue(target: Target, data: unknown, sent: Value): { value: unknown; source?: string; origin?: string; changed: unknown[] } {
  const answer = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const changed = Array.isArray(answer.changed) ? answer.changed : [];
  const now = Array.isArray(answer.limits) ? (answer.limits as Array<Record<string, unknown>>).find((l) => l?.key === target.key) : undefined;
  if (now && "value" in now) return { value: now.value, source: typeof now.source === "string" ? now.source : undefined, changed };
  const quota = answer.quota as { key?: unknown; value?: unknown } | undefined;
  if (quota && typeof quota === "object" && quota.key === target.key) return { value: quota.value ?? null, changed };
  const field = dig(answer, target.change.field);
  if (field.found) {
    // The run caps answer where each value comes from (`global_origin`).
    const origin = answer[`${target.change.field}_origin`];
    return { value: field.value, ...(typeof origin === "string" ? { origin } : {}), changed };
  }
  const own = changed.find((c) => (c as { setting?: unknown })?.setting === target.limit?.setting) as { new?: unknown } | undefined;
  return { value: own && "new" in own ? own.new : sent, changed };
}

/** Whether the person named the tenant on this command: then a limit's tenant_change applies. */
function explicitTenant(session: Session): boolean {
  return session.tenantSource === "option" && Boolean(session.tenant);
}

export const limitsSet: CommandSpec = {
  name: "limits set",
  summary: "Change a limit through the operation the instance names: a tenant's, or an operator's in Platform mode (needs --confirm).",
  description:
    "Reads the limit's published change (operation, body field, bounds, permissions, roles) and checks the value against it\n" +
    "before sending. Without --confirm, shows the old and new value, the operation and who may run it, and changes nothing.\n" +
    "Also changes the tenant quotas in tenant_quotas.changes (the inference budget, the monthly Processing Step cap).\n" +
    "An operator's change (a run cap) is sent only with a personal access token in Platform mode of a role it names, without\n" +
    "X-Tenant-Id; --tenant <id|slug> then sets one tenant's own run cap. An environment or licence limit, a value out of bounds,\n" +
    "an instance that does not publish how to change the limit, and a credential without the permission or the role are refused\n" +
    "before anything is sent. Propose the change to the person; never raise a limit on your own.",
  readOnly: false,
  destructive: true,
  idempotent: true,
  mcpTool: "limits_set",
  positionals: [
    { name: "key", description: "The limit's key, as `cavelon limits` lists it (e.g. kb_upload_max_file_size_mb).", required: true },
    {
      name: "value",
      description: "The new value in the limit's unit (50 or 50MB), a comma-separated list of file types, true/false, or none to clear the tenant's own value.",
      required: true,
    },
  ],
  options: {
    confirm: { type: "boolean", description: "Change it; without this nothing is changed." },
    env: ENV_OPTION,
  },
  examples: [
    "cavelon limits set kb_upload_max_file_size_mb 50",
    "cavelon limits set kb_upload_max_file_size_mb 50 --confirm",
    "cavelon limits set rate_limit_chat_rpm none --confirm",
    "cavelon limits set monthly_inference_token_budget 2000000",
    "cavelon limits set monthly_processing_step_cap none --confirm",
    "cavelon limits set max_concurrent_agent_runs_global 150 --confirm",
    "cavelon limits set max_concurrent_agent_runs_per_tenant 6 --tenant acme --confirm",
  ],
  async run(ctx, input) {
    const key = positional(input, "key")!.trim();
    const raw = positional(input, "value")!;
    const contracts = await ctx.contracts();
    const published = await readLimits(ctx);
    if (contracts.needsTenant) {
      throw new CavelonError(ExitCode.usage, {
        code: "tenant_required",
        message: "Limits belong to a tenant, and none is chosen.",
        hint: "Choose one with `cavelon use <tenant>` or pass --tenant; an operator's change reads the limits of any tenant and sends in Platform mode.",
      });
    }
    if (!published.published) {
      throw notPublished(
        `This instance does not publish its limits, so it does not say how to change ${key}; nothing was sent.`,
        "It is older than the limits in /api/v1/meta/capabilities. A tenant admin changes tenant settings in the Admin.",
      );
    }
    const session = await ctx.session();
    const target = findTarget(published, key, explicitTenant(session));
    const { change } = target;
    const operator = isOperatorChange(change);
    const { doc, op, fixed } = await changeOperation(ctx, change, key);
    const schema = doc ? fieldSchema(doc, op, change.field) : undefined;
    if (doc && !schema) {
      throw notPublished(
        `This instance names ${change.method} ${change.path} for ${key}, but its OpenAPI body has no ${change.field}, so nothing was sent.`,
        "The instance's capabilities and OpenAPI disagree; `cavelon status` shows its version.",
      );
    }
    const kind = kindOf(schema, target);
    const value = parseValue(raw, kind, target);
    checkBounds(target, value, aboveCeiling(change, value) ? await ceilingCode(ctx) : undefined);
    const body = bodyFor(change.field, value);
    // The instance's own schema, the same bounds and types, before anything is sent.
    if (doc) validateBody(doc, op, body);

    const client = await ctx.client();
    let principal: MetaPrincipal | undefined;
    if (operator) {
      const checked = await operatorCheck(client, target);
      if (checked.refusal) throw checked.refusal;
      principal = checked.principal;
    } else {
      principal = await readPrincipal(client);
    }
    const refused = permissionRefusal(principal, target);
    if (refused) throw refused;
    const params = { ...fixed, ...(await pathParams(ctx, change, operator ? undefined : principal)) };

    const flags = targetFlags(session);
    const previous = await previousValue(ctx, published, target);
    const operation = {
      operation: change.operation,
      method: change.method,
      path: change.path,
      field: change.field,
      body,
      ...(Object.keys(params).length ? { params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v[0]])) } : {}),
      ...(operator ? { mode: "platform" } : {}),
    };
    const base = {
      key,
      kind: target.kind,
      scope: target.scope,
      previous: previous ?? null,
      value,
      operation,
      permissions: change.permissions,
      ...(change.requires_role ? { requires_role: change.requires_role } : {}),
      ...(target.limit ? { limit: limitRef(target.limit) } : {}),
      ...(target.flag ? { switch: target.flag.setting } : {}),
    };
    const from = valueText(target, previous, kind);
    const to = valueText(target, value, kind);

    const nothing = noChange(target, previous, value, from);
    if (nothing) return { data: { ...base, changed: false, sent: false }, text: `${nothing}; nothing to change.` };

    const sends = `${change.method} ${change.path} ${JSON.stringify(body)}${operator ? " (Platform mode, no X-Tenant-Id)" : ""}`;
    const allowed = operator
      ? `a personal access token in Platform mode of a ${anyOf(change.requires_role ?? [], "platform role")}`
      : `a credential with ${anyOf(change.permissions)} (a session, a personal access token, or an admin API key of the tenant)`;
    if (!boolOption(input, "confirm")) {
      const confirm = `cavelon limits set ${shellWord(key)} ${shellWord(argText(value))}${flags} --confirm`;
      const source = target.limit && target.kind === "limit" ? ` (source now: ${target.limit.source}${target.limit.origin ? `, origin: ${target.limit.origin}` : ""})` : "";
      const what =
        target.scope === "platform" && target.limit?.tenant_change
          ? [`This changes the platform's cap for every tenant without its own; --tenant <id|slug> sets one tenant's own cap.`]
          : target.scope === "one_tenant" && params.tenant_id
            ? [`For tenant ${params.tenant_id[0]} only.`]
            : [];
      return {
        data: { ...base, changed: false, sent: false, confirm },
        text: [`${key}: ${from} → ${to}${source}.`, ...what, `Sends: ${sends}`, `Allowed: ${allowed}.`, `Nothing was changed. Change it with: ${confirm}`].join("\n"),
      };
    }

    let result;
    try {
      result = await callOperation(ctx, client, doc, op, { params, body, ...(operator ? { sendTenant: false } : {}) });
    } catch (error) {
      if (error instanceof CavelonError && error.status === 403) {
        const needs = operator ? `a Platform-mode token of a ${anyOf(change.requires_role ?? [], "platform role")}` : anyOf(change.permissions);
        throw new CavelonError(ExitCode.unauthorized, {
          code: error.code,
          status: 403,
          message: `${error.message} (${key} was not changed.)`,
          hint: `Changing ${key} needs ${needs}. A person with it runs the command, or uses the Admin.` + (error.hint ? ` ${error.hint}` : ""),
          docs: error.docs,
          details: { key, permissions: change.permissions, ...(change.requires_role ? { requires_role: change.requires_role } : {}), changed: false },
        });
      }
      if (error instanceof CavelonError && error.code === LIMIT_ABOVE_CEILING) {
        // The instance's ceiling may differ from the one it published.
        throw new CavelonError(ExitCode.validation, {
          code: error.code,
          status: error.status,
          message: `${error.message} (${key} was not changed.)`,
          hint: error.hint,
          docs: error.docs,
          details: { key, ...(error.details && typeof error.details === "object" ? (error.details as Record<string, unknown>) : {}), changed: false },
        });
      }
      throw error;
    }
    const answered = answeredValue(target, result.data, value);
    const now = valueText(target, answered.value as Value, Array.isArray(answered.value) ? "list" : kind);
    const where = answered.source ? ` (source: ${answered.source})` : answered.origin ? ` (origin: ${answered.origin})` : "";
    return {
      data: {
        ...base,
        now: answered.value ?? null,
        ...(answered.source ? { source: answered.source } : {}),
        ...(answered.origin ? { origin: answered.origin } : {}),
        changes: answered.changed,
        changed: true,
        sent: true,
      },
      text: `Changed ${key}: ${from} → ${now}${where}.`,
    };
  },
};
