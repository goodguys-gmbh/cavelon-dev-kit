import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { modelRow, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * What validate says before the import preview does: names an assertion
 * points at, a misspelt assertion type, references the preview will block,
 * the line to fix, the kit's hint, the checks it could not make, and a
 * package that names another solution than the folder.
 */

let server: FakeServer;
let sb: Sandbox;
let tenant: string;
let dirCount = 0;

type Found = { code: string; severity: string; file: string; line?: number; path: string; message: string; suggestion?: string; hint?: string };
type Validated = { valid: boolean; error_count: number; warning_count: number; blocking_count: number; findings: Found[]; skipped: Array<{ kind: string; check: string; reason: string }> };

const read = (file: string) => readFileSync(file, "utf8");

async function pulled(): Promise<string> {
  const dir = path.join(sb.home, `solution-${++dirCount}`);
  mkdirSync(dir, { recursive: true });
  const init = await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--harness", "support"], { cwd: dir });
  expect(init.code, init.stderr + init.stdout).toBe(0);
  const pull = await cli(sb, ["pull"], { cwd: dir });
  expect(pull.code, pull.stderr + pull.stdout).toBe(0);
  return dir;
}

function edit<T>(file: string, change: (value: T) => void): void {
  const value = parse(read(file)) as T;
  change(value);
  writeFileSync(file, stringify(value));
}

const lineOf = (dir: string, f: Found) => read(path.join(dir, f.file)).split("\n")[f.line! - 1];

const suite = (criteria: string) =>
  `name: Routing\nharness_slug: support\ntest_cases:\n  - name: Price\n    steps:\n      - user_message: What does it cost?\n        evaluation_criteria:\n${criteria}`;

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
  await cli(sb, ["harness", "new", "support", "--name", "Support"]);
});
afterAll(async () => {
  sb.cleanup();
  await server.close();
});
beforeEach(() => {
  server.state.configs.clear();
  server.state.models = [modelRow(tenant, { model_id: "gpt-4.1" })];
});

describe("did you mean", () => {
  it("suggests a field that starts with the one written: description_override for a handoff's description", async () => {
    const dir = await pulled();
    edit<Array<Record<string, unknown>>>(path.join(dir, "package", "agents.yaml"), (agents) => {
      agents.push({ ...agents[0]!, slug: "billing", name: "Billing", is_entrypoint: false });
      agents[0]!.handoffs = [{ to_agent_slug: "billing", description: "Questions about invoices" }];
    });
    const result = (await cli(sb, ["validate", "--offline", "--json"], { cwd: dir })).json<Validated>();
    const field = result.findings.find((f) => f.code === "package_field_unknown")!;
    expect(field).toMatchObject({ path: "agents[0].handoffs[0].description", suggestion: "description_override" });
    expect(field.message).toMatch(/Did you mean "description_override"\?$/);
  });
});

describe("test steps' assertions", () => {
  it("checks the agent and the tool an assertion names, with the closest name", async () => {
    const dir = await pulled();
    writeFileSync(
      path.join(dir, "tests", "routing.yaml"),
      suite("          - {type: answered_by, value: helpr}\n          - {type: handoff_to, value: helper}\n          - {type: tool_called, value: search_documnets}\n          - {type: tool_not_called, value: crn}\n"),
    );
    const result = await cli(sb, ["validate", "--json"], { cwd: dir });
    expect(result.code, result.stdout).toBe(3);
    const findings = result.json<Validated>().findings;
    const agent = findings.find((f) => f.path.endsWith("evaluation_criteria[0].value"))!;
    expect(agent).toMatchObject({ code: "package_reference_missing", severity: "error", file: "tests/routing.yaml", suggestion: "helper" });
    expect(agent.message).toBe('The test case "Price" of the suite "Routing" checks answered_by the agent "helpr", which is not in the package. Did you mean "helper"?');
    expect(lineOf(dir, agent)).toMatch(/answered_by, value: helpr/);
    const tool = findings.find((f) => f.path.endsWith("evaluation_criteria[3].value"))!;
    expect(tool).toMatchObject({ code: "package_reference_unknown", severity: "warning", suggestion: "crm" });
    // The built-in search tool needs no entry; a typo of it is a tool nobody has.
    expect(findings.find((f) => f.path.endsWith("evaluation_criteria[2].value"))).toMatchObject({ code: "package_reference_unknown", suggestion: "search_documents" });
    expect(findings.filter((f) => f.path.endsWith("evaluation_criteria[1].value"))).toEqual([]);
  });

  it("a misspelt type is one finding with the type it comes closest to, not one per shape", async () => {
    const dir = await pulled();
    writeFileSync(path.join(dir, "tests", "routing.yaml"), suite("          - States the price.\n          - type: answerd_by\n            value: helper\n"));
    const result = await cli(sb, ["validate", "--offline", "--json"], { cwd: dir });
    expect(result.code).toBe(3);
    const findings = result.json<Validated>().findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: "package_schema_invalid", path: "test_suites[1].test_cases[0].steps[0].evaluation_criteria[1].type", suggestion: "answered_by" });
    expect(findings[0]!.message).toMatch(/^type "answerd_by" is none of the types this field takes \(answered_by, .*\)\. Did you mean "answered_by"\?$/);
    expect(lineOf(dir, findings[0]!)).toMatch(/type: answerd_by/);
    expect(findings[0]!.hint).toContain("cavelon schema test_suites.test_cases.steps.evaluation_criteria");
  });
});

