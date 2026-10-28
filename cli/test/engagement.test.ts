import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { COMMANDS } from "../src/commands/index.js";
import type { PackageSchema } from "../src/contracts.js";
import { liveFields, previewLiveFields, rulesChange } from "../src/engagement.js";
import { packageToSend, packageToWrite } from "../src/managed-fields.js";
import { sameSectionValue } from "../src/package-format.js";
import { pageOf } from "../src/commands/engagement.js";
import { samplePackage, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

const SCHEMA = JSON.parse(readFileSync(new URL("../../contracts/cavelon/meta-package-schema-v3.json", import.meta.url), "utf8")) as PackageSchema;

/** The package schema of an instance from before the rule kinds were described: a list of open objects, nothing live, no partial import. */
function olderSchema(schema: { properties: Record<string, unknown> }): void {
  const persona = (schema as unknown as { $defs: Record<string, { properties: Record<string, Record<string, unknown>> }> }).$defs.PackagePersona!.properties;
  persona.engagement_rules = { anyOf: [{ type: "array", items: { type: "object", additionalProperties: true } }, { type: "null" }], default: null, title: "Engagement Rules" };
  delete persona.engagement_rules_kinds;
  for (const field of Object.values(persona)) delete field["x-cavelon-live"];
}

const STARTERS = { id: "tarife", kind: "starters", name: "Tariffs", pages: { include: ["/tarife/**"] }, content: { starters: ["Which tariff fits me?"] } };
const CALENDAR = {
  id: "advent-2026",
  kind: "calendar",
  name: "Advent",
  window: { timezone: "Europe/Vienna" },
  content: { title: "Advent calendar", start_date: "2026-12-01", door_count: 24, doors: [{ day: 1, title: "Door one", question: "What is new?" }, { day: 2, title: "Door two" }] },
};
const BANNER = { id: "winter-offer", kind: "banner", name: "Winter offer", content: { layout: { elements: [{ id: "heading", type: "text", x: 5, y: 5, w: 90, h: 30, text: "Winter offer" }] } } };
const DECORATION = { id: "snow", kind: "decoration", name: "Snow", content: { effect: "snow" } };

let sb: Sandbox;
let server: FakeServer;
let tenant: string;
let harnessId: string;
let dirCount = 0;

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  sb = sandbox();
  sb.env.CAVELON_CONTRACT_TTL_SECONDS = "0";
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, mayActivate: true }));
  expect((await cli(sb, ["harness", "new", "support", "--name", "Support"])).code).toBe(0);
  harnessId = server.state.harnesses.find((h) => h.slug === "support")!.id;
});
afterAll(async () => {
  sb.cleanup();
  await server.close();
});
beforeEach(() => {
  server.state.configs.clear();
  server.state.previewExtras = {};
  server.state.packageSchemaEdit = null;
  server.state.openapiEdit = null;
  server.state.openapiWithout = [];
  server.state.personas.clear();
  server.state.requests.length = 0;
  const harness = server.state.harnesses.find((h) => h.id === harnessId)!;
  harness.status = "draft";
});

async function solution(yaml = ""): Promise<string> {
  const dir = path.join(sb.home, `engagement-${++dirCount}`);
  mkdirSync(dir, { recursive: true });
  const init = await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--harness", "support"], { cwd: dir });
  expect(init.code, init.stderr + init.stdout).toBe(0);
  expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
  if (yaml) writeFileSync(path.join(dir, "cavelon.yaml"), readFileSync(path.join(dir, "cavelon.yaml"), "utf8") + yaml);
  return dir;
}

function writePersona(dir: string, persona: Record<string, unknown>): void {
  writeFileSync(path.join(dir, "package", "persona.yaml"), JSON.stringify(persona, null, 2));
}

const importBodies = () => server.state.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/agent-graph/import/preview").map((r) => r.body as { package: Record<string, any> });

