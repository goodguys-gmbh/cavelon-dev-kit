import { capText, RUN_CAP_KEYS } from "../capacity.js";
import { listOption, stringOption, type CommandSpec } from "../command.js";
import { CavelonError, ExitCode } from "../errors.js";
import { table } from "../format.js";
import { branchConcurrency, branchConcurrencyText } from "../branches.js";
import {
  bindsNow,
  bindsWhenText,
  changedBy,
  docsPage,
  formatQuota,
  formatQuotaValue,
  formatValue,
  isOperatorChange,
  readLimits,
  readQuotas,
  type Limit,
  type Quota,
  type QuotaValue,
} from "../limits.js";
import { cavelonCommand, fill } from "../printed.js";

/**
 * `cavelon limits`: what this instance lets the tenant's solution do, from
 * `/api/v1/meta/capabilities` (`limits`), grouped by where each value comes
 * from, with who changes it and how, the tenant's quotas with their use (the
 * Processing Step cap among them), and whether a
 * run's branches run concurrently.
 */

const SOURCE_ORDER = ["tenant", "platform", "licence"];

const SOURCE_TITLE: Record<string, string> = {
  tenant: "Set by this tenant (its own settings)",
  platform: "Set by the instance (its operator's settings)",
  licence: "Set by the instance's licence",
};