describe("references the import preview blocks", () => {
  it("are not 'Valid': validate says the preview will block them, and --strict fails", async () => {
    const dir = await pulled();
    edit<Array<Record<string, unknown>>>(path.join(dir, "package", "skills.yaml"), (skills) => {
      skills[0]!.knowledge_base_assignments = [{ knowledge_base_name: "Pricing" }];
    });
    edit<Array<Record<string, unknown>>>(path.join(dir, "package", "agents.yaml"), (agents) => {
      agents[0]!.llm_model = "gpt-9";
    });
    const result = await cli(sb, ["validate"], { cwd: dir });
    expect(result.code, result.stdout).toBe(0);
    expect(result.stdout).not.toMatch(/^Valid/m);
    expect(result.stdout).toMatch(/No errors against package schema v3 \(\d+ sections\), but 2 references the import preview will block unless they exist on the instance by then \(0 errors, 2 warnings; --strict fails on warnings\)\./);
    const json = (await cli(sb, ["validate", "--json"], { cwd: dir })).json<Validated>();
    expect(json).toMatchObject({ valid: true, blocking_count: 2, error_count: 0 });

    const strict = await cli(sb, ["validate", "--strict", "--json"], { cwd: dir });
    expect(strict.code).toBe(3);
    expect(strict.json<Validated>()).toMatchObject({ valid: false, strict: true, warning_count: 2 });
    expect((await cli(sb, ["validate", "--strict"], { cwd: dir })).stdout).toMatch(/0 errors, 2 warnings; --strict fails on warnings\./);
  });

  it("a clean package is still Valid, also with --strict", async () => {
    const dir = await pulled();
    const result = await cli(sb, ["validate", "--strict"], { cwd: dir });
    expect(result.code, result.stdout).toBe(0);
    expect(result.stdout).toMatch(/^Valid against package schema v3/m);
  });
});

