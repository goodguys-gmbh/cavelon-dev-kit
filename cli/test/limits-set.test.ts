import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CONTRACTS, defaultQuotaUsage, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type CliResult, type Sandbox } from "./helpers.js";

/**
 * `cavelon limits set`: a limit a tenant admin
 * may change is changed through the operation its published `change` names,
 * after showing the old and new value, and only with --confirm. The
 * Processing Step cap is a Tenant Owner's; an operator changes the run
 * caps in Platform mode; a credential's published permissions refuse a
 * change before it is sent. An environment or licence limit, a value
 * out of bounds, an instance that does not publish `change`, and a credential
 * without the permission or role are refused before anything is sent.
 */

type LimitEntry = Record<string, unknown> & { key: string };
interface ErrorBody {
  error: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
}

let server: FakeServer;
let sb: Sandbox;
let tenant: string;
let token: string;

/** The snapshot's `limits`, with its entries edited. */
function limitsWith(edit: (values: LimitEntry[]) => LimitEntry[]): Record<string, unknown> {
  const caps = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-capabilities.json"), "utf8")) as { limits: { values: LimitEntry[] } };
  return { ...caps.limits, values: edit(caps.limits.values) };
}

const patches = () => server.state.requests.filter((r) => r.method === "PATCH");
const errorOf = (result: CliResult) => result.json<ErrorBody>().error;

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  sb = sandbox();
  token = server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant });
  await login(sb, server.url, token);
});
afterEach(() => {
  server.state.capsPatch = {};
  server.state.tenantLimits.clear();
  server.state.inferenceBudgets.clear();
  server.state.requests.length = 0;
  server.state.servePrincipal = true;
  server.state.servePermissions = true;
  server.state.quotaUsage = defaultQuotaUsage();
  server.state.processingStepCaps.clear();
  server.state.processingStepsUsed = 0;
  server.state.runCapacity = {};
  server.state.tenantRunCaps.clear();
  server.state.tenantFlags.clear();
  server.state.processingStepTerms.clear();
  server.state.catalogWithout = [];
  server.state.enforcedCeilings = {};
});
afterAll(async () => {
  sb.cleanup();
  await server.close();
});

