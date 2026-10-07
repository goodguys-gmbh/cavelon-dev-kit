import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenApiDoc } from "../src/contracts.js";
import { branchConcurrency } from "../src/branches.js";
import { isOperatorChange, LIMIT_ABOVE_CEILING, parseLimits } from "../src/limits.js";
import { deref, operationAt, operationForPath, operations, schemaErrors } from "../src/openapi.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { buildArchive } from "../src/tar.js";
import { CAPACITY_PAGES } from "../src/capacity.js";
import { CONTRACTS, modelRow, openapiSnapshot, samplePackage, startFakeServer, traceFixture, type FakeServer } from "./fake-server.js";
import { seedQueryTool } from "./fake-database.js";

/**
 * The fake server must answer in the shapes the instance publishes, or the
 * other tests prove nothing. Every route it serves is checked against the
 * OpenAPI snapshot's response schema.
 */

let server: FakeServer;
let doc: OpenApiDoc;
let token: string;
let tenant: string;

beforeAll(async () => {
  doc = JSON.parse(openapiSnapshot()) as OpenApiDoc;
  server = await startFakeServer();
  tenant = server.addTenant("acme");
  token = server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, platform: true });
});
afterAll(() => server.close());

async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${server.url}${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tenant, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}

function check(method: string, template: string, status: number, data: unknown) {
  const op = operationAt(doc, method, template);
  expect(op, `${method} ${template} is in the snapshot`).toBeDefined();
  const schema = op!.responses[String(status)]?.content?.["application/json"]?.schema;
  expect(schema, `${method} ${template} documents ${status}`).toBeDefined();
  expect(schemaErrors(doc, schema!, data)).toEqual([]);
}