describe("lines", () => {
  it("a required field under another name points at the misspelt field's line", async () => {
    const dir = await pulled();
    const agents = path.join(dir, "package", "agents.yaml");
    writeFileSync(agents, read(agents).replace(/^ {2}temperature:/m, "  temprature:"));
    const findings = (await cli(sb, ["validate", "--offline", "--json"], { cwd: dir })).json<Validated>().findings;
    const renamed = findings.find((f) => f.code === "package_schema_invalid")!;
    expect(renamed.message).toMatch(/^missing required field "temperature" \("temprature" is set/);
    expect(lineOf(dir, renamed)).toMatch(/^ {2}temprature:/);
    expect(renamed.hint).toBe("Fix the field the finding names; `cavelon schema agents` lists the fields there (type, required, allowed values) with a minimal entry.");
  });

  it("invalid YAML gets the parser's line, and nothing that names the file's entries is reported", async () => {
    const dir = await pulled();
    writeFileSync(path.join(dir, "package", "skills.yaml"), "- slug: faq\n  name: FAQ: questions\n");
    const result = await cli(sb, ["validate", "--offline", "--json"], { cwd: dir });
    expect(result.code).toBe(3);
    const findings = result.json<Validated>().findings;
    expect(findings.map((f) => [f.code, f.file, f.line])).toEqual([["package_file_invalid", "package/skills.yaml", 2]]);
  });
});

describe("the hint of a schema finding", () => {
  it("is the CLI's, offline as online, not the API's", async () => {
    const dir = await pulled();
    edit<Array<Record<string, unknown>>>(path.join(dir, "package", "agents.yaml"), (agents) => {
      agents[0]!.handoffs = [{ to_agent_slug: "helper", is_active: "yes" }];
    });
    for (const args of [["validate", "--offline", "--json"], ["validate", "--json"]]) {
      const found = (await cli(sb, args, { cwd: dir })).json<Validated>().findings.find((f) => f.code === "package_schema_invalid")!;
      expect(found.path).toBe("agents[0].handoffs[0].is_active");
      expect(found.hint).toContain("`cavelon schema agents.handoffs`");
      expect(found.hint).not.toContain("detail.errors");
    }
  });
});

describe("checks that need the tenant's lists", () => {
  it("in a folder no pull filled, reads the lists it needs online, and names what it skipped offline", async () => {
    const dir = await pulled();
    rmSync(path.join(dir, ".cavelon", "inventory.json"));
    edit<Array<Record<string, unknown>>>(path.join(dir, "package", "agents.yaml"), (agents) => {
      agents[0]!.llm_model = "gpt-4.2";
    });
    const offline = await cli(sb, ["validate", "--offline", "--json"], { cwd: dir });
    expect(offline.json<Validated>().skipped).toEqual([
      expect.objectContaining({ kind: "models", check: "the agents' models", reason: expect.stringContaining("--offline") }),
    ]);
    expect((await cli(sb, ["validate", "--offline"], { cwd: dir })).stdout).toMatch(/^Not checked: the agents' models \(--offline, and no list of the tenant's models is cached; `cavelon models list` reads it\)\.$/m);

    const online = await cli(sb, ["validate", "--json"], { cwd: dir });
    const data = online.json<Validated>();
    expect(data.skipped).toEqual([]);
    expect(data.findings).toEqual([expect.objectContaining({ code: "package_model_unknown", suggestion: "gpt-4.1" })]);
    const inventory = JSON.parse(read(path.join(dir, ".cavelon", "inventory.json"))) as { names: Record<string, unknown> };
    expect(inventory.names.models).toEqual(["gpt-4.1"]);
    // Read once: the next run takes the list from the folder.
    expect((await cli(sb, ["validate", "--offline", "--json"], { cwd: dir })).json<Validated>().skipped).toEqual([]);
  });
});

describe("the solution's slug", () => {
  it("warns when harnesses.yaml names another solution than cavelon.yaml, as after copying a solution under another name", async () => {
    const dir = await pulled();
    writeFileSync(path.join(dir, "cavelon.yaml"), read(path.join(dir, "cavelon.yaml")).replace(/^harness: support$/m, "harness: qa-support"));
    const findings = (await cli(sb, ["validate", "--offline", "--json"], { cwd: dir })).json<Validated>().findings;
    const mismatch = findings.filter((f) => f.code === "solution_slug_mismatch");
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]).toMatchObject({ severity: "warning", file: "package/harnesses.yaml", path: "harnesses[0].slug" });
    expect(mismatch[0]!.message).toBe(
      'cavelon.yaml names the solution "qa-support", and the package\'s harnesses name "support": rename the slug (and every harness_slug) to "qa-support", or set harness in cavelon.yaml to the package\'s.',
    );
    expect((await cli(sb, ["explain", "solution_slug_mismatch", "--json"], { cwd: dir })).json()).toMatchObject({ code: "solution_slug_mismatch", kind: "kit" });
  });

  it("without harnesses in the package, warns once per section whose harness_slug names another solution", async () => {
    const dir = await pulled();
    rmSync(path.join(dir, "package", "harnesses.yaml"));
    edit<Array<Record<string, unknown>>>(path.join(dir, "package", "agents.yaml"), (agents) => {
      agents[0]!.harness_slug = "support-faq";
    });
    const mismatch = (await cli(sb, ["validate", "--offline", "--json"], { cwd: dir })).json<Validated>().findings.filter((f) => f.code === "solution_slug_mismatch");
    expect(mismatch.map((f) => f.path)).toEqual(["agents[0].harness_slug"]);
    expect(mismatch[0]!.message).toMatch(/^1 of the agents names the solution "support-faq" in harness_slug, and cavelon\.yaml names "support"/);
  });
});
