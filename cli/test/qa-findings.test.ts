import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../src/commands/index.js";
import { parseIndex, searchIndex } from "../src/commands/docs.js";
import type { InStream } from "../src/io.js";
import { createMcpServer } from "../src/mcp.js";
import { spanAttributes, suggestedSpan } from "../src/trace-view.js";
import { startFakeServer, traceFixture, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";
import { readFileSync } from "node:fs";
import { CONTRACTS } from "./fake-server.js";

/**
 * What QA coding agents found with kit 0.1.5: a confirm in an agent's shell
 * that skipped the preview, MCP arguments dropped without a word, test and
 * trace output that hid the assertions and the answer, and the smaller
 * frictions of status, whoami, tenant create, api, kb upload, pull and docs
 * search. Each with the fallback for an instance that does not publish what a
 * recent one does.
 */

let server: FakeServer;
let sb: Sandbox;
let tenant: string;
let dirCount = 0;
const AGENT = { CLAUDECODE: "1" };

async function initSolution(harness = "support", tenantRef = tenant): Promise<string> {
  const dir = path.join(sb.home, `solution-${++dirCount}`);
  mkdirSync(dir, { recursive: true });
  const result = await cli(sb, ["init", "--instance", server.url, "--tenant", tenantRef, "--harness", harness], { cwd: dir });
  expect(result.code, result.stderr + result.stdout).toBe(0);
  return dir;
}

const changes = (before: number) => server.state.requests.slice(before).filter((r) => r.method !== "GET");
const harness = (slug: string) => server.state.harnesses.find((h) => h.tenant_id === tenant && h.slug === slug)!;

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, mayActivate: true }));
  for (const [slug, name] of [["default", "Default"], ["support", "Support"], ["other", "Other"]]) await cli(sb, ["harness", "new", slug!, "--name", name!]);
});
afterAll(async () => {
  sb.cleanup();
  await server.close();
});
beforeEach(() => {
  for (const h of server.state.harnesses) {
    h.status = h.slug === "default" ? "active" : "draft";
    h.is_default = h.slug === "default";
  }
  server.state.tenantLimits.clear();
});

