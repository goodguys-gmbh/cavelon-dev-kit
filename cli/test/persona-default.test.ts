import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { editDistance, similarCodes } from "../src/code-hints.js";
import { COMMANDS } from "../src/commands/index.js";
import type { InStream } from "../src/io.js";
import { KIT_ERROR_CODES } from "../src/kit-codes.js";
import { createMcpServer } from "../src/mcp.js";
import { exportForm, personaYaml, sectionFields } from "../src/package-format.js";
import { CONTRACTS, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * The persona and the default route in the authoring flow, the smaller
 * frictions around explain, api describe, the first pull after an apply, and
 * the richer import preview of recent instances, each with the fallback for
 * an instance that does not publish it.
 */

let server: FakeServer;
let sb: Sandbox;
let tenant: string;
let dirCount = 0;

const read = (file: string) => readFileSync(file, "utf8");
const schema = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-package-schema-v3.json"), "utf8"));
const personaFields = Object.keys(sectionFields(schema, "persona")!);

async function initSolution(harness = "support"): Promise<string> {
  const dir = path.join(sb.home, `solution-${++dirCount}`);
  mkdirSync(dir, { recursive: true });
  const result = await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--harness", harness], { cwd: dir });
  expect(result.code, result.stderr + result.stdout).toBe(0);
  return dir;
}

async function pulled(harness = "support"): Promise<string> {
  const dir = await initSolution(harness);
  const result = await cli(sb, ["pull"], { cwd: dir });
  expect(result.code, result.stderr + result.stdout).toBe(0);
  return dir;
}

const harnessId = (slug: string) => server.state.harnesses.find((h) => h.tenant_id === tenant && h.slug === slug)!.id;

function makeDefault(slug: string): void {
  for (const h of server.state.harnesses) if (h.tenant_id === tenant) h.is_default = h.slug === slug;
}

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, mayActivate: true }));
  for (const [slug, name] of [["default", "Default"], ["support", "Support"]]) await cli(sb, ["harness", "new", slug!, "--name", name!]);
});
afterAll(async () => {
  sb.cleanup();
  await server.close();
});
beforeEach(() => {
  server.state.configs.clear();
  server.state.exportFillsDefaults = false;
  server.state.importRequirementsChanged = null;
  server.state.previewExtras = {};
  server.state.previewBlockers = [];
  server.state.requests.length = 0;
  server.state.ready = true;
  server.state.harnessesWithoutDefault = false;
  for (const h of server.state.harnesses) h.status = h.slug === "default" ? "active" : "draft";
  makeDefault("default");
});

