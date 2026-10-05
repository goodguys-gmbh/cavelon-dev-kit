import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { exportForm, settledForm } from "../src/package-format.js";
import { CONTRACTS, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * fmt and pull agree on the export's form: what fmt writes is what the export
 * gives back, a field the export only spells out is no change to pull, a
 * suite goes back to its own file, and a solution's folder holds no
 * tenant-wide section unless asked.
 */

let server: FakeServer;
let sb: Sandbox;
let tenant: string;
let dirCount = 0;

const read = (file: string) => readFileSync(file, "utf8");
const schema = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-package-schema-v3.json"), "utf8"));

async function pulled(box: Sandbox = sb, args: string[] = []): Promise<string> {
  const dir = path.join(box.home, `solution-${++dirCount}`);
  mkdirSync(dir, { recursive: true });
  const init = await cli(box, ["init", "--instance", server.url, "--tenant", tenant, "--harness", "support"], { cwd: dir });
  expect(init.code, init.stderr + init.stdout).toBe(0);
  const pull = await cli(box, ["pull", ...args], { cwd: dir });
  expect(pull.code, pull.stderr + pull.stdout).toBe(0);
  return dir;
}

async function applied(dir: string): Promise<void> {
  const preview = await cli(sb, ["apply", "--json"], { cwd: dir });
  expect(preview.code, preview.stderr + preview.stdout).toBe(0);
  const confirmed = await cli(sb, ["apply", "--confirm", preview.json<{ preview_id: string }>().preview_id], { cwd: dir });
  expect(confirmed.code, confirmed.stderr).toBe(0);
}

const suites = () => server.state.configs.get(tenant)!.pkg.test_suites as Array<Record<string, unknown>>;

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, mayActivate: true }));
  await cli(sb, ["harness", "new", "support", "--name", "Support"]);
});
afterAll(async () => {
  sb.cleanup();
  await server.close();
});
beforeEach(() => {
  server.state.configs.clear();
  server.state.exportFillsDefaults = true;
  server.state.packageSchemaEdit = null;
  server.state.tenantWideFlag = true;
  server.state.tenantWideReport = true;
});

/** The export and import requests this test made, with what they asked about the tenant-wide sections. */
const exportsAsked = () => server.state.requests.filter((r) => r.method === "GET" && r.path === "/api/v1/agent-graph/export").map((r) => r.query.get("include_tenant_wide"));
const importBodies = () =>
  server.state.requests.filter((r) => r.method === "POST" && r.path.startsWith("/api/v1/agent-graph/import")).map((r) => r.body as Record<string, unknown>);