function groupBySource(values: Limit[]): Array<{ source: string; limits: Limit[] }> {
  const sources = [...new Set(values.map((v) => v.source))].sort((a, b) => {
    const rank = (s: string) => (SOURCE_ORDER.includes(s) ? SOURCE_ORDER.indexOf(s) : SOURCE_ORDER.length);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  return sources.map((source) => ({ source, limits: values.filter((v) => v.source === source) }));
}

/** A published quota's state in words: "cap reached", "close to the cap". */
function quotaValueClose(quota: QuotaValue): string {
  if (quota.state === "reached") return "cap reached";
  return quota.near ? "close to the cap" : "";
}

/** " in 2026-10": the billing month the use counts. */
function periodText(quota: QuotaValue): string {
  return quota.period ? ` in ${quota.period.key}` : "";
}

/** A quota's use in words; one the instance shapes differently shows its numbers. */
function quotaUse(quota: Quota): string {
  if (quota.current !== null || quota.limit !== null) return formatQuota(quota);
  const numbers = Object.entries(quota.details).filter(([, v]) => typeof v === "number");
  return numbers.length ? numbers.map(([k, v]) => `${k} ${String(v)}`).join(", ") : "-";
}

export const limits: CommandSpec = {
  name: "limits",
  summary: "Show the instance's limits for this tenant, who can change each, and the tenant's quotas with their use.",
  description:
    "Read them before planning a solution: upload sizes and file types, run and tool limits, timeouts, rate limits, licence caps.\n" +
    "Grouped by source (tenant, platform, licence); each names who changes it (a tenant admin or the operator) and the setting.\n" +
    "A run cap also names its origin when the instance says: a platform setting (the Admin), the environment or the default.\n" +
    "A limit that binds only while another is on says so (the archive caps apply while archive uploads are on).\n" +
    "Branch concurrency: the width per node, the ceiling per process, and whether branches run concurrently (and which switch is off).\n" +
    "The tenant quotas include the monthly Processing Step cap with this billing month's use, where the instance publishes it.\n" +
    "A limit the instance does not list does not bind there. An instance older than the published limits lists none.",
  readOnly: true,
  idempotent: true,
  mcpTool: "limits",
  options: {
    key: { type: "string", multiple: true, value: "<key>", description: "Only these limits (e.g. kb_upload_max_file_size_mb)." },
    source: { type: "string", value: "<source>", description: "Only limits from this source: tenant, platform or licence." },
  },
  examples: ["cavelon limits", "cavelon limits --key kb_upload_max_file_size_mb --json", "cavelon limits --source tenant"],
  async run(ctx, input) {
    const contracts = await ctx.contracts();
    const published = await readLimits(ctx);
    if (contracts.needsTenant) {
      throw new CavelonError(ExitCode.usage, {
        code: "tenant_required",
        message: "Limits belong to a tenant, and none is chosen.",
        hint: `Choose one with \`${cavelonCommand("use")}\` (it lists your tenants) or pass --tenant <name or slug>.`,
      });
    }
    if (!published.published) {
      ctx.warn("This instance does not publish its limits (it is older than the limits in /api/v1/meta/capabilities); none is assumed.");
      return {
        data: { published: false, groups: [], tenant_quotas: null, quota_values: [], near: [], branch_concurrency: null },
        text: "This instance does not publish its limits. Commands send as they are, and the instance answers for itself.",
      };
    }
    const keys = listOption(input, "key").flatMap((k) => k.split(",")).map((k) => k.trim()).filter(Boolean);
    const source = stringOption(input, "source");
    const values = published.values.filter((v) => (!keys.length || keys.includes(v.key)) && (!source || v.source === source));
    const unknown = keys.filter((k) => !published.byKey.has(k));
    if (unknown.length) ctx.warn(`This instance lists no limit ${unknown.join(", ")}; it does not bind here.`);
    const groups = groupBySource(values);

    // The quotas are tenant objects with a use; filtering by limit key or source leaves them out.
    const quotas = keys.length || source ? undefined : await readQuotas(ctx, published);
    const quotaValues = keys.length || source ? [] : (published.tenantQuotas?.values ?? []);
    const near = [
      ...(quotas?.items.filter((q) => q.near) ?? []).map((q) => ({ key: q.key, current: q.current, limit: q.limit, ratio: q.ratio, text: `${q.key} ${formatQuota(q)}` })),
      ...quotaValues
        .filter((q) => q.near)
        .map((q) => ({ key: q.key, current: q.used, limit: q.value, ratio: q.ratio, text: `${q.key} ${formatQuotaValue(q)}${q.period ? `, resets ${q.period.resets_at}` : ""}` })),
    ];
    const branches = branchConcurrency(published, values);

    let text = groups
      .map(({ source: s, limits: list }) => {
        const rows = list.map((l) => ({
          key: l.key,
          value: formatValue(l),
          changed_by: changedBy(l),
          origin: l.origin ?? "",
          setting: l.setting,
          docs: l.docs,
        }));
        // The origin column only where the instance publishes one.
        const columns = list.some((l) => l.origin) ? ["key", "value", "changed_by", "origin", "setting", "docs"] : ["key", "value", "changed_by", "setting", "docs"];
        return `${SOURCE_TITLE[s] ?? `Source: ${s}`}:\n${table(rows, columns, 80)}`;
      })
      .join("\n\n");
    const caps = values.filter((v) => v.origin || (v.source === "tenant" && RUN_CAP_KEYS.includes(v.key)));
    if (caps.length) text += `\n\nWhere the run caps are set:\n${caps.map((l) => `  ${capText(l)}`).join("\n")}`;
    // A limit that binds only while an on/off limit is on: the archive caps.
    const conditional = values.filter((v) => v.binds_when);
    if (conditional.length) {
      const lines = conditional.map((l) => `  ${l.key} ${bindsWhenText(l)}${bindsNow(l, published) ? "" : `; ${l.binds_when} is off, so it does not bind now`}`);
      text += `\n\nOnly while another limit is on:\n${lines.join("\n")}`;
    }
    if (branches) text += `\n\nBranch concurrency (fan-outs and Map loops):\n${branchConcurrencyText(branches)}`;
    if (!groups.length) text = keys.length || source ? "No published limit matches." : "This instance publishes no binding limit.";
    if (quotas || quotaValues.length) {
      const rows = [
        ...(quotas?.items ?? []).map((q) => ({ quota: q.key, use: quotaUse(q), state: typeof q.details.state === "string" ? q.details.state : "", close: q.near ? "close to the quota" : "" })),
        // The quotas published with their use, this billing month.
        ...quotaValues.map((q) => ({ quota: q.key, use: `${formatQuotaValue(q)}${periodText(q)}`, state: q.state, close: quotaValueClose(q) })),
      ];
      text += `\n\nTenant quotas (${quotas?.path ?? published.tenantQuotas!.path}):\n`;
      if (quotas?.unavailable) text += `  not readable: ${quotas.unavailable}${rows.length ? "\n" : ""}`;
      if (rows.length || !quotas?.unavailable) text += table(rows, ["quota", "use", "state", "close"]) || "  none";
    }
    if (near.length) text += `\n\nClose to a quota: ${near.map((q) => q.text).join("; ")}`;
    const quotaChanges = keys.length || source ? [] : (published.tenantQuotas?.changes ?? []);
    const tenantChangeable = [...values.filter((v) => v.change && !isOperatorChange(v.change)).map((v) => v.key), ...quotaChanges.filter((c) => !isOperatorChange(c)).map((c) => c.key)];
    const operatorChangeable = values.filter((v) => [v.change, v.tenant_change].some((c) => c && isOperatorChange(c))).map((v) => v.key);
    if (tenantChangeable.length) {
      const owner = quotaValues.filter((q) => q.changeable_by === "tenant_owner" && tenantChangeable.includes(q.key)).map((q) => q.key);
      text += `\n\nA tenant admin changes ${tenantChangeable.length === 1 ? "it" : "these"} with: ${cavelonCommand("limits", "set", fill("key"), fill("value"))} (shows the change; --confirm sends it)`;
      if (owner.length) text += `; ${owner.join(", ")} only a Tenant Owner (settings.manage)`;
    }
    if (operatorChangeable.length) {
      text += `\n\nAn operator changes ${operatorChangeable.join(", ")} with the same command and a personal access token in Platform mode of the role the change names; --tenant <id|slug> sets the tenant (one tenant's own run cap, its flag).`;
    }
    const pages = [...new Set(values.map((v) => docsPage(v.docs)).filter(Boolean))];
    if (pages.length) text += `\n\nHow to change one: ${cavelonCommand("docs", "get", fill("page"))} (${pages.join(", ")})`;

    return {
      data: {
        published: true,
        groups: groups.map(({ source: s, limits: list }) => ({
          source: s,
          limits: list.map((l) => (l.binds_when ? { ...l, binds_now: bindsNow(l, published) } : l)),
        })),
        tenant_quotas: quotas
          ? { path: quotas.path, docs: quotas.docs, items: quotas.items, ...(quotas.unavailable ? { unavailable: quotas.unavailable } : {}) }
          : null,
        quota_values: quotaValues.map(({ near: isNear, ratio, ...q }) => ({ ...q, ratio, near: isNear })),
        near: near.map(({ text: _text, ...q }) => q),
        branch_concurrency: branches ?? null,
      },
      text,
    };
  },
};