describe("validate and fmt read the rules from the package schema", () => {
  it("accepts every kind, and names a field or a kind the schema does not have", async () => {
    const dir = await solution();
    writePersona(dir, { engagement_rules: [STARTERS, CALENDAR, BANNER, DECORATION] });
    const valid = await cli(sb, ["validate", "--json"], { cwd: dir });
    expect(valid.code, valid.stdout).toBe(0);

    writePersona(dir, { engagement_rules: [{ ...BANNER, colour: "red" }, { ...DECORATION, kind: "decoratoin" }] });
    const invalid = await cli(sb, ["validate", "--json"], { cwd: dir });
    expect(invalid.code).toBe(3);
    const findings = invalid.json<{ findings: Array<{ code: string; message: string; path: string; suggestion?: string }> }>().findings;
    expect(findings).toContainEqual(expect.objectContaining({ code: "package_schema_invalid", message: 'field "colour" is not allowed here' }));
    expect(findings).toContainEqual(expect.objectContaining({ code: "package_schema_invalid", suggestion: "decoration" }));
    // One finding per mistake, not one per rule kind the value might have been.
    expect(findings.filter((f) => f.path.startsWith("persona.engagement_rules[0]"))).toHaveLength(1);
  });

  it("an older instance that does not describe the kinds takes any rule", async () => {
    server.state.packageSchemaEdit = olderSchema;
    const dir = await solution();
    writePersona(dir, { engagement_rules: [{ ...BANNER, colour: "red" }] });
    const result = await cli(sb, ["validate", "--json"], { cwd: dir });
    expect(result.code, result.stdout).toBe(0);
  });

  it("fmt writes a rule in the schema's order and keeps an empty list", async () => {
    const dir = await solution();
    writePersona(dir, { engagement_rules: [{ content: { starters: ["Hi?"] }, kind: "starters", id: "hi" }] });
    expect((await cli(sb, ["fmt"], { cwd: dir })).code).toBe(0);
    const rules = (parse(readFileSync(path.join(dir, "package", "persona.yaml"), "utf8")) as { engagement_rules: Array<Record<string, unknown>> }).engagement_rules;
    expect(Object.keys(rules[0]!).slice(0, 4)).toEqual(["id", "enabled", "name", "kind"]);

    writePersona(dir, { engagement_rules: [] });
    expect((await cli(sb, ["fmt"], { cwd: dir })).code).toBe(0);
    expect(parse(readFileSync(path.join(dir, "package", "persona.yaml"), "utf8"))).toMatchObject({ engagement_rules: [] });
  });

  it("[] removes the rules and a left-out list keeps them, so the two never compare equal", () => {
    expect(sameSectionValue("persona", { engagement_rules: [] }, {}, SCHEMA)).toBe(false);
    expect(sameSectionValue("persona", { engagement_rules: null }, {}, SCHEMA)).toBe(true);
    expect(sameSectionValue("persona", { engagement_rules: [STARTERS] }, { engagement_rules: [{ ...STARTERS, enabled: true, priority: 0 }] }, SCHEMA)).toBe(true);
  });
});