describe("--confirm when a coding agent runs cavelon in its shell", () => {
  it("takes the preview's token: a bare --confirm and another change's token change nothing", async () => {
    const before = server.state.requests.length;
    const preview = await cli(sb, ["limits", "set", "agent_max_turns", "40", "--json"], { env: AGENT });
    expect(preview.code).toBe(0);
    const shown = preview.json<{ confirm_token: string; confirm: string }>();
    expect(shown.confirm_token).toMatch(/^[0-9a-f]{12}$/);
    expect(shown.confirm).toBe(`cavelon limits set agent_max_turns 40 --confirm ${shown.confirm_token}`);
    const text = await cli(sb, ["limits", "set", "agent_max_turns", "40"], { env: AGENT });
    expect(text.stdout).toContain(`Change it with: cavelon limits set agent_max_turns 40 --confirm ${shown.confirm_token}`);

    const bare = await cli(sb, ["limits", "set", "agent_max_turns", "40", "--confirm"], { env: AGENT });
    expect(bare.code).toBe(5);
    expect(bare.stdout).toMatch(/--confirm alone does not confirm when a coding agent runs cavelon\. Nothing was changed/);
    const other = await cli(sb, ["limits", "set", "agent_max_turns", "41", "--confirm", shown.confirm_token, "--json"], { env: AGENT });
    expect(other.code).toBe(4);
    expect(other.json()).toMatchObject({ changed: false, token_mismatch: true });
    expect(changes(before)).toEqual([]);

    const done = await cli(sb, ["limits", "set", "agent_max_turns", "40", "--confirm", shown.confirm_token, "--json"], { env: AGENT });
    expect(done.code, done.stderr).toBe(0);
    expect(done.json()).toMatchObject({ value: 40, now: 40 });
    expect(changes(before)).toHaveLength(1);
  });

  it("leaves a person's terminal with the plain flag", async () => {
    const before = server.state.requests.length;
    const done = await cli(sb, ["limits", "set", "agent_max_turns", "30", "--confirm", "--json"]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.json()).toMatchObject({ value: 30 });
    expect(changes(before)).toHaveLength(1);
  });

  it("holds for harness default (--confirm=<token> too), variables delete and activate --make-default", async () => {
    harness("support").status = "active";
    const shown = (await cli(sb, ["harness", "default", "support", "--json"], { env: AGENT })).json<{ confirm_token: string; confirm: string }>();
    expect(shown.confirm).toBe(`cavelon harness default support --confirm ${shown.confirm_token}`);
    expect((await cli(sb, ["harness", "default", "support", "--confirm"], { env: AGENT })).code).toBe(5);
    expect(harness("support").is_default).toBe(false);
    expect((await cli(sb, ["harness", "default", "support", `--confirm=${shown.confirm_token}`], { env: AGENT })).code).toBe(0);
    expect(harness("support").is_default).toBe(true);

    await cli(sb, ["variables", "set", "crm_url", "https://crm.example.com"]);
    const variable = (await cli(sb, ["variables", "delete", "crm_url", "--json"], { env: AGENT })).json<{ confirm_token: string }>();
    expect((await cli(sb, ["variables", "delete", "crm_url", "--confirm", "--json"], { env: AGENT })).json()).toMatchObject({ deleted: false, token_required: true });
    expect((await cli(sb, ["variables", "delete", "crm_url", "--confirm", variable.confirm_token, "--json"], { env: AGENT })).json()).toMatchObject({ deleted: true });

    // activate refuses a bare --confirm before it activates anything.
    const dir = await initSolution("other");
    const refused = await cli(sb, ["activate", "--make-default", "--confirm", "--json"], { cwd: dir, env: AGENT });
    expect(refused.code).toBe(5);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe("confirm_token_required");
    expect(harness("other").status).toBe("draft");
  });
});