describe("contract snapshots", () => {
  it("records where they came from", () => {
    const readme = readFileSync(path.join(CONTRACTS, "..", "README.md"), "utf8");
    expect(readme).toMatch(/Recorded on \d{4}-\d{2}-\d{2}/);
    expect(doc.paths["/api/v1/operations/{operation_id}"]).toBeDefined();
  });

  it("the /meta samples match the published schemas", () => {
    const caps = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-capabilities.json"), "utf8"));
    check("GET", "/api/v1/meta/capabilities", 200, caps);
    // The check has teeth: a body without the required fields fails it.
    const schema = operationAt(doc, "GET", "/api/v1/meta/capabilities")!.responses["200"]!.content!["application/json"]!.schema!;
    expect(schemaErrors(doc, schema, { instance: {} })).not.toEqual([]);
    const catalog = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-error-catalog.json"), "utf8"));
    check("GET", "/api/v1/meta/error-catalog", 200, catalog);
  });

  it("publishes limits in the shape the kit reads", () => {
    const caps = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-capabilities.json"), "utf8"));
    const schemas = (doc.components as { schemas: Record<string, { required?: string[]; properties: Record<string, unknown> }> }).schemas;
    expect(schemas.MetaCapabilities!.required).toContain("limits");
    expect(schemas.MetaLimits!.required).toEqual(expect.arrayContaining(["values", "tenant_quotas"]));
    // Every field the kit reads from an entry is one the instance must send.
    expect(schemas.LimitValue!.required).toEqual(
      expect.arrayContaining(["key", "value", "unit", "source", "changeable_by", "setting", "docs", "scope", "description"]),
    );
    expect(schemas.TenantQuotasLink!.required).toEqual(expect.arrayContaining(["path", "docs"]));
    // The kit keeps every published entry, and the keys its pre-send checks read are among them.
    const published = parseLimits(caps);
    expect(published.published).toBe(true);
    expect(published.values).toHaveLength(caps.limits.values.length);
    expect(published.byKey.get("kb_upload_max_file_size_mb")).toMatchObject({ unit: "megabytes", changeable_by: "tenant_admin", source: "platform" });
    expect(published.byKey.get("kb_upload_allowed_extensions")!.value).toContain("pdf");
    // Extensions are published without the dot, as the kit compares them.
    expect((published.byKey.get("kb_upload_allowed_extensions")!.value as string[]).some((e) => e.startsWith("."))).toBe(false);
    // The licence cap binds only on a customer-managed instance with a licence; the snapshot is a hosted default.
    expect(published.byKey.has("licence_max_harnesses")).toBe(false);
    // The quotas link points at a route the instance publishes.
    expect(published.tenantQuotas!.path).toBe("/api/v1/tenants/current/quota-usage");
    expect(operationAt(doc, "GET", published.tenantQuotas!.path)).toBeDefined();
    // The check has teeth: an entry without its source fails the schema.
    const broken = structuredClone(caps);
    delete broken.limits.values[0].source;
    const schema = operationAt(doc, "GET", "/api/v1/meta/capabilities")!.responses["200"]!.content!["application/json"]!.schema!;
    expect(schemaErrors(doc, schema, broken)).not.toEqual([]);
  });

  it("names how a tenant admin changes each of its limits, with an operation the OpenAPI publishes", () => {
    const caps = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-capabilities.json"), "utf8"));
    const schemas = (doc.components as { schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }> }).schemas;
    expect(schemas.LimitChange!.required).toEqual(expect.arrayContaining(["operation", "method", "path", "field", "permissions"]));
    const published = parseLimits(caps);
    const changes = [
      ...published.values.flatMap((v) => [
        { key: v.key, tenant: v.changeable_by === "tenant_admin", change: v.change },
        ...(v.tenant_change ? [{ key: v.key, tenant: false, change: v.tenant_change }] : []),
      ]),
      ...published.tenantQuotas!.changes.map((c) => ({ key: c.key, tenant: true, change: c })),
    ];
    expect(changes.filter((c) => c.change).length).toBeGreaterThanOrEqual(10);
    for (const { key, tenant, change } of changes) {
      // A tenant's limit names its change; an operator's names one only with the roles it needs.
      if (tenant) expect(change, key).toBeDefined();
      if (!change) continue;
      expect(isOperatorChange(change), key).toBe(!tenant);
      if (!tenant) expect(change, key).toMatchObject({ mode: "platform", requires_role: expect.arrayContaining(["superadmin"]) });
      // The path may carry a parameter in place (the tenant's flag); the rest are the tenant.
      const found = operationForPath(doc, change.method, change.path);
      const op = found?.op;
      expect(op?.operationId, key).toBe(change.operation);
      for (const param of op!.parameters.filter((p) => p.in === "path")) expect(param.name === "tenant_id" || param.name in found!.fixed, `${key}: ${param.name}`).toBe(true);
      // A tenant's change names its permissions; an operator's platform caps need a role alone.
      if (tenant) expect(change.permissions.length, key).toBeGreaterThan(0);
      // The body takes the field, nested where it is dotted, within the published bounds.
      const body = op!.requestBody!.content!["application/json"]!.schema!;
      const nest = (value: unknown) => change.field.split(".").reduceRight<unknown>((inner, part) => ({ [part]: inner }), value);
      let sample: unknown = change.minimum ?? 1;
      if (change.field.endsWith("enabled")) sample = true;
      else if (Array.isArray(published.byKey.get(key)?.value)) sample = ["pdf"];
      expect(schemaErrors(doc, body, nest(sample)), key).toEqual([]);
      if (change.maximum !== undefined && !change.maximum_setting) expect(schemaErrors(doc, body, nest(change.maximum + 1)), key).not.toEqual([]);
    }
    expect(published.byKey.get("rate_limit_chat_rpm")!.change).toMatchObject({ maximum_setting: "RATE_LIMIT_CHAT_RPM", path: "/api/v1/tenants/current/rate-limits" });
    expect(published.tenantQuotas!.changes.map((c) => [c.key, c.path])).toEqual([
      ["monthly_inference_token_budget", "/api/v1/tenants/{tenant_id}/limits"],
      ["monthly_processing_step_cap", "/api/v1/tenants/current/processing-step-cap"],
    ]);
    // The operator's run caps: the platform's caps, and one tenant's own through tenant_change.
    expect(published.byKey.get("max_concurrent_agent_runs_global")!.change).toMatchObject({ path: "/api/v1/platform-settings/runs/capacity", field: "global", requires_role: ["superadmin"] });
    expect(published.byKey.get("max_concurrent_agent_runs_per_tenant")!.tenant_change).toMatchObject({
      path: "/api/v1/tenants/{tenant_id}/limits",
      field: "max_concurrent_agent_runs",
      requires_role: ["platform_admin", "superadmin"],
    });
    // The tenant's flag behind concurrent branches: a change on the limit itself, the flag in its path.
    const flag = published.byKey.get("orchestration_parallel_branches")!.change!;
    expect(flag).toEqual({
      operation: "set_flag_api_v1_admin_feature_flags__tenant_id___flag_key__put",
      method: "PUT",
      path: "/api/v1/admin/feature-flags/{tenant_id}/ORCHESTRATION_PARALLEL_FANOUT_ENABLED",
      field: "enabled",
      permissions: [],
      requires_role: ["platform_admin", "superadmin"],
      mode: "platform",
    });
    expect(operationForPath(doc, flag.method, flag.path)).toMatchObject({
      op: { path: "/api/v1/admin/feature-flags/{tenant_id}/{flag_key}" },
      fixed: { flag_key: ["ORCHESTRATION_PARALLEL_FANOUT_ENABLED"] },
    });
    // An environment-only operator limit has no change: it cannot be changed at runtime.
    expect(published.byKey.get("model_endpoint_slot_wait_seconds")!.change).toBeUndefined();
    // /meta/principal publishes a credential's permissions and an API key's scopes.
    expect(schemas.MetaPrincipal!.properties).toHaveProperty("permissions");
    expect(Object.keys((schemas.PrincipalApiKey as unknown as { properties: object }).properties)).toContain("scopes");
    // And, on a recent instance, the acting tenant and the operations a person runs instead.
    expect(Object.keys((schemas.MetaPrincipal as unknown as { properties: object }).properties)).toEqual(expect.arrayContaining(["permissions", "tenant", "needs_a_person"]));
    expect(Object.keys((schemas.OperationNeedingAPerson as unknown as { properties: object }).properties)).toEqual(["operation", "method", "path", "reason"]);
  });

  it("publishes the Processing Step cap with its use, and branch concurrency", () => {
    const caps = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-capabilities.json"), "utf8"));
    const published = parseLimits(caps);
    expect(published.tenantQuotas!.values).toEqual([
      expect.objectContaining({ key: "monthly_processing_step_cap", value: null, used: 0, state: "none", changeable_by: "tenant_owner", change: expect.objectContaining({ permissions: ["settings.manage"], minimum: 0 }) }),
    ]);
    const op = operationAt(doc, "PATCH", "/api/v1/tenants/current/processing-step-cap")!;
    const body = op.requestBody!.content!["application/json"]!.schema!;
    for (const value of [0, 5000, null]) expect(schemaErrors(doc, body, { monthly_processing_step_cap: value })).toEqual([]);
    const branches = branchConcurrency(published)!;
    expect(branches).toMatchObject({ width: 8, process_ceiling: 32, parallel: true, off: [] });
    expect(branches.switches.map((s) => s.setting)).toEqual(["ORCHESTRATION_PARALLEL_FANOUT_ENABLED", "feature_flags.ORCHESTRATION_PARALLEL_FANOUT_ENABLED"]);
    // The refusal of new work at the cap is in the catalog, so `cavelon explain` explains it.
    const catalog = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-error-catalog.json"), "utf8")) as { api_error_codes: Array<{ code: string }> };
    expect(catalog.api_error_codes.map((e) => e.code)).toContain("PROCESSING_STEP_CAP_REACHED");
    // The quota rows a Tenant Owner changes may name their change.
    const usage = (doc.components as { schemas: Record<string, { properties: Record<string, { additionalProperties?: unknown }> }> }).schemas.TenantQuotaUsage!;
    expect(usage.properties.monthly_processing_steps!.additionalProperties).toBe(true);
    expect(usage.properties.monthly_inference_tokens!.additionalProperties).toBe(true);
  });

  it("publishes the archive upload rules the kit checks a .zip against", () => {
    const caps = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-capabilities.json"), "utf8"));
    const published = parseLimits(caps);
    // The snapshot's tenant has archive uploads off: the switch is its own boolean entry, a tenant admin's.
    expect(published.byKey.get("kb_upload_archive_enabled")).toMatchObject({
      value: false,
      unit: "boolean",
      changeable_by: "tenant_admin",
      setting: "upload_defaults.archive_uploads.enabled",
      docs: "/docs/reference/limits-and-quotas#archive-uploads",
      change: { method: "PATCH", path: "/api/v1/tenants/current/upload-defaults", field: "archive_uploads.enabled" },
    });
    // The formats are the operator's, with no change.
    const formats = published.byKey.get("kb_upload_archive_formats")!;
    expect(formats).toMatchObject({ unit: "file_extensions", changeable_by: "operator", setting: "upload_defaults.archive_uploads.formats" });
    expect(formats.change).toBeUndefined();
    // The caps are published either way, binding only while the switch is on.
    for (const key of ["kb_upload_archive_max_entries", "kb_upload_archive_max_total_uncompressed_mb", "kb_upload_archive_max_compression_ratio"]) {
      expect(published.byKey.get(key), key).toMatchObject({ binds_when: "kb_upload_archive_enabled", changeable_by: "tenant_admin", change: { field: expect.stringMatching(/^archive_uploads\./) } });
    }
    expect(published.values.filter((v) => v.binds_when).every((v) => published.byKey.get(v.binds_when!)?.unit === "boolean")).toBe(true);
    // .zip is no allowed extension: without the archive rules the kit could not tell whether one is accepted.
    expect(published.byKey.get("kb_upload_allowed_extensions")!.value).not.toContain("zip");
    // The code the kit's refusal of a key setting a secret reuses is in the instance's error catalog.
    const catalog = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-error-catalog.json"), "utf8")) as { api_error_codes: Array<{ code: string }> };
    expect(catalog.api_error_codes.map((e) => e.code)).toContain("secret_needs_a_person");
  });

  it("publishes the per-visitor rate limits and the refusal above a ceiling", () => {
    const caps = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-capabilities.json"), "utf8"));
    const published = parseLimits(caps);
    for (const [key, field, setting] of [
      ["rate_limit_chat_visitor_rpm", "chat_per_visitor", "RATE_LIMIT_CHAT_VISITOR_RPM"],
      ["rate_limit_widget_visitor_rpm", "widget_per_visitor", "RATE_LIMIT_WIDGET_VISITOR_RPM"],
    ] as const) {
      expect(published.byKey.get(key), key).toMatchObject({
        unit: "requests_per_minute",
        changeable_by: "tenant_admin",
        change: { method: "PATCH", path: "/api/v1/tenants/current/rate-limits", field, minimum: 1, maximum_setting: setting },
      });
    }
    const catalog = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-error-catalog.json"), "utf8")) as { api_error_codes: Array<{ code: string; area: string }> };
    expect(catalog.api_error_codes.find((e) => e.code === LIMIT_ABOVE_CEILING)).toMatchObject({ area: "limits" });
  });

  it("an instance without limits publishes none, and the kit assumes none", () => {
    const caps = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-capabilities.json"), "utf8"));
    delete caps.limits;
    expect(parseLimits(caps)).toMatchObject({ published: false, values: [] });
    expect(parseLimits(null).published).toBe(false);
    expect(parseLimits({ limits: { values: "x" } }).published).toBe(false);
  });

  it("the package schema snapshot is the version the capabilities name, and the test package matches it", () => {
    const schema = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-package-schema-v3.json"), "utf8"));
    const caps = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-capabilities.json"), "utf8"));
    expect(schema["x-package-version"]).toBe(caps.contracts.package_versions.current);
    expect(schema.required).toContain("manifest");
    const { $id: _id, $schema: _s, ...body } = schema;
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(body);
    expect(validate(samplePackage()), JSON.stringify(validate.errors)).toBe(true);
    // A package declares the variables and secrets it needs, names only.
    for (const section of ["required_variables", "required_secrets"]) {
      expect(schema.properties[section], section).toMatchObject({ type: "array", items: { $ref: "#/$defs/PackageRequiredValue" } });
    }
    expect(schema.$defs.PackageRequiredValue.required).toEqual(["name"]);
    expect(Object.keys(schema.$defs.PackageRequiredValue.properties).sort((a, b) => a.localeCompare(b))).toEqual(["description", "name"]);
    expect(validate({ ...samplePackage(), required_secrets: [{ name: "crm_api_token", description: "CRM" }] })).toBe(true);
    expect(validate({ ...samplePackage(), required_secrets: [{ name: "crm token" }] })).toBe(false);
    // Every section of the test package is one the schema publishes.
    expect(Object.keys(samplePackage()).filter((k) => !(k in schema.properties))).toEqual([]);
  });

  it("a trigger run says whether it waits for run capacity", () => {
    const schemas = (doc.components as { schemas: Record<string, { properties: Record<string, Record<string, unknown>> }> }).schemas;
    expect(schemas.AgentRunResponse!.properties.waiting_for_capacity).toMatchObject({ type: "boolean", default: false });
    // Both routes the commands read a run from answer with it.
    for (const template of ["/api/v1/triggers/runs", "/api/v1/triggers/runs/{run_id}"]) {
      expect(JSON.stringify(operationAt(doc, "GET", template)!.responses["200"]), template).toContain("#/components/schemas/AgentRunResponse");
    }
  });

  it("publishes the Model Registry routes and the endpoint limit the models commands use", () => {
    const schemas = (doc.components as { schemas: Record<string, { properties: Record<string, Record<string, unknown>> }> }).schemas;
    expect(JSON.stringify(operationAt(doc, "GET", "/api/v1/model-registry")!.responses["200"])).toContain("#/components/schemas/ModelResponse");
    const update = operationAt(doc, "PATCH", "/api/v1/model-registry/{model_registry_id}")!;
    expect(JSON.stringify(update.responses["200"])).toContain("#/components/schemas/ModelResponse");
    const body = update.requestBody!.content!["application/json"]!.schema!;
    expect(schemaErrors(doc, body, { max_concurrent_requests: 8 })).toEqual([]);
    expect(schemaErrors(doc, body, { max_concurrent_requests: null })).toEqual([]);
    expect(schemaErrors(doc, body, { max_concurrent_requests: 0 })).not.toEqual([]);
    expect(schemaErrors(doc, body, { max_concurrent_requests: 100_001 })).not.toEqual([]);
    // What models list shows of a row, and what it leaves out.
    expect(Object.keys(schemas.ModelResponse!.properties)).toEqual(
      expect.arrayContaining(["id", "model_id", "display_name", "provider", "base_url", "max_concurrent_requests", "is_active", "api_key_type", "api_key_masked"]),
    );
  });

  it("the docs index lists the capacity pages the skills and explain point to", () => {
    const index = readFileSync(path.join(CONTRACTS, "docs", "llms.txt"), "utf8");
    for (const page of CAPACITY_PAGES) expect(index, page).toContain(`/api/v1/docs/${page}.md)`);
  });

  it("the routes the repository commands wrap are published", () => {
    for (const [method, template] of [
      ["GET", "/api/v1/meta/package-schema"],
      ["GET", "/api/v1/meta/principal"],
      ["GET", "/api/v1/agent-graph/export"],
      ["POST", "/api/v1/agent-graph/import/preview"],
      ["POST", "/api/v1/agent-graph/import"],
      ["GET", "/api/v1/harnesses/{harness_id}/readiness"],
      ["POST", "/api/v1/harnesses/{harness_id}/activate"],
    ]) {
      expect(operationAt(doc, method!, template!), `${method} ${template}`).toBeDefined();
    }
    const importBody = operationAt(doc, "POST", "/api/v1/agent-graph/import")!.requestBody!.content!["application/json"]!.schema!;
    expect(schemaErrors(doc, importBody, { package: {}, preview_id: "pv_1", runtime_bindings: {} })).toEqual([]);
  });
});