describe("cavelon.yaml's unmanaged fields and managed kinds", () => {
  const managed = { unmanaged: ["/persona/widget_title"], kinds: { "/persona/engagement_rules": ["starters"] } };

  it("apply sends only the managed kinds and names them; pull writes only them", () => {
    const pkg = { persona: { widget_title: "Help", engagement_rules: [STARTERS, CALENDAR] } };
    const sent = packageToSend(pkg, managed, SCHEMA);
    expect(sent.package.persona).toEqual({ engagement_rules: [STARTERS], engagement_rules_kinds: ["starters"] });
    expect(sent.left_out).toEqual(["/persona/widget_title"]);
    expect(sent.kinds).toEqual([{ pointer: "/persona/engagement_rules", kinds: ["starters"], sent: true, other_kinds_left_out: ["advent-2026"] }]);
    expect(packageToWrite(pkg, managed, SCHEMA).persona).toEqual({ engagement_rules: [STARTERS] });
    // The folder's own package is left as it is.
    expect(pkg.persona.engagement_rules).toHaveLength(2);
  });

  it("an instance that cannot import some kinds only gets no list at all", () => {
    const older = structuredClone(SCHEMA);
    olderSchema(older as unknown as { properties: Record<string, unknown> });
    const sent = packageToSend({ persona: { engagement_rules: [STARTERS] } }, managed, older);
    expect(sent.package.persona).toEqual({});
    expect(sent.kinds[0]).toMatchObject({ sent: false, reason: expect.stringContaining("engagement_rules_kinds") });
    expect(packageToWrite({ persona: { engagement_rules: [STARTERS] } }, managed, older).persona).toEqual({});
  });

  it("refuses a cavelon.yaml whose pointer is not a field inside a section", async () => {
    const dir = await solution("unmanaged:\n  - persona\n");
    const result = await cli(sb, ["validate", "--json"], { cwd: dir });
    expect(result.code).toBe(3);
    expect(result.json<{ error: { code: string } }>().error.code).toBe("project_file_invalid");
  });

  it("pull leaves the Admin's campaigns and unmanaged fields out of the folder", async () => {
    const dir = await solution("unmanaged:\n  - /persona/widget_title\nmanaged_kinds:\n  /persona/engagement_rules: [starters]\n");
    server.state.configs.set(tenant, { pkg: { ...samplePackage(), persona: { widget_title: "Help", engagement_rules: [STARTERS, CALENDAR, BANNER] } }, version: 2 });
    const pulled = await cli(sb, ["pull", "--force"], { cwd: dir });
    expect(pulled.code, pulled.stderr).toBe(0);
    expect(pulled.stdout).toContain("Left to the Admin, as cavelon.yaml says");
    const persona = parse(readFileSync(path.join(dir, "package", "persona.yaml"), "utf8")) as Record<string, unknown>;
    expect((persona.engagement_rules as Array<{ id: string }>).map((r) => r.id)).toEqual(["tarife"]);
    expect(persona.widget_title).toBeUndefined();
    // The instance is asked for the managed kinds only, where its export takes them.
    const exports = server.state.requests.filter((r) => r.path === "/api/v1/agent-graph/export");
    expect((exports.at(-1)!.query as URLSearchParams).getAll("engagement_rules_kinds")).toEqual(["starters"]);
  });

  it("apply imports the starters with their kinds, warns about the rest, and validate says why", async () => {
    const dir = await solution("unmanaged:\n  - /persona/widget_title\nmanaged_kinds:\n  /persona/engagement_rules: [starters]\n");
    writePersona(dir, { widget_title: "Help", engagement_rules: [STARTERS, BANNER] });
    const validate = await cli(sb, ["validate", "--json"], { cwd: dir });
    const codes = validate.json<{ findings: Array<{ code: string }> }>().findings.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["unmanaged_field_set", "managed_kinds_left_out"]));

    const preview = await cli(sb, ["apply", "--json"], { cwd: dir });
    expect(preview.code, preview.stdout).toBe(0);
    const sent = importBodies().at(-1)!.package.persona;
    expect(sent).toEqual({ engagement_rules: [STARTERS], engagement_rules_kinds: ["starters"] });
    expect(preview.json<{ managed: { left_out: string[] } }>().managed.left_out).toEqual(["/persona/widget_title"]);
    expect(preview.stderr).toContain("winter-offer");
  });

  it("on an older instance, apply leaves the rules out and the solution keeps all of them", async () => {
    server.state.packageSchemaEdit = olderSchema;
    const dir = await solution("managed_kinds:\n  /persona/engagement_rules: [starters]\n");
    writePersona(dir, { greeting_message: "Hello", engagement_rules: [STARTERS] });
    const validate = await cli(sb, ["validate", "--json"], { cwd: dir });
    expect(validate.json<{ findings: Array<{ code: string }> }>().findings.map((f) => f.code)).toContain("managed_kinds_unsupported");
    const preview = await cli(sb, ["apply", "--json"], { cwd: dir });
    expect(preview.code, preview.stdout).toBe(0);
    expect(importBodies().at(-1)!.package.persona).toEqual({ greeting_message: "Hello" });
    expect(preview.stderr).toContain("Left out /persona/engagement_rules");
  });
});

