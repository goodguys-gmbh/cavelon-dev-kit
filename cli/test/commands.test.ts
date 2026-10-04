import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitJsonBody } from "../src/commands/api.js";
import { parseIndex, searchIndex } from "../src/commands/docs.js";
import { aliasOf } from "../src/openapi.js";
import { CONTRACTS, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

let server: FakeServer;
let sb: Sandbox;
let tenant: string;
let platformSb: Sandbox;

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
  platformSb = sandbox();
  await login(platformSb, server.url, server.addToken({ kind: "pat", tenantIds: [], platform: true }));
});
afterAll(async () => {
  sb.cleanup();
  platformSb.cleanup();
  await server.close();
});

describe("api", () => {
  it("reads FastAPI's short names off the operationId", () => {
    expect(aliasOf("list_harnesses_api_v1_harnesses_get", "/api/v1/harnesses", "get")).toBe("list_harnesses");
    expect(aliasOf("get_harness_by_slug_api_v1_harnesses_by_slug__slug__get", "/api/v1/harnesses/by-slug/{slug}", "get")).toBe("get_harness_by_slug");
    expect(aliasOf("custom", "/x", "get")).toBe("custom");
  });

  it("takes --json <body> as the body and a bare --json as the output switch", () => {
    expect(splitJsonBody(["op", "--json", "{}"])).toEqual(["op", "--body", "{}"]);
    expect(splitJsonBody(["op", "--json", "-"])).toEqual(["op", "--body", "-"]);
    expect(splitJsonBody(["op", "--json"])).toEqual(["op", "--json"]);
    expect(splitJsonBody(["op", "--json", "--limit", "3"])).toEqual(["op", "--json", "--limit", "3"]);
    expect(splitJsonBody(["op", "--json={\"a\":1}"])).toEqual(["op", "--body={\"a\":1}"]);
    // A parameter after --json is a parameter, and --json stays the output switch.
    expect(splitJsonBody(["op", "--json", "slug=support"])).toEqual(["op", "--json", "slug=support"]);
    expect(splitJsonBody(["op", "--json", "@body.json"])).toEqual(["op", "--body", "@body.json"]);
  });

  it("lists the instance's operations, filtered and paged", async () => {
    const page1 = await cli(sb, ["api", "list", "--tag", "harnesses", "--limit", "3", "--json"]);
    expect(page1.code).toBe(0);
    const data = page1.json<{ items: Array<{ operation: string; read_only: boolean }>; next_cursor: string; total: number }>();
    expect(data.items).toHaveLength(3);
    expect(data.items[0]).toMatchObject({ operation: "list_harnesses", read_only: true });
    expect(data.total).toBeGreaterThan(3);
    const page2 = await cli(sb, ["api", "list", "--tag", "harnesses", "--limit", "3", "--cursor", data.next_cursor, "--json"]);
    expect(page2.json<{ items: Array<{ operation: string }> }>().items[0]!.operation).not.toBe("list_harnesses");

    const text = await cli(sb, ["api", "list", "--search", "operations"]);
    expect(text.stdout).toMatch(/list_operations_route\s+GET\s+\/api\/v1\/operations/);
    const tags = await cli(sb, ["api", "list", "--tags", "--json"]);
    expect(tags.json<{ items: Array<{ tag: string }> }>().items.map((t) => t.tag)).toContain("operations");
  });

  it("describes an operation from the OpenAPI", async () => {
    const result = await cli(sb, ["api", "describe", "create_harness", "--json"]);
    expect(result.code).toBe(0);
    const data = result.json<Record<string, any>>();
    expect(data).toMatchObject({ method: "POST", path: "/api/v1/harnesses", read_only: false });
    expect(data.body.schema.fields.slug).toMatch(/string, required/);
  });

  it("calls an operation with parameters and a body", async () => {
    const created = await cli(sb, ["api", "create_harness", "--json", '{"slug":"via-api","name":"Via API"}']);
    expect(created.code, created.stderr).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ slug: "via-api", status: "draft" });

    const bySlug = await cli(sb, ["api", "get_harness_by_slug", "slug=via-api", "--json"]);
    expect(bySlug.code).toBe(0);
    expect(bySlug.json()).toMatchObject({ slug: "via-api" });

    const viaP = await cli(sb, ["api", "get_harness_by_slug", "-p", "slug=via-api"]);
    expect(JSON.parse(viaP.stdout)).toMatchObject({ slug: "via-api" });

    const fromFile = path.join(sb.home, "body.json");
    writeFileSync(fromFile, JSON.stringify({ slug: "from-file", name: "From file" }));
    expect((await cli(sb, ["api", "create_harness", "--json", `@${fromFile}`])).code).toBe(0);
    expect((await cli(sb, ["api", "create_harness", "--json", "-"], { stdin: '{"slug":"stdin","name":"S"}' })).code).toBe(0);
  });

  it("checks the body and parameters against the OpenAPI before sending (exit 3)", async () => {
    server.state.requests.length = 0;
    const bad = await cli(sb, ["api", "create_harness", "--json", '{"name":"No slug","colour":"red"}', "--json"]);
    expect(bad.code).toBe(3);
    const err = bad.json<{ error: { code: string; message: string } }>().error;
    expect(err.code).toBe("validation_failed");
    expect(err.message).toMatch(/slug/);
    expect(err.message).toMatch(/colour/);
    expect(server.state.requests.some((r) => r.method === "POST")).toBe(false);

    expect((await cli(sb, ["api", "get_harness_by_slug"])).code).toBe(3);
    expect((await cli(sb, ["api", "get_harness_by_slug", "slug=x", "nope=1"])).code).toBe(3);
  });

  it("maps the instance's answers to exit codes", async () => {
    expect((await cli(sb, ["api", "get_harness_by_slug", "slug=missing"])).code).toBe(1);
    expect((await cli(sb, ["api", "create_harness", "--json", '{"slug":"via-api","name":"dup"}'])).code).toBe(4);
    expect((await cli(sb, ["api", "no_such_operation"])).code).toBe(2);
    const unauth = await cli(sb, ["api", "list_harnesses", "--json"], { env: { CAVELON_URL: server.url, CAVELON_TOKEN: "cvpat_revoked" } });
    expect(unauth.code).toBe(7);
    expect(unauth.json<{ error: { status: number } }>().error.status).toBe(401);
  });

  it("finds an operation by a looser spelling and says which one it took", async () => {
    const described = await cli(sb, ["api", "describe", "createTenant", "--json"]);
    expect(described.code, described.stderr).toBe(0);
    expect(described.json()).toMatchObject({ operation: "create_tenant", method: "POST", path: "/api/v1/tenants" });
    expect(described.stderr).toMatch(/"createTenant" is taken as create_tenant/);
    expect((await cli(sb, ["api", "describe", "list-harnesses", "--json"])).json()).toMatchObject({ operation: "list_harnesses" });
    const missing = await cli(sb, ["api", "describe", "createTenantNow"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/Did you mean: create_tenant/);
  });

  it("takes the body with --body; --json <body> still works, with a deprecation warning", async () => {
    const body = await cli(sb, ["api", "create_harness", "--body", '{"slug":"by-body","name":"By body"}', "--json"]);
    expect(body.code, body.stderr).toBe(0);
    expect(body.stderr).not.toMatch(/deprecated/);
    const alias = await cli(sb, ["api", "create_harness", "--json", '{"slug":"by-alias","name":"By alias"}']);
    expect(alias.code, alias.stderr).toBe(0);
    expect(alias.stderr).toMatch(/`--json <body>` as the request body is deprecated/);
    const warned: string[] = [];
    splitJsonBody(["op", "--json", "{}"], (m) => warned.push(m));
    splitJsonBody(["op", "--json"], (m) => warned.push(m));
    expect(warned).toHaveLength(1);
  });

  it("says to pass a parameter as name=value when it was given as an option", async () => {
    const result = await cli(sb, ["api", "get_harness_by_slug", "--slug", "support", "--json"]);
    expect(result.code).toBe(2);
    expect(result.json<{ error: { hint: string } }>().error.hint).toMatch(/pass slug=<value> \(or -p slug=<value>\)/);
  });

  it("bounds a long list response", async () => {
    for (let i = 0; i < 5; i++) await cli(sb, ["harness", "new", `bulk-${i}`]);
    const result = await cli(sb, ["api", "list_harnesses", "--limit", "2", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json<unknown[]>()).toHaveLength(2);
    expect(result.stderr).toMatch(/Showing 2 of \d+ items/);
  });
});