/** A sandbox of its own, so the OpenAPI it caches is the one the server plays now (an older instance). */
async function olderInstance(): Promise<Sandbox> {
  server.state.tenantWideFlag = false;
  // An instance without the flag marks no section either: the kit falls back to the two it exported with every solution.
  server.state.packageSchemaEdit = (s) => {
    for (const node of Object.values(s.properties as Record<string, Record<string, unknown>>)) delete node["x-cavelon-scope"];
  };
  const box = sandbox();
  await login(box, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
  return box;
}

describe("the export's form", () => {
  it("fmt fills an empty list or object where the schema publishes no default, and each entry's order from its position", () => {
    const agent = (exportForm(schema, schema.properties.agents, [{ slug: "a" }]) as Array<Record<string, unknown>>)[0]!;
    expect(agent).toMatchObject({ tool_assignments: [], handoffs: [], trigger_inject_paths: [] });
    // A nullable field without a default stays out: the instance's value for it is not in the schema.
    expect(agent).not.toHaveProperty("memory_config");
    const kb = (exportForm(schema, schema.properties.knowledge_bases, [{ name: "Handbook" }]) as Array<Record<string, unknown>>)[0]!;
    expect(kb).toMatchObject({ chunking_config: {}, retrieval_config: {}, kb_type: "prose" });
    const suite = (exportForm(schema, schema.properties.test_suites, [{ name: "S", test_cases: [{ name: "b", steps: [{ user_message: "1" }, { user_message: "2" }] }, { name: "a" }] }]) as Array<Record<string, unknown>>)[0]!;
    expect(suite).toMatchObject({ tags: [], settings: {} });
    const cases = suite.test_cases as Array<Record<string, unknown>>;
    expect(cases.map((c) => c.sort_order)).toEqual([0, 1]);
    expect((cases[0]!.steps as Array<Record<string, unknown>>).map((s) => s.step_order)).toEqual([1, 2]);
    // One that is set stays as written.
    const kept = exportForm(schema, schema.properties.test_suites, [{ name: "S", test_cases: [{ name: "b", sort_order: 7 }] }]) as Array<Record<string, unknown>>;
    expect((kept[0]!.test_cases as Array<Record<string, unknown>>)[0]!.sort_order).toBe(7);
  });

  it("counts a field null, empty or at the value the instance gives it as unset, and nothing else", () => {
    const node = schema.properties.agents;
    const short = [{ slug: "a", name: "A" }];
    const spelled = [{ slug: "a", name: "A", memory_config: {}, handoffs: [], max_output_tokens: null, is_active: true, display_order: 0 }];
    expect(settledForm(schema, node, spelled)).toEqual(settledForm(schema, node, short));
    expect(settledForm(schema, node, [{ slug: "a", name: "A", is_active: false }])).not.toEqual(settledForm(schema, node, short));
    expect(settledForm(schema, node, [{ slug: "a", name: "A", memory_config: { window: 3 } }])).not.toEqual(settledForm(schema, node, short));
  });

  it("after fmt and apply, the first pull writes nothing, and the test cases keep their written order", async () => {
    const dir = await pulled();
    const smoke = path.join(dir, "tests", "smoke.yaml");
    writeFileSync(
      smoke,
      "name: Smoke\nharness_slug: support\ntest_cases:\n  - name: Zebra\n    steps:\n      - user_message: first\n  - name: Apple\n    steps:\n      - user_message: second\n",
    );
    expect((await cli(sb, ["fmt"], { cwd: dir })).code).toBe(0);
    const formatted = parse(read(smoke)) as Record<string, unknown>;
    expect(formatted).toMatchObject({ tags: [], settings: {} });
    expect((formatted.test_cases as Array<Record<string, unknown>>).map((c) => [c.name, c.sort_order])).toEqual([["Zebra", 0], ["Apple", 1]]);
    await applied(dir);

    const pull = await cli(sb, ["pull", "--json"], { cwd: dir });
    expect(pull.code, pull.stderr).toBe(0);
    expect(pull.json<{ files: { written: string[]; removed: string[] } }>().files).toMatchObject({ written: [], removed: [] });
    expect((parse(read(smoke)) as Record<string, unknown>).test_cases).toEqual(formatted.test_cases);
    // The instance holds the written order, not the alphabetical one.
    const onInstance = suites().find((s) => s.name === "Smoke")!.test_cases as Array<Record<string, unknown>>;
    expect(onInstance.map((c) => c.name)).toEqual(["Zebra", "Apple"]);
    expect((await cli(sb, ["fmt", "--check"], { cwd: dir })).code).toBe(0);
  });

  it("pull writes a changed suite back to the file it came from, whatever the file is called, and remembers where", async () => {
    const dir = await pulled();
    const tests = path.join(dir, "tests");
    // A suite applied from a file named apart from the suite.
    const own = path.join(tests, "smoke-checks.yaml");
    writeFileSync(own, "name: QA smoke\nharness_slug: support\ntest_cases:\n  - name: Hours\n    steps:\n      - user_message: When are you open?\n");
    await applied(dir);
    expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
    expect(read(own)).toMatch(/^name: QA smoke/);

    const suite = suites().find((s) => s.name === "QA smoke")!;
    (suite.test_cases as Array<Record<string, unknown>>)[0]!.name = "Opening hours";
    const pull = await cli(sb, ["pull", "--json"], { cwd: dir });
    expect(pull.code, pull.stderr).toBe(0);
    const files = pull.json<{ files: { written: string[]; removed: string[] } }>().files;
    expect(files.written).toContain("tests/smoke-checks.yaml");
    expect(files.removed).toEqual([]);
    expect(readdirSync(tests)).not.toContain("qa-smoke.yaml");
    expect(read(own)).toMatch(/name: Opening hours/);
    const state = JSON.parse(read(path.join(dir, ".cavelon", "pulled-files.json"))) as { items: Record<string, Record<string, string>> };
    expect(state.items.test_suites).toMatchObject({ "QA smoke": "smoke-checks.yaml" });
  });

  it("a suite pull has not seen yet gets a file named after it; one deleted on the instance loses its file", async () => {
    const dir = await pulled();
    suites().push({ name: "Late arrivals", harness_slug: "support", test_cases: [] });
    suites().splice(0, 1);
    const pull = await cli(sb, ["pull", "--json"], { cwd: dir });
    const files = pull.json<{ files: { written: string[]; removed: string[] } }>().files;
    expect(files.written).toContain("tests/late-arrivals.yaml");
    expect(files.removed).toEqual(["tests/smoke.yaml"]);
  });
});

describe("tenant-wide sections", () => {
  it("a solution's pull leaves them out unless --include-tenant-wide, and keeps a file of one that is there, with a warning", async () => {
    const dir = await pulled();
    const pkgDir = path.join(dir, "package");
    expect(existsSync(path.join(pkgDir, "tenant_settings.yaml"))).toBe(false);
    expect(existsSync(path.join(pkgDir, "model_registry.yaml"))).toBe(false);
    expect(existsSync(path.join(pkgDir, "agents.yaml"))).toBe(true);

    const asked = await cli(sb, ["pull", "--include-tenant-wide", "--json"], { cwd: dir });
    expect(asked.code, asked.stderr).toBe(0);
    expect(asked.json<{ files: { written: string[]; tenant_wide: string[] } }>().files).toMatchObject({
      written: expect.arrayContaining(["package/model_registry.yaml", "package/tenant_settings.yaml"]),
      tenant_wide: [],
    });

    const again = await cli(sb, ["pull"], { cwd: dir });
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain("Left out the tenant-wide sections kb_orders, model_registry, model_role_defaults, realtime_config, telephony_config, tenant_settings (--include-tenant-wide writes them).");
    expect(again.stderr).toMatch(/Kept package\/tenant_settings\.yaml as it is: it holds a tenant-wide section/);
    expect(existsSync(path.join(pkgDir, "tenant_settings.yaml"))).toBe(true);
  });

  it("--include-tenant-wide asks the export for them where the instance takes include_tenant_wide, and fills kept", async () => {
    server.state.requests.length = 0;
    const dir = await pulled();
    expect(exportsAsked()).toEqual([null]);
    const asked = await cli(sb, ["pull", "--include-tenant-wide", "--json"], { cwd: dir });
    expect(asked.code, asked.stderr).toBe(0);
    expect(exportsAsked()).toEqual([null, "true"]);
    expect(asked.json<{ tenant_wide_pulled: string[] }>().tenant_wide_pulled).toEqual(expect.arrayContaining(["tenant_settings", "model_registry"]));

    // Without the flag the export no longer carries them; the files stay, and say so in kept.
    const again = await cli(sb, ["pull", "--json"], { cwd: dir });
    expect(again.code, again.stderr).toBe(0);
    const files = again.json<{ files: { kept: string[]; tenant_wide: string[]; removed: string[] } }>().files;
    expect(files.kept).toEqual(expect.arrayContaining(["package/tenant_settings.yaml", "package/model_registry.yaml"]));
    expect(files.tenant_wide).toEqual(expect.arrayContaining(["tenant_settings", "model_registry"]));
    expect(files.removed).toEqual([]);
    expect(again.stderr).toMatch(/Kept package\/tenant_settings\.yaml as it is: it holds a tenant-wide section, which pull leaves out of a solution's folder\. apply leaves it out too/);
    expect(again.stderr).not.toMatch(/tenant_settings\.yaml: its section is not in this instance's package schema/);
  });

  it("an empty --include-tenant-wide pull says so", async () => {
    const dir = await pulled();
    const config = server.state.configs.get(tenant)!;
    for (const section of ["tenant_settings", "model_registry", "model_role_defaults", "realtime_config", "telephony_config", "kb_orders"]) delete config.pkg[section];
    const asked = await cli(sb, ["pull", "--include-tenant-wide"], { cwd: dir });
    expect(asked.code, asked.stderr).toBe(0);
    expect(asked.stdout).toContain("The export carries no tenant-wide sections, so --include-tenant-wide wrote none.");
  });

  it("on an older instance, whose export carries them always, pull leaves them out and --include-tenant-wide asks nothing more", async () => {
    const box = await olderInstance();
    try {
      server.state.requests.length = 0;
      const dir = await pulled(box);
      expect(existsSync(path.join(dir, "package", "tenant_settings.yaml"))).toBe(false);
      const asked = await cli(box, ["pull", "--include-tenant-wide"], { cwd: dir });
      expect(asked.code, asked.stderr).toBe(0);
      expect(exportsAsked()).toEqual([null, null]);
      expect(existsSync(path.join(dir, "package", "tenant_settings.yaml"))).toBe(true);
    } finally {
      box.cleanup();
    }
  });

  it("apply leaves them out of a solution's import unless --include-tenant-wide, which a person sees first", async () => {
    const dir = await pulled(sb, ["--include-tenant-wide"]);
    const config = server.state.configs.get(tenant)!;
    config.pkg.tenant_settings = { default_guardrail_slugs: [] };
    writeFileSync(path.join(dir, "package", "tenant_settings.yaml"), "default_guardrail_slugs:\n  - pii\n");

    const validated = await cli(sb, ["validate", "--json"], { cwd: dir });
    expect(validated.code, validated.stdout).toBe(0);
    const warned = validated.json<{ findings: Array<{ code: string; file?: string }> }>().findings.filter((f) => f.code === "tenant_wide_section");
    expect(warned.map((f) => f.file)).toEqual(expect.arrayContaining(["package/tenant_settings.yaml", "package/model_registry.yaml"]));
    expect((await cli(sb, ["explain", "tenant_wide_section"], { cwd: dir })).stdout).toContain("cavelon apply --include-tenant-wide");

    server.state.requests.length = 0;
    const plain = await cli(sb, ["apply", "--json"], { cwd: dir });
    expect(plain.code, plain.stderr).toBe(0);
    expect(importBodies()[0]).not.toHaveProperty("include_tenant_wide");
    const left = plain.json<{ tenant_wide: { left_out: string[]; imported: string[] }; show_to_person: boolean; preview_id: string }>();
    expect(left.tenant_wide).toMatchObject({ left_out: expect.arrayContaining(["tenant_settings"]), imported: [] });
    expect(left.show_to_person).toBe(false);
    const text = await cli(sb, ["apply"], { cwd: dir });
    expect(text.stdout).toMatch(/tenant-wide: .*tenant_settings.* left out \(`cavelon apply --include-tenant-wide` imports them, for every solution of the tenant\)/);
    const kept = await cli(sb, ["apply", "--confirm", left.preview_id], { cwd: dir });
    expect(kept.code, kept.stderr).toBe(0);
    expect(server.state.configs.get(tenant)!.pkg.tenant_settings).toEqual({ default_guardrail_slugs: [] });

    server.state.requests.length = 0;
    const asked = await cli(sb, ["apply", "--include-tenant-wide", "--json"], { cwd: dir });
    expect(asked.code, asked.stderr).toBe(0);
    expect(importBodies()[0]).toMatchObject({ include_tenant_wide: true });
    const shown = asked.json<{ tenant_wide: { imported: string[] }; show_to_person: boolean; preview_id: string }>();
    expect(shown.tenant_wide.imported).toEqual(expect.arrayContaining(["tenant_settings"]));
    expect(shown.show_to_person).toBe(true);
    expect(asked.stderr).toMatch(/package\/tenant_settings\.yaml.* the whole tenant shares: this import changes .*tenant_settings.* for every solution of the tenant\./);
    const human = await cli(sb, ["apply", "--include-tenant-wide"], { cwd: dir });
    expect(human.stdout).toMatch(/This changes what the whole tenant shares \(.*tenant_settings.*\): show this preview to a person before confirming\./);
    const done = await cli(sb, ["apply", "--confirm", shown.preview_id], { cwd: dir });
    expect(done.code, done.stderr).toBe(0);
    expect(importBodies().at(-1)).toMatchObject({ include_tenant_wide: true, preview_id: shown.preview_id });
    expect(server.state.configs.get(tenant)!.pkg.tenant_settings).toEqual({ default_guardrail_slugs: ["pii"] });
  });

  it("shows the preview's own tenant_wide report: left out, or applied with the active solutions it reaches; confirm replays the flag", async () => {
    const dir = await pulled(sb, ["--include-tenant-wide"]);
    const support = server.state.harnesses.find((h) => h.tenant_id === tenant && h.slug === "support")!;
    const status = support.status;
    support.status = "active";
    try {
      server.state.requests.length = 0;
      const plain = await cli(sb, ["apply", "--json"], { cwd: dir });
      expect(plain.code, plain.stderr).toBe(0);
      type Report = { sections: string[]; applied: boolean; imported: string[]; left_out: string[]; reaches_active_solutions: string[]; reported_by: string };
      const left = plain.json<{ tenant_wide: Report; warnings: string[] }>();
      expect(left.tenant_wide).toMatchObject({ applied: false, imported: [], reaches_active_solutions: [], reported_by: "instance" });
      expect(left.tenant_wide.left_out).toEqual(expect.arrayContaining(["tenant_settings", "model_registry"]));
      expect(left.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^This solution import leaves tenant_settings out/)]));

      const asked = await cli(sb, ["apply", "--include-tenant-wide", "--json"], { cwd: dir });
      expect(asked.code, asked.stderr).toBe(0);
      expect(importBodies().at(-1)).toMatchObject({ include_tenant_wide: true });
      const shown = asked.json<{ tenant_wide: Report; show_to_person: boolean; preview_id: string }>();
      expect(shown.tenant_wide).toMatchObject({ applied: true, left_out: [], reaches_active_solutions: ["support"], reported_by: "instance" });
      expect(shown.tenant_wide.imported).toEqual(shown.tenant_wide.sections);
      expect(shown.show_to_person).toBe(true);
      // The stored preview holds the flag, so its confirm sends the request the preview id was made for.
      const stored = JSON.parse(read(path.join(dir, ".cavelon", "previews", `${shown.preview_id}.json`))) as { request: Record<string, unknown> };
      expect(stored.request.include_tenant_wide).toBe(true);

      const human = await cli(sb, ["apply", "--include-tenant-wide"], { cwd: dir });
      expect(human.stdout).toMatch(/^tenant-wide: .*tenant_settings.* change for every solution of the tenant, reaching the active solution support$/m);
      expect(human.stdout).toMatch(/This changes what the whole tenant shares \(.*\), reaching the active solution support: show this preview to a person before confirming\./);

      server.state.requests.length = 0;
      const done = await cli(sb, ["apply", "--confirm", shown.preview_id], { cwd: dir });
      expect(done.code, done.stderr).toBe(0);
      expect(importBodies()).toEqual([expect.objectContaining({ include_tenant_wide: true, preview_id: shown.preview_id })]);
      expect(done.stdout).toMatch(/^tenant-wide: .*tenant_settings.*, for every solution of the tenant \(active: support\)$/m);
    } finally {
      support.status = status;
    }
  });

  it("reads the package files where the preview reports no tenant_wide", async () => {
    const dir = await pulled(sb, ["--include-tenant-wide"]);
    server.state.tenantWideReport = false;
    const plain = await cli(sb, ["apply", "--json"], { cwd: dir });
    expect(plain.code, plain.stderr).toBe(0);
    expect(plain.json<{ tenant_wide: Record<string, unknown> }>().tenant_wide).toMatchObject({
      applied: false,
      left_out: expect.arrayContaining(["tenant_settings", "model_registry"]),
      reaches_active_solutions: [],
      reported_by: "kit",
    });
  });

  it("still takes --tenant-wide, the flag's name in 0.1.7, with a warning", async () => {
    const dir = await pulled(sb, ["--tenant-wide"]);
    expect(existsSync(path.join(dir, "package", "tenant_settings.yaml"))).toBe(true);
    server.state.requests.length = 0;
    const asked = await cli(sb, ["apply", "--tenant-wide"], { cwd: dir });
    expect(asked.code, asked.stderr).toBe(0);
    expect(importBodies()[0]).toMatchObject({ include_tenant_wide: true });
    expect(asked.stderr).toContain("--tenant-wide is now --include-tenant-wide; --tenant-wide is still taken for now and will be refused in a later release.");
  });

  it("validate says that a finding in a tenant-wide file concerns what a solution's apply leaves out", async () => {
    const dir = await pulled(sb, ["--include-tenant-wide"]);
    writeFileSync(
      path.join(dir, "package", "model_registry.yaml"),
      "- model_id: llama-70b\n  display_name: Llama 70B\n  provider: openai\n  max_concurrent_requests: 4\n",
    );
    const validated = await cli(sb, ["validate", "--json", "--offline"], { cwd: dir });
    const findings = validated.json<{ findings: Array<{ code: string; message: string; file?: string }> }>().findings;
    const limit = findings.find((f) => f.code === "model_endpoint_limit_without_base_url");
    expect(limit?.file).toBe("package/model_registry.yaml");
    expect(limit?.message).toMatch(
      /without a base_url; .* model_registry is tenant-wide: a solution's apply leaves it out unless --include-tenant-wide, which changes it for every solution of the tenant\.$/,
    );
    // The tenant_wide_section warning says it once already; it gets no second note.
    const section = findings.find((f) => f.code === "tenant_wide_section" && f.file === "package/model_registry.yaml");
    expect(section?.message).not.toMatch(/is tenant-wide: a solution's apply/);
    expect((await cli(sb, ["explain", "model_endpoint_limit_without_base_url"], { cwd: dir })).stdout).toContain("apply sends model_registry only with --include-tenant-wide");
  });

  it("names the file when the instance blocks on a tenant-wide section the import leaves out", async () => {
    const dir = await pulled(sb, ["--include-tenant-wide"]);
    server.state.previewBlockers = ["tenant_settings.default_guardrail_slugs references missing guardrail 'pii'."];
    server.state.previewExtras = {
      blocker_details: [{ code: "reference_missing", message: "references missing guardrail 'pii'.", path: "tenant_settings.default_guardrail_slugs", hint: null }],
    };
    try {
      const blocked = await cli(sb, ["apply"], { cwd: dir });
      expect(blocked.code).toBe(3);
      expect(blocked.stdout).toContain(
        "hint: A blocker is in package/tenant_settings.yaml, which this import leaves out (tenant-wide); the instance checks it anyway: remove the file, or fix it.",
      );
    } finally {
      server.state.previewBlockers = [];
      server.state.previewExtras = {};
    }
  });

  it("on an older instance, apply says the import takes them anyway, and sends no flag", async () => {
    const box = await olderInstance();
    try {
      const dir = await pulled(box, ["--include-tenant-wide"]);
      server.state.requests.length = 0;
      const preview = await cli(box, ["apply", "--json"], { cwd: dir });
      expect(preview.code, preview.stderr).toBe(0);
      expect(importBodies()[0]).not.toHaveProperty("include_tenant_wide");
      expect(preview.stderr).toMatch(/this instance does not publish include_tenant_wide and imports them with every solution's package\); remove the file unless that is meant\./);
      expect(preview.json<{ show_to_person: boolean; tenant_wide: { imported: string[] } }>()).toMatchObject({
        show_to_person: true,
        tenant_wide: { imported: expect.arrayContaining(["tenant_settings"]) },
      });
    } finally {
      box.cleanup();
    }
  });

  it("the tenant's full configuration keeps them", async () => {
    const dir = path.join(sb.home, `full-${++dirCount}`);
    mkdirSync(dir);
    expect((await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--harness", "support"], { cwd: dir })).code).toBe(0);
    writeFileSync(path.join(dir, "cavelon.yaml"), read(path.join(dir, "cavelon.yaml")).replace(/^harness: .*\n/m, ""));
    const pull = await cli(sb, ["pull"], { cwd: dir });
    expect(pull.code, pull.stderr).toBe(0);
    expect(existsSync(path.join(dir, "package", "tenant_settings.yaml"))).toBe(true);
  });

  it("follows the sections an instance marks x-cavelon-scope: tenant", async () => {
    const box = sandbox();
    try {
      await login(box, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
      server.state.packageSchemaEdit = (s) => {
        const properties = s.properties as Record<string, Record<string, unknown>>;
        properties.model_registry!["x-cavelon-scope"] = "solution";
        delete properties.tenant_settings!["x-cavelon-scope"];
      };
      const dir = await pulled(box);
      expect(existsSync(path.join(dir, "package", "model_role_defaults.yaml"))).toBe(false);
      expect(existsSync(path.join(dir, "package", "model_registry.yaml"))).toBe(true);
      expect(existsSync(path.join(dir, "package", "tenant_settings.yaml"))).toBe(true);
    } finally {
      box.cleanup();
    }
  });
});