describe("MCP tool arguments", () => {
  async function client(cwd: string): Promise<Client> {
    const mcp = createMcpServer(
      {
        stdout: { write: () => true },
        stderr: { write: () => true },
        stdin: Readable.from([]) as unknown as InStream,
        env: sb.env,
        cwd,
        now: () => new Date(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
      COMMANDS,
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    const c = new Client({ name: "test", version: "0" });
    await c.connect(clientSide);
    return c;
  }
  const payload = (result: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, any>;

  it("are spelled in snake_case, and refuse the CLI's spelling or an unknown one naming the closest, doing nothing", async () => {
    const dir = await initSolution();
    const c = await client(dir);
    try {
      const { tools } = await c.listTools();
      const props = (name: string) => Object.keys((tools.find((t) => t.name === name)!.inputSchema as { properties: object }).properties);
      expect(props("activate")).toEqual(expect.arrayContaining(["make_default", "confirm"]));
      expect(props("kb_upload")).toEqual(expect.arrayContaining(["keep_both", "dry_run"]));
      expect(tools.flatMap((t) => Object.keys((t.inputSchema as { properties: object }).properties)).filter((p) => p.includes("-"))).toEqual([]);

      const before = server.state.requests.length;
      const unknown = await c.callTool({ name: "activate", arguments: { makedefault: true } });
      expect(unknown.isError).toBe(true);
      expect(payload(unknown).error).toMatchObject({ code: "unknown_argument", exit_code: 2, message: expect.stringMatching(/activate has no argument "makedefault"; nothing was done\. Did you mean "make_default"\?/) });
      expect(changes(before)).toEqual([]);
      expect(harness("support").status).toBe("draft");

      const kebab = await c.callTool({ name: "activate", arguments: { "make-default": true } });
      expect(kebab.isError).toBe(true);
      expect(payload(kebab).error).toMatchObject({
        code: "unknown_argument",
        exit_code: 2,
        message: expect.stringMatching(/activate has no argument "make-default"; nothing was done\. Did you mean "make_default"\?/),
        details: { argument: "make-default", suggestion: "make_default" },
      });
      expect(changes(before)).toEqual([]);
      expect(harness("support").status).toBe("draft");
    } finally {
      await c.close();
    }
  });
});

describe("test results and traces", () => {
  const conversation = "22222222-2222-4222-8222-222222222222";
  const traceId = "c0000000-0000-4000-8000-0000000000aa";

  beforeAll(() => {
    server.state.suites.push({ id: randomUUID(), tenant_id: tenant, name: "smoke", harness_id: null, archived_at: null });
  });

  it("test run --wait names each failed assertion and the answer under a failed case", async () => {
    server.state.runSummary = { passed: 0, failed: 1, errors: 0, total_cases: 1, pass_rate: 0 };
    server.state.runResults = [
      {
        name: "Ticket price",
        status: "fail",
        agent_slug: "front-desk",
        error_message: "Agent front-desk answered; ticket-agent must answer.",
        generated_answer: "A family ticket costs 89 EUR.",
        judge_breakdown: {
          deterministic_criteria: [
            { type: "answered_by", label: "Answered by ticket-agent", passed: false, expected: "ticket-agent", observed: "front-desk", reasoning: "Agent front-desk answered." },
            { type: "tool_called", label: "Called search_documents", passed: true, reasoning: "Called." },
          ],
          criteria: [{ criterion: "Names the price", score: 1, reasoning: "It does." }],
        },
      },
    ];
    try {
      const result = await cli(sb, ["test", "run", "--suite", "smoke", "--wait", "--timeout", "10s"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("    Ticket price (step 1)  fail: Agent front-desk answered; ticket-agent must answer.\n      failed: Answered by ticket-agent [answered_by]\n      answer: A family ticket costs 89 EUR.");
      const runId = (await cli(sb, ["test", "run", "--suite", "smoke", "--json"])).json<{ runs: Array<{ run_id: string }> }>().runs[0]!.run_id;
      const view = await cli(sb, ["trace", runId]);
      expect(view.stdout).toContain(
        [
          "    Assertions (1 of 2 passed):",
          '      FAIL  Answered by ticket-agent [answered_by] (expected "ticket-agent", observed "front-desk"): Agent front-desk answered.',
          "      pass  Called search_documents [tool_called]: Called.",
          '      score 1  criterion "Names the price": It does.',
          "    Answer: A family ticket costs 89 EUR.",
        ].join("\n"),
      );
    } finally {
      server.state.runResults = null;
      server.state.runSummary = { passed: 2, failed: 0, errors: 0, total_cases: 2, pass_rate: 1 };
    }
  });

  it("reads a retrieval span's attributes even when encoded twice, and shows the query and the hits as a table", async () => {
    const attributes = {
      query: "family ticket price",
      knowledge_outcome: "unusable_hits",
      source_count: 2,
      sources: [
        { document_id: "d1", knowledge_base_id: "k1", title: "bergbahn-faq.md", rank: 1, score: 0.4123, citation_state: "citable", cited: false },
        { document_id: "d2", knowledge_base_id: "k1", title: "winter-prices.md", rank: 2, score: 0.2, citation_state: "not_citable", cited: false },
      ],
    };
    server.state.traces.set(`conversation:${conversation}`, [traceFixture(traceId, conversation, { retrievalAttributes: JSON.stringify(JSON.stringify(attributes)) })]);
    const spans = await cli(sb, ["trace", conversation, "--kind", "conversation", "--trace", traceId, "--json"]);
    const items = spans.json<{ spans: { items: Array<{ type: string; knowledge_outcome: string | null }> } }>().spans.items;
    expect(items.map((s) => [s.type, s.knowledge_outcome])).toEqual([
      ["agent", null],
      ["llm", null],
      ["tool", "unusable_hits"],
      ["retrieval", "unusable_hits"],
    ]);
    const args = ["trace", conversation, "--kind", "conversation", "--trace", traceId, "--span", `${traceId}-span-4`];
    const json = (await cli(sb, [...args, "--json"])).json<Record<string, any>>();
    expect(json.attributes).toEqual(attributes);
    expect(json.retrieval).toMatchObject({ query: "family ticket price", knowledge_outcome: "unusable_hits", source_count: 2, sources: [expect.objectContaining({ rank: 1, title: "bergbahn-faq.md", cited: false }), expect.objectContaining({ rank: 2 })] });
    const text = (await cli(sb, args)).stdout;
    expect(text).toMatch(/^query:\s+family ticket price$/m);
    expect(text).toMatch(/^knowledge_outcome:\s+unusable_hits$/m);
    expect(text).toMatch(/^RANK\s+TITLE\s+SCORE\s+CITABLE\s+CITED\s+DOCUMENT_ID$/m);
    expect(text).toMatch(/^1\s+bergbahn-faq\.md\s+0\.412\s+yes\s+no\s+d1$/m);
    expect(text).toContain("What it means: cavelon explain unusable_hits");
  });

  it("suggests the last model call when no span failed, never the root span", () => {
    const fixture = traceFixture(traceId, conversation, { failedSearch: false });
    expect(suggestedSpan(fixture.spans)!.id).toBe(`${traceId}-span-2`);
    expect(suggestedSpan(traceFixture(traceId, conversation).spans)!.id).toBe(`${traceId}-span-3`);
    expect(spanAttributes('"{\\"a\\": 1}"')).toEqual({ a: 1 });
    expect(spanAttributes("not json")).toBeUndefined();
  });

  it("explain reads a knowledge outcome from the instance's catalog, and knows the documented values where it lists none", async () => {
    // An older instance's catalog lists no knowledge outcome.
    server.state.catalogWithout = ["content_gap", "unusable_hits", "retrieval_fault", "no_usable_evidence", "usable_evidence"];
    try {
      const older = { CAVELON_CACHE_DIR: path.join(sb.home, `cache-${randomUUID()}`) };
      const fallback = await cli(sb, ["explain", "unusable_hits", "--json"], { env: older });
      expect(fallback.code).toBe(0);
      expect(fallback.json()).toMatchObject({ code: "unusable_hits", kind: "knowledge_outcome", recorded_as: "no_usable_evidence" });
      expect((await cli(sb, ["explain", "no_usable_evidence"], { env: older })).stdout).toMatch(/content_gap \(no hits\), unusable_hits \(hits, none usable\) or retrieval_fault/);
    } finally {
      server.state.catalogWithout = [];
    }

    const fresh = { CAVELON_CACHE_DIR: path.join(sb.home, `cache-${randomUUID()}`) };
    const listed = await cli(sb, ["explain", "unusable_hits"], { env: fresh });
    expect(listed.stdout).toMatch(/^kind:\s+knowledge outcome/m);
    expect(listed.stdout).toMatch(/^meaning:\s+The agent recorded no_usable_evidence although the search returned hits/m);
    expect((await cli(sb, ["explain", "unusable_hits", "--json"], { env: fresh })).json()).toMatchObject({ kind: "knowledge_outcome", area: "knowledge_outcome" });
  });
});

describe("status, whoami and the tenant", () => {
  it("outside a solution folder, says the tenant is the one chosen with cavelon use, and where that holds", async () => {
    const outside = path.join(sb.home, "outside");
    mkdirSync(outside, { recursive: true });
    const whoami = await cli(sb, ["whoami"], { cwd: outside });
    expect(whoami.code, whoami.stderr).toBe(0);
    expect(whoami.stdout).toMatch(/^tenant from: +`cavelon use`, for every folder without a cavelon\.yaml \(--tenant chooses another for one command\)$/m);
    const status = await cli(sb, ["status"], { cwd: outside });
    expect(status.stdout).toMatch(/^tenant: +Acme \(acme, [0-9a-f-]{36}\), from `cavelon use`, for every folder without a cavelon\.yaml/m);
    expect((await cli(sb, ["whoami", "--json"], { cwd: outside })).json<{ tenant: { source: string } }>().tenant.source).toBe("use");
  });

  it("names a tenant given by id that is none of the token's memberships, and says which solution is the default route", async () => {
    const beta = server.addTenant("beta", "Beta Corp");
    const operator = server.addToken({ kind: "pat", tenantIds: [], reachesAll: true, platform: true, globalRole: "superadmin" });
    const env = { CAVELON_URL: server.url, CAVELON_TOKEN: operator };
    const who = await cli(sb, ["whoami", "--tenant", beta, "--json"], { env });
    expect(who.code, who.stderr).toBe(0);
    expect(who.json()).toMatchObject({ tenant: { id: beta, name: "Beta Corp", slug: "beta" } });

    const dir = await initSolution("support", beta);
    const status = await cli(sb, ["status", "--json"], { cwd: dir, env });
    expect(status.json()).toMatchObject({ tenant: { id: beta, name: "Beta Corp", slug: "beta" } });
  });

  it("does not call an active solution ready to activate, and names the default route", async () => {
    const dir = await initSolution("support");
    harness("support").status = "active";
    const text = await cli(sb, ["status"], { cwd: dir });
    expect(text.stdout).toMatch(/^state:\s+active$/m);
    expect(text.stdout).toMatch(/^default route:\s+no: Default \(default\) answers the tenant's chat and widget; preview a change with cavelon harness default support$/m);
    expect(text.stdout).toMatch(/^tenant:\s+Acme \(acme, [0-9a-f-]{36}\), from cavelon\.yaml$/m);
    harness("support").is_default = true;
    harness("default").is_default = false;
    expect((await cli(sb, ["status", "--json"], { cwd: dir })).json()).toMatchObject({ solution: { state: { default_route: { is_default: true } } } });
  });

  it("leaves another solution's running test run out of this folder's operations, and says so", async () => {
    const dir = await initSolution("support");
    const steps = server.state.defaultSteps;
    server.state.defaultSteps = Array<"running">(20).fill("running");
    server.state.suites.push({ id: randomUUID(), tenant_id: tenant, name: "theirs", harness_id: harness("other").id, archived_at: null });
    server.state.suites.push({ id: randomUUID(), tenant_id: tenant, name: "ours", harness_id: harness("support").id, archived_at: null });
    try {
      const theirs = (await cli(sb, ["test", "run", "--harness", "other", "--suite", "theirs", "--json"])).json<{ operation_ids: string[] }>().operation_ids[0]!;
      const ours = (await cli(sb, ["test", "run", "--harness", "support", "--suite", "ours", "--json"])).json<{ operation_ids: string[] }>().operation_ids[0]!;
      const status = await cli(sb, ["status", "--json"], { cwd: dir });
      const ops = status.json<{ operations: { items: Array<{ id: string }>; scope: string; other_solutions: number } }>().operations;
      expect(ops.items.map((o) => o.id)).toContain(ours);
      expect(ops.items.map((o) => o.id)).not.toContain(theirs);
      expect(ops).toMatchObject({ scope: "solution", other_solutions: expect.any(Number) });
      expect((await cli(sb, ["status"], { cwd: dir })).stdout).toMatch(/Running operations of support and the tenant's shared work \(1 operation of other solutions not shown/);
    } finally {
      server.state.defaultSteps = steps;
      for (const op of server.state.operations.values()) op.steps = ["succeeded"];
    }
  });

  it("tenant create refuses a token whose ceiling holds no platform role before sending", async () => {
    const builder = server.addToken({ kind: "pat", tenantIds: [tenant], platform: true, ceilingRole: "tenant_builder", tokenName: "builder" });
    const before = server.state.requests.length;
    const result = await cli(sb, ["tenant", "create", "--confirm", "newco", "--json"], { env: { CAVELON_URL: server.url, CAVELON_TOKEN: builder } });
    expect(result.code).toBe(7);
    expect(result.json<{ error: Record<string, unknown> }>().error).toMatchObject({
      code: "permission_missing",
      message: expect.stringMatching(/"builder" may enter Platform mode, but its ceiling tenant_builder gives it no role there with tenants\.manage/),
      details: { sent: false, ceiling_role: "tenant_builder" },
    });
    expect(changes(before)).toEqual([]);
  });

  it("harness default refuses a draft and names the command that activates it", async () => {
    const result = await cli(sb, ["harness", "default", "support"]);
    expect(result.code).toBe(4);
    expect(result.stderr).toMatch(/Support \(support\) is draft, and only an active solution can be the tenant's default route; nothing was changed\./);
    expect(result.stderr).toMatch(/cavelon activate --harness support --make-default/);
  });
});

describe("api", () => {
  it("describe shows what the instance keeps for a person and which fields are secret values", async () => {
    const secret = (await cli(sb, ["api", "describe", "set_secret", "--json"])).json<Record<string, any>>();
    expect(secret.person_only).toMatchObject({ source: "instance" });
    expect(secret.secret_fields).toEqual(["value"]);
    const text = (await cli(sb, ["api", "describe", "update_model"])).stdout;
    expect(text).toMatch(/^Secret values \(x-cavelon-secret\): api_key\. A person enters them; an agent leaves them out\.$/m);
    expect(text).toMatch(/"api_key": ".*secret value \(x-cavelon-secret\): a person enters it"/);
    expect((await cli(sb, ["api", "describe", "list_variables", "--json"])).json()).toMatchObject({ person_only: null, secret_fields: [] });
  });

  it("list --limit 0 lists every operation", async () => {
    const all = await cli(sb, ["api", "list", "--limit", "0", "--json"]);
    expect(all.code, all.stderr).toBe(0);
    const page = all.json<{ items: unknown[]; total: number; next_cursor: string | null }>();
    expect(page.items.length).toBe(page.total);
    expect(page.next_cursor).toBeNull();
  });
});

describe("kb upload", () => {
  const kb = "0f0e0d0c-0000-4000-8000-0000000000e1";
  beforeAll(() => {
    server.state.kbs.push({ id: kb, tenant_id: tenant, name: "FAQ" });
  });

  it("counts one file as one file, and reads the documents' statuses after the wait", async () => {
    const dir = path.join(sb.home, "kb-one");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "prices.md"), "# Prices\n");
    expect((await cli(sb, ["kb", "upload", dir, "--kb", "FAQ", "--dry-run"])).stdout).toMatch(/^Would upload 1 file:$/m);
    const waited = await cli(sb, ["kb", "upload", dir, "--kb", "FAQ", "--wait", "--timeout", "10s", "--json"]);
    expect(waited.code, waited.stderr).toBe(0);
    expect(waited.json<{ documents: Array<{ status: string }> }>().documents.map((d) => d.status)).toEqual(["ready"]);
    expect((await cli(sb, ["kb", "upload", dir, "--kb", "FAQ", "--keep-both"])).stdout).toMatch(/^Uploaded 1 file to FAQ\.$/m);
  });

  it.each([
    ["reports", true],
    ["without upload_outcome, recognises", false],
  ])("%s a file whose content is already active as deduplicated, not as uploaded", async (_label, reported) => {
    const dir = path.join(sb.home, `kb-dedup-${String(reported)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `same-${String(reported)}.md`), `# Same ${String(reported)}\n`);
    server.state.uploadDedup = true;
    server.state.uploadOutcome = reported;
    try {
      expect((await cli(sb, ["kb", "upload", dir, "--kb", "FAQ"])).stdout).toMatch(/^Uploaded 1 file to FAQ\.$/m);
      const again = await cli(sb, ["kb", "upload", dir, "--kb", "FAQ", "--keep-both"]);
      expect(again.stdout).toMatch(/^Nothing new uploaded to FAQ: the content of the file is already active\.$/m);
      expect(again.stdout).toMatch(/same-\w+\.md: identical to the active document [0-9a-f]{8}…; nothing new was created \(deduplicated\)/);
      const json = await cli(sb, ["kb", "upload", dir, "--kb", "FAQ", "--keep-both", "--json"]);
      expect(json.json<{ documents: Array<{ upload_outcome: string | null }> }>().documents.map((d) => d.upload_outcome)).toEqual(["deduplicated"]);
      // Without --keep-both: no second version exists, so neither the note about both versions nor an old operation to wait for.
      const plain = await cli(sb, ["kb", "upload", dir, "--kb", "FAQ"]);
      expect(plain.code, plain.stderr).toBe(0);
      expect(plain.stdout).toMatch(/nothing new was created \(deduplicated\)/);
      expect(plain.stdout).not.toMatch(/Both versions answer|exists \(|Wait with|Operations:/);
      const plainJson = (await cli(sb, ["kb", "upload", dir, "--kb", "FAQ", "--json"])).json<{ operation_ids: string[]; existing: Array<{ outcome: string }> }>();
      expect(plainJson.operation_ids).toEqual([]);
      expect(plainJson.existing.map((m) => m.outcome)).toEqual(["identical"]);
      // --replace never deactivates the document the identical file is.
      const replaced = await cli(sb, ["kb", "upload", dir, "--kb", "FAQ", "--replace", "--json"]);
      expect(replaced.json<{ existing: Array<{ outcome: string }> }>().existing.map((m) => m.outcome)).not.toContain("deactivated");
    } finally {
      server.state.uploadDedup = false;
      server.state.uploadOutcome = false;
    }
  });
});

describe("kb upload --dry-run and identical content", () => {
  beforeAll(() => {
    if (!server.state.kbs.some((k) => k.tenant_id === tenant && k.name === "FAQ")) server.state.kbs.push({ id: randomUUID(), tenant_id: tenant, name: "FAQ" });
  });

  it.each([
    ["names a file identical to an active document, by the published file hash", true],
    ["without file_sha256 on the documents, stays as it was", false],
  ])("%s", async (_label, published) => {
    const dir = path.join(sb.home, `kb-identical-${String(published)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `kept-${String(published)}.md`), `# Kept ${String(published)}\n`);
    expect((await cli(sb, ["kb", "upload", dir, "--kb", "FAQ"])).code).toBe(0);
    // The same bytes under another name, a changed file under the uploaded name, and a new file.
    const copy = path.join(sb.home, `kb-identical-${String(published)}-next`);
    mkdirSync(copy, { recursive: true });
    writeFileSync(path.join(copy, `renamed-${String(published)}.md`), `# Kept ${String(published)}\n`);
    writeFileSync(path.join(copy, `kept-${String(published)}.md`), `# Kept ${String(published)}, changed\n`);
    writeFileSync(path.join(copy, `new-${String(published)}.md`), "# New\n");
    server.state.documentHashes = published;
    try {
      const dry = await cli(sb, ["kb", "upload", copy, "--kb", "FAQ", "--dry-run"]);
      expect(dry.code, dry.stderr).toBe(0);
      // A file identical to an active document creates nothing new, so it is not counted as an upload.
      expect(dry.stdout).toMatch(published ? /^Would upload 2 files:$/m : /^Would upload 3 files:$/m);
      if (published) {
        expect(dry.stdout).toMatch(new RegExp(`renamed-true\\.md: identical to the active document [0-9a-f]{8}… \\(kept-true\\.md\\); nothing new would be created \\(deduplicated\\)`));
      } else {
        expect(dry.stdout).not.toMatch(/identical to the active document/);
      }
      // A changed file under an uploaded name is never identical.
      expect(dry.stdout).toMatch(new RegExp(`^kept-${String(published)}\\.md exists \\([0-9a-f]{8}…\\)`, "m"));
      const json = (await cli(sb, ["kb", "upload", copy, "--kb", "FAQ", "--dry-run", "--json"])).json<{
        content_compared: boolean;
        identical: Array<{ file: string; filename: string }>;
        existing: Array<{ identical?: boolean }>;
      }>();
      expect(json.content_compared).toBe(published);
      expect(json.identical.map((i) => [path.basename(i.file), i.filename])).toEqual(published ? [["renamed-true.md", "kept-true.md"]] : []);
      expect(json.existing.map((m) => m.identical)).toEqual([published ? false : undefined]);
    } finally {
      server.state.documentHashes = false;
    }
  });

  it("does not offer to replace or deactivate a same-named document the file is identical to", async () => {
    const dir = path.join(sb.home, "kb-identical-same");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "same-name.md"), "# Same name\n");
    expect((await cli(sb, ["kb", "upload", dir, "--kb", "FAQ"])).code).toBe(0);
    server.state.documentHashes = true;
    try {
      const dry = await cli(sb, ["kb", "upload", dir, "--kb", "FAQ", "--dry-run"]);
      expect(dry.stdout).toMatch(/^\S*same-name\.md: identical to the active document [0-9a-f]{8}…; nothing new would be created \(deduplicated\)$/m);
      expect(dry.stdout).not.toMatch(/exists \(|Both versions answer/);
      expect(dry.stdout).toMatch(/^Nothing new to upload:$/m);
      // The plan agrees with the flag and the text: nothing is replaced.
      const json = (await cli(sb, ["kb", "upload", dir, "--kb", "FAQ", "--dry-run", "--json"])).json<{ existing: Array<{ plan: string; identical: boolean }>; new_files: string[] }>();
      expect(json.existing).toEqual([expect.objectContaining({ plan: "identical", identical: true })]);
      expect(json.new_files).toEqual([]);
      const replace = await cli(sb, ["kb", "upload", dir, "--kb", "FAQ", "--replace", "--dry-run"]);
      expect(replace.stdout).not.toMatch(/exists \(|deactivates/);
    } finally {
      server.state.documentHashes = false;
    }
  });
});

describe("pull and docs search", () => {
  it("pull outside git points at the files it listed, not at git diff", async () => {
    const dir = await initSolution("support");
    const result = await cli(sb, ["pull"], { cwd: dir });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/See what changed: (the files listed above \(this folder is not in a git repository\)|git status --short -- .* \(new files\), then git diff -- )/);
    expect(result.stdout).not.toMatch(/See what changed: git diff -- package/);
  });

  it("finds the page a beginner means for greetings, the website, a tool's API key and a wrong answer", () => {
    const entries = parseIndex(readFileSync(path.join(CONTRACTS, "docs", "llms.txt"), "utf8"), "https://cavelon.example.com");
    const first = (q: string) => searchIndex(entries, q)[0]?.page;
    const firstThree = (q: string) => searchIndex(entries, q).slice(0, 3).map((e) => e.page);
    for (const q of ["How do I change the greeting?", "Wie ändere ich die Begrüßung?"]) expect(first(q), q).toBe("concepts/personas");
    for (const q of ["How do I put the bot on my website?", "Wie binde ich den Chat auf meiner Website ein?", "embed the chat"]) expect(first(q), q).toBe("channels/widget");
    for (const q of ["Where do I store an API key for a tool?", "Wo speichere ich den API-Schlüssel für ein Tool?"]) {
      expect(firstThree(q), q).toEqual(expect.arrayContaining(["concepts/tools", "tutorials/tool-using-agent"]));
      expect(first(q), q).not.toBe("administration/api-keys-and-auth");
    }
    for (const q of ["Why did my agent answer wrong?", "Warum hat mein Agent falsch geantwortet?"]) {
      expect(first(q), q).toBe("concepts/playground-and-debugging");
      expect(firstThree(q), q).toContain("academy/lesson-d0-traces");
    }
  });
});