describe("the apply preview lists rules and says what reaches visitors at once", () => {
  it("lists the rules added, removed and changed, and warns about lost campaigns", async () => {
    const dir = await solution();
    server.state.personas.set(harnessId, { engagement_rules: [{ ...STARTERS, enabled: true, priority: 0 }, CALENDAR] });
    writePersona(dir, { engagement_rules: [{ ...STARTERS, content: { starters: ["Another question?"] } }, DECORATION] });
    const preview = await cli(sb, ["apply"], { cwd: dir });
    expect(preview.code, preview.stdout).toBe(0);
    expect(preview.stdout).toMatch(/engagement rules:\s*\n\s+\+ decoration snow "Snow"\n\s+- calendar advent-2026 "Advent"\n\s+~ starters tarife "Tariffs"/);
    expect(preview.stderr).toContain("removes 1 (calendar advent-2026");
    const json = await cli(sb, ["apply", "--json"], { cwd: dir });
    expect(json.json<{ engagement_rules: Array<{ removed: Array<{ id: string }> }> }>().engagement_rules[0]!.removed).toEqual([{ id: "advent-2026", kind: "calendar", name: "Advent" }]);
  });

  it("an empty list removes every rule; a left-out list is no rule change", async () => {
    const dir = await solution();
    server.state.personas.set(harnessId, { engagement_rules: [CALENDAR] });
    writePersona(dir, { engagement_rules: [] });
    const emptied = await cli(sb, ["apply", "--json"], { cwd: dir });
    expect(emptied.json<{ engagement_rules: Array<{ removed: unknown[] }> }>().engagement_rules[0]!.removed).toHaveLength(1);
    expect(importBodies().at(-1)!.package.persona).toEqual({ engagement_rules: [] });

    writePersona(dir, { greeting_message: "Hello" });
    const kept = await cli(sb, ["apply", "--json"], { cwd: dir });
    expect(kept.json<Record<string, unknown>>().engagement_rules).toBeUndefined();
    expect(importBodies().at(-1)!.package.persona).toEqual({ greeting_message: "Hello" });
  });

  const draftPreview = (extra: Record<string, unknown>) => ({
    publication: { target: "draft", harness_id: harnessId, published_version: 4, draft_revision: 2, ...extra },
  });

  it.each(["the instance reports them", "the kit reads them from the diff"])("on an active solution's draft, live persona fields need a person (%s)", async (how) => {
    server.state.harnesses.find((h) => h.id === harnessId)!.status = "active";
    const dir = await solution();
    writePersona(dir, { engagement_rules: [STARTERS] });
    server.state.previewExtras =
      how === "the instance reports them"
        ? { ...draftPreview({ live_fields: ["/persona/engagement_rules"] }), changes: [] }
        : { ...draftPreview({}), changes: [{ section: "persona", key: "support", action: "update", fields: [{ field: "engagement_rules" }] }] };
    const preview = await cli(sb, ["apply"], { cwd: dir });
    expect(preview.code, preview.stdout).toBe(0);
    expect(preview.stdout).toContain("live traffic stays on published v4. Except /persona/engagement_rules: persona widget fields reach visitors at once");
    expect(preview.stdout).toContain("visitors of the active solution support see at once");
    expect(preview.stdout).toContain("show this preview to a person");
    const data = (await cli(sb, ["apply", "--json"], { cwd: dir })).json<{ live_fields: { pointers: string[] }; show_to_person: boolean }>();
    expect(data.live_fields.pointers).toEqual(["/persona/engagement_rules"]);
    expect(data.show_to_person).toBe(true);
  });

  it("a draft change without live fields keeps live traffic on the published version", async () => {
    server.state.harnesses.find((h) => h.id === harnessId)!.status = "active";
    const dir = await solution();
    server.state.previewExtras = { ...draftPreview({ live_fields: [] }), changes: [] };
    const preview = await cli(sb, ["apply", "--json"], { cwd: dir });
    expect(preview.json<Record<string, unknown>>().live_fields).toBeUndefined();
    expect(preview.json<{ show_to_person: boolean }>().show_to_person).toBe(false);
  });

  it("reads the live fields from the schema, and the documented ones from an older one", () => {
    const marked = liveFields(SCHEMA);
    expect(marked.marked).toBe(true);
    expect(marked.fields).toEqual(expect.arrayContaining(["greeting_message", "teaser_messages", "engagement_rules", "widget_title"]));
    expect(marked.fields).not.toContain("persona_prompt");
    const older = structuredClone(SCHEMA);
    olderSchema(older as unknown as { properties: Record<string, unknown> });
    expect(liveFields(older)).toMatchObject({ marked: false, fields: expect.arrayContaining(["engagement_rules", "greeting_message", "teaser_messages"]) });
    expect(previewLiveFields({ changes: [{ section: "persona", fields: [{ field: "bot_name" }] }] }, ["engagement_rules"])).toEqual({ pointers: [], reported_by: "kit" });
  });

  it("compares rules with defaults counted as unset, and only the kinds sent", () => {
    const field = { field: "engagement_rules", discriminator: "kind" };
    const change = rulesChange(SCHEMA, field, [{ ...STARTERS, enabled: true }, CALENDAR], [STARTERS], ["starters"]);
    expect(change).toMatchObject({ added: [], removed: [], changed: [], unchanged: 1, kept: 1 });
  });
});