describe("tenant", () => {
  it("creates and lists tenants with a platform token, without a tenant header", async () => {
    server.state.requests.length = 0;
    const created = await cli(platformSb, ["tenant", "create", "newco", "--name", "NewCo", "--use", "--json"]);
    expect(created.code, created.stderr + created.stdout).toBe(0);
    expect(created.json()).toMatchObject({ slug: "newco", name: "NewCo" });
    const post = server.state.requests.find((r) => r.method === "POST" && r.path === "/api/v1/tenants")!;
    expect(post.headers["x-tenant-id"]).toBeUndefined();
    expect(post.body).toEqual({ slug: "newco", name: "NewCo" });

    const list = await cli(platformSb, ["tenant", "list", "--json", "--limit", "1"]);
    expect(list.code).toBe(0);
    const page = list.json<{ items: Array<{ slug: string }>; next_cursor: string | null; source: string }>();
    expect(page.source).toBe("platform");
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).toBe("1");

    // --use switched to the new tenant.
    const who = await cli(platformSb, ["status", "--offline", "--json"]);
    expect(who.json<{ tenant: { ref: string; source: string } }>().tenant).toEqual({ ref: "newco", source: "use" });
  });

  it("lists the tenants the token reaches with name, slug, role and id when it is no platform operator", async () => {
    const result = await cli(sb, ["tenant", "list", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json<{ source: string; items: Array<{ id: string; name: string }> }>()).toMatchObject({
      source: "token",
      items: [{ id: tenant, name: "Acme", slug: "acme", role: "tenant_admin" }],
    });
    const text = await cli(sb, ["tenant", "list"]);
    expect(text.stdout).toMatch(/^NAME\s+SLUG\s+ROLE\s+ID\nAcme\s+acme\s+tenant_admin\s+[0-9a-f-]{36}$/m);
    expect(text.stdout).toContain("Choose one: cavelon use <slug>");
  });

  it("an older instance: lists the person's memberships, with the slug where /auth/me names it", async () => {
    server.state.serveTenantReach = false;
    try {
      const result = await cli(sb, ["tenant", "list", "--json"]);
      expect(result.code).toBe(0);
      expect(result.json<{ source: string; items: Array<{ id: string; name: string; slug: string | null }> }>()).toMatchObject({
        source: "memberships",
        items: [{ id: tenant, name: "Acme", slug: null }],
      });
    } finally {
      server.state.serveTenantReach = true;
    }
  });

  it("refuses tenant creation with a tenant API key (exit 7)", async () => {
    const key = server.addToken({ kind: "key", tenantIds: [tenant] });
    const result = await cli(sb, ["tenant", "create", "nope", "--json"], { env: { CAVELON_URL: server.url, CAVELON_TOKEN: key } });
    expect(result.code).toBe(7);
    expect(result.json<{ error: { code: string } }>().error.code).toBe("api_key_cannot_create_tenants");
  });

  it("reports the server's validation error (exit 3)", async () => {
    const result = await cli(platformSb, ["tenant", "create", "Bad Slug!"]);
    expect(result.code).toBe(3);
  });

  /** An operator's token that reaches every tenant but may not enter Platform mode, as an instance names its ceiling. */
  const operatorEnv = () => ({
    CAVELON_URL: server.url,
    CAVELON_TOKEN: server.addToken({ kind: "pat", tenantIds: [], reachesAll: true, ceilingRole: "tenant_builder", tokenName: "operator" }),
  });

  it("refuses before sending when the token may not enter Platform mode, and names the remedy (exit 7)", async () => {
    server.state.requests.length = 0;
    const result = await cli(sb, ["tenant", "create", "blocked", "--json"], { env: operatorEnv() });
    expect(result.code).toBe(7);
    const error = result.json<{ error: { code: string; message: string; hint: string; details: { sent: boolean } } }>().error;
    expect(error.code).toBe("platform_mode_not_allowed");
    expect(error.message).toMatch(/may not enter Platform mode \(ceiling tenant_builder\)/);
    expect(error.hint).toMatch(/Allow Platform mode/);
    expect(error.hint).toMatch(/in the Admin/);
    expect(error.hint).not.toMatch(/cavelon whoami/);
    expect(error.details.sent).toBe(false);
    expect(server.state.requests.some((r) => r.method === "POST" && r.path === "/api/v1/tenants")).toBe(false);
  });

  it("refuses before sending when Platform mode lacks tenants.manage (exit 7)", async () => {
    const env = { CAVELON_URL: server.url, CAVELON_TOKEN: server.addToken({ kind: "pat", tenantIds: [], platform: true, permissions: ["platform.maintenance"] }) };
    server.state.requests.length = 0;
    const result = await cli(sb, ["tenant", "create", "blocked", "--json"], { env });
    expect(result.code).toBe(7);
    expect(result.json<{ error: { code: string } }>().error.code).toBe("permission_missing");
    expect(server.state.requests.some((r) => r.method === "POST" && r.path === "/api/v1/tenants")).toBe(false);
  });

  it("an instance whose /meta/principal does not say whether the token allows Platform mode: sends, and the route decides", async () => {
    server.state.principalWithoutPlatformMode = true;
    try {
      server.state.requests.length = 0;
      const result = await cli(sb, ["tenant", "create", "unsaid", "--json"], { env: operatorEnv() });
      expect(result.code).toBe(7);
      expect(result.json<{ error: { status: number } }>().error.status).toBe(403);
      expect(server.state.requests.some((r) => r.method === "POST" && r.path === "/api/v1/tenants")).toBe(true);
      const created = await cli(platformSb, ["tenant", "create", "unsaid-ok", "--json"]);
      expect(created.code, created.stdout).toBe(0);
    } finally {
      server.state.principalWithoutPlatformMode = undefined;
    }
  });

  it("an instance without /meta/principal: sends, and the refusal's hint is about Platform mode, not the tenant", async () => {
    server.state.servePrincipal = false;
    try {
      const env = { CAVELON_URL: server.url, CAVELON_TOKEN: server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }) };
      const result = await cli(sb, ["tenant", "create", "blocked", "--json"], { env });
      expect(result.code).toBe(7);
      const error = result.json<{ error: { status: number; hint: string } }>().error;
      expect(error.status).toBe(403);
      expect(error.hint).toMatch(/platform route/);
      expect(error.hint).toMatch(/tenants\.manage/);
      expect(error.hint).not.toMatch(/Check the tenant/);
    } finally {
      server.state.servePrincipal = true;
    }
  });

  it("--use switches only when the token acts in the new tenant", async () => {
    const env = { CAVELON_URL: server.url, CAVELON_TOKEN: server.addToken({ kind: "pat", tenantIds: [], platform: true, platformOnly: true }) };
    const created = await cli(sb, ["tenant", "create", "kept-out", "--use", "--json"], { env });
    expect(created.code, created.stdout + created.stderr).toBe(0);
    const data = created.json<{ slug: string; used: boolean; warnings: string[] }>();
    expect(data).toMatchObject({ slug: "kept-out", used: false });
    expect(data.warnings.join()).toMatch(/does not act in the new tenant/);
    const status = await cli(sb, ["status", "--offline", "--json"], { env });
    expect(status.json<{ tenant: { ref: string } | null }>().tenant?.ref).not.toBe("kept-out");
  });

  it("an operator's token without memberships: tenant list says so and how to find any tenant", async () => {
    const env = operatorEnv();
    const text = await cli(sb, ["tenant", "list"], { env });
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/^No memberships of your own; this token reaches every tenant/);
    expect(text.stdout).toContain("cavelon tenant list --search <part of the name>");
    const json = await cli(sb, ["tenant", "list", "--json"], { env });
    expect(json.json()).toMatchObject({ items: [], total: 0, reaches_all_tenants: true, listed: "own_memberships", note: expect.stringMatching(/total count only your own/) });
  });

  it("whoami says whether the token may enter Platform mode and which tenants it reaches", async () => {
    const env = operatorEnv();
    const text = await cli(sb, ["whoami"], { env });
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toMatch(/platform mode:\s+not allowed \(ceiling tenant_builder\)/);
    expect(text.stdout).toMatch(/reaches:\s+every tenant \(as operator; no memberships of your own\)/);
    const json = await cli(sb, ["whoami", "--json"], { env });
    expect(json.json()).toMatchObject({ credential: { platform_mode_allowed: false, ceiling_role: "tenant_builder" }, reaches: { every_tenant: true } });
    const platform = await cli(platformSb, ["whoami"]);
    expect(platform.stdout).toMatch(/platform mode:\s+allowed/);
  });
});