describe("limits set without --confirm", () => {
  it("shows the old and new value, the operation and who may run it, and sends nothing", async () => {
    const result = await cli(sb, ["limits", "set", "kb_upload_max_file_size_mb", "50"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      "kb_upload_max_file_size_mb: 25 MB → 50 MB (source now: platform).\n" +
        'Sends: PATCH /api/v1/tenants/current/upload-defaults {"max_file_size_mb":50}\n' +
        "Allowed: a credential with settings.uploads.manage or settings.manage (a session, a personal access token, or an admin API key of the tenant).\n" +
        "Nothing was changed. Change it with: cavelon limits set kb_upload_max_file_size_mb 50 --confirm\n",
    );
    expect(patches()).toEqual([]);

    const json = (await cli(sb, ["limits", "set", "kb_upload_max_file_size_mb", "50MB", "--json"])).json();
    expect(json).toMatchObject({
      key: "kb_upload_max_file_size_mb",
      kind: "limit",
      previous: 25,
      value: 50,
      operation: {
        operation: "update_upload_defaults_api_v1_tenants_current_upload_defaults_patch",
        method: "PATCH",
        path: "/api/v1/tenants/current/upload-defaults",
        field: "max_file_size_mb",
        body: { max_file_size_mb: 50 },
      },
      permissions: ["settings.uploads.manage", "settings.manage"],
      changed: false,
      sent: false,
      confirm: "cavelon limits set kb_upload_max_file_size_mb 50 --confirm",
    });
    expect(patches()).toEqual([]);
  });

  it("checks the unit offline: a suffix must be the limit's own", async () => {
    const wrong = await cli(sb, ["limits", "set", "kb_upload_max_file_size_mb", "50GB", "--confirm"]);
    expect(wrong.code).toBe(2);
    expect(wrong.stderr).toMatch(/kb_upload_max_file_size_mb is in megabytes; "50GB" is not/);
    const word = await cli(sb, ["limits", "set", "agent_max_turns", "many", "--confirm"]);
    expect(word.code).toBe(2);
    expect(word.stderr).toMatch(/agent_max_turns takes a whole number, or none to clear it; got "many"/);
    const flag = await cli(sb, ["limits", "set", "kb_upload_archive_enabled", "maybe", "--confirm"]);
    expect(flag.code).toBe(2);
    expect(flag.stderr).toMatch(/switched on or off \(archive_uploads\.enabled\): give true or false/);
    expect(patches()).toEqual([]);
  });
});

describe("docs/limits.md", () => {
  /** The exit code the table of refusals gives for a code. */
  function documentedExit(code: string): number | undefined {
    const doc = readFileSync(path.resolve(__dirname, "../../docs/limits.md"), "utf8");
    const row = doc.split("\n").find((line) => line.startsWith(`| \`${code}\` |`));
    return row ? Number(row.split("|")[2]!.trim()) : undefined;
  }

  it.each([
    ["a word for a number", ["agent_max_turns", "abc"], "usage"],
    ["a fraction for a whole number", ["agent_max_turns", "10.5"], "usage"],
    ["neither on nor off for a switch", ["kb_upload_archive_enabled", "maybe"], "usage"],
    ["a value out of bounds", ["agent_max_turns", "0"], "request_invalid"],
  ])("states the exit code and error code of %s", async (_what, args, code) => {
    const result = await cli(sb, ["limits", "set", ...args, "--json"]);
    expect(errorOf(result).code).toBe(code);
    expect(result.code).toBe(documentedExit(code));
    expect(patches()).toEqual([]);
  });
});

describe("limits set --confirm", () => {
  it("upload defaults: sends exactly the field and prints the new value from the answer", async () => {
    const result = await cli(sb, ["limits", "set", "kb_upload_max_file_size_mb", "50", "--confirm"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe("Changed kb_upload_max_file_size_mb: 25 MB → 50 MB (source: tenant).\n");
    expect(patches().map((r) => [r.path, r.body])).toEqual([["/api/v1/tenants/current/upload-defaults", { max_file_size_mb: 50 }]]);
    // The limits now read the tenant's own value; the same value again sends nothing.
    expect((await cli(sb, ["limits", "--key", "kb_upload_max_file_size_mb", "--json"])).json()).toMatchObject({
      groups: [{ source: "tenant", limits: [expect.objectContaining({ value: 50 })] }],
    });
    const same = await cli(sb, ["limits", "set", "kb_upload_max_file_size_mb", "50", "--confirm"]);
    expect(same.stdout).toBe("kb_upload_max_file_size_mb is already 50 MB (source: tenant); nothing to change.\n");
    expect(patches()).toHaveLength(1);
  });

  it("upload defaults: a nested field, and a list of file types", async () => {
    const cap = await cli(sb, ["limits", "set", "kb_upload_archive_max_entries", "20", "--confirm", "--json"]);
    expect(cap.code, cap.stderr).toBe(0);
    expect(cap.json()).toMatchObject({ previous: 50, value: 20, now: 20, source: "tenant", changed: true, sent: true });
    expect(patches().at(-1)!.body).toEqual({ archive_uploads: { max_entries: 20 } });

    const types = await cli(sb, ["limits", "set", "kb_upload_allowed_extensions", "pdf, .docx,pdf", "--confirm"]);
    expect(types.code, types.stderr).toBe(0);
    expect(types.stdout).toMatch(/^Changed kb_upload_allowed_extensions: .+ → pdf, docx \(source: tenant\)\.\n$/);
    expect(patches().at(-1)!.body).toEqual({ allowed_extensions: ["pdf", "docx"] });
  });

  it("agent defaults", async () => {
    const result = await cli(sb, ["limits", "set", "agent_max_turns", "40", "--confirm", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.json()).toMatchObject({ previous: 25, value: 40, now: 40, source: "tenant", changes: [{ setting: "agent_max_turns", old: null, new: 40 }] });
    expect(patches().map((r) => [r.path, r.body])).toEqual([["/api/v1/tenants/current/agent-defaults", { agent_max_turns: 40 }]]);
  });

  it("archive uploads: kb_upload_archive_enabled true|false sets a boolean", async () => {
    const preview = await cli(sb, ["limits", "set", "kb_upload_archive_enabled", "true"]);
    expect(preview.code, preview.stderr).toBe(0);
    expect(preview.stdout).toMatch(/^kb_upload_archive_enabled: off → on \(source now: platform\)\.\nSends: PATCH \/api\/v1\/tenants\/current\/upload-defaults \{"archive_uploads":\{"enabled":true\}\}\n/);
    const on = await cli(sb, ["limits", "set", "kb_upload_archive_enabled", "true", "--confirm"]);
    expect(on.code, on.stderr).toBe(0);
    expect(on.stdout).toBe("Changed kb_upload_archive_enabled: off → on (source: tenant).\n");
    expect(patches().map((r) => r.body)).toEqual([{ archive_uploads: { enabled: true } }]);
    // The operator's formats are listed now that the switch is on.
    const formats = (await cli(sb, ["limits", "--key", "kb_upload_archive_formats", "--json"])).json<{ groups: Array<{ limits: Array<{ value: unknown }> }> }>();
    expect(formats.groups[0]!.limits[0]!.value).toEqual(["zip"]);
    const again = await cli(sb, ["limits", "set", "kb_upload_archive_enabled", "on", "--confirm"]);
    expect(again.stdout).toBe("kb_upload_archive_enabled is already on (source: tenant); nothing to change.\n");
    const off = await cli(sb, ["limits", "set", "kb_upload_archive_enabled", "false", "--confirm", "--json"]);
    expect(off.json()).toMatchObject({ previous: true, value: false, now: false, changed: true });
    expect(patches().map((r) => r.body)).toEqual([{ archive_uploads: { enabled: true } }, { archive_uploads: { enabled: false } }]);
  });

  it("the per-visitor rate limits change through the generic change", async () => {
    const chat = await cli(sb, ["limits", "set", "rate_limit_chat_visitor_rpm", "30", "--confirm"]);
    expect(chat.code, chat.stderr).toBe(0);
    expect(chat.stdout).toBe("Changed rate_limit_chat_visitor_rpm: 60 requests/min → 30 requests/min (source: tenant).\n");
    const widget = await cli(sb, ["limits", "set", "rate_limit_widget_visitor_rpm", "10rpm", "--confirm", "--json"]);
    expect(widget.code, widget.stderr).toBe(0);
    expect(widget.json()).toMatchObject({ previous: 20, value: 10, now: 10, source: "tenant", operation: { field: "widget_per_visitor" } });
    expect(patches().map((r) => [r.path, r.body])).toEqual([
      ["/api/v1/tenants/current/rate-limits", { chat_per_visitor: 30 }],
      ["/api/v1/tenants/current/rate-limits", { widget_per_visitor: 10 }],
    ]);
  });

  it("an instance that enforces a lower ceiling than it published: its limit_above_platform_ceiling names the setting and that only an operator raises it", async () => {
    server.state.enforcedCeilings = { widget_per_visitor: 10 };
    const result = await cli(sb, ["limits", "set", "rate_limit_widget_visitor_rpm", "15", "--confirm", "--json"]);
    expect(result.code).toBe(3);
    const error = errorOf(result);
    expect(error.code).toBe("limit_above_platform_ceiling");
    expect(error.message).toMatch(/rate_limits\.widget_per_visitor may only lower the platform ceiling of 10 requests per minute; an operator raises RATE_LIMIT_WIDGET_VISITOR_RPM \(rate_limit_widget_visitor_rpm was not changed\.\)$/);
    expect(error.hint).toBe("rate_limits.widget_per_visitor may only be lowered: send at most 10. Only the instance operator raises the ceiling, with RATE_LIMIT_WIDGET_VISITOR_RPM; ask them.");
    expect(error.details).toEqual({
      key: "rate_limit_widget_visitor_rpm",
      setting: "rate_limits.widget_per_visitor",
      value: 15,
      maximum: 10,
      maximum_setting: "RATE_LIMIT_WIDGET_VISITOR_RPM",
      changed: false,
    });
    expect(result.stderr + result.stdout).not.toContain(token);
  });

  it("rate limits: lowers one, and none clears the tenant's own value", async () => {
    const lowered = await cli(sb, ["limits", "set", "rate_limit_chat_rpm", "100rpm", "--confirm"]);
    expect(lowered.code, lowered.stderr).toBe(0);
    expect(lowered.stdout).toBe("Changed rate_limit_chat_rpm: 200 requests/min → 100 requests/min (source: tenant).\n");
    const cleared = await cli(sb, ["limits", "set", "rate_limit_chat_rpm", "none", "--confirm"]);
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(cleared.stdout).toBe("Changed rate_limit_chat_rpm: 100 requests/min → 200 requests/min (source: platform).\n");
    expect(patches().map((r) => [r.path, r.body])).toEqual([
      ["/api/v1/tenants/current/rate-limits", { chat: 100 }],
      ["/api/v1/tenants/current/rate-limits", { chat: null }],
    ]);
    // Clearing a value the tenant does not have is no change.
    const nothing = await cli(sb, ["limits", "set", "rate_limit_chat_rpm", "none", "--confirm"]);
    expect(nothing.stdout).toBe("rate_limit_chat_rpm has no value of this tenant's own to clear (source: platform); nothing to change.\n");
    expect(patches()).toHaveLength(2);
  });

  it("the inference budget, through tenant_quotas.changes, for this tenant", async () => {
    // The quota row names its change, so the preview shows the current value.
    const preview = await cli(sb, ["limits", "set", "monthly_inference_token_budget", "2000000"]);
    expect(preview.code, preview.stderr).toBe(0);
    expect(preview.stdout).toContain(`monthly_inference_token_budget: 1000000 → 2000000.\nSends: PATCH /api/v1/tenants/{tenant_id}/limits {"monthly_inference_token_budget":2000000}`);
    expect(preview.stdout).toContain("Allowed: a credential with limits.inference_budget.manage or limits.manage");
    expect(patches()).toEqual([]);

    const result = await cli(sb, ["limits", "set", "monthly_inference_token_budget", "2000000", "--confirm", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.json()).toMatchObject({ kind: "quota", value: 2_000_000, now: 2_000_000, changed: true, sent: true });
    expect(patches().map((r) => [r.path, r.body])).toEqual([[`/api/v1/tenants/${tenant}/limits`, { monthly_inference_token_budget: 2_000_000 }]]);
    expect(server.state.inferenceBudgets.get(tenant)).toBe(2_000_000);

    const none = await cli(sb, ["limits", "set", "monthly_inference_token_budget", "none"]);
    expect(none.code).toBe(2);
    expect(none.stderr).toMatch(/takes a whole number; it has no value of the tenant's own to clear/);

    // An older instance's quota row names no change: the current value is not published.
    const usage = defaultQuotaUsage();
    delete (usage.monthly_inference_tokens as Record<string, unknown>).change;
    server.state.quotaUsage = usage;
    const older = await cli(sb, ["limits", "set", "monthly_inference_token_budget", "3000000"]);
    expect(older.stdout).toMatch(/^monthly_inference_token_budget: not published → 3000000\.\n/);
  });
});

describe("a tenant on Processing-Step terms", () => {
  it("is not offered the inference budget: the instance publishes no change for it, so limits set refuses before sending", async () => {
    server.state.processingStepTerms.add(tenant);
    const result = await cli(sb, ["limits", "set", "monthly_inference_token_budget", "2000000", "--confirm", "--json"]);
    expect(result.code).toBe(1);
    const error = errorOf(result);
    expect(error.code).toBe("limit_not_found");
    expect(error.details).toMatchObject({ sent: false });
    expect((error.details as { changeable: string[] }).changeable).not.toContain("monthly_inference_token_budget");
    expect((error.details as { changeable: string[] }).changeable).toContain("monthly_processing_step_cap");
    expect(patches()).toEqual([]);
    // The Processing Step cap stays the Tenant Owner's to change.
    const cap = await cli(sb, ["limits", "set", "monthly_processing_step_cap", "40000", "--confirm"]);
    expect(cap.code, cap.stderr).toBe(0);
    expect(patches().map((r) => r.path)).toEqual(["/api/v1/tenants/current/processing-step-cap"]);
  });
});

describe("the monthly Processing Step cap", () => {
  it("a Tenant Owner sets it, and none clears it", async () => {
    const preview = await cli(sb, ["limits", "set", "monthly_processing_step_cap", "40000"]);
    expect(preview.code, preview.stderr).toBe(0);
    expect(preview.stdout).toBe(
      "monthly_processing_step_cap: none (no cap) → 40000.\n" +
        'Sends: PATCH /api/v1/tenants/current/processing-step-cap {"monthly_processing_step_cap":40000}\n' +
        "Allowed: a credential with settings.manage (a session, a personal access token, or an admin API key of the tenant).\n" +
        "Nothing was changed. Change it with: cavelon limits set monthly_processing_step_cap 40000 --confirm\n",
    );
    expect(patches()).toEqual([]);

    const set = await cli(sb, ["limits", "set", "monthly_processing_step_cap", "40000", "--confirm", "--json"]);
    expect(set.code, set.stderr).toBe(0);
    expect(set.json()).toMatchObject({ kind: "quota", previous: null, value: 40000, now: 40000, changed: true, sent: true });
    expect(patches().map((r) => [r.path, r.body])).toEqual([["/api/v1/tenants/current/processing-step-cap", { monthly_processing_step_cap: 40000 }]]);
    // `cavelon limits` shows the cap with this month's use.
    server.state.processingStepsUsed = 36000;
    const shown = await cli(sb, ["limits"]);
    expect(shown.stdout).toMatch(/monthly_processing_step_cap\s+36000 of 40000 \(90%\) in 2026-10\s+ok\s+close to the cap/);
    expect(shown.stdout).toContain("Close to a quota: monthly_processing_step_cap 36000 of 40000 (90%), resets 2026-11-01T00:00:00+00:00");

    const cleared = await cli(sb, ["limits", "set", "monthly_processing_step_cap", "none", "--confirm"]);
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(cleared.stdout).toBe("Changed monthly_processing_step_cap: 40000 → none (no cap).\n");
    expect(patches().at(-1)!.body).toEqual({ monthly_processing_step_cap: null });
    expect(server.state.processingStepCaps.has(tenant)).toBe(false);
  });

  it("with no cap set, none and 0 send nothing and say it is already none", async () => {
    server.state.processingStepCaps.delete(tenant);
    for (const value of ["none", "0"]) {
      const preview = await cli(sb, ["limits", "set", "monthly_processing_step_cap", value, "--json"]);
      expect(preview.code, preview.stderr).toBe(0);
      expect(preview.json()).toMatchObject({ previous: null, changed: false, sent: false });
      const confirmed = await cli(sb, ["limits", "set", "monthly_processing_step_cap", value, "--confirm"]);
      expect(confirmed.code, confirmed.stderr).toBe(0);
      expect(confirmed.stdout).toBe("monthly_processing_step_cap is already none (no cap); nothing to change.\n");
    }
    expect(patches()).toEqual([]);
  });

  it("explain explains the refusal of new work at the cap, with the cap, its use and who raises it", async () => {
    server.state.processingStepCaps.set(tenant, 1000);
    server.state.processingStepsUsed = 1000;
    for (const code of ["processing_step_cap", "PROCESSING_STEP_CAP_REACHED", "processing_step_cap_reached"]) {
      const result = await cli(sb, ["explain", code, "--json"]);
      expect(result.code, `${code}: ${result.stderr}`).toBe(0);
      expect(result.json()).toMatchObject({ code: "PROCESSING_STEP_CAP_REACHED", kind: "api" });
    }
    const text = await cli(sb, ["explain", "processing_step_cap"]);
    expect(text.stdout).toMatch(/meaning: +The workspace has reached its monthly Processing Step cap/);
    expect(text.stdout).toMatch(
      /raise: +monthly_processing_step_cap is 1000 Processing Steps, 1000 used in 2026-10 \(state: reached\)\. It resets at 2026-11-01T00:00:00\+00:00\. A Tenant Owner raises or removes it with `cavelon limits set monthly_processing_step_cap <n\|none> --confirm`/,
    );
  });

  it("a tenant admin without settings.manage is refused before sending, naming the permission", async () => {
    const adminSb = sandbox();
    try {
      const admin = server.addToken({
        kind: "pat",
        tenantIds: [tenant],
        defaultTenant: tenant,
        tokenName: "admin-laptop",
        permissions: ["settings.uploads.manage", "settings.retention.manage", "limits.inference_budget.manage", "limits.view"],
      });
      await login(adminSb, server.url, admin);
      const result = await cli(adminSb, ["limits", "set", "monthly_processing_step_cap", "40000", "--confirm", "--json"]);
      expect(result.code).toBe(7);
      const error = errorOf(result);
      expect(error.code).toBe("forbidden");
      expect(error.message).toBe(
        'The personal access token "admin-laptop" may not change monthly_processing_step_cap: it needs settings.manage, which this credential does not hold. Nothing was sent.',
      );
      expect(error.hint).toMatch(/^A Tenant Owner with settings\.manage runs the command, or changes it in the Admin\./);
      expect(error.details).toMatchObject({ sent: false, permissions: ["settings.manage"] });
      expect(patches()).toEqual([]);
    } finally {
      adminSb.cleanup();
    }
  });
});

describe("an operator's change in Platform mode", () => {
  /** A Platform-mode token of a platform role; the limits are read for --tenant acme, the change is sent without X-Tenant-Id. */
  const operatorEnv = (fields: { globalRole?: string; ceilingRole?: string } = {}) => ({
    CAVELON_URL: server.url,
    CAVELON_TOKEN: server.addToken({ kind: "pat", tenantIds: [tenant], platform: true, tokenName: "ops", ...fields }),
  });
  const sentTo = (p: string) => server.state.requests.filter((r) => r.method !== "GET" && r.path === p);

  it("a superadmin's token changes a platform run cap, and limits shows its new origin", async () => {
    const opSb = sandbox();
    try {
      const env = operatorEnv({ globalRole: "superadmin" });
      const preview = await cli(opSb, ["limits", "set", "max_concurrent_agent_runs_global", "150", "--tenant", "acme"], { env });
      expect(preview.code, preview.stderr).toBe(0);
      expect(preview.stdout).toBe(
        "max_concurrent_agent_runs_global: 200 → 150 (source now: platform, origin: default).\n" +
          'Sends: PATCH /api/v1/platform-settings/runs/capacity {"global":150} (Platform mode, no X-Tenant-Id)\n' +
          "Allowed: a personal access token in Platform mode of a superadmin.\n" +
          "Nothing was changed. Change it with: cavelon limits set max_concurrent_agent_runs_global 150 --tenant acme --confirm\n",
      );
      expect(sentTo("/api/v1/platform-settings/runs/capacity")).toEqual([]);

      const result = await cli(opSb, ["limits", "set", "max_concurrent_agent_runs_global", "150", "--tenant", "acme", "--confirm"], { env });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("Changed max_concurrent_agent_runs_global: 200 → 150 (origin: platform_setting).\n");
      const [sent] = sentTo("/api/v1/platform-settings/runs/capacity");
      expect(sent!.body).toEqual({ global: 150 });
      expect(sent!.headers["x-tenant-id"]).toBeUndefined();
      const listed = (await cli(opSb, ["limits", "--key", "max_concurrent_agent_runs_global", "--tenant", "acme", "--json"], { env })).json<{
        groups: Array<{ limits: LimitEntry[] }>;
      }>();
      expect(listed.groups[0]!.limits[0]).toMatchObject({ value: 150, origin: "platform_setting" });

      // A decimal where the field takes a number, and null back to the baseline.
      const wait = await cli(opSb, ["limits", "set", "agent_run_slot_wait_seconds", "12.5", "--tenant", "acme", "--confirm", "--json"], { env });
      expect(wait.code, wait.stderr).toBe(0);
      expect(sentTo("/api/v1/platform-settings/runs/capacity").at(-1)!.body).toEqual({ wait_seconds: 12.5 });
      const cleared = await cli(opSb, ["limits", "set", "max_concurrent_agent_runs_global", "none", "--tenant", "acme", "--confirm"], { env });
      expect(cleared.stdout).toBe("Changed max_concurrent_agent_runs_global: 150 → 200 (origin: default).\n");
    } finally {
      opSb.cleanup();
    }
  });

  it("a platform admin's token sets one tenant's own run cap with --tenant, through tenant_change", async () => {
    const opSb = sandbox();
    try {
      const env = operatorEnv({ globalRole: "platform_admin" });
      const preview = await cli(opSb, ["limits", "set", "max_concurrent_agent_runs_per_tenant", "6", "--tenant", "acme", "--json"], { env });
      expect(preview.code, preview.stderr).toBe(0);
      expect(preview.json()).toMatchObject({
        scope: "one_tenant",
        previous: null,
        value: 6,
        requires_role: ["platform_admin", "superadmin"],
        operation: { path: "/api/v1/tenants/{tenant_id}/limits", params: { tenant_id: tenant }, mode: "platform", body: { max_concurrent_agent_runs: 6 } },
      });
      const result = await cli(opSb, ["limits", "set", "max_concurrent_agent_runs_per_tenant", "6", "--tenant", "acme", "--confirm"], { env });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("Changed max_concurrent_agent_runs_per_tenant: none (the platform's cap applies) → 6.\n");
      const [sent] = sentTo(`/api/v1/tenants/${tenant}/limits`);
      expect(sent!.body).toEqual({ max_concurrent_agent_runs: 6 });
      expect(sent!.headers["x-tenant-id"]).toBeUndefined();
      // The tenant's limits now name its own cap.
      const listed = (await cli(opSb, ["limits", "--key", "max_concurrent_agent_runs_per_tenant", "--tenant", "acme", "--json"], { env })).json<{
        groups: Array<{ source: string; limits: LimitEntry[] }>;
      }>();
      expect(listed.groups[0]).toMatchObject({ source: "tenant", limits: [expect.objectContaining({ value: 6 })] });
      // Without --tenant the same key is the platform's cap, which takes a superadmin.
      const platform = await cli(opSb, ["limits", "set", "max_concurrent_agent_runs_per_tenant", "6", "--json"], { env: { ...env, CAVELON_TENANT: tenant } });
      expect(platform.code).toBe(7);
      expect(errorOf(platform)).toMatchObject({ code: "platform_role_required", details: { requires_role: ["superadmin"], sent: false } });
    } finally {
      opSb.cleanup();
    }
  });

  it("is refused before sending without a Platform-mode token of the role, naming the role and the Admin page", async () => {
    const cases: Array<{ name: string; env: Record<string, string>; args: string[]; why: RegExp }> = [
      { name: "a tenant's token", env: { CAVELON_URL: server.url, CAVELON_TOKEN: token }, args: ["max_concurrent_agent_runs_global", "150"], why: /does not work in Platform mode/ },
      { name: "a platform admin for a superadmin's cap", env: operatorEnv({ globalRole: "platform_admin" }), args: ["max_concurrent_agent_runs_global", "150", "--tenant", "acme"], why: /has the ceiling role platform_admin/ },
      {
        name: "a superadmin's token with a lower ceiling",
        env: operatorEnv({ globalRole: "superadmin", ceilingRole: "platform_support" }),
        args: ["max_concurrent_agent_runs_per_tenant", "6", "--tenant", "acme"],
        why: /has the ceiling role platform_support/,
      },
      {
        name: "an API key",
        env: { CAVELON_URL: server.url, CAVELON_TOKEN: server.addToken({ kind: "key", tenantIds: [tenant], tokenName: "ci", scopes: ["admin"] }) },
        args: ["max_concurrent_agent_runs_global", "150"],
        why: /The API key "ci" is a tenant's key/,
      },
    ];
    for (const c of cases) {
      const opSb = sandbox();
      try {
        const result = await cli(opSb, ["limits", "set", ...c.args, "--confirm", "--json"], { env: c.env });
        expect(result.code, c.name).toBe(7);
        const error = errorOf(result);
        expect(error.code, c.name).toBe("platform_role_required");
        expect(error.message, c.name).toMatch(/is an operator's change: it needs a personal access token in Platform mode of a (superadmin|platform_admin or superadmin)\./);
        expect(error.message, c.name).toMatch(c.why);
        expect(error.hint, c.name).toMatch(/changes it in the Admin \((Platform › Operations › Rate limits › Run caps|the tenant's Limits section \(Concurrent Agent Runs\))\)/);
      } finally {
        opSb.cleanup();
      }
    }
    expect(server.state.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("the tenant's flag behind concurrent branches: the limit's own change, a PUT with {tenant_id} from --tenant and the flag from the published path", async () => {
    // The snapshot as the instance publishes it, unedited: the change sits on orchestration_parallel_branches.
    const opSb = sandbox();
    try {
      const env = operatorEnv({ globalRole: "platform_admin" });
      const preview = await cli(opSb, ["limits", "set", "orchestration_parallel_branches", "false", "--tenant", "acme", "--json"], { env });
      expect(preview.code, preview.stderr).toBe(0);
      expect(preview.json()).toMatchObject({
        kind: "limit",
        scope: "one_tenant",
        switch: "feature_flags.ORCHESTRATION_PARALLEL_FANOUT_ENABLED",
        previous: true,
        value: false,
        requires_role: ["platform_admin", "superadmin"],
        operation: {
          method: "PUT",
          path: "/api/v1/admin/feature-flags/{tenant_id}/ORCHESTRATION_PARALLEL_FANOUT_ENABLED",
          params: { tenant_id: tenant, flag_key: "ORCHESTRATION_PARALLEL_FANOUT_ENABLED" },
          body: { enabled: false },
          mode: "platform",
        },
        changed: false,
        sent: false,
      });
      const flagPath = `/api/v1/admin/feature-flags/${tenant}/ORCHESTRATION_PARALLEL_FANOUT_ENABLED`;
      expect(sentTo(flagPath)).toEqual([]);

      const off = await cli(opSb, ["limits", "set", "orchestration_parallel_branches", "false", "--tenant", "acme", "--confirm"], { env });
      expect(off.code, off.stderr).toBe(0);
      expect(off.stdout).toBe("Changed orchestration_parallel_branches: on → off.\n");
      expect(sentTo(flagPath).map((r) => [r.method, r.body, r.headers["x-tenant-id"]])).toEqual([["PUT", { enabled: false }, undefined]]);
      // The limits read it back: branches run in sequence, and the tenant's flag is the switch that turned them off.
      const listed = (await cli(opSb, ["limits", "--tenant", "acme", "--json"], { env })).json<{ branch_concurrency: Record<string, unknown> }>();
      expect(listed.branch_concurrency).toMatchObject({ parallel: false, off: ["feature_flags.ORCHESTRATION_PARALLEL_FANOUT_ENABLED"] });
      const again = await cli(opSb, ["limits", "set", "orchestration_parallel_branches", "off", "--tenant", "acme"], { env });
      expect(again.stdout).toBe("orchestration_parallel_branches is already off (feature_flags.ORCHESTRATION_PARALLEL_FANOUT_ENABLED); nothing to change.\n");
      expect((await cli(opSb, ["limits", "set", "orchestration_parallel_branches", "none", "--tenant", "acme"], { env })).code).toBe(2);
      const on = await cli(opSb, ["limits", "set", "orchestration_parallel_branches", "on", "--tenant", "acme", "--confirm"], { env });
      expect(on.stdout).toBe("Changed orchestration_parallel_branches: off → on.\n");

      // A tenant's token is refused before sending, naming the roles and Feature Flags.
      const tenantToken = await cli(sb, ["limits", "set", "orchestration_parallel_branches", "false", "--confirm", "--json"]);
      expect(tenantToken.code).toBe(7);
      const error = errorOf(tenantToken);
      expect(error.code).toBe("platform_role_required");
      expect(error.message).toMatch(/of a platform_admin or superadmin\./);
      expect(error.hint).toMatch(/Configure › Feature Flags/);
      expect(sentTo(flagPath)).toHaveLength(2);
    } finally {
      opSb.cleanup();
    }
  });
});

describe("limits set refuses before sending", () => {
  it("an operator's limit without a change, naming who changes it and where", async () => {
    for (const args of [["model_endpoint_slot_wait_seconds", "60"], ["webhook_max_timeout_seconds", "300", "--confirm"]]) {
      const result = await cli(sb, ["limits", "set", ...args, "--json"]);
      expect(result.code, args[0]).toBe(7);
      const error = errorOf(result);
      expect(error.code).toBe("limit_changed_by_operator");
      expect(error.details).toMatchObject({ sent: false, limit: { key: args[0], changeable_by: "operator" } });
    }
    // An environment-only limit says it cannot be changed at runtime.
    const webhook = errorOf(await cli(sb, ["limits", "set", "webhook_max_timeout_seconds", "300", "--json"]));
    expect(webhook.message).toMatch(/the instance operator sets it, with WEBHOOK_MAX_TIMEOUT_SECONDS \(source: platform\)/);
    expect(webhook.hint).toMatch(/^It cannot be changed at runtime: the instance operator changes WEBHOOK_MAX_TIMEOUT_SECONDS with a deploy\. Docs: cavelon docs get reference\/configuration$/);
    // A run cap with an origin but without a change (an older instance).
    server.state.capsPatch = { limits: limitsWith((values) => values.map(({ change: _c, tenant_change: _t, ...rest }) => (rest.key.startsWith("max_concurrent") ? rest : { ...rest, change: _c })) as LimitEntry[]) };
    const cap = errorOf(await cli(sb, ["limits", "set", "max_concurrent_agent_runs_per_tenant", "50", "--json"]));
    expect(cap.message).toBe(
      "max_concurrent_agent_runs_per_tenant is not the tenant's to change: the instance operator sets it, with the built-in default; " +
        "the operator sets it in the Admin (Platform › Operations › Rate limits) or with MAX_CONCURRENT_AGENT_RUNS_PER_TENANT. Nothing was sent.",
    );
    expect(cap.hint).toMatch(/^Ask the instance operator; the API does not change it\. Docs: cavelon docs get reference\/configuration$/);
    expect(patches()).toEqual([]);
  });

  it("a licence limit", async () => {
    server.state.capsPatch = {
      limits: limitsWith((values) => [
        ...values,
        {
          key: "licence_max_harnesses",
          value: 2,
          unit: "count",
          source: "licence",
          changeable_by: "operator",
          setting: "entitlements.max_harnesses",
          docs: "/docs/reference/limits-and-quotas#licence-entitlements",
          scope: "instance",
          description: "Active solutions (harnesses) the licence allows on this instance.",
        },
      ]),
    };
    const result = await cli(sb, ["limits", "set", "licence_max_harnesses", "5", "--confirm", "--json"]);
    expect(result.code).toBe(7);
    const error = errorOf(result);
    expect(error.code).toBe("limit_changed_by_operator");
    expect(error.message).toBe("licence_max_harnesses is not the tenant's to change: the operator (licence) sets it, with the licence entitlement entitlements.max_harnesses. Nothing was sent.");
    expect(error.hint).toMatch(/^The instance operator installs a renewed licence\. Docs: cavelon docs get reference\/limits-and-quotas$/);
    expect(patches()).toEqual([]);
  });

  it("a value out of the published bounds; a rate limit above the ceiling names the operator's setting", async () => {
    for (const [key, value, message] of [
      ["kb_upload_max_file_size_mb", "101", "kb_upload_max_file_size_mb is at most 100 MB; 101 MB is above it. Nothing was sent."],
      ["agent_max_turns", "0", "agent_max_turns is at least 1; 0 is below it. Nothing was sent."],
      ["rate_limit_chat_rpm", "201", "rate_limit_chat_rpm may only be lowered: the platform ceiling is 200 requests/min (RATE_LIMIT_CHAT_RPM), and 201 requests/min is above it. Nothing was sent."],
    ]) {
      const result = await cli(sb, ["limits", "set", key!, value!, "--confirm", "--json"]);
      expect(result.code, key).toBe(3);
      const error = errorOf(result);
      // Above a ceiling, the instance's own code.
      expect(error.code, key).toBe(key === "rate_limit_chat_rpm" ? "limit_above_platform_ceiling" : "request_invalid");
      expect(error.message).toBe(message);
      expect(error.details).toMatchObject({ sent: false });
    }
    const ceiling = errorOf(await cli(sb, ["limits", "set", "rate_limit_chat_rpm", "500", "--json"]));
    expect(ceiling.hint).toBe("Only the instance operator raises the ceiling, with RATE_LIMIT_CHAT_RPM; ask them. A tenant admin sets a value up to 200 requests/min.");
    expect(ceiling.details).toMatchObject({ setting: "rate_limits.chat", value: 500, maximum: 200, maximum_setting: "RATE_LIMIT_CHAT_RPM" });
    for (const [key, value, maximum, setting] of [
      ["rate_limit_chat_visitor_rpm", "61", 60, "RATE_LIMIT_CHAT_VISITOR_RPM"],
      ["rate_limit_widget_visitor_rpm", "21", 20, "RATE_LIMIT_WIDGET_VISITOR_RPM"],
    ] as const) {
      const visitor = errorOf(await cli(sb, ["limits", "set", key, value, "--confirm", "--json"]));
      expect(visitor).toMatchObject({ code: "limit_above_platform_ceiling", details: { key, maximum, maximum_setting: setting, sent: false } });
      expect(visitor.message).toContain(`the platform ceiling is ${maximum} requests/min (${setting})`);
    }
    // An instance whose catalog has no such code answers request_invalid, and so does the kit.
    server.state.catalogWithout = ["limit_above_platform_ceiling"];
    const older = sandbox();
    try {
      await login(older, server.url, token);
      expect(errorOf(await cli(older, ["limits", "set", "rate_limit_chat_rpm", "201", "--json"])).code).toBe("request_invalid");
    } finally {
      older.cleanup();
    }
    expect(patches()).toEqual([]);
  });

  it("explain limit_above_platform_ceiling: the catalog's meaning, today's ceilings and that only an operator raises one", async () => {
    const result = await cli(sb, ["explain", "limit_above_platform_ceiling"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/meaning:\s+The value is above the platform's ceiling for this limit; a tenant may only lower it\./);
    expect(result.stdout).toMatch(/fix:\s+Send at most `maximum`\. Only an operator raises the ceiling, through `maximum_setting`\./);
    const json = (await cli(sb, ["explain", "limit_above_platform_ceiling", "--json"])).json<{ area: string; kit_hint: string }>();
    expect(json.area).toBe("limits");
    expect(json.kit_hint).toContain("rate_limit_chat_rpm up to 200 requests/min (RATE_LIMIT_CHAT_RPM)");
    expect(json.kit_hint).toContain("rate_limit_chat_visitor_rpm up to 60 requests/min (RATE_LIMIT_CHAT_VISITOR_RPM), rate_limit_widget_visitor_rpm up to 20 requests/min (RATE_LIMIT_WIDGET_VISITOR_RPM)");
    expect(json.kit_hint).toMatch(/only the instance operator raises a ceiling, with the setting named\.$/);
  });

  it("the archive formats are the operator's: the refusal names the tenant's switch", async () => {
    const result = await cli(sb, ["limits", "set", "kb_upload_archive_formats", "zip", "--confirm", "--json"]);
    expect(result.code).toBe(7);
    const error = errorOf(result);
    expect(error.code).toBe("limit_changed_by_operator");
    expect(error.message).toBe("kb_upload_archive_formats is not the tenant's to change: the instance operator sets it, with upload_defaults.archive_uploads.formats (source: platform). Nothing was sent.");
    expect(error.hint).toBe("A tenant admin turns it on with cavelon limits set kb_upload_archive_enabled true (upload_defaults.archive_uploads.enabled). Docs: cavelon docs get reference/limits-and-quotas");
    expect(error.details).toMatchObject({ switch: "kb_upload_archive_enabled", sent: false });
    expect(patches()).toEqual([]);
  });

  it("an older instance: an entry without change, or no limits at all", async () => {
    const older = limitsWith((values) => values.map(({ change: _change, tenant_change: _tenant, ...rest }) => rest as LimitEntry));
    server.state.capsPatch = { limits: { ...older, tenant_quotas: { path: "/api/v1/tenants/current/quota-usage", docs: "/docs/reference/limits-and-quotas#tenant-resource-quotas" } } };
    const result = await cli(sb, ["limits", "set", "kb_upload_max_file_size_mb", "50", "--confirm", "--json"]);
    expect(result.code).toBe(1);
    const error = errorOf(result);
    expect(error.code).toBe("operation_unavailable");
    expect(error.message).toBe("This instance does not publish how to change kb_upload_max_file_size_mb, so nothing was sent.");
    expect(error.hint).toMatch(/A tenant admin changes upload_defaults\.max_file_size_mb in the Admin's settings\. Docs: cavelon docs get reference\/limits-and-quotas$/);
    // `limits` still reads such an instance, without the hint to change one.
    const listed = await cli(sb, ["limits"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).not.toContain("cavelon limits set");

    server.state.capsPatch = { limits: undefined };
    const none = await cli(sb, ["limits", "set", "agent_max_turns", "40", "--json"]);
    expect(none.code).toBe(1);
    expect(errorOf(none)).toMatchObject({ code: "operation_unavailable", message: "This instance does not publish its limits, so it does not say how to change agent_max_turns; nothing was sent." });
    expect(patches()).toEqual([]);
  });

  it("a key the instance does not list", async () => {
    const result = await cli(sb, ["limits", "set", "max_magic", "5", "--json"]);
    expect(result.code).toBe(1);
    const error = errorOf(result);
    expect(error.code).toBe("limit_not_found");
    expect(error.hint).toMatch(
      /^A tenant admin or owner changes these: kb_upload_max_file_size_mb, kb_upload_allowed_extensions, kb_upload_archive_enabled, .*rate_limit_widget_rpm, rate_limit_chat_visitor_rpm, rate_limit_widget_visitor_rpm, monthly_inference_token_budget, monthly_processing_step_cap\. An operator changes these in Platform mode: max_concurrent_agent_runs_per_tenant, max_concurrent_agent_runs_global, agent_run_slot_wait_seconds, orchestration_parallel_branches\./,
    );
  });

  it("an API key whose scopes hold none of the permissions, read from /meta/principal", async () => {
    const keySb = sandbox();
    try {
      const chatKey = server.addToken({ kind: "key", tenantIds: [tenant], tokenName: "widget", scopes: ["chat"] });
      const env = { CAVELON_URL: server.url, CAVELON_TOKEN: chatKey };
      for (const args of [["agent_max_turns", "40"], ["monthly_inference_token_budget", "5", "--confirm"]]) {
        // The key's published permissions hold none of the change's.
        const result = await cli(keySb, ["limits", "set", ...args, "--json"], { env });
        expect(result.code, args[0]).toBe(7);
        const error = errorOf(result);
        expect(error.code).toBe("forbidden");
        expect(error.message).toMatch(/^The API key "widget" may not change .+: it needs .+, which this credential does not hold\. Nothing was sent\.$/);
        expect(error.details).toMatchObject({ sent: false, held: [] });
        // An older instance publishes no permissions: the key's scopes decide.
        server.state.servePermissions = false;
        const older = errorOf(await cli(keySb, ["limits", "set", ...args, "--json"], { env }));
        server.state.servePermissions = true;
        expect(older.message).toMatch(/^The API key "widget" may not change .+: its scopes \(chat\) hold none of .+\. Nothing was sent\.$/);
        expect(older.hint).toMatch(/an admin API key of the tenant/);
        expect(older.details).toMatchObject({ sent: false, scopes: ["chat"] });
      }
      expect(patches()).toEqual([]);

      // An admin key changes its own tenant's limits and budget.
      const adminKey = server.addToken({ kind: "key", tenantIds: [tenant], tokenName: "ci", scopes: ["admin"] });
      const adminEnv = { CAVELON_URL: server.url, CAVELON_TOKEN: adminKey };
      expect((await cli(keySb, ["limits", "set", "agent_max_turns", "40", "--confirm"], { env: adminEnv })).code).toBe(0);
      const budget = await cli(keySb, ["limits", "set", "monthly_inference_token_budget", "5", "--confirm", "--json"], { env: adminEnv });
      expect(budget.code, budget.stderr).toBe(0);
      expect(patches().map((r) => r.path)).toEqual(["/api/v1/tenants/current/agent-defaults", `/api/v1/tenants/${tenant}/limits`]);
    } finally {
      keySb.cleanup();
    }
  });

  it("a person without the permission: refused before sending from /meta/principal's permissions", async () => {
    const memberSb = sandbox();
    try {
      await login(memberSb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, permissions: ["agents.view"] }));
      const result = await cli(memberSb, ["limits", "set", "agent_max_turns", "40", "--json"]);
      expect(result.code).toBe(7);
      const error = errorOf(result);
      expect(error.code).toBe("forbidden");
      expect(error.message).toBe(
        'The personal access token "laptop" may not change agent_max_turns: it needs settings.manage, settings.uploads.manage or settings.retention.manage, which this credential does not hold. Nothing was sent.',
      );
      expect(error.details).toMatchObject({ sent: false, held: ["agents.view"] });
      expect(patches()).toEqual([]);
    } finally {
      memberSb.cleanup();
    }
  });

  it("an instance without permissions in /meta/principal sends, and its refusal names the permissions (exit 7)", async () => {
    const memberSb = sandbox();
    try {
      await login(memberSb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, permissions: ["agents.view"] }));
      server.state.servePermissions = false;
      const result = await cli(memberSb, ["limits", "set", "agent_max_turns", "40", "--confirm", "--json"]);
      expect(result.code).toBe(7);
      const error = errorOf(result);
      expect(error.code).toBe("forbidden");
      expect(error.message).toBe("PATCH /api/v1/tenants/current/agent-defaults: This credential may not change these settings. (agent_max_turns was not changed.)");
      expect(error.hint).toMatch(/^Changing agent_max_turns needs settings\.manage, settings\.uploads\.manage or settings\.retention\.manage\./);
      expect(server.state.tenantLimits.get(tenant)?.has("agent_max_turns") ?? false).toBe(false);
      // An instance without /meta/principal leaves the decision to the instance as well.
      server.state.servePrincipal = false;
      expect((await cli(memberSb, ["limits", "set", "agent_max_turns", "40", "--confirm"])).code).toBe(7);
    } finally {
      memberSb.cleanup();
    }
  });
});

describe("limits set is safe for agents", () => {
  it("never prints a token, in any outcome", async () => {
    const keySb = sandbox();
    try {
      const key = server.addToken({ kind: "key", tenantIds: [tenant], scopes: ["chat"] });
      const runs: Array<Promise<CliResult>> = [];
      for (const extra of [[], ["--json"]]) {
        runs.push(
          cli(sb, ["limits", "set", "kb_upload_max_file_size_mb", "50", ...extra]),
          cli(sb, ["limits", "set", "agent_max_turns", "30", "--confirm", ...extra]),
          cli(sb, ["limits", "set", "monthly_inference_token_budget", "7", "--confirm", ...extra]),
          cli(sb, ["limits", "set", "max_concurrent_agent_runs_per_tenant", "5", ...extra]),
          cli(sb, ["limits", "set", "rate_limit_chat_rpm", "999", ...extra]),
          cli(keySb, ["limits", "set", "agent_max_turns", "30", ...extra], { env: { CAVELON_URL: server.url, CAVELON_TOKEN: key } }),
        );
      }
      for (const result of await Promise.all(runs)) {
        const all = result.stdout + result.stderr;
        for (const secret of [token, key, token.slice(6), key.slice(4)]) expect(all).not.toContain(secret);
      }
    } finally {
      keySb.cleanup();
    }
  });

  it("is a changing, destructive command with an MCP tool", async () => {
    const listed = (await cli(sb, ["commands", "--json"])).json<{ items: Array<{ command: string; read_only: boolean; destructive: boolean; mcp_tool: string | null }> }>();
    expect(listed.items.find((c) => c.command === "limits set")).toMatchObject({ read_only: false, destructive: true, mcp_tool: "limits_set" });
    const help = await cli(sb, ["limits", "set", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/never raise a limit on your own/);
  });

  it("limits names the command for the limits a tenant admin changes", async () => {
    const result = await cli(sb, ["limits"]);
    expect(result.stdout).toContain("A tenant admin changes these with: cavelon limits set <key> <value> (shows the change; --confirm sends it)");
  });
});
