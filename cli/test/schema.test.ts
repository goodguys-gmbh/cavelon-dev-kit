import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

let server: FakeServer;
let sb: Sandbox;
let tenant: string;

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
});
afterAll(async () => {
  sb.cleanup();
  await server.close();
});

describe("schema", () => {
  it("lists the sections the published schema holds, with the file each is kept in", async () => {
    const result = await cli(sb, ["schema", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const data = result.json<{ schema: { package_version: string }; sections: Array<{ section: string; kind: string; required: boolean; file: string }> }>();
    expect(data.schema.package_version).toBe("v3");
    expect(data.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ section: "agents", kind: "list", required: false, file: "package/agents.yaml" }),
        expect.objectContaining({ section: "manifest", kind: "object", required: true }),
      ]),
    );
    const text = await cli(sb, ["schema"]);
    expect(text.stdout).toMatch(/^SECTION\s+KIND\s+REQUIRED\s+FILE$/m);
    expect(text.stdout).toContain("cavelon schema <section>");
  });

  it("shows one section's fields and the smallest entry with every required field", async () => {
    const result = await cli(sb, ["schema", "agents", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const data = result.json<{ kind: string; entry: string; fields: Array<{ name: string; required: boolean }>; example: Array<Record<string, unknown>> }>();
    expect(data).toMatchObject({ kind: "list", entry: "PackageAgent" });
    const required = data.fields.filter((f) => f.required).map((f) => f.name);
    expect(required).toEqual(expect.arrayContaining(["slug", "name", "llm_model"]));
    expect(data.example).toHaveLength(1);
    expect(Object.keys(data.example[0]!).sort()).toEqual([...required].sort());
    expect(data.example[0]!.slug).toBe("<slug>");

    const text = await cli(sb, ["schema", "agents"]);
    expect(text.stdout).toMatch(/^FIELD\s+TYPE\s+REQUIRED\s+NOTES$/m);
    expect(text.stdout).toContain("Minimal example (required fields only):");
    // The example is YAML a file can take as it is.
    const yaml = text.stdout.slice(text.stdout.indexOf("Minimal example"));
    const parsed = parse(yaml.slice(yaml.indexOf("\n") + 1)) as Array<Record<string, unknown>>;
    expect(parsed[0]).toMatchObject({ slug: "<slug>", name: "<name>" });

    // An object section, with a constant and nested values filled from the schema.
    const manifest = (await cli(sb, ["schema", "manifest", "--json"])).json<{ kind: string; example: Record<string, unknown> }>();
    expect(manifest).toMatchObject({ kind: "object", example: { package_version: "v3", exported_at: "<exported_at>" } });
  });

  it("names the closest sections for one it does not know (exit 2)", async () => {
    const result = await cli(sb, ["schema", "agent", "--json"]);
    expect(result.code).toBe(2);
    expect(result.json<{ error: { hint: string } }>().error.hint).toMatch(/Did you mean: agents/);
  });

  it("works offline from the cached copy, and names the file of an item folder", async () => {
    expect((await cli(sb, ["schema"])).code).toBe(0);
    const dir = path.join(sb.home, "sol");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "cavelon.yaml"), `instance: ${server.url}\nlayout:\n  items:\n    test_suites: tests\n`);
    server.state.requests.length = 0;
    const result = await cli(sb, ["schema", "test_suites", "--offline", "--json"], { cwd: dir });
    expect(result.code, result.stderr).toBe(0);
    expect(result.json()).toMatchObject({ file: "tests/<one file per entry>.yaml", schema: { source: "cache" } });
    expect(server.state.requests).toHaveLength(0);
  });
});