describe("harness", () => {
  it("creates, lists and clones solutions", async () => {
    const created = await cli(sb, ["harness", "new", "support", "--name", "Support", "--description", "FAQ bot", "--json"]);
    expect(created.code).toBe(0);
    const harness = created.json<{ id: string; slug: string }>();
    expect(harness.slug).toBe("support");

    const cloned = await cli(sb, ["harness", "clone", "support", "--slug", "support-v2", "--no-tests", "--json"]);
    expect(cloned.code, cloned.stderr).toBe(0);
    expect(cloned.json()).toMatchObject({ slug: "support-v2" });
    const cloneCall = server.state.requests.filter((r) => r.path === `/api/v1/harnesses/${harness.id}/clone`).pop()!;
    expect(cloneCall.body).toEqual({ slug: "support-v2", include_tests: false });

    const list = await cli(sb, ["harness", "list", "--json"]);
    const slugs = list.json<{ items: Array<{ slug: string }> }>().items.map((h) => h.slug);
    expect(slugs).toEqual(expect.arrayContaining(["support", "support-v2"]));
    const text = await cli(sb, ["harness", "list"]);
    expect(text.stdout).toMatch(/^SLUG\s+NAME\s+STATUS\s+DEFAULT\s+ID/);
  });

  it("says which source is unknown", async () => {
    const result = await cli(sb, ["harness", "clone", "ghost", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json<{ error: { code: string } }>().error.code).toBe("solution_not_found");
  });

  it("finds a solution by its name, or by its slug in other letter case, and names the closest on a miss", async () => {
    const created = await cli(sb, ["harness", "new", "expense-approval", "--name", "Expense Approval", "--json"]);
    expect(created.code, created.stderr).toBe(0);
    const id = created.json<{ id: string }>().id;
    for (const ref of ["Expense Approval", "expense approval", "EXPENSE-APPROVAL", id]) {
      server.state.requests.length = 0;
      const cloned = await cli(sb, ["harness", "clone", ref, "--slug", `copy-${Math.random().toString(36).slice(2, 8)}`, "--json"]);
      expect(cloned.code, `${ref}: ${cloned.stderr}${cloned.stdout}`).toBe(0);
      expect(server.state.requests.some((r) => r.path === `/api/v1/harnesses/${id}/clone`), ref).toBe(true);
    }
    const miss = await cli(sb, ["harness", "clone", "Expense Aproval", "--json"]);
    expect(miss.code).toBe(1);
    const error = miss.json<{ error: { code: string; message: string; hint: string; details: { candidates: Array<{ slug: string }> } } }>().error;
    expect(error.code).toBe("solution_not_found");
    expect(error.message).toContain('No solution "Expense Aproval" in this tenant. Closest: Expense Approval (expense-approval).');
    expect(error.hint).toContain("--harness expense-approval");
    expect(error.details.candidates[0]!.slug).toBe("expense-approval");
  });
});

describe("docs", () => {
  it("searches the instance's llms.txt and reads a page", async () => {
    const search = await cli(sb, ["docs", "search", "regression", "testing", "--json"]);
    expect(search.code).toBe(0);
    const hits = search.json<{ items: Array<{ page: string; title: string }> }>().items;
    expect(hits[0]!.page).toBe("concepts/regression-testing");

    const page = await cli(sb, ["docs", "get", "concepts/regression-testing", "--json"]);
    expect(page.code).toBe(0);
    const head = page.json<{ markdown: string; next_cursor: string | null; length: number }>();
    expect(head.markdown).toMatch(/^# /);
    // The page is longer than one default read: the cursor reads on to its end.
    expect(head.next_cursor).toBe(String(head.markdown.length));
    const tail = (await cli(sb, ["docs", "get", "concepts/regression-testing", "--cursor", head.next_cursor!, "--json"])).json<{ markdown: string; next_cursor: string | null }>();
    expect(tail.next_cursor).toBeNull();
    const doc = { markdown: head.markdown + tail.markdown };
    expect(doc.markdown.length).toBe(head.length);

    const chunk = await cli(sb, ["docs", "get", "concepts/regression-testing", "--max-chars", "1000", "--json"]);
    const first = chunk.json<{ markdown: string; next_cursor: string }>();
    expect(first.markdown).toHaveLength(1000);
    const rest = await cli(sb, ["docs", "get", "concepts/regression-testing", "--max-chars", "1000", "--cursor", first.next_cursor, "--json"]);
    expect(rest.json<{ markdown: string }>().markdown.slice(0, 20)).toBe(doc.markdown.slice(1000, 1020));
  });

  it("finds the concept page first for beginner questions in German and English", async () => {
    const first = async (question: string) => {
      const result = await cli(sb, ["docs", "search", question, "--json"]);
      expect(result.code, result.stderr).toBe(0);
      return result.json<{ items: Array<{ page: string }>; total: number; terms: string[] }>();
    };
    for (const [question, page] of [
      ["Wie lade ich Dokumente in eine Wissensbasis hoch?", "concepts/knowledge-bases"],
      ["Wie teste ich meinen Agenten?", "concepts/regression-testing"],
      ["Wie mache ich meinen Bot zur Standardantwort für alle Nutzer?", "concepts/harnesses"],
      ["how do I upload documents to a knowledge base", "concepts/knowledge-bases"],
      ["how do I test my agent", "concepts/regression-testing"],
      ["triggers", "concepts/triggers"],
    ] as const) {
      const found = await first(question);
      expect(found.items[0]?.page, question).toBe(page);
      // Only the pages that match well, never most of the index.
      expect(found.total, question).toBeLessThanOrEqual(12);
    }
    expect((await first("Wie lade ich Dokumente in eine Wissensbasis hoch?")).terms).toEqual(["upload", "document", "knowledge", "base"]);
  });

  it("matches whole words and drops stop words", async () => {
    const entries = parseIndex(readFileSync(path.join(CONTRACTS, "docs", "llms.txt"), "utf8"), "https://cavelon.example.com");
    // "test" is in "latest" and "contest" as letters only.
    const latest = { page: "x/latest", title: "The latest release", description: "What is new.", section: "Reference", url: "https://x" };
    expect(searchIndex([latest], "test")).toEqual([]);
    expect(searchIndex(entries, "wie ist das in der")).toEqual([]);
    expect(searchIndex(entries, "how do I use it")).toEqual([]);
  });

  it("says so when nothing matches, with English words and the index to try", async () => {
    const result = await cli(sb, ["docs", "search", "Quarkstrudel", "--json"]);
    expect(result.code).toBe(0);
    const data = result.json<{ items: unknown[]; total: number; hint: string }>();
    expect(data).toMatchObject({ items: [], total: 0 });
    expect(data.hint).toMatch(/^No page matches "Quarkstrudel" \(looked for: quarkstrudel\)\. The docs are in English: try English words/);
    expect(data.hint).toContain("cavelon docs get index");
    const text = await cli(sb, ["docs", "search", "Wie", "ist", "das?"]);
    expect(text.stdout).toMatch(/No page matches "Wie ist das\?" \(it has only stop words\)/);

    const index = await cli(sb, ["docs", "get", "index", "--max-chars", "200", "--json"]);
    expect(index.code, index.stderr).toBe(0);
    const head = index.json<{ page: string; markdown: string; next_cursor: string }>();
    expect(head).toMatchObject({ page: "index", next_cursor: "200" });
    expect(head.markdown).toMatch(/^# Cavelon Documentation/);
  });

  it("suggests pages for an unknown one", async () => {
    const result = await cli(sb, ["docs", "get", "concepts/regression", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json<{ error: { hint: string } }>().error.hint).toMatch(/concepts\/regression-testing/);
  });

  it("says clearly when the instance serves no docs", async () => {
    const other = sandbox();
    try {
      server.state.serveDocs = false;
      await login(other, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
      const result = await cli(other, ["docs", "search", "anything", "--json"]);
      expect(result.code).toBe(1);
      expect(result.json<{ error: { code: string } }>().error.code).toBe("docs_unavailable");
    } finally {
      server.state.serveDocs = true;
      other.cleanup();
    }
  });
});

describe("behind a proxy that sends root paths to the Admin", () => {
  it("finds the OpenAPI and the docs index under /api", async () => {
    const other = sandbox();
    server.state.rootPathsReachApi = false;
    try {
      await login(other, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
      const ops = await cli(other, ["api", "list", "--tag", "operations", "--json"]);
      expect(ops.code, ops.stderr + ops.stdout).toBe(0);
      expect(ops.json<{ total: number }>().total).toBe(3);
      const docs = await cli(other, ["docs", "search", "regression", "--json"]);
      expect(docs.code, docs.stderr + docs.stdout).toBe(0);
      expect(docs.json<{ items: Array<{ page: string }> }>().items[0]!.page).toBe("concepts/regression-testing");
    } finally {
      server.state.rootPathsReachApi = true;
      other.cleanup();
    }
  });
});