describe("the persona file", () => {
  it("init writes every persona field as a placeholder, and pull keeps them where the solution sets none", async () => {
    const dir = await initSolution();
    const file = path.join(dir, "package", "persona.yaml");
    const placeholders = read(file);
    for (const field of personaFields) expect(placeholders, field).toMatch(new RegExp(`^# ${field}:`, "m"));
    // Placeholders only: it reads as nothing, so validate and apply see no package yet.
    expect((await cli(sb, ["apply", "--json"], { cwd: dir })).json<{ error: { message: string } }>().error.message).toBe("No package files in package/.");

    // The export has persona: null; outside git the file init wrote may be replaced, and it holds the same placeholders.
    expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
    expect(read(file)).toBe(placeholders);
    const again = await cli(sb, ["pull", "--json"], { cwd: dir });
    expect(again.json<{ files: { written: string[]; unchanged: string[] } }>().files).toMatchObject({ written: [], unchanged: expect.arrayContaining(["package/persona.yaml"]) });

    // apply sends no persona for a file of placeholders.
    const preview = await cli(sb, ["apply", "--json"], { cwd: dir });
    expect(preview.code, preview.stdout).toBe(0);
    const sent = server.state.requests.find((r) => r.path === "/api/v1/agent-graph/import/preview")!.body as { package: Record<string, unknown> };
    expect(sent.package).not.toHaveProperty("persona");
  });

  it("pull writes the persona's set fields and the unset ones as commented placeholders, and a later pull keeps the bytes", async () => {
    const dir = await pulled();
    // A persona whose export leaves the null fields out, as the instance does.
    const pkg = server.state.configs.get(tenant)!.pkg;
    pkg.persona = { bot_name: "Mia", greeting_message: "Grüezi! Wie kann ich helfen?", greeting_enabled: true, fallback_message_enabled: true };
    server.state.configs.get(tenant)!.version++;
    expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
    const text = read(path.join(dir, "package", "persona.yaml"));
    expect(text).toMatch(/^bot_name: Mia$/m);
    expect(text).toMatch(/^# persona_prompt: null$/m);
    expect(text).toMatch(/^# fallback_message: null$/m);
    expect(text.indexOf("bot_name")).toBeLessThan(text.indexOf("persona_prompt"));
    expect(parse(text)).toEqual(pkg.persona);

    // The same value spelled with explicit nulls is the same: the bytes stay.
    pkg.persona = { ...(pkg.persona as object), persona_prompt: null };
    const again = await cli(sb, ["pull", "--json"], { cwd: dir });
    expect(again.json<{ files: { written: string[] } }>().files.written).toEqual([]);
    expect(read(path.join(dir, "package", "persona.yaml"))).toBe(text);
  });

  it("validate warns when a greeting or fallback is on and its text empty, a left-out switch counting as its default", async () => {
    const dir = await pulled();
    const file = path.join(dir, "package", "persona.yaml");
    writeFileSync(file, "bot_name: Mia\ngreeting_enabled: true\ngreeting_message: ''\n");
    const result = await cli(sb, ["validate", "--offline", "--json"], { cwd: dir });
    expect(result.code).toBe(0);
    const findings = result.json<{ findings: Array<{ code: string; path: string; file: string; line?: number; message: string }> }>().findings;
    const persona = findings.filter((f) => f.code === "persona_message_empty");
    expect(persona.map((f) => f.path)).toEqual(["persona.greeting_enabled", "persona.fallback_message"]);
    expect(persona[0]).toMatchObject({ file: "package/persona.yaml", line: 2 });
    expect(persona[1]!.message).toMatch(/fallback_message_enabled is true by default/);

    writeFileSync(file, "bot_name: Mia\ngreeting_message: Hallo!\nfallback_message_enabled: false\n");
    const quiet = await cli(sb, ["validate", "--offline", "--json"], { cwd: dir });
    expect(quiet.json<{ findings: Array<{ code: string }> }>().findings.map((f) => f.code)).not.toContain("persona_message_empty");
    expect((await cli(sb, ["explain", "persona_message_empty"], { cwd: dir })).stdout).toMatch(/greeting_message, fallback_message/);
  });

  it("writes placeholders with the schema's defaults", () => {
    const text = personaYaml({ bot_name: "Mia" }, sectionFields(schema, "persona")!);
    expect(text).toMatch(/^# greeting_enabled: true$/m);
    expect(text).toMatch(/^# teaser_messages: \[\]$/m);
    expect(parse(text)).toEqual({ bot_name: "Mia" });
  });
});

describe("the default route", () => {
  it("harness list marks it in a DEFAULT column, and leaves the column out where the instance does not say", async () => {
    const listed = await cli(sb, ["harness", "list"]);
    expect(listed.stdout).toMatch(/^SLUG\s+NAME\s+STATUS\s+DEFAULT\s+ID$/m);
    expect(listed.stdout).toMatch(/^default\s+Default\s+active\s+yes\s+[0-9a-f-]{36}$/m);
    expect(listed.stdout).toMatch(/^support\s+Support\s+draft\s+[0-9a-f-]{36}$/m);

    server.state.harnessesWithoutDefault = true;
    const older = await cli(sb, ["harness", "list"]);
    expect(older.stdout).toMatch(/^SLUG\s+NAME\s+STATUS\s+ID$/m);
    expect((await cli(sb, ["harness", "list", "--json"])).json<{ items: Array<{ is_default: unknown }> }>().items.every((h) => h.is_default === null)).toBe(true);
  });

  it("harness default previews the change naming the current default, and changes it only with --confirm", async () => {
    // A draft cannot be the default route: the kit says so, and sends nothing.
    const draft = await cli(sb, ["harness", "default", "support", "--json"]);
    expect(draft.code).toBe(4);
    expect(draft.json<{ error: Record<string, unknown> }>().error).toMatchObject({
      code: "solution_not_active",
      message: expect.stringMatching(/^Support \(support\) is draft, and only an active solution can be the tenant's default route/),
      hint: expect.stringMatching(/cavelon activate --harness support --make-default/),
    });
    expect(server.state.requests.some((r) => r.path.endsWith("/default"))).toBe(false);
    server.state.harnesses.find((h) => h.id === harnessId("support"))!.status = "active";

    const preview = await cli(sb, ["harness", "default", "support"]);
    expect(preview.code).toBe(0);
    expect(preview.stdout).toMatch(/^default → Default \(default\) now; would become Support \(support\)\. This changes live traffic/m);
    expect(preview.stdout).toMatch(/with their yes: cavelon harness default support --confirm/);
    expect(server.state.requests.some((r) => r.path.endsWith("/default"))).toBe(false);

    const changed = await cli(sb, ["harness", "default", "support", "--confirm", "--json"]);
    expect(changed.json()).toMatchObject({ changed: true, harness: { slug: "support" }, previous_default: { slug: "default" } });
    expect(server.state.harnesses.find((h) => h.id === harnessId("support"))!.is_default).toBe(true);
    expect(server.state.harnesses.find((h) => h.id === harnessId("default"))!.is_default).toBe(false);
    expect((await cli(sb, ["harness", "default", "support"])).stdout).toMatch(/already the tenant's default route/);

    // In a solution folder, the folder's solution.
    makeDefault("default");
    const dir = await initSolution();
    expect((await cli(sb, ["harness", "default"], { cwd: dir })).stdout).toMatch(/would become Support \(support\)/);
  });

  it("activate says when the solution is not the default route, and --make-default changes it only with --confirm", async () => {
    const dir = await initSolution();
    const activated = await cli(sb, ["activate"], { cwd: dir });
    expect(activated.code, activated.stderr).toBe(0);
    expect(activated.stdout).toMatch(/Not the default route: the tenant's chat and widget answer with Default \(default\)/);
    expect(activated.stdout).toMatch(/Ask the person whether Support \(support\) should answer there; .*Preview: cavelon harness default support/);

    const json = await cli(sb, ["activate", "--json"], { cwd: dir });
    expect(json.json()).toMatchObject({ already_active: true, default_route: { is_default: false, current: { slug: "default" }, confirm: "cavelon harness default support --confirm" } });

    expect((await cli(sb, ["activate", "--confirm"], { cwd: dir })).code).toBe(2);
    const previewed = await cli(sb, ["activate", "--make-default"], { cwd: dir });
    expect(previewed.stdout).toMatch(/default → Default \(default\) now; would become Support \(support\)/);
    expect(previewed.stdout).toMatch(/cavelon activate --harness support --make-default --confirm/);
    expect(server.state.harnesses.find((h) => h.slug === "support")!.is_default).toBe(false);

    const confirmed = await cli(sb, ["activate", "--make-default", "--confirm"], { cwd: dir });
    expect(confirmed.stdout).toMatch(/Default route: Support \(support\) \(was Default \(default\)\)\./);
    expect((await cli(sb, ["activate"], { cwd: dir })).stdout).toMatch(/Support \(support\) is the tenant's default route\./);
  });

  it("over MCP, harness_default and activate's make_default change the default route only with their own preview's confirm_token", async () => {
    const dir = await initSolution();
    const mcp = createMcpServer(
      {
        stdout: { write: () => true },
        stderr: { write: () => true },
        stdin: Readable.from([]) as unknown as InStream,
        env: sb.env,
        cwd: dir,
        now: () => new Date(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
      COMMANDS,
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return { isError: Boolean(result.isError), body: JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, any> };
    };
    const support = () => server.state.harnesses.find((h) => h.slug === "support")!;
    try {
      // true is refused before anything happens: activate does not activate either.
      for (const [name, args] of [
        ["harness_default", { solution: "support", confirm: true }],
        ["activate", { make_default: true, confirm: true }],
      ] as const) {
        const bare = await call(name, args);
        expect(bare.isError, name).toBe(true);
        expect(bare.body.error, name).toMatchObject({ code: "confirm_token_required", exit_code: 2 });
      }
      expect(support()).toMatchObject({ status: "draft", is_default: false });
      // A draft cannot be the default route.
      expect((await call("harness_default", { solution: "support" })).body.error).toMatchObject({ code: "solution_not_active", exit_code: 4 });

      // make_default, as the instructions spell it, activates and previews the default route.
      const previewed = await call("activate", { make_default: true });
      expect(previewed.body).toMatchObject({ activated: true, default_route: { is_default: false, confirm_token: expect.stringMatching(/^[0-9a-f]{12}$/) } });
      expect(support()).toMatchObject({ status: "active", is_default: false });

      const shown = await call("harness_default", { solution: "support" });
      expect(shown.body).toMatchObject({ changed: false, default_route: { slug: "default" }, confirm_token: expect.stringMatching(/^[0-9a-f]{12}$/) });
      expect(shown.body.confirm).toMatch(/^Show the person this, then call harness_default again with the same arguments and confirm: "[0-9a-f]{12}"/);
      // harness_default's token is not activate's: the default route stays.
      const other = await call("activate", { make_default: true, confirm: shown.body.confirm_token });
      expect(other.body).toMatchObject({ already_active: true, default_route: { is_default: false, token_mismatch: true }, exit_code: 4 });
      expect(other.body.default_route.confirm_token).not.toBe(shown.body.confirm_token);
      expect(support()).toMatchObject({ status: "active", is_default: false });

      const done = await call("harness_default", { solution: "support", confirm: shown.body.confirm_token });
      expect(done.body).toMatchObject({ changed: true, previous_default: { slug: "default" } });
      expect(support().is_default).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("activate keeps its result when the instance refuses the default route, and exits 1", async () => {
    const dir = await initSolution();
    server.state.failures = [{ method: "POST", path: /\/default$/, status: 403 }];
    try {
      const result = await cli(sb, ["activate", "--make-default", "--confirm", "--json"], { cwd: dir });
      expect(result.code).toBe(1);
      expect(result.json()).toMatchObject({ activated: true, default_route: { changed: false, current: { slug: "default" } } });
      expect(server.state.harnesses.find((h) => h.slug === "support")!.status).toBe("active");
    } finally {
      server.state.failures = [];
    }
  });

  it("activate says nothing of the default route where the instance does not mark it", async () => {
    server.state.harnessesWithoutDefault = true;
    const dir = await initSolution();
    const activated = await cli(sb, ["activate", "--json"], { cwd: dir });
    expect(activated.code).toBe(0);
    expect(activated.json()).toMatchObject({ activated: true, default_route: { is_default: null, known: false } });
    expect((await cli(sb, ["activate", "--make-default"], { cwd: dir })).stdout).toMatch(/default → unknown \(this instance does not say\) now/);
  });
});

describe("persona reads through cavelon api", () => {
  it("pass the folder's solution as harness_id, unless one is given; outside a folder, none", async () => {
    server.state.personas.set(harnessId("support"), { bot_name: "Mia" });
    const dir = await initSolution();
    const got = await cli(sb, ["api", "get_bot_persona", "--json"], { cwd: dir });
    expect(got.code, got.stderr).toBe(0);
    expect(got.json()).toMatchObject({ harness_id: harnessId("support"), bot_name: "Mia" });
    expect(got.stderr).toMatch(/Sent harness_id=.*the solution support from cavelon\.yaml/);

    const other = await cli(sb, ["api", "get_bot_persona", `harness_id=${harnessId("default")}`, "--json"], { cwd: dir });
    expect(other.json()).toMatchObject({ harness_id: harnessId("default") });
    const outside = await cli(sb, ["api", "get_bot_persona", "--json"]);
    expect(outside.json()).toMatchObject({ harness_id: harnessId("default") });
    // Other operations with an optional harness_id are left as they are.
    server.state.requests.length = 0;
    await cli(sb, ["api", "list_harnesses"], { cwd: dir });
    expect(server.state.requests.every((r) => !r.query.has("harness_id"))).toBe(true);
  });
});

describe("explain", () => {
  it("knows the kit's own codes, and names a CLI fix where the instance's names a route", async () => {
    const dir = await initSolution();
    const own = await cli(sb, ["explain", "operation_not_found", "--json"], { cwd: dir });
    expect(own.code).toBe(0);
    expect(own.json()).toMatchObject({ code: "operation_not_found", kind: "cli" });
    expect((await cli(sb, ["explain", "uncommitted_changes"], { cwd: dir })).stdout).toMatch(/kind:\s+cavelon error code/);

    const schemaInvalid = await cli(sb, ["explain", "package_schema_invalid", "--json"], { cwd: dir });
    expect(schemaInvalid.json<{ cli_fix: string }>().cli_fix).toMatch(/cavelon validate/);
    expect((await cli(sb, ["explain", "package_schema_invalid"], { cwd: dir })).stdout).toMatch(/with the CLI:\s+Run `cavelon validate`/);
    expect(schemaInvalid.json<{ cli_fix: string }>().cli_fix).toMatch(/A missing manifest comes from `cavelon pull`, or `cavelon init`/);
    // What a confirm with another change's token returns, as the docs and the MCP server name it.
    const mismatch = await cli(sb, ["explain", "token_mismatch", "--json"], { cwd: dir });
    expect(mismatch.code, mismatch.stdout).toBe(0);
    expect(mismatch.json()).toMatchObject({ code: "token_mismatch", kind: "cli", message: expect.stringMatching(/not the one for this change/) });
  });

  it("suggests codes a typo away or with the same start, never one that only shares a common word", async () => {
    const dir = await initSolution();
    const typo = await cli(sb, ["explain", "preview_unknwn", "--json"], { cwd: dir });
    expect(typo.json<{ error: { details: { similar: string[] } } }>().error.details.similar[0]).toBe("preview_unknown");
    const unrelated = await cli(sb, ["explain", "thing_not_here", "--json"], { cwd: dir });
    expect(unrelated.json<{ error: { hint: string } }>().error.hint).not.toMatch(/does_not_return/);

    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(similarCodes("sandbox_seed_failed", ["sandbox_harness_not_allowed", "for_each_item_body_does_not_return", "seed"])).toEqual(["sandbox_harness_not_allowed"]);
  });

  it("lists every code the CLI raises", () => {
    const src = path.resolve(__dirname, "../src");
    const raised = new Set<string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (name.endsWith(".ts")) for (const m of read(file).matchAll(/\bcode: "([a-z_]+)"/g)) raised.add(m[1]!);
        else if (!name.includes(".")) walk(file);
      }
    };
    walk(src);
    const known = new Set([...KIT_ERROR_CODES.map((e) => e.code)]);
    // validate's findings are explained by package-check's own list.
    const findings = ["package_file_invalid", "package_file_duplicate", "package_section_unknown"];
    expect([...raised].filter((c) => !known.has(c) && !findings.includes(c)).sort()).toEqual([]);
  });
});

describe("api describe", () => {
  it("shows the item fields of an array body field", async () => {
    const described = await cli(sb, ["api", "describe", "run_trigger_now", "--json"]);
    expect(described.code, described.stderr).toBe(0);
    const fields = described.json<{ body: { schema: { fields: Record<string, unknown> } } }>().body.schema.fields;
    expect(fields.document_bindings).toMatch(/^array of \w+/);
    expect(fields["document_bindings[]"]).toMatchObject({ type: "object", fields: expect.any(Object) });
  });
});

describe("fmt", () => {
  it("fills the schema's defaults in hand-written files, keeps files already in that form, and --check says which would change", async () => {
    const dir = await pulled();
    // The fake export fills no defaults here, unlike an instance's; fmt brings the pulled files there first.
    expect((await cli(sb, ["fmt"], { cwd: dir })).code).toBe(0);
    const agents = path.join(dir, "package", "agents.yaml");
    const harnesses = read(path.join(dir, "package", "harnesses.yaml"));
    writeFileSync(agents, "# by hand\n- {slug: helper, name: Helper, llm_model: gpt-4.1, llm_provider: openai, temperature: 0.2, parallel_tool_calls: false, system_prompt: Hi}\n");
    const check = await cli(sb, ["fmt", "--check", "--json"], { cwd: dir });
    expect(check.code).toBe(3);
    expect(check.json<{ changed: string[]; comments_dropped: unknown[] }>()).toMatchObject({ changed: ["package/agents.yaml"], comments_dropped: [{ file: "package/agents.yaml", comments: 1 }] });
    expect((await cli(sb, ["fmt", "--check"], { cwd: dir })).stdout).toMatch(/^fmt would drop the comments of package\/agents\.yaml \(1\); keep notes you need elsewhere first\.$/m);
    expect(read(agents)).toMatch(/^# by hand/);

    const formatted = await cli(sb, ["fmt"], { cwd: dir });
    expect(formatted.code, formatted.stderr).toBe(0);
    expect(formatted.stdout).toMatch(/formatted {2}package\/agents\.yaml/);
    // The comment is gone, and fmt says so; outside git it does not point at git diff.
    expect(formatted.stderr).toMatch(/fmt dropped the comments of package\/agents\.yaml \(1\).*not in a git repository/);
    expect(formatted.stdout).toMatch(/^Check it: cavelon validate\.$/m);
    const value = parse(read(agents)) as Array<Record<string, unknown>>;
    expect(value[0]).toMatchObject({ slug: "helper", is_entrypoint: false, is_active: true, display_order: 0, output_mode: "text", skip_persona: false });
    // Block lists, fields in the schema's order.
    expect(read(agents)).toMatch(/^- slug: helper\n {2}name: Helper\n/);
    expect(read(path.join(dir, "package", "harnesses.yaml"))).toBe(harnesses);
    expect((await cli(sb, ["fmt", "--check"], { cwd: dir })).code).toBe(0);
    expect((await cli(sb, ["validate", "--offline"], { cwd: dir })).code).toBe(0);
  });

  describe("against an export that fills the schema's defaults, as an instance's does", () => {
    const byHand = "- {slug: helper, name: Helper, llm_model: gpt-4.1, llm_provider: openai, temperature: 0.2, parallel_tool_calls: false, system_prompt: Answer from the handbook.}\n";

    async function applied(dir: string): Promise<void> {
      const preview = await cli(sb, ["apply", "--json"], { cwd: dir });
      expect(preview.code, preview.stderr + preview.stdout).toBe(0);
      const confirmed = await cli(sb, ["apply", "--confirm", preview.json<{ preview_id: string }>().preview_id], { cwd: dir });
      expect(confirmed.code, confirmed.stderr).toBe(0);
    }

    it("the first pull after fmt and apply writes no file", async () => {
      server.state.exportFillsDefaults = true;
      const dir = await pulled();
      const agents = path.join(dir, "package", "agents.yaml");
      writeFileSync(agents, byHand);
      expect((await cli(sb, ["fmt"], { cwd: dir })).code).toBe(0);
      await applied(dir);
      const pull = await cli(sb, ["pull", "--json"], { cwd: dir });
      expect(pull.code, pull.stderr).toBe(0);
      expect(pull.json<{ files: { written: string[] } }>().files.written).toEqual([]);
    });

    it("without fmt, the first pull keeps a file whose fields the export only spells out, and writes a real change", async () => {
      server.state.exportFillsDefaults = true;
      const dir = await pulled();
      const agents = path.join(dir, "package", "agents.yaml");
      writeFileSync(agents, byHand);
      await applied(dir);
      const pull = await cli(sb, ["pull", "--json"], { cwd: dir });
      expect(pull.code, pull.stderr).toBe(0);
      expect(pull.json<{ files: { written: string[] } }>().files.written).toEqual([]);
      expect(read(agents)).toBe(byHand);

      // A change on the instance is written, in the export's form; the manifest follows with its export time.
      const pkg = server.state.configs.get(tenant)!.pkg;
      (pkg.agents as Array<Record<string, unknown>>)[0]!.temperature = 0.7;
      const again = await cli(sb, ["pull", "--json"], { cwd: dir });
      expect(again.json<{ files: { written: string[] } }>().files.written).toEqual(["package/agents.yaml", "package/manifest.yaml"]);
      expect((parse(read(agents)) as Array<Record<string, unknown>>)[0]).toMatchObject({ slug: "helper", temperature: 0.7, is_active: true, memory_config: {}, handoffs: [] });
      expect(read(agents)).toMatch(/^- slug: helper\n {2}harness_slug: null\n {2}name: Helper\n/);
      // fmt and pull agree: the pulled file is in the export's form.
      expect((await cli(sb, ["fmt", "--check"], { cwd: dir })).code).toBe(0);
    });
  });

  it("fills defaults through references, lists and nullable fields", () => {
    const formed = exportForm(schema, schema.properties.agents, [{ slug: "a", tool_assignments: [{ tool_slug: "search_documents" }] }]) as Array<Record<string, unknown>>;
    expect(formed[0]).toMatchObject({ is_active: true, tool_assignments: [expect.objectContaining({ tool_slug: "search_documents" })] });
    expect(Object.keys(formed[0]!)[0]).toBe("slug");
    expect(exportForm(schema, schema.properties.persona, null)).toBeNull();
  });
});

describe("apply shows the instance's structured preview", () => {
  it("a blocked preview: its blockers first, with code, file and path, hint and explain; no word about the preview id", async () => {
    const dir = await pulled();
    server.state.previewBlockers = ["Agent helper has no model."];
    server.state.previewExtras = {
      preview_id: null,
      blocker_details: [{ code: "agent_model_missing", message: "Agent helper has no model.", path: "agents[0].llm_model", hint: "Set llm_model." }],
    };
    const result = await cli(sb, ["apply"], { cwd: dir });
    expect(result.code).toBe(3);
    expect(result.stdout).toMatch(/- agent_model_missing {2}package\/agents\.yaml:\d+ agents\[0\]\.llm_model: Agent helper has no model\./);
    expect(result.stdout).toMatch(/hint: Set llm_model\./);
    expect(result.stdout).toMatch(/more: cavelon explain agent_model_missing/);
    expect(result.stderr).not.toMatch(/update the instance/);
    const json = await cli(sb, ["apply", "--json"], { cwd: dir });
    expect(json.json<{ blocker_details: Array<{ file: string }> }>().blocker_details[0]).toMatchObject({ code: "agent_model_missing", file: "package/agents.yaml" });
  });

  it("field changes, not-applied fields with the command that sets them, and the active solutions it reaches", async () => {
    const dir = await pulled();
    server.state.previewExtras = {
      changes: [{ object: "agents:helper", field: "system_prompt", old: "Answer.", new: "Answer from the handbook." }],
      ignored: { sections: [], fields: [], count: 0, not_applied: [{ path: "harnesses[0].is_default", how: "Use the default route action." }, { path: "harnesses[0].status", how: "Activate it." }] },
      impact: { changed_tools: [], changed_knowledge_bases: [], active_harnesses: [{ harness_slug: "default", name: "Default" }], sandbox_writers: [] },
    };
    const result = await cli(sb, ["apply"], { cwd: dir });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/- agents:helper\.system_prompt: "Answer\." → "Answer from the handbook\."/);
    expect(result.stdout).toMatch(/not applied:\s+\n {2}- harnesses\[0\]\.is_default \(set with cavelon harness default support\)/);
    expect(result.stdout).toMatch(/- harnesses\[0\]\.status \(set with cavelon activate --harness support\)/);
    expect(result.stdout).toMatch(/This reaches the active solution default: show this preview to a person before confirming\./);
    const json = await cli(sb, ["apply", "--json"], { cwd: dir });
    expect(json.json()).toMatchObject({
      field_changes: [{ object: "agents:helper", field: "system_prompt", old: "Answer.", new: "Answer from the handbook." }],
      not_applied: [expect.objectContaining({ path: "harnesses[0].is_default", command: "cavelon harness default support" }), expect.anything()],
    });
  });

  it("shows where two long texts differ, so an edit at the end of a long prompt is seen", async () => {
    const dir = await pulled();
    const start = "You answer questions about the product from the FAQ. ".repeat(4);
    server.state.previewExtras = {
      changes: [{ object: "agents:helper", field: "system_prompt", old: `${start}Answer only from the FAQ.`, new: `${start}Answer only from the FAQ, and name the page you used.` }],
    };
    try {
      const result = await cli(sb, ["apply"], { cwd: dir });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `- agents:helper.system_prompt: …" FAQ. Answer only from the FAQ." → …" FAQ. Answer only from the FAQ, and name the page you used." (from character ${start.length + 25})`,
      );
    } finally {
      server.state.previewExtras = {};
    }
  });

  it("reads a diff grouped by object, and keeps today's output without these fields", async () => {
    const dir = await pulled();
    server.state.previewExtras = { changes: { persona: { bot_name: { before: null, after: "Mia" } } } };
    expect((await cli(sb, ["apply"], { cwd: dir })).stdout).toMatch(/- persona\.bot_name: null → "Mia"/);
    server.state.previewExtras = {};
    const plain = await cli(sb, ["apply", "--json"], { cwd: dir });
    expect(plain.json()).not.toHaveProperty("field_changes");
    expect(plain.json()).not.toHaveProperty("not_applied");
    expect((await cli(sb, ["apply"], { cwd: dir })).stdout).not.toMatch(/field changes|not applied/);
  });
});
