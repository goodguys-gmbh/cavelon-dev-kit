import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CONTRACTS, defaultQuotaUsage, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";
import { buildZip, type ZipEntry } from "./zip-writer.js";

/**
 * The kit reads the limits the instance
 * publishes, refuses before sending what they rule out, and assumes nothing
 * on an instance that publishes none.
 */

type LimitEntry = Record<string, unknown> & { key: string };

let server: FakeServer;
let sb: Sandbox;
let tenant: string;
const KB = "4c1b9a3e-0000-4000-8000-0000000004b1";

/** The snapshot's `limits`, with some entries changed, added or removed. */
function limitsWith(edit: (values: LimitEntry[]) => LimitEntry[]): Record<string, unknown> {
  const caps = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-capabilities.json"), "utf8")) as { limits: { values: LimitEntry[] } };
  return { ...caps.limits, values: edit(caps.limits.values) };
}

const override = (key: string, patch: Record<string, unknown>) => (values: LimitEntry[]) =>
  values.map((v) => (v.key === key ? { ...v, ...patch } : v));

const LICENCE: LimitEntry = {
  key: "licence_max_harnesses",
  value: 2,
  unit: "count",
  source: "licence",
  changeable_by: "operator",
  setting: "entitlements.max_harnesses",
  docs: "/docs/reference/limits-and-quotas#licence-entitlements",
  scope: "instance",
  description: "Active solutions (harnesses) the licence allows on this instance.",
};

const uploads = () => server.state.requests.filter((r) => r.path.endsWith("/documents/upload"));
const creates = () => server.state.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/harnesses");

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  server.state.kbs.push({ id: KB, tenant_id: tenant, name: "FAQ" });
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
});
afterEach(() => {
  server.state.capsPatch = {};
  server.state.quotaUsage = defaultQuotaUsage();
  server.state.tenantFlags.clear();
  server.state.processingStepCaps.clear();
  server.state.processingStepsUsed = 0;
  server.state.harnesses.length = 0;
  server.state.requests.length = 0;
  server.state.failures = [];
});
afterAll(async () => {
  sb.cleanup();
  await server.close();
});

