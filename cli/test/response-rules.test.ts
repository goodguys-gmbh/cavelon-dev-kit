import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { samplePackage, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

const RULES = {
  identity: "off", citations: "inherit", images: "off", action_buttons: "off",
  response_style: "off", language_hint: "off", plain_language: "off",
};
let server: FakeServer;
let sb: Sandbox;
let tenant: string;
let sequence = 0;

beforeAll(async () => {
  server = await startFakeServer();
  sb = sandbox();
  sb.env.CAVELON_CONTRACT_TTL_SECONDS = "0";
  tenant = server.addTenant("acme", "Acme");
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
  expect((await cli(sb, ["harness", "new", "support", "--name", "Support"])).code).toBe(0);
});
afterAll(async () => {
  sb.cleanup();
  await server.close();
});
beforeEach(() => {
  server.state.responseRules = true;
  server.state.configs.clear();
  server.state.requests.length = 0;
});

async function solution(): Promise<string> {
  const dir = path.join(sb.home, `rules-${++sequence}`);
  mkdirSync(dir);
  expect((await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--harness", "support"], { cwd: dir })).code).toBe(0);
  expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
  return dir;
}
function write(dir: string, section: string, value: unknown): void {
  writeFileSync(path.join(dir, "package", `${section}.yaml`), JSON.stringify(value));
}
function read(dir: string, section: string): any {
  return parse(readFileSync(path.join(dir, "package", `${section}.yaml`), "utf8"));
}
function configured(): Record<string, unknown> {
  const pkg = samplePackage();
  pkg.persona = { bot_name: "Support", greeting_enabled: false, fallback_message_enabled: false, plain_language: "lay" };
  (pkg.agents as Array<Record<string, unknown>>)[0]!.response_rules = RULES;
  return pkg;
}

const unknownFields = (result: Awaited<ReturnType<typeof cli>>) => result.json<{ findings: Array<{ code: string; path: string; severity: string }> }>().findings.filter((f) => f.code === "package_field_unknown");

describe("response rules from the instance's contracts", () => {
  it("validates the documented consultant and report-only wording check", async () => {
    const blocks = (file: URL) => [...readFileSync(file, "utf8").matchAll(/```yaml\n([\s\S]*?)\n```/g)].map((match) => parse(match[1]!));
    const [rules, persona, suite] = blocks(new URL("../../plugin/skills/cavelon-authoring/references/response-rules.md", import.meta.url));
    const [consultants, link] = blocks(new URL("../../examples/support-faq/README.md", import.meta.url));
    const pkg = configured();
    const agents = pkg.agents as Array<Record<string, unknown>>;
    agents[0]!.response_rules = rules.response_rules;
    agents[0]!.handoffs = link.handoffs;
    agents.push(...consultants.map((agent: Record<string, unknown>) => ({ ...agent, harness_slug: "support", skill_assignments: [{ skill_slug: "faq" }] })));
    const dir = await solution();
    write(dir, "agents", agents);
    write(dir, "persona", { ...pkg.persona as object, ...persona });
    writeFileSync(path.join(dir, "tests", "plain-wording.yaml"), JSON.stringify({ name: "Plain wording", harness_slug: "support", ...suite }));
    const result = await cli(sb, ["validate", "--json"], { cwd: dir });
    expect(result.code, result.stdout).toBe(0);
    expect(result.json<{ findings: Array<{ severity: string }> }>().findings.filter((f) => f.severity === "error")).toEqual([]);
    const assertion = suite.test_cases[0].steps[0].evaluation_criteria.find((criterion: { type?: string }) => criterion.type === "must_not_contain");
    expect(assertion).toMatchObject({ gate: false, scope: "model_answer", match: "regex" });
    const longSentence = new RegExp(assertion.value, "u");
    expect(longSentence.test("Please send the unused item back within thirty days.")).toBe(false);
    expect(longSentence.test(Array(26).fill("word").join(" ") + ".")).toBe(true);
    expect(longSentence.test(Array(30).fill("Short sentence.").join(" "))).toBe(false);
  });

  it("sends explicit off and an empty override map to reset saved settings", async () => {
    server.state.configs.set(tenant, { pkg: configured(), version: 1 });
    const dir = await solution();
    write(dir, "persona", { plain_language: "off", greeting_enabled: false, fallback_message_enabled: false });
    const agents = read(dir, "agents") as Array<Record<string, unknown>>;
    agents[0]!.response_rules = {};
    write(dir, "agents", agents);
    const preview = await cli(sb, ["apply", "--json"], { cwd: dir });
    expect(preview.code, preview.stdout).toBe(0);
    const sent = server.state.requests.find((r) => r.path === "/api/v1/agent-graph/import/preview")!.body as { package: Record<string, any> };
    expect(sent.package.persona.plain_language).toBe("off");
    expect(sent.package.agents[0].response_rules).toEqual({});
    const applied = await cli(sb, ["apply", "--confirm", preview.json<{ preview_id: string }>().preview_id, "--json"], { cwd: dir });
    expect(applied.code, applied.stdout).toBe(0);
    const stored = server.state.configs.get(tenant)!.pkg;
    expect(stored.persona).toMatchObject({ plain_language: "off" });
    expect((stored.agents as Array<Record<string, unknown>>)[0]!.response_rules).toEqual({});
  });

  it("omits unset fields so an import keeps the instance's saved settings", async () => {
    server.state.configs.set(tenant, { pkg: configured(), version: 1 });
    const dir = await solution();
    write(dir, "persona", { bot_name: "Updated", greeting_enabled: false, fallback_message_enabled: false });
    const agents = read(dir, "agents") as Array<Record<string, unknown>>;
    delete agents[0]!.response_rules;
    write(dir, "agents", agents);
    const preview = await cli(sb, ["apply", "--json"], { cwd: dir });
    expect(preview.code, preview.stdout).toBe(0);
    const applied = await cli(sb, ["apply", "--confirm", preview.json<{ preview_id: string }>().preview_id, "--json"], { cwd: dir });
    expect(applied.code, applied.stdout).toBe(0);
    const sent = server.state.requests.find((r) => r.path === "/api/v1/agent-graph/import")!.body as { package: Record<string, any> };
    expect(sent.package.persona).not.toHaveProperty("plain_language");
    expect(sent.package.agents[0]).not.toHaveProperty("response_rules");
    const stored = server.state.configs.get(tenant)!.pkg;
    expect(stored.persona).toMatchObject({ bot_name: "Updated", plain_language: "lay" });
    expect((stored.agents as Array<Record<string, unknown>>)[0]!.response_rules).toEqual(RULES);
  });

  it("warns and lists ignored fields on an older instance, keeping the local values", async () => {
    server.state.responseRules = false;
    const dir = await solution();
    expect(readFileSync(path.join(dir, "package", "persona.yaml"), "utf8")).not.toContain("# plain_language:");
    const pkg = configured();
    write(dir, "persona", pkg.persona);
    write(dir, "agents", pkg.agents);
    const valid = await cli(sb, ["validate", "--json"], { cwd: dir });
    expect(valid.code, valid.stdout).toBe(0);
    expect(unknownFields(valid)).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "warning", path: "persona.plain_language" }),
      expect.objectContaining({ severity: "warning", path: "agents[0].response_rules" }),
    ]));
    expect((await cli(sb, ["validate", "--strict", "--json"], { cwd: dir })).code).toBe(3);
    const preview = await cli(sb, ["apply", "--json"], { cwd: dir });
    expect(preview.code, preview.stdout).toBe(0);
    expect(preview.json<{ ignored: { fields: string[] } }>().ignored.fields).toEqual(["persona.plain_language", "agents[0].response_rules"]);
    const text = await cli(sb, ["apply"], { cwd: dir });
    expect(text.stdout).toMatch(/ignored.*persona\.plain_language.*agents\[0\]\.response_rules/);
    expect(read(dir, "persona").plain_language).toBe("lay");
    expect(read(dir, "agents")[0].response_rules).toEqual(RULES);
    const imported = await cli(sb, ["apply", "--confirm", preview.json<{ preview_id: string }>().preview_id, "--json"], { cwd: dir });
    expect(imported.code, imported.stdout).toBe(0);
    const stored = server.state.configs.get(tenant)!.pkg;
    expect(stored.persona).not.toHaveProperty("plain_language");
    expect((stored.agents as Array<Record<string, unknown>>)[0]).not.toHaveProperty("response_rules");
  });

  it.each([true, false])("discovers API request fields for response-rule support=%s", async (supported) => {
    server.state.responseRules = supported;
    const doc = await fetch(`${server.url}/openapi.json`).then((response) => response.json()) as { components: { schemas: Record<string, { properties: Record<string, unknown> }> } };
    const schemas = doc.components.schemas;
    expect("plain_language" in schemas.BotPersonaSchema!.properties).toBe(supported);
    for (const name of ["AgentDefinitionCreate", "AgentDefinitionUpdate"]) expect("response_rules" in schemas[name]!.properties).toBe(supported);
    const described = await cli(sb, ["api", "describe", "update_agent_definition", "--json"]);
    expect(described.code, described.stdout).toBe(0);
    expect(JSON.stringify(described.json()).includes('"response_rules"')).toBe(supported);
  });

  it("discovers the persona levels and the agent's open override map", async () => {
    const persona = await cli(sb, ["schema", "persona", "--json"]);
    expect(persona.code).toBe(0);
    const fields = persona.json<{ fields: Array<{ name: string; enum?: string[] }> }>().fields;
    expect(fields.find((f) => f.name === "plain_language")?.enum).toEqual(["off", "on_request", "auto", "lay", "expert"]);
    const agents = await cli(sb, ["schema", "agents", "--json"]);
    expect(agents.json<{ fields: Array<{ name: string }> }>().fields.map((f) => f.name)).toContain("response_rules");
  });

  it("pulls, formats, previews and imports both fields without changing their values", async () => {
    server.state.configs.set(tenant, { pkg: configured(), version: 1 });
    const dir = await solution();
    expect(read(dir, "persona").plain_language).toBe("lay");
    expect(read(dir, "agents")[0].response_rules).toEqual(RULES);
    expect((await cli(sb, ["fmt"], { cwd: dir })).code).toBe(0);
    const valid = await cli(sb, ["validate", "--json"], { cwd: dir });
    expect(valid.code, valid.stdout).toBe(0);
    expect(unknownFields(valid)).toEqual([]);
    expect(read(dir, "persona").plain_language).toBe("lay");
    expect(read(dir, "agents")[0].response_rules).toEqual(RULES);
    const preview = await cli(sb, ["apply", "--json"], { cwd: dir });
    expect(preview.code, preview.stdout).toBe(0);
    const request = server.state.requests.find((r) => r.path === "/api/v1/agent-graph/import/preview")!.body as { package: Record<string, any> };
    expect(request.package.persona.plain_language).toBe("lay");
    expect(request.package.agents[0].response_rules).toEqual(RULES);
    const applied = await cli(sb, ["apply", "--confirm", preview.json<{ preview_id: string }>().preview_id, "--json"], { cwd: dir });
    expect(applied.code, applied.stdout).toBe(0);
    expect(server.state.configs.get(tenant)!.pkg.persona).toMatchObject({ plain_language: "lay" });
    expect((server.state.configs.get(tenant)!.pkg.agents as Array<Record<string, unknown>>)[0]!.response_rules).toEqual(RULES);
  });

  it("checks the published plain-language enum, while leaving an open rule map to the instance", async () => {
    const dir = await solution();
    write(dir, "persona", { plain_language: "always" });
    const bad = await cli(sb, ["validate", "--json"], { cwd: dir });
    expect(bad.code).toBe(3);
    expect(bad.json<{ findings: unknown[] }>().findings).toContainEqual(expect.objectContaining({ code: "package_schema_invalid", path: "persona.plain_language" }));
    write(dir, "persona", { plain_language: "expert", greeting_enabled: false, fallback_message_enabled: false });
    const agents = samplePackage().agents as Array<Record<string, unknown>>;
    agents[0]!.response_rules = { ...RULES, future_rule: "inherit" };
    write(dir, "agents", agents);
    const valid = await cli(sb, ["validate", "--json"], { cwd: dir });
    expect(valid.code).toBe(0);
    expect(unknownFields(valid)).toEqual([]);
  });
});