/** Every method and path template a command passes to the instance, read from the commands' source. */
function routesInSource(): Array<[string, string, string]> {
  const dir = path.resolve(__dirname, "../src/commands");
  const found: Array<[string, string, string]> = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(path.join(dir, file), "utf8");
    for (const match of text.matchAll(/"(GET|POST|PUT|PATCH|DELETE)",\s*"(\/api\/v1\/[^"]+)"/g)) found.push([file, match[1]!, match[2]!]);
  }
  return found;
}

describe("the OpenAPI snapshot", () => {
  it("holds only the operations the kit uses, as scripts/trim-openapi.mjs writes it", () => {
    const listed = (JSON.parse(readFileSync(path.join(CONTRACTS, "..", "kit-operations.json"), "utf8")) as { operations: string[] }).operations;
    const inSnapshot = Object.entries(doc.paths).flatMap(([route, item]) =>
      Object.keys(item)
        .filter((key) => ["get", "put", "post", "delete", "patch", "head", "options", "trace"].includes(key))
        .map((method) => `${method.toUpperCase()} ${route}`),
    );
    expect(inSnapshot.filter((op) => !listed.includes(op)), "operations outside contracts/kit-operations.json").toEqual([]);
    expect(listed.filter((op) => !inSnapshot.includes(op)), "listed operations missing from the snapshot").toEqual([]);
    expect(doc.info?.title).toBe("Cavelon API");
    // No prose: the server's descriptions explain its implementation, not the shapes the kit reads.
    expect(openapiSnapshot()).not.toMatch(/"description": "/);
  });

  it("keeps the instance's person-only marker through the trim", () => {
    const marked = operations(doc).filter((o) => o.personOnly?.marked).map((o) => `${o.method} ${o.path}: ${o.personOnly?.reason}`);
    expect(marked).toEqual(["PUT /api/v1/secrets/{name}: Sets or deletes a secret value", "DELETE /api/v1/secrets/{name}: Sets or deletes a secret value"]);
  });

  it("carry no developer notes, as scripts/scrub-contracts.mjs leaves them", () => {
    const files = readdirSync(CONTRACTS, { recursive: true, encoding: "utf8" }).filter((f) => /\.(json|md|txt)$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const file of files) {
      const text = readFileSync(path.join(CONTRACTS, file), "utf8");
      expect(text, file).not.toMatch(/\(#\d+/);
    }
  });
});

describe("the routes the commands use", () => {
  it("are all in the snapshot, so a route that leaves it fails here", () => {
    const routes: Array<[string, string, string]> = [
      ...routesInSource(),
      // Built from a variable or a template in the source.
      ["loops.ts", "POST", "/api/v1/triggers/runs/{run_id}/loops/{loop_id}/pause"],
      ["loops.ts", "POST", "/api/v1/triggers/runs/{run_id}/loops/{loop_id}/resume"],
      ["sandboxes.ts", "GET", "/api/v1/sandboxes/{sandbox_id}/artifact-jobs/{job_id}"],
      ["sandboxes.ts", "PUT", "/api/v1/sandboxes/{sandbox_id}/artifact-jobs/{job_id}/content"],
      ["sandboxes.ts", "GET", "/api/v1/sandboxes/{sandbox_id}/artifact-jobs/{job_id}/content"],
      ["models.ts", "GET", "/api/v1/model-registry"],
      ["models.ts", "PATCH", "/api/v1/model-registry/{model_registry_id}"],
    ];
    // The scan finds the routes of the loop and Sandbox commands, not nothing.
    expect(routes.filter(([file]) => file === "loops.ts").length).toBeGreaterThanOrEqual(9);
    expect(routes.filter(([file]) => file === "sandboxes.ts").length).toBeGreaterThanOrEqual(12);
    const missing = routes.filter(([, method, template]) => !operationAt(doc, method, template)).map(([file, method, template]) => `${file}: ${method} ${template}`);
    expect(missing).toEqual([]);
  });

  it("take the headers the commands send", () => {
    const header = (method: string, template: string) =>
      operationAt(doc, method, template)!
        .parameters.filter((p) => p.in === "header")
        .map((p) => p.name);
    expect(header("POST", "/api/v1/triggers/runs/{run_id}/loops/{loop_id}/pause")).toContain("Idempotency-Key");
    expect(header("POST", "/api/v1/sandboxes/{sandbox_id}/artifact-jobs")).toContain("idempotency-key");
    expect(header("POST", "/api/v1/sandboxes/{sandbox_id}/refresh-workspace")).toEqual(expect.arrayContaining(["idempotency-key", "if-match"]));
    expect(header("POST", "/api/v1/sandboxes/{sandbox_id}/validate")).toContain("if-match");
  });
});

describe("the fake server answers in the published shapes", () => {
  it("meta, tenants, harnesses", async () => {
    check("GET", "/api/v1/meta/capabilities", 200, (await call("GET", "/api/v1/meta/capabilities")).data);
    const created = await fetch(`${server.url}/api/v1/tenants`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "contract", name: "Contract" }),
    });
    check("POST", "/api/v1/tenants", 201, await created.json());
    const platform = await fetch(`${server.url}/api/v1/tenants`, { headers: { Authorization: `Bearer ${token}` } });
    check("GET", "/api/v1/tenants", 200, await platform.json());
    const harness = await call("POST", "/api/v1/harnesses", { slug: "h", name: "H" });
    check("POST", "/api/v1/harnesses", 201, harness.data);
    check("GET", "/api/v1/harnesses", 200, (await call("GET", "/api/v1/harnesses")).data);
    check("GET", "/api/v1/harnesses/by-slug/{slug}", 200, (await call("GET", "/api/v1/harnesses/by-slug/h")).data);
    const clone = await call("POST", `/api/v1/harnesses/${(harness.data as { id: string }).id}/clone`, { slug: "h2" });
    check("POST", "/api/v1/harnesses/{harness_id}/clone", 201, clone.data);
    check("GET", "/api/v1/auth/me", 200, (await call("GET", "/api/v1/auth/me")).data);
    check("GET", "/api/v1/tenants/{tenant_id}", 200, (await call("GET", `/api/v1/tenants/${tenant}`)).data);
    check("GET", "/api/v1/tenants/current/quota-usage", 200, (await call("GET", "/api/v1/tenants/current/quota-usage")).data);
    check("GET", "/api/v1/meta/principal", 200, (await call("GET", "/api/v1/meta/principal")).data);
    const id = (harness.data as { id: string }).id;
    check("GET", "/api/v1/harnesses/{harness_id}", 200, (await call("GET", `/api/v1/harnesses/${id}`)).data);
    check("GET", "/api/v1/harnesses/{harness_id}/readiness", 200, (await call("GET", `/api/v1/harnesses/${id}/readiness`)).data);
    const activated = await call("POST", `/api/v1/harnesses/${id}/activate`, { force: false });
    expect(activated.status).toBe(403); // this token may not activate
    server.state.tokens.get(token)!.mayActivate = true;
    check("POST", "/api/v1/harnesses/{harness_id}/activate", 200, (await call("POST", `/api/v1/harnesses/${id}/activate`, { force: false })).data);
  });

  it("Model Registry rows", async () => {
    server.state.models.push(modelRow(tenant, { model_id: "llama-70b", base_url: "http://vllm:8000/v1", max_concurrent_requests: 4 }));
    const rows = (await call("GET", "/api/v1/model-registry")).data as Array<{ id: string }>;
    check("GET", "/api/v1/model-registry", 200, rows);
    const patched = await call("PATCH", `/api/v1/model-registry/${rows[0]!.id}`, { max_concurrent_requests: 8 });
    check("PATCH", "/api/v1/model-registry/{model_registry_id}", 200, patched.data);
    server.state.models.push(modelRow(tenant, { model_id: "gpt-4.1" }));
    const second = ((await call("GET", "/api/v1/model-registry")).data as Array<{ id: string; model_id: string }>).find((r) => r.model_id === "gpt-4.1")!;
    expect((await call("PATCH", `/api/v1/model-registry/${second.id}`, { max_concurrent_requests: 2 })).status).toBe(422);
    expect(operationAt(doc, "PATCH", "/api/v1/model-registry/{model_registry_id}")!.responses["422"]).toBeDefined();
    server.state.models = [];
  });

  it("tenant limit changes", async () => {
    for (const [p, body] of [
      ["/api/v1/tenants/current/upload-defaults", { max_file_size_mb: 50, archive_uploads: { enabled: true } }],
      ["/api/v1/tenants/current/agent-defaults", { agent_max_turns: 40 }],
      ["/api/v1/tenants/current/rate-limits", { chat: 100 }],
    ] as const) {
      const changed = await call("PATCH", p, body);
      expect(changed.status, p).toBe(200);
      check("PATCH", p, 200, changed.data);
      expect(operationAt(doc, "PATCH", p)!.responses["403"], p).toBeDefined();
    }
    const budget = await call("PATCH", `/api/v1/tenants/${tenant}/limits`, { monthly_inference_token_budget: 5 });
    check("PATCH", "/api/v1/tenants/{tenant_id}/limits", 200, budget.data);
    expect((await call("PATCH", `/api/v1/tenants/${randomUUID()}/limits`, { monthly_inference_token_budget: 5 })).status).toBe(403);
    expect((await call("PATCH", "/api/v1/tenants/current/rate-limits", { chat: 1000 })).status).toBe(422);
    // The Processing Step cap: set, then cleared with null.
    for (const value of [5000, null]) {
      const cap = await call("PATCH", "/api/v1/tenants/current/processing-step-cap", { monthly_processing_step_cap: value });
      expect(cap.status).toBe(200);
      check("PATCH", "/api/v1/tenants/current/processing-step-cap", 200, cap.data);
    }
    expect((await call("PATCH", "/api/v1/tenants/current/processing-step-cap", { monthly_processing_step_cap: -1 })).status).toBe(422);
    server.state.tenantLimits.clear();
    server.state.inferenceBudgets.clear();
  });

  it("an operator's changes in Platform mode", async () => {
    const operator = server.addToken({ kind: "pat", tenantIds: [], platform: true, globalRole: "superadmin" });
    const platformCall = async (method: string, p: string, body: unknown) => {
      const response = await fetch(`${server.url}${p}`, { method, headers: { Authorization: `Bearer ${operator}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, data: (await response.json()) as unknown };
    };
    const caps = await platformCall("PATCH", "/api/v1/platform-settings/runs/capacity", { global: 150 });
    expect(caps.status).toBe(200);
    check("PATCH", "/api/v1/platform-settings/runs/capacity", 200, caps.data);
    const own = await platformCall("PATCH", `/api/v1/tenants/${tenant}/limits`, { max_concurrent_agent_runs: 6 });
    expect(own.status).toBe(200);
    check("PATCH", "/api/v1/tenants/{tenant_id}/limits", 200, own.data);
    const flag = await platformCall("PUT", `/api/v1/admin/feature-flags/${tenant}/ORCHESTRATION_PARALLEL_FANOUT_ENABLED`, { enabled: false });
    expect(flag.status).toBe(200);
    check("PUT", "/api/v1/admin/feature-flags/{tenant_id}/{flag_key}", 200, flag.data);
    const principal = await fetch(`${server.url}/api/v1/meta/principal`, { headers: { Authorization: `Bearer ${operator}` } });
    check("GET", "/api/v1/meta/principal", 200, await principal.json());
    // A tenant's token in Tenant mode is refused.
    expect((await call("PATCH", "/api/v1/platform-settings/runs/capacity", { global: 150 })).status).toBe(403);
    server.state.runCapacity = {};
    server.state.tenantRunCaps.clear();
    server.state.tenantFlags.clear();
  });

  it("variables and secrets", async () => {
    check("PUT", "/api/v1/variables/{name}", 200, (await call("PUT", "/api/v1/variables/region", { value: "eu" })).data);
    check("GET", "/api/v1/variables", 200, (await call("GET", "/api/v1/variables")).data);
    check("GET", "/api/v1/variables/{name}", 200, (await call("GET", "/api/v1/variables/region")).data);
    expect((await call("GET", "/api/v1/variables/nope")).status).toBe(404);
    const setBody = operationAt(doc, "PUT", "/api/v1/secrets/{name}")!.requestBody!.content!["application/json"]!.schema!;
    expect(schemaErrors(doc, setBody, { value: "x" })).toEqual([]);
    expect(schemaErrors(doc, setBody, { value: "" })).not.toEqual([]);
    const secret = await call("PUT", "/api/v1/secrets/crm_api_token", { value: "never-shown" });
    check("PUT", "/api/v1/secrets/{name}", 200, secret.data);
    expect(JSON.stringify(secret.data)).not.toContain("never-shown");
    check("GET", "/api/v1/secrets", 200, (await call("GET", "/api/v1/secrets")).data);
    check("GET", "/api/v1/secrets/{name}", 200, (await call("GET", "/api/v1/secrets/crm_api_token")).data);
    check("GET", "/api/v1/secrets/{name}", 200, (await call("GET", "/api/v1/secrets/unknown")).data);
    // The status a response carries is never the value.
    const status = (doc.components as { schemas: Record<string, { properties: Record<string, unknown> }> }).schemas.TenantSecretStatus!;
    expect(Object.keys(status.properties).sort((a, b) => a.localeCompare(b))).toEqual(["changed_at", "declared", "description", "name", "status"]);
    // A key gets the documented 403 with the instance's code.
    expect(operationAt(doc, "PUT", "/api/v1/secrets/{name}")!.responses["403"]).toBeDefined();
    expect(operationAt(doc, "DELETE", "/api/v1/secrets/{name}")!.responses["403"]).toBeDefined();
    const key = server.addToken({ kind: "key", tenantIds: [tenant] });
    const refused = await fetch(`${server.url}/api/v1/secrets/crm_api_token`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ value: "x" }),
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "secret_needs_a_person" });
    expect((await fetch(`${server.url}/api/v1/secrets/crm_api_token`, { method: "DELETE", headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tenant } })).status).toBe(204);
    expect((await fetch(`${server.url}/api/v1/variables/region`, { method: "DELETE", headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tenant } })).status).toBe(204);
  });

  it("knowledge bases, uploads, test runs, operations, traces", async () => {
    server.state.kbs.push({ id: "4c1b9a3e-0000-4000-8000-0000000000aa", tenant_id: tenant, name: "FAQ" });
    check("GET", "/api/v1/knowledge-bases", 200, (await call("GET", "/api/v1/knowledge-bases")).data);
    const form = new FormData();
    form.append("files", new Blob(["# hi"]), "a.md");
    const upload = await fetch(`${server.url}/api/v1/knowledge-bases/4c1b9a3e-0000-4000-8000-0000000000aa/documents/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tenant },
      body: form,
    });
    const docs = (await upload.json()) as Array<{ id: string; operation_id: string }>;
    check("POST", "/api/v1/knowledge-bases/{kb_id}/documents/upload", 202, docs);
    const listed = await call("GET", "/api/v1/knowledge-bases/4c1b9a3e-0000-4000-8000-0000000000aa/documents");
    check("GET", "/api/v1/knowledge-bases/{kb_id}/documents", 200, listed.data);
    expect(listed.data).toHaveLength(1);
    const toggled = await call("PATCH", "/api/v1/knowledge-bases/4c1b9a3e-0000-4000-8000-0000000000aa/documents/active", {
      updates: [{ id: docs[0]!.id, is_active: false }],
    });
    check("PATCH", "/api/v1/knowledge-bases/{kb_id}/documents/active", 200, toggled.data);
    expect(toggled.data).toEqual({ activated: 0, deactivated: 1 });
    // The upload form of the snapshot's instance takes replace_doc_ids, which kb upload --replace sends.
    const uploadForm = operationAt(doc, "POST", "/api/v1/knowledge-bases/{kb_id}/documents/upload")!.requestBody!.content["multipart/form-data"]!.schema!;
    expect(Object.keys((deref(doc, uploadForm) as { properties: Record<string, unknown> }).properties)).toContain("replace_doc_ids");

    server.state.suites.push({ id: "5a17e000-0000-4000-8000-0000000000aa", tenant_id: tenant, name: "s", harness_id: null, archived_at: null });
    check("GET", "/api/v1/test-suites", 200, (await call("GET", "/api/v1/test-suites")).data);
    const run = await call("POST", "/api/v1/test-suites/5a17e000-0000-4000-8000-0000000000aa/runs", {});
    check("POST", "/api/v1/test-suites/{suite_id}/runs", 201, run.data);
    const runId = (run.data as { id: string }).id;
    check("GET", "/api/v1/test-runs/{run_id}", 200, (await call("GET", `/api/v1/test-runs/${runId}`)).data);
    check("GET", "/api/v1/test-runs/{run_id}/results", 200, (await call("GET", `/api/v1/test-runs/${runId}/results`)).data);
    // A failed trigger case: what the instance records for it, in the published fields.
    server.state.runResults = [
      { name: "Loop", status: "fail", error_message: "Assertion failed: x", llm_judge_reasoning: "x", judge_breakdown: { evaluation_kind: "deterministic" }, agent_run_id: randomUUID() },
    ];
    check("GET", "/api/v1/test-runs/{run_id}/results", 200, (await call("GET", `/api/v1/test-runs/${runId}/results`)).data);
    server.state.runResults = null;

    const op = await call("GET", `/api/v1/operations/${docs[0]!.operation_id}`);
    check("GET", "/api/v1/operations/{operation_id}", 200, op.data);
    check("GET", "/api/v1/operations", 200, (await call("GET", "/api/v1/operations")).data);

    server.state.traces.set("trigger:7aace000-0000-4000-8000-0000000000bb", [traceFixture("7aace000-0000-4000-8000-0000000000cc", null)]);
    const traces = await call("GET", "/api/v1/triggers/runs/7aace000-0000-4000-8000-0000000000bb/traces");
    check("GET", "/api/v1/triggers/runs/{run_id}/traces", 200, traces.data);
    const detail = await call("GET", "/api/v1/triggers/runs/7aace000-0000-4000-8000-0000000000bb/traces/7aace000-0000-4000-8000-0000000000cc");
    check("GET", "/api/v1/triggers/runs/{run_id}/traces/{trace_id}", 200, detail.data);
  });

  it("database connections, queries, runs, connection tests and test runs", async () => {
    const { connection, query } = seedQueryTool(server.state.db, tenant);
    server.state.features.database_connector_enabled = true;
    try {
      check("GET", "/api/v1/meta/capabilities", 200, (await call("GET", "/api/v1/meta/capabilities")).data);
      check("GET", "/api/v1/database-connectors/instance", 200, (await call("GET", "/api/v1/database-connectors/instance")).data);
      connection.caCertificates = [{ subject: "CN=Shop Root CA", issuer: "CN=Shop Root CA", not_before: "2026-01-01T00:00:00Z", not_after: "2031-01-01T00:00:00Z", sha256: "AB:CD" }];
      check("GET", "/api/v1/database-connectors/connections", 200, (await call("GET", "/api/v1/database-connectors/connections")).data);
      check("GET", "/api/v1/database-connectors/connections/{connection_id}", 200, (await call("GET", `/api/v1/database-connectors/connections/${connection.id}`)).data);
      check("POST", "/api/v1/database-connectors/connections/{connection_id}/test", 200, (await call("POST", `/api/v1/database-connectors/connections/${connection.id}/test`)).data);
      check("GET", "/api/v1/database-connectors/queries", 200, (await call("GET", `/api/v1/database-connectors/queries?connection_id=${connection.id}`)).data);
      check("GET", "/api/v1/database-connectors/queries/{query_id}", 200, (await call("GET", `/api/v1/database-connectors/queries/${query.id}`)).data);
      const body = { values: { order_no: "A-10023", email: "ada@example.com" } };
      const requestSchema = operationAt(doc, "POST", "/api/v1/database-connectors/queries/{query_id}/test-run")!.requestBody!.content!["application/json"]!.schema!;
      expect(schemaErrors(doc, requestSchema, body)).toEqual([]);
      check("POST", "/api/v1/database-connectors/queries/{query_id}/test-run", 200, (await call("POST", `/api/v1/database-connectors/queries/${query.id}/test-run`, body)).data);
      check("GET", "/api/v1/database-connectors/queries/{query_id}/runs", 200, (await call("GET", `/api/v1/database-connectors/queries/${query.id}/runs?limit=5`)).data);
      // Off, the connector's routes are not there, as on the instance.
      server.state.features.database_connector_enabled = false;
      expect((await call("GET", "/api/v1/database-connectors/connections")).status).toBe(404);
    } finally {
      delete server.state.features.database_connector_enabled;
    }
  });

  it("triggers, runs, loops, identities, Sandboxes and archive jobs", async () => {
    const harness = randomUUID();
    const keyId = randomUUID();
    server.state.lr.apiKeys.push({ id: keyId, tenant_id: tenant, name: "runner", key_prefix: "cbp_x1", is_active: true });
    const box = {
      id: randomUUID(),
      tenant_id: tenant,
      name: "box",
      execution_mode: "isolated_container" as const,
      lifecycle_state: "ready",
      config_version: 1,
      revision: 0,
      allowed_harness_ids: [harness],
      machine_api_key_ids: [],
      files: new Map([["a.txt", Buffer.from("a")]]),
      writer_owner_run_id: null,
      healthy: true,
      readiness: null,
      activity: [],
      refreshKeys: new Map(),
    };
    server.state.lr.sandboxes.push(box);
    const triggerId = randomUUID();
    server.state.lr.triggers.push({
      id: triggerId,
      tenant_id: tenant,
      slug: "t",
      name: "T",
      harness_id: harness,
      trigger_type: "webhook",
      is_active: true,
      identity: { api_key_id: null, version: 1 },
      required_solutions: [{ id: harness, name: "T" }],
      loop: { iterations: 2, sandboxId: box.id },
    });
    check("GET", "/api/v1/triggers", 200, (await call("GET", "/api/v1/triggers")).data);
    check("GET", "/api/v1/triggers/{trigger_id}", 200, (await call("GET", `/api/v1/triggers/${triggerId}`)).data);
    const identity = `/api/v1/triggers/${triggerId}/execution-identity`;
    check("GET", "/api/v1/triggers/{trigger_id}/execution-identity", 200, (await call("GET", identity)).data);
    check("PUT", "/api/v1/triggers/{trigger_id}/execution-identity", 200, (await call("PUT", identity, { api_key_id: keyId, expected_version: 1 })).data);
    check("GET", "/api/v1/tenants/{tenant_id}/api-keys", 200, (await call("GET", `/api/v1/tenants/${tenant}/api-keys`)).data);

    const run = (await call("POST", `/api/v1/triggers/${triggerId}/run`, { payload: {} })).data as { id: string; operation_id: string };
    check("POST", "/api/v1/triggers/{trigger_id}/run", 202, run);
    check("GET", "/api/v1/triggers/runs/{run_id}", 200, (await call("GET", `/api/v1/triggers/runs/${run.id}`)).data);
    const loops = (await call("GET", `/api/v1/triggers/runs/${run.id}/loops`)).data as { items: Array<{ id: string; version: number }> };
    check("GET", "/api/v1/triggers/runs/{run_id}/loops", 200, loops);
    const loop = `/api/v1/triggers/runs/${run.id}/loops/${loops.items[0]!.id}`;
    check("GET", "/api/v1/triggers/runs/{run_id}/loops/{loop_id}/iterations", 200, (await call("GET", `${loop}/iterations`)).data);
    const detail = (await call("GET", loop)).data as { version: number; state: string };
    check("GET", "/api/v1/triggers/runs/{run_id}/loops/{loop_id}", 200, detail);
    // An iteration's child is a sub-run the run routes read.
    const iterations = (await call("GET", `${loop}/iterations`)).data as { items: Array<{ child_run_id: string }> };
    check("GET", "/api/v1/triggers/runs/{run_id}", 200, (await call("GET", `/api/v1/triggers/runs/${iterations.items[0]!.child_run_id}`)).data);
    check("GET", "/api/v1/operations/{operation_id}", 200, (await call("GET", `/api/v1/operations/${run.operation_id}`)).data);
    check("POST", "/api/v1/triggers/runs/{run_id}/cancel", 200, (await call("POST", `/api/v1/triggers/runs/${run.id}/cancel`)).data);

    // A run that completes without a loop keeps its stages' errors in its orchestration state.
    const stageTrigger = randomUUID();
    server.state.lr.triggers.push({
      ...server.state.lr.triggers.find((t) => t.id === triggerId)!,
      id: stageTrigger,
      slug: "no-loop",
      loop: undefined,
      stageError: { key: "node:count", index: 2, type: "OrchestrationNodeExecutionError", message: "loop_run_authority_missing" },
    });
    const noLoop = (await call("POST", `/api/v1/triggers/${stageTrigger}/run`, { payload: {} })).data as { id: string };
    check("GET", "/api/v1/triggers/runs/{run_id}/orchestration-state", 200, (await call("GET", `/api/v1/triggers/runs/${noLoop.id}/orchestration-state`)).data);

    server.state.lr.triggers.find((t) => t.id === triggerId)!.loop!.iterations = 5;
    const second = (await call("POST", `/api/v1/triggers/${triggerId}/run`, { payload: {} })).data as { id: string };
    const loop2 = ((await call("GET", `/api/v1/triggers/runs/${second.id}/loops`)).data as { items: Array<{ id: string; version: number }> }).items[0]!;
    const control = `/api/v1/triggers/runs/${second.id}/loops/${loop2.id}`;
    const paused = await call("POST", `${control}/pause`, { expected_version: loop2.version }, { "Idempotency-Key": randomUUID() });
    check("POST", "/api/v1/triggers/runs/{run_id}/loops/{loop_id}/pause", 202, paused.data);
    await call("GET", control);
    const version = ((await call("GET", control)).data as { version: number }).version;
    const resumed = await call("POST", `${control}/resume`, { expected_version: version }, { "Idempotency-Key": randomUUID() });
    check("POST", "/api/v1/triggers/runs/{run_id}/loops/{loop_id}/resume", 202, resumed.data);
    // Stopping the run releases the Sandbox's writer, which an archive job needs.
    await call("POST", `/api/v1/triggers/runs/${second.id}/cancel`);

    const sandboxes = `/api/v1/sandboxes/${box.id}`;
    check("GET", "/api/v1/sandboxes", 200, (await call("GET", "/api/v1/sandboxes")).data);
    check("GET", "/api/v1/sandboxes/{sandbox_id}", 200, (await call("GET", sandboxes)).data);
    check("POST", "/api/v1/sandboxes/{sandbox_id}/validate", 200, (await call("POST", `${sandboxes}/validate`, undefined, { "If-Match": '"1"' })).data);
    const q = `harness_id=${harness}`;
    check("GET", "/api/v1/sandboxes/{sandbox_id}/files", 200, (await call("GET", `${sandboxes}/files?${q}`)).data);
    check("GET", "/api/v1/sandboxes/{sandbox_id}/files/content", 200, (await call("GET", `${sandboxes}/files/content?${q}&path=a.txt&encoding=utf-8`)).data);
    const activity = (await call("GET", `${sandboxes}/activity?${q}`)).data as { entries: Array<{ id: string }> };
    check("GET", "/api/v1/sandboxes/{sandbox_id}/activity", 200, activity);
    const one = `${sandboxes}/activity/${activity.entries[0]!.id}`;
    check("GET", "/api/v1/sandboxes/{sandbox_id}/activity/{operation_link_id}", 200, (await call("GET", `${one}?${q}`)).data);
    check("GET", "/api/v1/sandboxes/{sandbox_id}/activity/{operation_link_id}/logs", 200, (await call("GET", `${one}/logs?${q}`)).data);
    check("GET", "/api/v1/sandboxes/{sandbox_id}/activity/{operation_link_id}/receipt", 200, (await call("GET", `${one}/receipt?${q}`)).data);

    const archive = buildArchive([{ name: "b.txt", directory: false, content: Buffer.from("b") }]);
    const jobBody = { harness_id: harness, direction: "import", expected_workspace_revision: `revision-${box.revision}`, sha256: archive.sha256, size_bytes: archive.bytes.length };
    const importBody = operationAt(doc, "POST", "/api/v1/sandboxes/{sandbox_id}/artifact-jobs")!.requestBody!.content!["application/json"]!.schema!;
    expect(schemaErrors(doc, importBody, jobBody)).toEqual([]);
    const created = await call("POST", `${sandboxes}/artifact-jobs`, jobBody, { "Idempotency-Key": randomUUID() });
    check("POST", "/api/v1/sandboxes/{sandbox_id}/artifact-jobs", 202, created.data);
    const job = `${sandboxes}/artifact-jobs/${(created.data as { id: string }).id}`;
    check("GET", "/api/v1/sandboxes/{sandbox_id}/artifact-jobs/{job_id}", 200, (await call("GET", job)).data);
    await call("GET", job);
    const put = await fetch(`${server.url}${job}/content`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tenant, "Content-Type": "application/octet-stream" },
      body: archive.bytes,
    });
    check("PUT", "/api/v1/sandboxes/{sandbox_id}/artifact-jobs/{job_id}/content", 200, await put.json());
    const exportJob = await call("POST", `${sandboxes}/artifact-jobs`, { harness_id: harness, direction: "export", expected_workspace_revision: `revision-${box.revision}` }, { "Idempotency-Key": randomUUID() });
    const exportPath = `${sandboxes}/artifact-jobs/${(exportJob.data as { id: string }).id}`;
    for (let i = 0; i < 4; i++) await call("GET", exportPath);
    const tar = await fetch(`${server.url}${exportPath}/content`, { headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tenant } });
    expect(tar.headers.get("content-type")).toBe("application/x-tar");
    const bytes = Buffer.from(await tar.arrayBuffer());
    expect(tar.headers.get("x-content-sha256")).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});
