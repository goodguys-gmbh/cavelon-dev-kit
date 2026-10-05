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
});

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
  it("a solution's pull leaves them out unless --tenant-wide, and keeps a file of one that is there, with a warning", async () => {
    const dir = await pulled();
    const pkgDir = path.join(dir, "package");
    expect(existsSync(path.join(pkgDir, "tenant_settings.yaml"))).toBe(false);
    expect(existsSync(path.join(pkgDir, "model_registry.yaml"))).toBe(false);
    expect(existsSync(path.join(pkgDir, "agents.yaml"))).toBe(true);

    const asked = await cli(sb, ["pull", "--tenant-wide", "--json"], { cwd: dir });
    expect(asked.code, asked.stderr).toBe(0);
    expect(asked.json<{ files: { written: string[]; tenant_wide: string[] } }>().files).toMatchObject({
      written: expect.arrayContaining(["package/model_registry.yaml", "package/tenant_settings.yaml"]),
      tenant_wide: [],
    });

    const again = await cli(sb, ["pull"], { cwd: dir });
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain("Left out the tenant-wide sections model_registry, tenant_settings (--tenant-wide writes them).");
    expect(again.stderr).toMatch(/Kept package\/tenant_settings\.yaml as it is: it holds a tenant-wide section/);
    expect(existsSync(path.join(pkgDir, "tenant_settings.yaml"))).toBe(true);
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
        properties.model_role_defaults!["x-cavelon-scope"] = "tenant";
        properties.model_registry!["x-cavelon-scope"] = "solution";
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
