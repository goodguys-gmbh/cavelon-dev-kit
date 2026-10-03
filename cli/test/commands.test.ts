import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitJsonBody } from "../src/commands/api.js";
import { aliasOf } from "../src/openapi.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
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

  it("lists a person's memberships when they are no platform operator", async () => {
    const result = await cli(sb, ["tenant", "list", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json<{ source: string; items: Array<{ id: string; name: string }> }>()).toMatchObject({
      source: "memberships",
      items: [{ id: tenant, name: "Acme" }],
    });
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
    expect(text.stdout).toMatch(/^SLUG\s+NAME\s+STATUS\s+ID/);
  });

  it("says which source is unknown", async () => {
    const result = await cli(sb, ["harness", "clone", "ghost", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json<{ error: { code: string } }>().error.code).toBe("not_found");
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
