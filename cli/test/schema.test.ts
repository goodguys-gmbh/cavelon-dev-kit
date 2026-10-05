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
    const yaml = text.stdout.slice(text.stdout.indexOf("Minimal example"), text.stdout.indexOf("\n\nWith one entry of each nested list:"));
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

  it("reaches a nested type by its path or its name, with its required fields, allowed values and a minimal entry", async () => {
    type Field = { name: string; required: boolean; default?: unknown };
    const agents = (await cli(sb, ["schema", "agents", "--json"])).json<{ nested: Array<{ field: string; path: string; type: string }>; nested_example: Array<Record<string, unknown>> }>();
    expect(agents.nested).toEqual(expect.arrayContaining([{ field: "handoffs", path: "agents.handoffs", type: "list of PackageAgentHandoff" }]));
    // The example with one entry of each nested list: a handoff among them.
    expect(agents.nested_example[0]!.handoffs).toEqual([{ to_agent_slug: "<to_agent_slug>" }]);
    expect((await cli(sb, ["schema", "agents"])).stdout).toMatch(/^cavelon schema agents\.handoffs\s+list of PackageAgentHandoff$/m);

    const byPath = await cli(sb, ["schema", "agents.handoffs", "--json"]);
    expect(byPath.code, byPath.stderr).toBe(0);
    const handoffs = byPath.json<{ path: string; section: string; kind: string; entry: string; file: string; fields: Field[]; example: unknown[] }>();
    expect(handoffs).toMatchObject({ path: "agents.handoffs", section: "agents", kind: "list", entry: "PackageAgentHandoff", file: "package/agents.yaml" });
    expect(handoffs.fields.find((f) => f.name === "to_agent_slug")).toMatchObject({ required: true });
    expect(handoffs.fields.find((f) => f.name === "edge_type")).toMatchObject({ required: false, default: "handoff" });
    expect(handoffs.fields.map((f) => f.name)).toContain("description_override");
    expect(handoffs.example).toEqual([{ to_agent_slug: "<to_agent_slug>" }]);

    const byName = (await cli(sb, ["schema", "PackageAgentHandoff", "--json"])).json<{ used_in: string[]; fields: Field[] }>();
    expect(byName.used_in).toEqual(["agents.handoffs"]);
    expect(byName.fields).toEqual(handoffs.fields);
    expect((await cli(sb, ["schema", "PackageTestCase", "--json"])).json()).toMatchObject({ used_in: ["test_suites.test_cases"], file: "package/test_suites.yaml" });
  });

  it("calls a list of several shapes so, and never cuts a command in the nested fields' table", async () => {
    const steps = (await cli(sb, ["schema", "test_suites.test_cases.steps", "--json"])).json<{ fields: Array<{ name: string; type: string }>; nested: Array<{ type: string }> }>();
    // A text, a judge criterion and seven assertion types: not "list of string".
    expect(steps.fields.find((f) => f.name === "evaluation_criteria")!.type).toBe("list of 9 shapes");
    expect(steps.nested).toEqual([{ field: "evaluation_criteria", path: "test_suites.test_cases.steps.evaluation_criteria", type: "list of 9 shapes" }]);
    const text = (await cli(sb, ["schema", "test_suites.test_cases.steps"])).stdout;
    expect(text).toMatch(/^cavelon schema test_suites\.test_cases\.steps\.evaluation_criteria\s+list of 9 shapes$/m);
  });

  it("lists the allowed values of a field whose type the schema names, as an edge type would be", async () => {
    const box = sandbox();
    try {
      await login(box, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
      server.state.packageSchemaEdit = (schema) => {
        const defs = (schema as unknown as { $defs: Record<string, Record<string, any>> }).$defs;
        defs.EdgeType = { enum: ["handoff", "consult"], title: "EdgeType", type: "string" };
        defs.PackageAgentHandoff!.properties.edge_type = { $ref: "#/$defs/EdgeType", default: "handoff" };
      };
      const handoffs = (await cli(box, ["schema", "agents.handoffs", "--json"])).json<{ fields: Array<{ name: string; type: string; enum?: string[] }> }>();
      expect(handoffs.fields.find((f) => f.name === "edge_type")).toMatchObject({ type: "EdgeType", enum: ["handoff", "consult"] });
      expect((await cli(box, ["schema", "agents.handoffs"])).stdout).toMatch(/^edge_type\s+EdgeType\s+one of handoff, consult/m);
    } finally {
      server.state.packageSchemaEdit = null;
      box.cleanup();
    }
  });

  it("lists the fields of an object-or-null field, and words a field without any with the right article", async () => {
    const plain = await cli(sb, ["schema", "agents.model_settings_extra"]);
    expect(plain.code, plain.stderr).toBe(0);
    expect(plain.stdout).toContain("It is an object; there are no fields to list.");
    expect(plain.stdout).not.toMatch(/\ba object\b/);
    const box = sandbox();
    try {
      await login(box, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
      server.state.packageSchemaEdit = (schema) => {
        const defs = (schema as unknown as { $defs: Record<string, Record<string, any>> }).$defs;
        defs.PackageAgent!.properties.model_settings_extra = {
          anyOf: [
            { type: "object", properties: { reasoning_effort: { type: "string", examples: ["low", "medium", "high"] } }, additionalProperties: true },
            { type: "null" },
          ],
          default: null,
          title: "Model Settings Extra",
        };
      };
      const result = await cli(box, ["schema", "agents.model_settings_extra", "--json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.json<{ fields: Array<{ name: string; type: string }> }>().fields).toEqual([expect.objectContaining({ name: "reasoning_effort", type: "string" })]);
      expect((await cli(box, ["schema", "agents.model_settings_extra"])).stdout).toMatch(/^reasoning_effort\s+string/m);
      expect((await cli(box, ["schema", "agents"])).stdout).toMatch(/cavelon schema agents\.model_settings_extra/);
    } finally {
      server.state.packageSchemaEdit = null;
      box.cleanup();
    }
  });

  it("lists each shape an entry may take, as a step's criteria", async () => {
    const result = await cli(sb, ["schema", "test_suites.test_cases.steps.evaluation_criteria", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    type Shape = { type: string; fields: Array<{ name: string; enum?: string[] }>; example: Record<string, unknown> };
    const data = result.json<{ shapes: Shape[]; other_shapes: string[]; fields: unknown[] }>();
    expect(data.other_shapes).toEqual(["string"]);
    const routing = data.shapes.find((s) => s.type === "RoutingCriterion")!;
    expect(routing.fields.find((f) => f.name === "type")!.enum).toEqual(["answered_by", "handoff_to"]);
    expect(routing.example).toEqual({ type: "answered_by", value: "<value>" });
    expect(data.shapes.map((s) => s.type)).toEqual(expect.arrayContaining(["CriterionSpec", "ToolCriterion", "TextMatchCriterion"]));

    // A suite's example carries a case with a step and its criteria.
    const suites = (await cli(sb, ["schema", "test_suites", "--json"])).json<{ nested_example: Array<{ test_cases: Array<{ steps: Array<{ evaluation_criteria: unknown[] }> }> }> }>();
    const step = suites.nested_example[0]!.test_cases[0]!.steps[0]!;
    expect(step).toMatchObject({ user_message: "<user_message>" });
    expect(step.evaluation_criteria).toEqual(expect.arrayContaining(["<evaluation_criteria>", { text: "<text>" }]));
  });

  it("names the nested fields there are for a path it does not know (exit 2)", async () => {
    const result = await cli(sb, ["schema", "agents.handof", "--json"]);
    expect(result.code).toBe(2);
    const error = result.json<{ error: { message: string; hint: string } }>().error;
    expect(error.message).toBe('The package schema has no nested field "handof" under agents.');
    expect(error.hint).toMatch(/^Did you mean: agents\.handoffs\? Nested under agents: .*handoffs/);
    expect((await cli(sb, ["schema", "PackageNothing"])).code).toBe(2);
  });
});