describe("engagement preview", () => {
  const previews = () => server.state.requests.filter((r) => r.path === "/api/v1/bot-persona/engagement/preview");

  it("is a read-only MCP tool", () => {
    const spec = COMMANDS.find((c) => c.name === "engagement preview")!;
    expect(spec).toMatchObject({ readOnly: true, mcpTool: "engagement_preview" });
  });

  it("previews the folder's rules for a page and a moment", async () => {
    const dir = await solution();
    writePersona(dir, { engagement_rules: [STARTERS, CALENDAR, BANNER, DECORATION] });
    const result = await cli(sb, ["engagement", "preview", "--page", "https://www.example.at/tarife/winter", "--at", "2026-12-02T09:00:00+01:00"], { cwd: dir });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/starters:\s+rule tarife\n\s+- Which tariff fits me\?/);
    expect(result.stdout).toMatch(/calendar:\s+advent-2026 "Advent calendar": 2 open doors, today door 2/);
    expect(result.stdout).toMatch(/banners:\s*\n\s+- winter-offer/);
    expect(result.stdout).toMatch(/decoration:\s+snow: snow on launcher, header/);
    const body = previews()[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ page_host: "www.example.at", page_path: "/tarife/winter", at: "2026-12-02T09:00:00+01:00" });
    expect((body.rules as Array<{ id: string }>).map((r) => r.id)).toEqual(["tarife", "advent-2026", "winter-offer", "snow"]);
  });

  it("with --stored, previews the solution's own rules and sends none", async () => {
    server.state.personas.set(harnessId, { engagement_rules: [BANNER] });
    const dir = await solution();
    const result = await cli(sb, ["engagement", "preview", "--stored", "--json"], { cwd: dir });
    expect(result.code, result.stderr).toBe(0);
    expect(result.json<{ engagement: { banners: Array<{ rule_id: string }> } }>().engagement.banners.map((b) => b.rule_id)).toEqual(["winter-offer"]);
    expect(previews()[0]!.body).not.toHaveProperty("rules");
  });

  it("is refused before anything is sent where the instance does not mark the route read-only, or lacks it", async () => {
    const dir = await solution();
    server.state.openapiEdit = (doc) => {
      delete doc.paths["/api/v1/bot-persona/engagement/preview"].post["x-cavelon-read-only"];
    };
    const unmarked = await cli(sb, ["engagement", "preview", "--json"], { cwd: dir });
    expect(unmarked.code).toBe(1);
    expect(unmarked.json<{ error: { code: string } }>().error.code).toBe("operation_unavailable");
    server.state.openapiEdit = null;
    server.state.openapiWithout = ["POST /api/v1/bot-persona/engagement/preview"];
    const missing = await cli(sb, ["engagement", "preview", "--json"], { cwd: dir });
    expect(missing.json<{ error: { code: string } }>().error.code).toBe("operation_unavailable");
    expect(previews()).toEqual([]);
  });

  it("reads a page from a URL, a host without a scheme, or a path", () => {
    expect(pageOf("https://www.example.at/a/b?x=1#y")).toEqual({ page_host: "www.example.at", page_path: "/a/b" });
    expect(pageOf("www.example.at")).toEqual({ page_host: "www.example.at", page_path: "/" });
    expect(pageOf("/kontakt?x=1")).toEqual({ page_path: "/kontakt" });
    expect(pageOf(undefined)).toEqual({ page_path: "/" });
  });
});