describe("cavelon limits", () => {
  it("groups the limits by source, with who changes each, the setting and the docs", async () => {
    server.state.capsPatch = { limits: limitsWith(override("kb_upload_max_file_size_mb", { value: 10, source: "tenant" })) };
    const result = await cli(sb, ["limits"]);
    expect(result.code, result.stderr).toBe(0);
    const text = result.stdout;
    expect(text.indexOf("Set by this tenant")).toBeLessThan(text.indexOf("Set by the instance (its operator"));
    const tenantPart = text.slice(text.indexOf("Set by this tenant"), text.indexOf("Set by the instance"));
    expect(tenantPart).toMatch(/kb_upload_max_file_size_mb\s+10 MB\s+a tenant admin\s+upload_defaults\.max_file_size_mb\s+\/docs\/reference\/limits-and-quotas#upload-and-storage-quotas/);
    expect(text).toMatch(/webhook_max_timeout_seconds\s+\d+ s\s+the instance operator\s+WEBHOOK_MAX_TIMEOUT_SECONDS/);
    expect(text).toMatch(/cavelon docs get <page> \(.*reference\/configuration/);

    const json = (await cli(sb, ["limits", "--json"])).json<{
      published: boolean;
      groups: Array<{ source: string; limits: LimitEntry[] }>;
      tenant_quotas: { path: string; items: Array<{ key: string; current: number | null; limit: number | null }> };
    }>();
    expect(json.published).toBe(true);
    expect(json.groups.map((g) => g.source)).toEqual(["tenant", "platform"]);
    // Whether branches run concurrently is decided by the tenant's flag while the platform switch is on.
    expect(json.groups[0]!.limits.map((l) => l.key)).toEqual(["kb_upload_max_file_size_mb", "orchestration_parallel_branches"]);
    expect(json.groups[1]!.limits.find((l) => l.key === "agent_max_turns")).toMatchObject({ changeable_by: "tenant_admin", setting: "agent_max_turns" });
  });

  it("shows branch concurrency: the width per node, the ceiling per process, and whether branches run concurrently", async () => {
    const on = await cli(sb, ["limits"]);
    expect(on.code, on.stderr).toBe(0);
    expect(on.stdout).toContain(
      "Branch concurrency (fan-outs and Map loops):\n" +
        "  width per node: 8 (ORCHESTRATION_MAX_BRANCH_CONCURRENCY); a node's max_concurrency above it is capped\n" +
        "  per process: 32 (ORCHESTRATION_PROCESS_MAX_BRANCH_INFLIGHT), shared by every run in one worker or API process\n" +
        "  concurrent: yes (ORCHESTRATION_PARALLEL_FANOUT_ENABLED and feature_flags.ORCHESTRATION_PARALLEL_FANOUT_ENABLED are on)",
    );
    // The tenant's flag off: branches run in sequence, and the switch that turned them off is named.
    server.state.tenantFlags.set(tenant, new Map([["ORCHESTRATION_PARALLEL_FANOUT_ENABLED", false]]));
    const off = await cli(sb, ["limits"]);
    expect(off.stdout).toContain(
      "  concurrent: no, fan-outs and Map loops run one branch after another (same result, slower): " +
        "feature_flags.ORCHESTRATION_PARALLEL_FANOUT_ENABLED is off (an operator turns it on in the Admin (Configure › Feature Flags), or with cavelon limits set orchestration_parallel_branches on --tenant <tenant> --confirm and a Platform-mode token)",
    );
    const json = (await cli(sb, ["limits", "--json"])).json<{ branch_concurrency: Record<string, unknown> }>();
    expect(json.branch_concurrency).toMatchObject({
      width: 8,
      process_ceiling: 32,
      parallel: false,
      deciding_setting: "feature_flags.ORCHESTRATION_PARALLEL_FANOUT_ENABLED",
      off: ["feature_flags.ORCHESTRATION_PARALLEL_FANOUT_ENABLED"],
    });
    // --key picks them like any other limit.
    const width = await cli(sb, ["limits", "--key", "orchestration_max_branch_concurrency"]);
    expect(width.stdout).toContain("width per node: 8");
    expect(width.stdout).not.toContain("concurrent:");
  });

  it("shows the monthly Processing Step cap under the tenant quotas, with this month's use and state", async () => {
    const none = await cli(sb, ["limits"]);
    expect(none.stdout).toMatch(/monthly_processing_step_cap\s+0 \(no cap\) in 2026-10\s+none\n/);
    // The quota-usage row that names the cap's change is the same quota: it is not listed twice.
    expect(none.stdout).not.toMatch(/^monthly_processing_steps\s/m);
    expect(none.stdout).toContain("monthly_processing_step_cap only a Tenant Owner (settings.manage)");
    server.state.processingStepCaps.set(tenant, 1000);
    server.state.processingStepsUsed = 1000;
    const reached = await cli(sb, ["limits"]);
    expect(reached.stdout).toMatch(/monthly_processing_step_cap\s+1000 of 1000 \(100%\) in 2026-10\s+reached\s+cap reached/);
    const json = (await cli(sb, ["limits", "--json"])).json<{ quota_values: Array<Record<string, unknown>>; near: Array<{ key: string }> }>();
    expect(json.quota_values).toEqual([expect.objectContaining({ key: "monthly_processing_step_cap", value: 1000, used: 1000, state: "reached", near: true })]);
    expect(json.near.map((n) => n.key)).toContain("monthly_processing_step_cap");
  });

  it("says which limits bind only while another is on: the archive caps", async () => {
    const result = await cli(sb, ["limits"]);
    expect(result.code, result.stderr).toBe(0);
    const caps = ["kb_upload_archive_max_entries", "kb_upload_archive_max_total_uncompressed_mb", "kb_upload_archive_max_compression_ratio"];
    for (const key of caps) {
      expect(result.stdout).toContain(`  ${key} applies while archive uploads are on (kb_upload_archive_enabled); kb_upload_archive_enabled is off, so it does not bind now`);
    }
    expect(result.stdout).toMatch(/kb_upload_archive_enabled\s+off\s+a tenant admin\s+upload_defaults\.archive_uploads\.enabled/);
    const json = (await cli(sb, ["limits", "--json"])).json<{ groups: Array<{ limits: Array<{ key: string; binds_when?: string; binds_now?: boolean }> }> }>();
    const all = json.groups.flatMap((g) => g.limits);
    expect(all.filter((l) => l.binds_when).map((l) => [l.key, l.binds_when, l.binds_now])).toEqual(caps.map((key) => [key, "kb_upload_archive_enabled", false]));
    expect(all.find((l) => l.key === "kb_upload_max_file_size_mb")).not.toHaveProperty("binds_now");

    server.state.capsPatch = { limits: limitsWith(override("kb_upload_archive_enabled", { value: true, source: "tenant" })) };
    const on = await cli(sb, ["limits"]);
    expect(on.stdout).toContain("  kb_upload_archive_max_entries applies while archive uploads are on (kb_upload_archive_enabled)\n");
  });

  it("an instance without the cap, branch concurrency or operator changes shows what it publishes, as before", async () => {
    const caps = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-capabilities.json"), "utf8")) as { limits: { values: LimitEntry[]; tenant_quotas: Record<string, unknown> } };
    const values = caps.limits.values
      .filter((v) => !v.key.startsWith("orchestration_max_branch") && !v.key.startsWith("orchestration_process") && v.key !== "orchestration_parallel_branches")
      .map(({ change, tenant_change: _t, binds_when: _b, ...rest }) => ((change as { requires_role?: unknown } | undefined)?.requires_role ? rest : { ...rest, ...(change ? { change } : {}) }) as LimitEntry);
    const { values: _quotaValues, ...link } = caps.limits.tenant_quotas;
    server.state.capsPatch = { limits: { values, tenant_quotas: { ...link, changes: (link.changes as Array<{ key: string }>).filter((c) => c.key !== "monthly_processing_step_cap") } } };
    const usage = defaultQuotaUsage();
    usage.monthly_processing_steps = {};
    delete (usage.monthly_inference_tokens as Record<string, unknown>).change;
    server.state.quotaUsage = usage;
    const result = await cli(sb, ["limits"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("Branch concurrency");
    expect(result.stdout).not.toContain("monthly_processing_step_cap");
    expect(result.stdout).not.toContain("An operator changes");
    expect(result.stdout).not.toContain("Only while another limit is on");
    expect(result.stdout).toMatch(/^monthly_processing_steps\s+-/m);
    const json = (await cli(sb, ["limits", "--json"])).json<{ branch_concurrency: unknown; quota_values: unknown[] }>();
    expect(json).toMatchObject({ branch_concurrency: null, quota_values: [] });
  });

  it("merges in the tenant's quotas with their current use and flags those close to the limit", async () => {
    server.state.quotaUsage = { ...defaultQuotaUsage(), knowledge_bases: { current: 9, limit: 10 } };
    const result = await cli(sb, ["limits", "--json"]);
    const data = result.json<{
      tenant_quotas: { path: string; items: Array<{ key: string; current: number | null; limit: number | null; near: boolean }> };
      near: Array<{ key: string }>;
    }>();
    expect(data.tenant_quotas.path).toBe("/api/v1/tenants/current/quota-usage");
    expect(data.tenant_quotas.items.find((q) => q.key === "agents")).toMatchObject({ current: 2, limit: 20, near: false });
    // A limit of 0 caps nothing.
    expect(data.tenant_quotas.items.find((q) => q.key === "monthly_ingestion_tokens")).toMatchObject({ near: false });
    expect(data.near).toEqual([expect.objectContaining({ key: "knowledge_bases", current: 9, limit: 10 })]);

    const text = (await cli(sb, ["limits"])).stdout;
    expect(text).toMatch(/knowledge_bases\s+9 of 10 \(90%\)\s+close to the quota/);
    expect(text).toMatch(/documents_per_kb\s+current_total 3, limit_per_kb 2000/);
    expect(text).toMatch(/Close to a quota: knowledge_bases 9 of 10 \(90%\)/);
  });

  it("filters by key and source, and says when the instance lists no such limit", async () => {
    const one = await cli(sb, ["limits", "--key", "kb_upload_allowed_extensions,no_such_limit", "--json"]);
    const data = one.json<{ groups: Array<{ limits: LimitEntry[] }>; tenant_quotas: unknown; warnings?: string[] }>();
    expect(data.groups.flatMap((g) => g.limits).map((l) => l.key)).toEqual(["kb_upload_allowed_extensions"]);
    expect(data.tenant_quotas).toBeNull();
    expect(one.stderr).toMatch(/lists no limit no_such_limit/);
    const licence = await cli(sb, ["limits", "--source", "licence"]);
    expect(licence.stdout).toMatch(/No published limit matches/);
  });

  it("shows the limits it read when only the quota use cannot be read (exit 0)", async () => {
    server.state.failures = [{ method: "GET", path: /\/quota-usage$/, status: 500 }];
    const result = await cli(sb, ["limits", "--json"]);
    expect(result.code, result.stdout).toBe(0);
    const data = result.json<{ groups: unknown[]; tenant_quotas: { items: unknown[]; unavailable: string } }>();
    expect(data.groups.length).toBeGreaterThan(0);
    expect(data.tenant_quotas.items).toEqual([]);
    expect(data.tenant_quotas.unavailable).toMatch(/quota-usage/);
    const text = await cli(sb, ["limits"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/not readable: .*quota-usage/);
  });

  it("on an instance without limits, says so and assumes none", async () => {
    server.state.capsPatch = { limits: undefined };
    const result = await cli(sb, ["limits", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json()).toMatchObject({ published: false, groups: [], tenant_quotas: null, quota_values: [], near: [] });
    expect(result.stderr).toMatch(/does not publish its limits/);
    expect(server.state.requests.some((r) => r.path.endsWith("/quota-usage"))).toBe(false);
    // The same keys as a current instance's answer, so a caller reads both alike.
    server.state.capsPatch = {};
    const current = await cli(sb, ["limits", "--json"]);
    const keys = (data: Record<string, unknown>) => Object.keys(data).filter((k) => k !== "warnings").sort();
    expect(keys(result.json())).toEqual(keys(current.json()));
  });
});

describe("cavelon status", () => {
  it("mentions the quotas that are close to their limit", async () => {
    server.state.quotaUsage = { ...defaultQuotaUsage(), tools: { current: 48, limit: 50 } };
    const result = await cli(sb, ["status"]);
    expect(result.stdout).toMatch(/limits:\s+close to a quota: tools 48 of 50 \(96%\)/);
    const json = (await cli(sb, ["status", "--json"])).json<{ limits: { near: Array<{ key: string }> } }>();
    expect(json.limits.near.map((q) => q.key)).toEqual(["tools"]);

    server.state.quotaUsage = defaultQuotaUsage();
    expect((await cli(sb, ["status"])).stdout).toMatch(/limits:\s+none close to a quota/);
  });

  it("says when the instance publishes no limits", async () => {
    server.state.capsPatch = { limits: undefined };
    const result = await cli(sb, ["status", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json<{ limits: unknown }>().limits).toEqual({ published: false });
  });
});

describe("kb upload checks the published upload limits before sending", () => {
  function folder(name: string, files: Record<string, number | string>): string {
    const dir = path.join(sb.home, name);
    mkdirSync(dir, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      writeFileSync(path.join(dir, file), typeof content === "number" ? Buffer.alloc(content, 1) : content);
    }
    return dir;
  }

  it("refuses a file larger than the limit, naming the limit, its source and who changes it", async () => {
    server.state.capsPatch = { limits: limitsWith(override("kb_upload_max_file_size_mb", { value: 1, source: "tenant" })) };
    const dir = folder("big", { "small.md": "# ok", "large.pdf": 1024 * 1024 + 1 });
    const result = await cli(sb, ["kb", "upload", dir, "--kb", "FAQ", "--json"]);
    expect(result.code).toBe(3);
    const error = result.json<{ error: { code: string; message: string; hint: string; docs: string; details: Record<string, any> } }>().error;
    expect(error.code).toBe("upload_file_too_large");
    expect(error.message).toMatch(/1 of 2 files .* nothing was sent: .*large\.pdf \(1\.0 MB\) is larger than 1 MB \(kb_upload_max_file_size_mb, source tenant; a tenant admin changes upload_defaults\.max_file_size_mb\)/);
    expect(error.hint).toMatch(/cavelon docs get reference\/limits-and-quotas/);
    expect(error.docs).toBe("/docs/reference/limits-and-quotas#upload-and-storage-quotas");
    expect(error.details.refused).toEqual([expect.objectContaining({ file: path.join("big", "large.pdf"), reason: "too_large" })]);
    expect(error.details.limits[0]).toMatchObject({ key: "kb_upload_max_file_size_mb", value: 1, source: "tenant", changeable_by: "tenant_admin" });
    expect(error.details.sent).toBe(false);
    // Nothing went to the instance: not the upload, not even the knowledge-base lookup.
    expect(uploads()).toHaveLength(0);
    expect(server.state.requests.some((r) => r.path === "/api/v1/knowledge-bases")).toBe(false);
  });

  it("refuses a file type the tenant does not accept, also in a dry run", async () => {
    const dir = folder("types", { "a.md": "# a", "tool.exe": "MZ", README: "plain" });
    const dry = await cli(sb, ["kb", "upload", dir, "--kb", "FAQ", "--dry-run", "--json"]);
    expect(dry.code).toBe(3);
    const error = dry.json<{ error: { code: string; message: string; details: Record<string, any> } }>().error;
    expect(error.code).toBe("upload_file_type_unsupported");
    expect(error.message).toMatch(/README \(no extension\), .*tool\.exe \(\.exe\) have types this tenant does not accept \(kb_upload_allowed_extensions, source platform; a tenant admin changes upload_defaults\.allowed_extensions\)/);
    expect(error.details.refused.map((r: { file: string }) => path.basename(r.file)).sort()).toEqual(["README", "tool.exe"]);

    const result = await cli(sb, ["kb", "upload", dir, "--kb", "FAQ", "--json"]);
    expect(result.code).toBe(3);
    expect(uploads()).toHaveLength(0);
  });

  it("sends files within the limits", async () => {
    const dir = folder("fine", { "a.md": "# a", "b.PDF": "%PDF" });
    const result = await cli(sb, ["kb", "upload", dir, "--kb", KB, "--json"]);
    expect(result.code, result.stdout).toBe(0);
    expect(uploads()).toHaveLength(1);
  });

  it("on an instance without limits, sends as before and lets the instance answer", async () => {
    server.state.capsPatch = { limits: undefined };
    const dir = folder("old", { "tool.exe": "MZ" });
    const result = await cli(sb, ["kb", "upload", dir, "--kb", KB, "--json"]);
    expect(result.code, result.stdout).toBe(0);
    expect(uploads()).toHaveLength(1);
  });

  it("checks only the limits the instance publishes", async () => {
    server.state.capsPatch = { limits: limitsWith((values) => values.filter((v) => v.key !== "kb_upload_allowed_extensions")) };
    const dir = folder("partial", { "tool.exe": "MZ" });
    const result = await cli(sb, ["kb", "upload", dir, "--kb", KB, "--json"]);
    expect(result.code, result.stdout).toBe(0);
    expect(uploads()).toHaveLength(1);
  });
});

describe("kb upload checks a zip archive against the published archive rules", () => {
  const ARCHIVE_DOCS = "/docs/reference/limits-and-quotas#archive-uploads";
  const archiveEntry = (key: string, value: number | string[], unit: string, field: string): LimitEntry => ({
    key,
    value,
    unit,
    source: "tenant",
    changeable_by: "tenant_admin",
    setting: `upload_defaults.archive_uploads.${field}`,
    docs: ARCHIVE_DOCS,
    scope: "tenant",
    description: key,
  });
  /**
   * The entries an older instance publishes while archive uploads are on:
   * no switch of its own,
   * the formats under the boolean field, and no `binds_when`.
   */
  const archivesOn = (caps: { entries?: number; mb?: number; ratio?: number } = {}) =>
    limitsWith((values) => [
      ...values.filter((v) => !v.key.startsWith("kb_upload_archive_")),
      archiveEntry("kb_upload_archive_formats", ["zip"], "file_extensions", "enabled"),
      archiveEntry("kb_upload_archive_max_entries", caps.entries ?? 500, "count", "max_entries"),
      archiveEntry("kb_upload_archive_max_total_uncompressed_mb", caps.mb ?? 100, "megabytes", "max_total_uncompressed_mb"),
      archiveEntry("kb_upload_archive_max_compression_ratio", caps.ratio ?? 100, "count", "max_compression_ratio"),
    ]);

  let n = 0;
  function zipFolder(entries: ZipEntry[], options: { zip64?: boolean } = {}): string {
    const dir = path.join(sb.home, `zips-${++n}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "bundle.zip"), buildZip(entries, options));
    return dir;
  }
  const docs = (count: number): ZipEntry[] => Array.from({ length: count }, (_, i) => ({ name: `docs/page-${i}.md`, content: `# Page ${i}\n\nSome text of page ${i}.\n` }));
  const refusal = (result: Awaited<ReturnType<typeof cli>>) =>
    result.json<{ error: { code: string; message: string; hint: string; docs: string; details: Record<string, any> } }>().error;

  it("refuses a zip while the tenant has archive uploads off, as the snapshot's default instance does", async () => {
    const dir = zipFolder(docs(2));
    const result = await cli(sb, ["kb", "upload", dir, "--kb", KB, "--json"]);
    expect(result.code).toBe(3);
    const error = refusal(result);
    expect(error.code).toBe("archive_uploads_disabled");
    expect(error.message).toMatch(/bundle\.zip is a zip archive, and this tenant has archive uploads turned off \(kb_upload_archive_enabled, source platform; a tenant admin changes upload_defaults\.archive_uploads\.enabled\)/);
    expect(error.hint).toMatch(/A tenant admin turns archive uploads on with cavelon limits set kb_upload_archive_enabled true \(shows the change; --confirm sends it\)\./);
    expect(error.docs).toBe(ARCHIVE_DOCS);
    expect(error.details).toMatchObject({ sent: false, refused: [{ reason: "archive_not_expanded" }], limits: [{ key: "kb_upload_archive_enabled", value: false }] });
    expect(uploads()).toHaveLength(0);
  });

  /** The snapshot's archive entries with the switch, the formats and the caps set. */
  const archives4370 = (state: { enabled: boolean; formats: string[]; entries?: number; gate?: string }) =>
    limitsWith((values) =>
      values.map((v) => {
        if (v.key === "kb_upload_archive_enabled") return { ...v, value: state.enabled, source: "tenant" };
        if (v.key === "kb_upload_archive_formats") return { ...v, value: state.formats };
        if (v.key === "kb_upload_archive_max_entries") return { ...v, value: state.entries ?? 50, ...(state.gate ? { binds_when: state.gate } : {}) };
        return v;
      }),
    );

  it("refuses a zip while the switch is off, though the formats list zip", async () => {
    server.state.capsPatch = { limits: archives4370({ enabled: false, formats: ["zip"] }) };
    const error = refusal(await cli(sb, ["kb", "upload", zipFolder(docs(2)), "--kb", KB, "--json"]));
    expect(error.code).toBe("archive_uploads_disabled");
    expect(error.message).toMatch(/this tenant has archive uploads turned off \(kb_upload_archive_enabled, source tenant;/);
    expect(error.details.limits).toEqual([expect.objectContaining({ key: "kb_upload_archive_enabled", value: false })]);
    expect(uploads()).toHaveLength(0);
  });

  it("with the switch on, checks the formats and the caps", async () => {
    server.state.capsPatch = { limits: archives4370({ enabled: true, formats: ["zip"] }) };
    expect((await cli(sb, ["kb", "upload", zipFolder(docs(3)), "--kb", KB, "--json"])).code).toBe(0);
    expect(uploads()).toHaveLength(1);

    server.state.capsPatch = { limits: archives4370({ enabled: true, formats: ["zip"], entries: 2 }) };
    const capped = refusal(await cli(sb, ["kb", "upload", zipFolder(docs(3)), "--kb", KB, "--json"]));
    expect(capped.code).toBe("archive_entry_limit_exceeded");
    expect(capped.hint).toMatch(/kb_upload_archive_max_entries is 2 .* It applies while archive uploads are on \(kb_upload_archive_enabled\)\./);
    expect(capped.details.limits).toEqual([expect.objectContaining({ key: "kb_upload_archive_max_entries", binds_when: "kb_upload_archive_enabled" })]);

    server.state.capsPatch = { limits: archives4370({ enabled: true, formats: ["tar"] }) };
    const format = refusal(await cli(sb, ["kb", "upload", zipFolder(docs(1)), "--kb", KB, "--json"]));
    expect(format.code).toBe("archive_format_disabled");
    expect(format.message).toMatch(/this tenant expands only tar \(kb_upload_archive_formats, source platform; the instance operator changes upload_defaults\.archive_uploads\.formats\)/);
    expect(uploads()).toHaveLength(1);
  });

  it("does not check a cap whose binds_when entry is off", async () => {
    // A cap that binds under another switch, published off: the zip goes to the instance.
    const gate: LimitEntry = { key: "kb_upload_archive_caps_enforced", value: false, unit: "boolean", source: "platform", changeable_by: "operator", setting: "X", docs: ARCHIVE_DOCS, scope: "tenant", description: "" };
    const gated = archives4370({ enabled: true, formats: ["zip"], entries: 1, gate: gate.key });
    server.state.capsPatch = { limits: { ...gated, values: [...(gated.values as LimitEntry[]), gate] } };
    expect((await cli(sb, ["kb", "upload", zipFolder(docs(3)), "--kb", KB, "--json"])).code).toBe(0);
    expect(uploads()).toHaveLength(1);
    // The same cap under a switch that is on binds.
    server.state.capsPatch = { limits: archives4370({ enabled: true, formats: ["zip"], entries: 1, gate: "kb_upload_archive_enabled" }) };
    expect(refusal(await cli(sb, ["kb", "upload", zipFolder(docs(3)), "--kb", KB, "--json"])).code).toBe("archive_entry_limit_exceeded");
  });

  it("an older instance: an empty list of formats says archives are off", async () => {
    server.state.capsPatch = {
      limits: limitsWith((values) => [
        ...values.filter((v) => !v.key.startsWith("kb_upload_archive_")),
        { ...archiveEntry("kb_upload_archive_formats", [], "file_extensions", "enabled"), source: "platform" },
      ]),
    };
    const error = refusal(await cli(sb, ["kb", "upload", zipFolder(docs(2)), "--kb", KB, "--json"]));
    expect(error.code).toBe("archive_uploads_disabled");
    expect(error.message).toMatch(/has archive uploads turned off \(kb_upload_archive_formats, source platform; a tenant admin changes upload_defaults\.archive_uploads\.enabled\)/);
    expect(error.hint).not.toMatch(/limits set kb_upload_archive_enabled/);
  });

  it("sends a zip within the caps when the tenant expands zip archives", async () => {
    server.state.capsPatch = { limits: archivesOn() };
    const dir = zipFolder([{ name: "docs/" }, ...docs(3)]);
    const dry = await cli(sb, ["kb", "upload", dir, "--kb", KB, "--dry-run", "--json"]);
    expect(dry.code, dry.stdout).toBe(0);
    const result = await cli(sb, ["kb", "upload", dir, "--kb", KB, "--json"]);
    expect(result.code, result.stdout).toBe(0);
    expect(uploads()).toHaveLength(1);
  });

  it("refuses a zip with more files than kb_upload_archive_max_entries; directories do not count", async () => {
    server.state.capsPatch = { limits: archivesOn({ entries: 3 }) };
    const fits = zipFolder([{ name: "docs/" }, { name: "docs/more/" }, ...docs(3)]);
    expect((await cli(sb, ["kb", "upload", fits, "--kb", KB, "--dry-run", "--json"])).code).toBe(0);
    const dir = zipFolder(docs(4));
    const result = await cli(sb, ["kb", "upload", dir, "--kb", KB, "--dry-run", "--json"]);
    expect(result.code).toBe(3);
    const error = refusal(result);
    expect(error.code).toBe("archive_entry_limit_exceeded");
    expect(error.message).toMatch(/bundle\.zip \(4 files\) holds more files than 3 \(kb_upload_archive_max_entries, source tenant; a tenant admin changes upload_defaults\.archive_uploads\.max_entries\)/);
    expect(error.details.refused[0]).toMatchObject({ reason: "archive_too_many_files", archive: { files: 4 } });
    expect(uploads()).toHaveLength(0);
  });

  it("refuses a zip whose files unpack to more than kb_upload_archive_max_total_uncompressed_mb", async () => {
    server.state.capsPatch = { limits: archivesOn({ mb: 1, ratio: 100_000 }) };
    // Two files of 600 KiB each: small packed, 1.2 MB unpacked.
    const dir = zipFolder([
      { name: "a.txt", content: Buffer.alloc(600 * 1024, "a") },
      { name: "b.txt", content: Buffer.alloc(600 * 1024, "b") },
    ]);
    const result = await cli(sb, ["kb", "upload", dir, "--kb", KB, "--json"]);
    expect(result.code).toBe(3);
    const error = refusal(result);
    expect(error.code).toBe("archive_uncompressed_size_exceeded");
    expect(error.message).toMatch(/bundle\.zip \(1\.2 MB unpacked\) unpacks to more than 1 MB \(kb_upload_archive_max_total_uncompressed_mb/);
    expect(error.details.refused[0].archive.unpacked_bytes).toBe(1_228_800);
    expect(uploads()).toHaveLength(0);
  });

  it("refuses a zip with a file compressed more than kb_upload_archive_max_compression_ratio", async () => {
    server.state.capsPatch = { limits: archivesOn({ ratio: 50 }) };
    const dir = zipFolder([{ name: "plain.md", content: "# plain", deflate: false }, { name: "zeros.txt", content: Buffer.alloc(200 * 1024) }]);
    const result = await cli(sb, ["kb", "upload", dir, "--kb", KB, "--json"]);
    expect(result.code).toBe(3);
    const error = refusal(result);
    expect(error.code).toBe("archive_compression_ratio_exceeded");
    expect(error.message).toMatch(/bundle\.zip \(zeros\.txt at \d+(\.\d)?:1\) compresses a file more than 50:1/);
    expect(error.details.refused[0].archive).toMatchObject({ files: 2, max_ratio_entry: "zeros.txt" });
    expect(uploads()).toHaveLength(0);
  });

  it("reads a zip64 archive's directory", async () => {
    server.state.capsPatch = { limits: archivesOn({ entries: 2 }) };
    const dir = zipFolder(docs(3), { zip64: true });
    const result = await cli(sb, ["kb", "upload", dir, "--kb", KB, "--dry-run", "--json"]);
    expect(refusal(result)).toMatchObject({ code: "archive_entry_limit_exceeded", details: { refused: [{ archive: { files: 3 } }] } });
  });

  it("refuses a file named .zip that is no zip archive", async () => {
    server.state.capsPatch = { limits: archivesOn() };
    const dir = path.join(sb.home, "fake-zip");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "bundle.zip"), "PK not really");
    const result = await cli(sb, ["kb", "upload", dir, "--kb", KB, "--json"]);
    expect(result.code).toBe(3);
    expect(refusal(result)).toMatchObject({ code: "archive_magic_invalid", message: expect.stringMatching(/bundle\.zip is not a zip archive, though named \.zip/) });
    expect(uploads()).toHaveLength(0);
  });

  it("names every refused file with its own reason; the first reason gives the code", async () => {
    server.state.capsPatch = { limits: archivesOn({ entries: 1 }) };
    const dir = zipFolder(docs(2));
    writeFileSync(path.join(dir, "tool.exe"), "MZ");
    const error = refusal(await cli(sb, ["kb", "upload", dir, "--kb", KB, "--json"]));
    expect(error.code).toBe("upload_file_type_unsupported");
    expect(error.message).toMatch(/2 of 2 files .*tool\.exe \(\.exe\) has a type .*; .*bundle\.zip \(2 files\) holds more files than 1/);
    expect(error.details.limits.map((l: { key: string }) => l.key)).toEqual(["kb_upload_allowed_extensions", "kb_upload_archive_max_entries"]);
  });

  it("on an instance that publishes no archive rules, sends the zip and lets the instance decide", async () => {
    server.state.capsPatch = { limits: limitsWith((values) => values.filter((v) => !v.key.startsWith("kb_upload_archive_"))) };
    const dir = zipFolder(docs(2));
    writeFileSync(path.join(dir, "notes.zip"), "PK not really");
    const result = await cli(sb, ["kb", "upload", dir, "--kb", KB, "--json"]);
    expect(result.code, result.stdout).toBe(0);
    expect(uploads()).toHaveLength(1);
    expect(result.json<{ documents: unknown[] }>().documents).toHaveLength(2);
  });

  it("still checks a zip's own size against kb_upload_max_file_size_mb", async () => {
    server.state.capsPatch = { limits: limitsWith(override("kb_upload_max_file_size_mb", { value: 0.001 })) };
    const dir = zipFolder(docs(40));
    expect(refusal(await cli(sb, ["kb", "upload", dir, "--kb", KB, "--json"])).code).toBe("upload_file_too_large");
  });
});

describe("harness new checks the licence and the quota before creating", () => {
  const harness = (slug: string, status = "draft") => ({ id: randomUUID(), tenant_id: tenant, slug, name: slug, status });

  it("refuses when this tenant alone reaches licence_max_harnesses", async () => {
    server.state.capsPatch = { limits: limitsWith((values) => [...values, LICENCE]) };
    server.state.harnesses.push(harness("one"), harness("two", "active"), harness("old", "archived"));
    const result = await cli(sb, ["harness", "new", "three", "--json"]);
    expect(result.code).toBe(7);
    const error = result.json<{ error: { code: string; message: string; hint: string; details: Record<string, any> } }>().error;
    expect(error.code).toBe("license_limit_reached");
    expect(error.message).toMatch(/allows 2 solutions .* this tenant alone has 2/);
    expect(error.hint).toMatch(/licence_max_harnesses is 2 \(source: licence\); the operator \(licence\) changes it with entitlements\.max_harnesses/);
    expect(error.details).toMatchObject({ active_in_tenant: 2, sent: false, limits: [expect.objectContaining({ source: "licence", scope: "instance" })] });
    expect(creates()).toHaveLength(0);
  });

  it("sends when the tenant is below the licence cap, and when the slug exists (a replay or a conflict)", async () => {
    server.state.capsPatch = { limits: limitsWith((values) => [...values, LICENCE]) };
    server.state.harnesses.push(harness("one"), harness("old", "archived"));
    const below = await cli(sb, ["harness", "new", "two", "--json"]);
    expect(below.code, below.stdout).toBe(0);
    const existing = await cli(sb, ["harness", "new", "two", "--json"]);
    expect(existing.code).toBe(4); // the instance's own 409
    expect(creates()).toHaveLength(2);
  });

  it("refuses when the tenant's quotas list a solution quota that is used up", async () => {
    server.state.quotaUsage = { ...defaultQuotaUsage(), harnesses: { current: 3, limit: 3 } };
    const result = await cli(sb, ["harness", "new", "four", "--json"]);
    expect(result.code).toBe(3);
    const error = result.json<{ error: { code: string; message: string; details: Record<string, any> } }>().error;
    expect(error.code).toBe("tenant_quota_reached");
    expect(error.message).toMatch(/3 of 3 \(100%\) of its solution quota/);
    expect(error.details.quota).toMatchObject({ key: "harnesses", current: 3, limit: 3, path: "/api/v1/tenants/current/quota-usage" });
    expect(creates()).toHaveLength(0);
  });

  it("assumes no cap the instance does not publish", async () => {
    // The snapshot has no licence entry and no solution quota: no extra reads, straight to the create.
    const plain = await cli(sb, ["harness", "new", "five", "--json"]);
    expect(plain.code, plain.stdout).toBe(0);
    expect(server.state.requests.some((r) => r.method === "GET" && r.path === "/api/v1/harnesses")).toBe(false);

    server.state.capsPatch = { limits: undefined };
    server.state.quotaUsage = { ...defaultQuotaUsage(), harnesses: { current: 9, limit: 3 } };
    server.state.requests.length = 0;
    const old = await cli(sb, ["harness", "new", "six", "--json"]);
    expect(old.code, old.stdout).toBe(0);
    expect(server.state.requests.some((r) => r.path.endsWith("/quota-usage"))).toBe(false);
    expect(creates()).toHaveLength(1);
  });
});
