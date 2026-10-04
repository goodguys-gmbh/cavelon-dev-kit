import { statSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setKeyringFactoryForTests, type KeyringEntry } from "../src/credentials.js";
import { instanceKey } from "../src/paths.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

let server: FakeServer;
let sb: Sandbox;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  server = await startFakeServer();
  tenantA = server.addTenant("acme", "Acme");
  tenantB = server.addTenant("globex", "Globex");
});
afterAll(() => server.close());
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

describe("login", () => {
  it("reads the token from stdin, checks it, and stores it in a user-only file", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA], defaultTenant: tenantA, email: "ada@example.com" });
    const result = await cli(sb, ["login", "--instance", server.url, "--token-stdin", "--json"], { stdin: `${token}\n` });
    expect(result.code).toBe(0);
    const data = result.json<{ instance: string; credential: { kind: string; store: string }; owner: { email: string } }>();
    expect(data.instance).toBe(server.url);
    expect(data.credential).toEqual({ kind: "personal_access_token", store: "file" });
    expect(data.owner.email).toBe("ada@example.com");

    const credentials = path.join(sb.env.CAVELON_CONFIG_DIR!, "credentials.json");
    if (process.platform !== "win32") expect(statSync(credentials).mode & 0o777).toBe(0o600);
    // The token is in the credentials file only: never in the config, output or cache.
    expect(readFileSync(credentials, "utf8")).toContain(token);
    expect(readFileSync(path.join(sb.env.CAVELON_CONFIG_DIR!, "config.json"), "utf8")).not.toContain(token);
    expect(result.stdout + result.stderr).not.toContain(token);
    // The contracts were cached per instance and version.
    const cached = readdirSync(path.join(sb.env.CAVELON_CACHE_DIR!, instanceKey(server.url), "v0.0.0-dev"));
    expect(cached).toEqual(expect.arrayContaining(["capabilities.json", "openapi.json", "error-catalog.json"]));
  });

  it("says the token is refused, not that the tenant is unknown", async () => {
    const result = await cli(sb, ["login", "--instance", server.url, "--tenant", "acme", "--token-stdin"], { stdin: "cvpat_expired\n" });
    expect(result.code).toBe(7);
  });

  it("refuses a token the instance refuses, and stores nothing", async () => {
    const result = await cli(sb, ["login", "--instance", server.url, "--token-stdin"], { stdin: "cvpat_not-a-real-one\n" });
    expect(result.code).toBe(7);
    expect(result.stderr).toMatch(/error:/);
    expect(existsSync(path.join(sb.env.CAVELON_CONFIG_DIR!, "credentials.json"))).toBe(false);
  });

  it("never takes the token as an argument", async () => {
    for (const args of [["login", "--token", "cvpat_x"], ["login", "--token=cvpat_x"], ["whoami", "--token", "cvpat_x"]]) {
      const result = await cli(sb, args);
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/never takes a token as an argument/);
    }
  });

  it("does not prompt without a terminal", async () => {
    const result = await cli(sb, ["login", "--instance", server.url]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/No terminal to ask for the token/);
  });

  it("warns when the instance's contracts are newer than the kit's, and still logs in", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA], defaultTenant: tenantA });
    server.state.capsPatch = { contracts: { api_version: "v2", package_versions: { current: "v9", accepted: ["v8", "v9"] } } };
    try {
      const result = await cli(sb, ["login", "--instance", server.url, "--token-stdin", "--json"], { stdin: token });
      expect(result.code).toBe(0);
      const warnings = result.json<{ warnings: string[] }>().warnings;
      expect(warnings.join("\n")).toMatch(/API v2/);
      expect(warnings.join("\n")).toMatch(/package format v9/);
      expect(result.stderr).toMatch(/warning: .*Update cavelon/);
    } finally {
      server.state.capsPatch = {};
    }
  });

  it("refuses a wrong API key on an instance older than the /meta routes, which answers 404 before checking the caller", async () => {
    server.state.serveMeta = false;
    try {
      const wrong = await cli(sb, ["login", "--instance", server.url, "--token-stdin", "--json"], { stdin: "cbp_wrong\n" });
      expect(wrong.code, wrong.stdout).toBe(7);
      expect(wrong.json<{ error: { code: string } }>().error.code).toBe("unauthorized");
      expect(existsSync(path.join(sb.env.CAVELON_CONFIG_DIR!, "credentials.json"))).toBe(false);

      // A key the instance knows still logs in there.
      const key = server.addToken({ kind: "key", tenantIds: [tenantA] });
      const right = await cli(sb, ["login", "--instance", server.url, "--token-stdin", "--json"], { stdin: key });
      expect(right.code, right.stdout + right.stderr).toBe(0);
      expect(readFileSync(path.join(sb.env.CAVELON_CONFIG_DIR!, "credentials.json"), "utf8")).toContain(key);
    } finally {
      server.state.serveMeta = true;
    }
  });

  it("logs in with a platform token that has no tenant yet, and says to choose one", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [], platform: true });
    const result = await cli(sb, ["login", "--instance", server.url, "--token-stdin"], { stdin: token });
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/cavelon use <tenant>/);
  });
});

describe("login without --tenant", () => {
  type Refusal = { error: { code: string; message: string; hint: string; status: number; details: Record<string, unknown> } };
  const PLATFORM_REFUSAL = "This personal access token does not work in Platform mode; select a tenant with X-Tenant-Id";
  const credentials = () => path.join(sb.env.CAVELON_CONFIG_DIR!, "credentials.json");
  const config = () => JSON.parse(readFileSync(path.join(sb.env.CAVELON_CONFIG_DIR!, "config.json"), "utf8")) as { instances: Record<string, Record<string, unknown>> };
  /** A person at a terminal: the hidden token, then each answer on its own line. */
  const atTerminal = (args: string[], ...lines: string[]) => cli(sb, args, { tty: true, stdin: lines.map((l) => `${l}\n`).join(""), env: { NO_COLOR: "1" } });
  /** An older instance: it lists no tenants and refuses a token it cannot place, everywhere. */
  async function olderInstance<T>(run: () => Promise<T>): Promise<T> {
    server.state.serveTenantReach = false;
    try {
      return await run();
    } finally {
      server.state.serveTenantReach = true;
    }
  }

  it("the fake answers a token it cannot place only on /meta/principal, with the tenants it reaches; an older one refuses it there too", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA, tenantB] });
    for (const route of ["/api/v1/auth/me", "/api/v1/meta/capabilities", "/api/v1/tenants"]) {
      const response = await fetch(`${server.url}${route}`, { headers: { Authorization: `Bearer ${token}` } });
      expect([route, response.status]).toEqual([route, 403]);
      expect(await response.json()).toEqual({ detail: PLATFORM_REFUSAL });
    }
    const principal = await fetch(`${server.url}/api/v1/meta/principal`, { headers: { Authorization: `Bearer ${token}` } });
    expect(principal.status).toBe(200);
    expect(await principal.json()).toMatchObject({
      tenant_id: null,
      reaches_all_tenants: false,
      tenants: [
        { id: tenantA, slug: "acme", name: "Acme", role: "tenant_admin", is_default: false },
        { id: tenantB, slug: "globex", name: "Globex", role: "tenant_admin", is_default: false },
      ],
    });
    await olderInstance(async () => {
      const refused = await fetch(`${server.url}/api/v1/meta/principal`, { headers: { Authorization: `Bearer ${token}` } });
      expect(refused.status).toBe(403);
    });
    const inTenant = await fetch(`${server.url}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tenantB } });
    expect(inTenant.status).toBe(200);
  });

  it("one tenant: uses it, says so, and remembers it by name and slug", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA], email: "ada@example.com" });
    const result = await cli(sb, ["login", "--instance", server.url, "--token-stdin"], { stdin: `${token}\n` });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Using tenant Acme (acme, ${tenantA}), the only one this token reaches.`);
    expect(result.stderr).not.toMatch(/other tenant/);
    expect(config().instances[server.url]).toMatchObject({ tenant: "acme", tenant_id: tenantA, tenant_name: "Acme", tenant_slug: "acme" });

    // Logging in again keeps the tenant chosen before.
    const json = await cli(sb, ["login", "--instance", server.url, "--token-stdin", "--json"], { stdin: `${token}\n` });
    expect(json.json<{ tenant: unknown }>().tenant).toEqual({ ref: "acme", id: tenantA, name: "Acme", slug: "acme", chosen: "use" });
    const who = await cli(sb, ["whoami", "--json"]);
    expect(who.code).toBe(0);
    expect(who.json<{ tenant: unknown }>().tenant).toMatchObject({ id: tenantA, name: "Acme", slug: "acme", mode: "tenant" });
    expect((await cli(sb, ["whoami"])).stdout).toMatch(new RegExp(`tenant:\\s+Acme \\(acme, ${tenantA}\\)`));
  });

  it("several tenants on a terminal: a numbered list, and a number chooses", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA, tenantB] });
    const result = await atTerminal(["login", "--instance", server.url], token, "2");
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain(`This token reaches 2 tenants on ${server.url}:`);
    expect(result.stderr).toMatch(/ 1 {2}Acme {2}acme {2}\(tenant_admin\)\n {3}2 {2}Globex {2}globex {2}\(tenant_admin\)/);
    expect(result.stderr).toContain("Which tenant? (type its number or part of its name)");
    expect(result.stdout).toContain(`Using tenant Globex (globex, ${tenantB}); \`cavelon use\` chooses another.`);
    expect(result.stdout + result.stderr).not.toContain(token);
    expect(config().instances[server.url]).toMatchObject({ tenant: "globex", tenant_id: tenantB });
    const who = await cli(sb, ["whoami", "--json"]);
    expect(who.json<{ tenant: unknown }>().tenant).toMatchObject({ id: tenantB, slug: "globex", source: "use" });
  });

  it("several tenants on a terminal: part of a name chooses, a miss asks again, and Enter takes the default", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA, tenantB] });
    const byName = await atTerminal(["login", "--instance", server.url], token, "nope", "7", "glob");
    expect(byName.code, byName.stderr).toBe(0);
    expect(byName.stderr).toContain('Nothing is called "nope".');
    expect(byName.stderr).toContain("There is no number 7 in the list.");
    expect(byName.stdout).toContain("Using tenant Globex");

    const withDefault = server.addToken({ kind: "pat", tenantIds: [tenantA, tenantB], defaultTenant: tenantB });
    await cli(sb, ["use", "--clear", "--instance", server.url]);
    const enter = await atTerminal(["login", "--instance", server.url], withDefault, "");
    expect(enter.code, enter.stderr).toBe(0);
    expect(enter.stderr).toMatch(/2 {2}Globex {2}globex {2}\(tenant_admin, default, press Enter\)/);
    expect(enter.stdout).toContain("Using tenant Globex");

    await cli(sb, ["use", "--clear", "--instance", server.url]);
    const cancelled = await atTerminal(["login", "--instance", server.url], token);
    expect(cancelled.code).toBe(1);
    expect(cancelled.stderr).toMatch(/Cancelled; nothing was chosen/);
  });

  it("several tenants without a terminal: stores the token and prints one ready `cavelon use` line per tenant (exit 2)", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA, tenantB] });
    const result = await cli(sb, ["login", "--instance", server.url, "--token-stdin"], { stdin: `${token}\n` });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`error: The token is stored for ${server.url}, but no tenant is chosen yet. This token reaches 2 tenants on ${server.url}, and there is no terminal to ask which one to use.`);
    expect(result.stderr).toMatch(/hint: Run the line for the tenant you want:\n {2}cavelon use acme +Acme\n {2}cavelon use globex +Globex/);
    expect(existsSync(credentials())).toBe(true);
    expect(result.stdout + result.stderr).not.toContain(token);

    const json = await cli(sb, ["login", "--instance", server.url, "--token-stdin", "--json"], { stdin: `${token}\n` });
    const { error } = json.json<Refusal>();
    expect(error.code).toBe("tenant_required");
    expect(error.details.tenants).toEqual([
      { id: tenantA, slug: "acme", name: "Acme", role: "tenant_admin", is_default: false, command: "cavelon use acme" },
      { id: tenantB, slug: "globex", name: "Globex", role: "tenant_admin", is_default: false, command: "cavelon use globex" },
    ]);
    // The printed line works as it is.
    const used = await cli(sb, ["use", "globex", "--json"]);
    expect(used.code, used.stderr + used.stdout).toBe(0);
    expect(used.json()).toMatchObject({ tenant: { ref: "globex", id: tenantB, name: "Globex", slug: "globex" } });
  });

  it("a tenant chosen with an earlier token that the new one does not reach is chosen again", async () => {
    await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenantA] }));
    const result = await cli(sb, ["login", "--instance", server.url, "--token-stdin", "--json"], { stdin: server.addToken({ kind: "pat", tenantIds: [tenantB] }) });
    expect(result.code, result.stdout).toBe(0);
    expect(result.json<{ tenant: unknown; warnings: string[] }>()).toMatchObject({
      tenant: { id: tenantB, chosen: "only" },
      warnings: expect.arrayContaining(["The tenant chosen before (acme) is not one this token reaches; choosing again."]),
    });
  });

  it("a token whose owner has a default tenant, without a terminal: acts there and prints the line for each other tenant", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA, tenantB], defaultTenant: tenantB });
    const result = await cli(sb, ["login", "--instance", server.url, "--token-stdin"], { stdin: `${token}\n` });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Acting in tenant Globex (globex, ${tenantB}), the one the instance chooses for this token.`);
    expect(result.stderr).toMatch(/Without a tenant this token acts in Globex\. To work in another tenant, run:\n {2}cavelon use acme {4}Acme/);
  });

  it("an operator's token that reaches every tenant: asks for part of a name on a terminal and searches", async () => {
    const summaries = server.addTenant("demo-long-document-summaries", "Demo: Long Document Summaries");
    server.addTenant("demo-short-answers", "Demo: Short Answers");
    const token = server.addToken({ kind: "pat", tenantIds: [], reachesAll: true, globalRole: "superadmin" });
    const result = await atTerminal(["login", "--instance", server.url], token, "demo", "long");
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain(`This token reaches every tenant on ${server.url}.`);
    expect(result.stderr).toContain("Which tenant? (type part of its name)");
    expect(result.stderr).toMatch(/2 match "demo":\n {3}1 {2}Demo: Long Document Summaries {2}demo-long-document-summaries/);
    expect(result.stdout).toContain(`Using tenant Demo: Long Document Summaries (demo-long-document-summaries, ${summaries})`);
    // The search went to the instance, without a tenant.
    const searches = server.state.requests.filter((r) => r.path === "/api/v1/meta/principal" && r.query.get("search"));
    expect(searches.map((r) => [r.query.get("search"), r.headers["x-tenant-id"]])).toEqual(expect.arrayContaining([["demo", undefined]]));
  });

  it("an operator's token that reaches every tenant: --tenant and `use` find a tenant by slug or name; without a terminal it is stored and told how to choose", async () => {
    const summaries = server.addTenant("demo-summaries-op", "Summaries for Operators");
    const token = server.addToken({ kind: "pat", tenantIds: [], reachesAll: true, globalRole: "superadmin" });
    const bySlug = await cli(sb, ["login", "--instance", server.url, "--tenant", "demo-summaries-op", "--token-stdin", "--json"], { stdin: `${token}\n` });
    expect(bySlug.code, bySlug.stdout).toBe(0);
    expect(bySlug.json<{ tenant: unknown }>().tenant).toMatchObject({ id: summaries, name: "Summaries for Operators", slug: "demo-summaries-op", chosen: "option" });
    expect((await cli(sb, ["use", "summaries for operators", "--json"])).json()).toMatchObject({ tenant: { ref: "demo-summaries-op", id: summaries } });

    await cli(sb, ["use", "--clear"]);
    const open = await cli(sb, ["login", "--instance", server.url, "--token-stdin"], { stdin: `${token}\n` });
    expect(open.code).toBe(2);
    expect(open.stderr).toContain(`This token reaches every tenant on ${server.url}, and there is no terminal`);
    expect(open.stderr).toContain("Choose one: `cavelon use <name or slug>`; `cavelon tenant list --search <part of the name>` finds its slug.");
    const listed = await cli(sb, ["tenant", "list", "--search", "operators", "--json"]);
    expect(listed.json<{ source: string; items: unknown[] }>()).toMatchObject({ source: "token", items: [{ id: summaries, slug: "demo-summaries-op" }] });
    const miss = await cli(sb, ["use", "demo-sumaries-op", "--json"]);
    expect(miss.code).toBe(1);
    expect(miss.json<Refusal>().error).toMatchObject({ code: "tenant_not_found", hint: expect.stringContaining("tenant list --search") });
  });

  it("no tenant: says where to change the token, and stores nothing", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [] });
    const result = await cli(sb, ["login", "--instance", server.url, "--token-stdin", "--json"], { stdin: `${token}\n` });
    expect(result.code).toBe(7);
    const { error } = result.json<Refusal>();
    expect(error.code).toBe("no_tenant_reached");
    expect(error.hint).toContain(`${server.url}/account/access-tokens`);
    expect(existsSync(credentials())).toBe(false);
  });

  it("whoami of a token that acts in no tenant yet: shows it and how to choose; any other call says the same", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA, tenantB] });
    const env = { CAVELON_URL: server.url, CAVELON_TOKEN: token };
    const who = await cli(sb, ["whoami", "--json"], { env });
    expect(who.code).toBe(0);
    expect(who.json<{ tenant: unknown; warnings: string[] }>()).toMatchObject({
      tenant: { id: null, mode: "none" },
      warnings: [expect.stringMatching(/No tenant is chosen\. Choose one with `cavelon use`, or run the line for the tenant you want:\n {2}cavelon use acme/)],
    });

    const limits = await cli(sb, ["limits", "--json"], { env });
    expect(limits.code).toBe(7);
    expect(limits.json<Refusal>().error.message).toContain(PLATFORM_REFUSAL);
    expect(limits.json<Refusal>().error.hint).toMatch(/^No tenant was named\. .*Run `cavelon use` to choose one/);

    const inTenant = await cli(sb, ["whoami", "--json", "--tenant", "Globex"], { env });
    expect(inTenant.code).toBe(0);
    expect(inTenant.json<{ tenant: unknown }>().tenant).toMatchObject({ id: tenantB, slug: "globex", mode: "tenant" });
  });

  it("an older instance: a token for several tenants it cannot place asks for --tenant <tenant-id> and stores nothing", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA, tenantB] });
    await olderInstance(async () => {
      const result = await cli(sb, ["login", "--instance", server.url, "--token-stdin", "--json"], { stdin: `${token}\n` });
      expect(result.code).toBe(2);
      const { error } = result.json<Refusal>();
      expect(error.code).toBe("tenant_required");
      expect(error.status).toBe(403);
      expect(error.message).toContain(PLATFORM_REFUSAL);
      expect(error.hint).toMatch(/--tenant <tenant-id>/);
      expect(error.hint).toMatch(/limited to one tenant needs none/);
      expect(existsSync(credentials())).toBe(false);
      expect(result.stdout + result.stderr).not.toContain(token);

      // Not even on a terminal: the instance names no tenant to choose from.
      const tty = await atTerminal(["login", "--instance", server.url], token);
      expect(tty.code).toBe(2);
      expect(tty.stderr).not.toContain("Which tenant?");

      // A name or slug cannot be looked up: no route answers this token without a tenant.
      const byName = await cli(sb, ["login", "--instance", server.url, "--tenant", "acme", "--token-stdin", "--json"], { stdin: `${token}\n` });
      expect(byName.code).toBe(2);
      expect(byName.json<Refusal>().error).toMatchObject({ code: "tenant_required", hint: expect.stringMatching(/--tenant <tenant-id>/) });
      expect(byName.json<Refusal>().error.message).toMatch(/Cannot find tenant "acme" by its name or slug/);
      expect(existsSync(credentials())).toBe(false);

      // The id gets in, and is kept for the commands that follow.
      const byId = await cli(sb, ["login", "--instance", server.url, "--tenant", tenantB, "--token-stdin", "--json"], { stdin: `${token}\n` });
      expect(byId.code).toBe(0);
      expect(byId.json<{ tenant: unknown; instance_version: string }>()).toMatchObject({ tenant: { ref: tenantB, id: tenantB }, instance_version: "v0.0.0-dev" });
      const who = await cli(sb, ["whoami", "--json"]);
      expect(who.code).toBe(0);
      expect(who.json<{ tenant: unknown }>().tenant).toMatchObject({ id: tenantB, name: "Globex", source: "use" });
      // `use` without a tenant has no list to offer there.
      const use = await cli(sb, ["use"]);
      expect(use.code).toBe(2);
      expect(use.stderr).toContain("This instance does not list the tenants a token reaches.");
    });
  });

  it("an older instance: whoami and any first call without a tenant say to pass the tenant's id", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA, tenantB] });
    const env = { CAVELON_URL: server.url, CAVELON_TOKEN: token };
    await olderInstance(async () => {
      const who = await cli(sb, ["whoami", "--json"], { env });
      expect(who.code).toBe(2);
      expect(who.json<Refusal>().error).toMatchObject({ code: "tenant_required", message: expect.stringContaining(PLATFORM_REFUSAL) });
      const limits = await cli(sb, ["limits", "--json"], { env });
      expect(limits.code).toBe(7);
      expect(limits.json<Refusal>().error.hint).toMatch(/--tenant <tenant-id>/);
    });
  });

  it("an older instance: a token whose owner has a default tenant acts there and names the other tenants", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA, tenantB], defaultTenant: tenantB });
    await olderInstance(async () => {
      const result = await cli(sb, ["login", "--instance", server.url, "--token-stdin"], { stdin: `${token}\n` });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`Acting in tenant Globex (${tenantB})`);
      expect(result.stderr).toMatch(/Your other tenants: Acme; `cavelon use <tenant>` chooses one/);
    });
  });

  it("an instance without /meta/principal refuses the same token on /auth/me, and login says the same", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA, tenantB] });
    server.state.serveMeta = false;
    try {
      const result = await cli(sb, ["login", "--instance", server.url, "--token-stdin", "--json"], { stdin: `${token}\n` });
      expect(result.code).toBe(2);
      expect(result.json<Refusal>().error).toMatchObject({ code: "tenant_required", message: expect.stringContaining(PLATFORM_REFUSAL) });
      expect(existsSync(credentials())).toBe(false);
    } finally {
      server.state.serveMeta = true;
    }
  });

  it("a Platform-mode token: logs in without a tenant and says to choose one", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA, tenantB], platform: true });
    const result = await cli(sb, ["login", "--instance", server.url, "--token-stdin", "--json"], { stdin: `${token}\n` });
    expect(result.code).toBe(0);
    expect(result.json<{ tenant: unknown; warnings: string[] }>()).toMatchObject({ tenant: null, warnings: expect.arrayContaining([expect.stringMatching(/Platform mode; choose a tenant with `cavelon use <tenant>`/)]) });
    const who = await cli(sb, ["whoami", "--json"]);
    expect(who.code).toBe(0);
    expect(who.json<{ tenant: unknown }>().tenant).toMatchObject({ id: null, mode: "platform" });
  });
});

describe("use without a tenant", () => {
  it("on a terminal: the same list as login, and the choice is stored", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA, tenantB], defaultTenant: tenantA });
    await login(sb, server.url, token);
    const result = await cli(sb, ["use"], { tty: true, stdin: "Glo\n", env: { NO_COLOR: "1" } });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain("This token reaches 2 tenants");
    expect(result.stdout).toContain(`Using tenant Globex (globex, ${tenantB}) on ${server.url}.`);
    expect((await cli(sb, ["status", "--offline", "--json"])).json<{ tenant: unknown }>().tenant).toEqual({ ref: "globex", source: "use" });
  });

  it("without a terminal: one ready line per tenant, and nothing changes (exit 2)", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA, tenantB], defaultTenant: tenantA });
    await login(sb, server.url, token);
    const result = await cli(sb, ["use"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/cavelon use acme +Acme\n {2}cavelon use globex +Globex/);
    expect((await cli(sb, ["status", "--offline", "--json"])).json<{ tenant: unknown }>().tenant).toBeNull();
  });

  it("a token for one tenant: uses it", async () => {
    await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenantB] }));
    const result = await cli(sb, ["use", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json()).toMatchObject({ tenant: { ref: "globex", id: tenantB } });
  });

  it("reads every page of a long list of tenants", async () => {
    const many = Array.from({ length: 230 }, (_, i) => server.addTenant(`zz-page-${String(i).padStart(3, "0")}`, `Page Tenant ${i}`));
    await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: many, defaultTenant: many[0] }));
    server.state.requests.length = 0;
    const result = await cli(sb, ["use", "zz-page-229", "--json"]);
    expect(result.code, result.stdout).toBe(0);
    expect(result.json()).toMatchObject({ tenant: { id: many[229], name: "Page Tenant 229" } });
    const pages = server.state.requests.filter((r) => r.path === "/api/v1/meta/principal");
    expect(pages.map((r) => [r.query.get("limit"), r.query.get("cursor")])).toEqual([["200", null], ["200", "200"]]);
  });

  it("a name or slug that is not one of the token's tenants names the closest", async () => {
    await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenantA, tenantB], defaultTenant: tenantA }));
    const result = await cli(sb, ["use", "globx", "--json"]);
    expect(result.code).toBe(1);
    const error = result.json<{ error: { code: string; message: string; hint: string; details: unknown } }>().error;
    expect(error.code).toBe("tenant_not_found");
    expect(error.message).toBe('No tenant "globx" that this token reaches. Closest: Globex (globex).');
    expect(error.hint).toContain("cavelon use globex");
    expect(error.details).toEqual({ tenants: [{ id: tenantB, slug: "globex", name: "Globex" }] });
  });
});

describe("logout", () => {
  it("deletes the stored token", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA], defaultTenant: tenantA });
    await login(sb, server.url, token);
    const out = await cli(sb, ["logout", "--json"]);
    expect(out.code).toBe(0);
    expect(out.json()).toEqual({ logged_out: [{ instance: server.url, deleted: true }] });
    const who = await cli(sb, ["whoami", "--instance", server.url]);
    expect(who.code).toBe(7);
  });
});

describe("whoami", () => {
  it("shows the owner, the tenant and where the credential came from", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA, tenantB], defaultTenant: tenantA, email: "ada@example.com", name: "Ada" });
    await login(sb, server.url, token);
    const result = await cli(sb, ["whoami", "--json"]);
    expect(result.code).toBe(0);
    const data = result.json<Record<string, any>>();
    expect(data.owner).toMatchObject({ email: "ada@example.com", name: "Ada" });
    expect(data.tenant).toMatchObject({ id: tenantA, name: "Acme" });
    expect(data.credential).toMatchObject({ kind: "personal_access_token", source: "login", store: "file" });
    expect(data.instance).toMatchObject({ url: server.url, source: "login", version: "v0.0.0-dev" });

    const text = await cli(sb, ["whoami"]);
    expect(text.stdout).toMatch(/acting as:\s+Ada <ada@example.com>/);
    expect(text.stdout).toMatch(/credential:\s+personal access token "laptop" from login/);
    expect(text.stdout).toMatch(/may activate:\s+no/);
  });

  it("names CAVELON_TOKEN as the source when it is set", async () => {
    const key = server.addToken({ kind: "key", tenantIds: [tenantB] });
    const result = await cli(sb, ["whoami", "--json"], { env: { CAVELON_URL: server.url, CAVELON_TOKEN: key } });
    expect(result.code).toBe(0);
    const data = result.json<Record<string, any>>();
    expect(data.credential).toMatchObject({ kind: "api_key", source: "CAVELON_TOKEN", store: null });
    expect(data.instance.source).toBe("CAVELON_URL");
  });

  it("exits 7 without a credential", async () => {
    const result = await cli(sb, ["whoami", "--json"], { env: { CAVELON_URL: server.url } });
    expect(result.code).toBe(7);
    expect(result.json<{ error: { code: string } }>().error.code).toBe("not_logged_in");
  });
});

describe("an instance with personal access tokens off", () => {
  type Refusal = { error: { code: string; message: string; hint: string; status: number } };
  const turnOff = () => (server.state.features = { ...server.state.features, personal_access_tokens_enabled: false });
  afterEach(() => {
    server.state.features = { ...server.state.features, personal_access_tokens_enabled: true };
  });

  function expectTokensOff(result: Awaited<ReturnType<typeof cli>>, token?: string) {
    expect(result.code).toBe(7);
    const error = result.json<Refusal>().error;
    expect(error.code).toBe("personal_access_tokens_disabled");
    expect(error.status).toBe(401);
    expect(error.message).toMatch(/has personal access tokens turned off/);
    expect(error.hint).toMatch(/PERSONAL_ACCESS_TOKENS_ENABLED/);
    expect(error.hint).toMatch(/tenant API key/);
    if (token) expect(result.stdout + result.stderr).not.toContain(token);
  }

  it("login names the setting instead of blaming the token, and stores nothing", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA], defaultTenant: tenantA });
    turnOff();
    server.state.requests.length = 0;
    expectTokensOff(await cli(sb, ["login", "--instance", server.url, "--token-stdin", "--json"], { stdin: token }), token);
    expect(existsSync(path.join(sb.env.CAVELON_CONFIG_DIR!, "credentials.json"))).toBe(false);
    // The instance is asked without the token, once.
    const probes = server.state.requests.filter((r) => r.path === "/api/v1/personal-access-tokens/options");
    expect(probes).toHaveLength(1);
    expect(probes[0]!.headers.authorization).toBeUndefined();

    expectTokensOff(await cli(sb, ["login", "--instance", server.url, "--tenant", "acme", "--token-stdin", "--json"], { stdin: token }), token);
    const text = await cli(sb, ["login", "--instance", server.url, "--token-stdin"], { stdin: token });
    expect(text.stderr).toMatch(/personal access tokens turned off/);
    expect(text.stderr).toMatch(/PERSONAL_ACCESS_TOKENS_ENABLED/);
  });

  it("whoami and every later command say the same once the operator turns them off", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA], defaultTenant: tenantA });
    await login(sb, server.url, token);
    turnOff();
    expectTokensOff(await cli(sb, ["whoami", "--json"]), token);
    expectTokensOff(await cli(sb, ["harness", "list", "--json"]), token);
    expectTokensOff(await cli(sb, ["api", "list_harnesses", "--json"], { env: { CAVELON_CACHE_DIR: path.join(sb.home, "cold-cache") } }), token);
    expectTokensOff(await cli(sb, ["whoami", "--json"], { env: { CAVELON_URL: server.url, CAVELON_TOKEN: "cvpat_not-a-real-one" } }));
  });

  it("a tenant API key still works there", async () => {
    const key = server.addToken({ kind: "key", tenantIds: [tenantA] });
    turnOff();
    const result = await cli(sb, ["whoami", "--json"], { env: { CAVELON_URL: server.url, CAVELON_TOKEN: key } });
    expect(result.code).toBe(0);
  });

  it("keeps blaming the token where tokens are on: a revoked or wrong one", async () => {
    for (const result of [
      await cli(sb, ["login", "--instance", server.url, "--token-stdin", "--json"], { stdin: "cvpat_revoked" }),
      await cli(sb, ["login", "--instance", server.url, "--tenant", "acme", "--token-stdin", "--json"], { stdin: "cvpat_revoked" }),
      await cli(sb, ["whoami", "--json"], { env: { CAVELON_URL: server.url, CAVELON_TOKEN: "cvpat_revoked" } }),
    ]) {
      expect(result.code).toBe(7);
      const error = result.json<Refusal>().error;
      expect(error.code).toBe("unauthorized");
      expect(error.hint).toMatch(/expired or revoked/);
      expect(error.hint).not.toMatch(/PERSONAL_ACCESS_TOKENS_ENABLED/);
    }
  });
});

describe("use and the tenant precedence", () => {
  it("chooses a tenant by slug, and option > CAVELON_TENANT > cavelon.yaml > use", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA, tenantB], platform: true });
    await login(sb, server.url, token);
    const used = await cli(sb, ["use", "acme", "--json"]);
    expect(used.code).toBe(0);
    expect(used.json()).toMatchObject({ tenant: { ref: "acme", id: tenantA } });

    const tenantOf = async (args: string[], env: Record<string, string> = {}, cwd?: string) => {
      server.state.requests.length = 0;
      const r = await cli(sb, ["harness", "list", "--json", ...args], { env, cwd });
      expect(r.code, r.stderr + r.stdout).toBe(0);
      const call = server.state.requests.find((q) => q.path === "/api/v1/harnesses");
      return call?.headers["x-tenant-id"];
    };
    expect(await tenantOf([])).toBe(tenantA);

    const project = path.join(sb.home, "solution", "deep");
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(sb.home, "solution", "cavelon.yaml"), `instance: ${server.url}\ntenant: globex\nfuture_key: kept\n`);
    expect(await tenantOf([], {}, project)).toBe(tenantB);
    expect(await tenantOf([], { CAVELON_TENANT: tenantA }, project)).toBe(tenantA);
    expect(await tenantOf(["--tenant", "globex"], { CAVELON_TENANT: tenantA }, project)).toBe(tenantB);
  });

  it("finds a member's tenant by its slug when its name differs, and remembers the id", async () => {
    const initech = server.addTenant("initech", "Initech Corporation");
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA, initech], defaultTenant: tenantA });
    // At login, before anything is remembered.
    const logged = await cli(sb, ["login", "--instance", server.url, "--tenant", "initech", "--token-stdin", "--json"], { stdin: token });
    expect(logged.code, logged.stdout + logged.stderr).toBe(0);
    const fresh = sandbox();
    try {
      await login(fresh, server.url, token);
      const who = await cli(fresh, ["whoami", "--tenant", "initech", "--json"]);
      expect(who.code, who.stdout + who.stderr).toBe(0);
      expect(who.json<{ tenant: { id: string } }>().tenant.id).toBe(initech);
      const used = await cli(fresh, ["use", "initech", "--json"]);
      expect(used.code, used.stdout + used.stderr).toBe(0);
      expect(used.json()).toMatchObject({ tenant: { ref: "initech", id: initech, name: "Initech Corporation" } });
      // A solution folder that names the slug, as the quickstart writes it.
      const dir = path.join(fresh.home, "solution");
      mkdirSync(dir);
      writeFileSync(path.join(dir, "cavelon.yaml"), `instance: ${server.url}\ntenant: initech\n`);
      server.state.requests.length = 0;
      expect((await cli(fresh, ["harness", "list", "--json"], { cwd: dir })).code).toBe(0);
      expect(server.state.requests.find((q) => q.path === "/api/v1/harnesses")?.headers["x-tenant-id"]).toBe(initech);
      // The slug was resolved once and remembered: no detail is read again.
      expect(server.state.requests.some((q) => q.path.startsWith("/api/v1/tenants/"))).toBe(false);
    } finally {
      fresh.cleanup();
    }
  });

  it("finds a member's tenant by its slug from the token's tenants, even without the tenant's settings", async () => {
    const umbrella = server.addTenant("umbrella", "Umbrella Holdings");
    const token = server.addToken({ kind: "pat", tenantIds: [umbrella], defaultTenant: umbrella, permissions: ["agents.view"] });
    await login(sb, server.url, token);
    const result = await cli(sb, ["use", "umbrella", "--json"]);
    expect(result.code, result.stdout).toBe(0);
    expect(result.json()).toMatchObject({ tenant: { ref: "umbrella", id: umbrella, name: "Umbrella Holdings", slug: "umbrella" } });
  });

  it("an older instance: tells a member who may not read the tenant's detail to use its name or id", async () => {
    const umbrella = server.addTenant("umbrella-old", "Umbrella Holdings");
    const token = server.addToken({ kind: "pat", tenantIds: [umbrella], defaultTenant: umbrella, permissions: ["agents.view"] });
    await login(sb, server.url, token);
    server.state.serveTenantReach = false;
    try {
      const result = await cli(sb, ["use", "umbrella-old", "--json"]);
      expect(result.code).toBe(1);
      const error = result.json<{ error: { code: string; message: string; hint: string; details: unknown } }>().error;
      expect(error.code).toBe("tenant_not_found");
      expect(error.hint).toMatch(/name or id/);
      // It names the tenants the instance told, so the person can pick one by name.
      expect(error.message).toContain(`Your tenants: Umbrella Holdings (${umbrella}).`);
      expect(error.details).toEqual({ tenants: [{ id: umbrella, name: "Umbrella Holdings" }] });
      expect((await cli(sb, ["use", "Umbrella Holdings", "--json"])).code).toBe(0);
      expect((await cli(sb, ["use", umbrella, "--json"])).code).toBe(0);
    } finally {
      server.state.serveTenantReach = true;
    }
  });

  it("an older instance: login --tenant with a slug the member's token cannot resolve names the tenants by name, and stores nothing", async () => {
    const initech = server.addTenant("initech-labs", "Initech");
    const token = server.addToken({ kind: "pat", tenantIds: [initech, tenantB], defaultTenant: initech, permissions: ["agents.view"] });
    server.state.serveTenantReach = false;
    try {
      const result = await cli(sb, ["login", "--instance", server.url, "--tenant", "initech-labs", "--token-stdin"], { stdin: `${token}\n` });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`No tenant "initech-labs" that this token can see. Your tenants: Initech (${initech}), Globex (${tenantB}).`);
      expect(existsSync(path.join(sb.env.CAVELON_CONFIG_DIR!, "credentials.json"))).toBe(false);
      const byName = await cli(sb, ["login", "--instance", server.url, "--tenant", "Initech", "--token-stdin", "--json"], { stdin: `${token}\n` });
      expect(byName.json<{ tenant: unknown }>().tenant).toMatchObject({ ref: "Initech", id: initech });
    } finally {
      server.state.serveTenantReach = true;
    }
    // A recent instance finds the slug in the token's tenants.
    const bySlug = await cli(sb, ["login", "--instance", server.url, "--tenant", "initech-labs", "--token-stdin", "--json"], { stdin: `${token}\n` });
    expect(bySlug.code, bySlug.stdout).toBe(0);
    expect(bySlug.json<{ tenant: unknown }>().tenant).toMatchObject({ ref: "initech-labs", id: initech, name: "Initech", slug: "initech-labs" });
  });

  it("a Platform-mode token finds any tenant by slug, not only its owner's memberships", async () => {
    const initrode = server.addTenant("initrode", "Initrode");
    await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenantA], platform: true }));
    const used = await cli(sb, ["use", "initrode", "--json"]);
    expect(used.code, used.stdout).toBe(0);
    expect(used.json()).toMatchObject({ tenant: { ref: "initrode", id: initrode, name: "Initrode", slug: "initrode" } });
  });

  it("refuses a tenant the token cannot reach", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA], defaultTenant: tenantA });
    await login(sb, server.url, token);
    const result = await cli(sb, ["use", tenantB, "--json"]);
    expect(result.code).toBe(7);
  });
});

describe("instance and token precedence", () => {
  it("prefers --instance over CAVELON_URL over cavelon.yaml over the login", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA], defaultTenant: tenantA });
    await login(sb, server.url, token);
    const status = async (args: string[], env: Record<string, string> = {}, cwd?: string) =>
      (await cli(sb, ["status", "--offline", "--json", ...args], { env, cwd })).json<{ instance: { url: string; source: string } }>().instance;

    expect(await status([])).toEqual({ url: server.url, source: "login" });
    const dir = path.join(sb.home, "repo");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "cavelon.yaml"), "instance: https://yaml.example.com\n");
    expect(await status([], {}, dir)).toEqual({ url: "https://yaml.example.com", source: "cavelon.yaml" });
    expect(await status([], { CAVELON_URL: "https://env.example.com/" }, dir)).toEqual({ url: "https://env.example.com", source: "CAVELON_URL" });
    expect(await status(["--instance", "opt.example.com"], { CAVELON_URL: "https://env.example.com" }, dir)).toEqual({
      url: "https://opt.example.com",
      source: "option",
    });
  });

  it("uses CAVELON_TOKEN over the stored login, but never sends it to another instance", async () => {
    const stored = server.addToken({ kind: "pat", tenantIds: [tenantA], defaultTenant: tenantA, email: "stored@example.com" });
    const fromEnv = server.addToken({ kind: "pat", tenantIds: [tenantA], defaultTenant: tenantA, email: "env@example.com" });
    await login(sb, server.url, stored);
    const who = await cli(sb, ["whoami", "--json"], { env: { CAVELON_URL: server.url, CAVELON_TOKEN: fromEnv } });
    expect(who.json<{ owner: { email: string } }>().owner.email).toBe("env@example.com");

    // Without CAVELON_URL the token is not used at all: a cavelon.yaml from a
    // cloned repository must not be able to send it to its own host.
    const dir = path.join(sb.home, "foreign");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "cavelon.yaml"), "instance: https://attacker.example.com\n");
    server.state.requests.length = 0;
    const foreign = await cli(sb, ["whoami", "--json"], { cwd: dir, env: { CAVELON_TOKEN: fromEnv } });
    expect(foreign.code).toBe(7);
    expect(foreign.json<{ error: { message: string } }>().error.message).toMatch(/CAVELON_URL is not/);

    // CAVELON_URL names another instance: its token stays there.
    const other = await cli(sb, ["status", "--offline", "--json", "--instance", server.url], {
      env: { CAVELON_URL: "https://other.example.com", CAVELON_TOKEN: fromEnv },
    });
    expect(other.json<{ credential: { source: string } }>().credential.source).toBe("login");
  });

  it("refuses a cavelon.yaml that holds a token", async () => {
    const dir = path.join(sb.home, "bad");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "cavelon.yaml"), "instance: https://x.example.com\ntoken: cvpat_oops\n");
    const result = await cli(sb, ["status", "--json"], { cwd: dir });
    expect(result.code).toBe(3);
    expect(result.json<{ error: { code: string } }>().error.code).toBe("project_file_has_secret");
  });

  it("lets --instance override an unusable CAVELON_URL or cavelon.yaml instance", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA], defaultTenant: tenantA });
    const env = { CAVELON_URL: "http://ci.internal" };
    const status = await cli(sb, ["status", "--offline", "--instance", "https://cavelon.example.com", "--json"], { env });
    expect(status.code, status.stdout).toBe(0);
    expect(status.json<{ instance: { url: string; source: string } }>().instance).toEqual({ url: "https://cavelon.example.com", source: "option" });
    const dir = path.join(sb.home, "lan");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "cavelon.yaml"), "instance: http://cavelon.lan\n");
    expect((await cli(sb, ["status", "--offline", "--instance", "https://cavelon.example.com", "--json"], { cwd: dir })).code).toBe(0);
    const logged = await cli(sb, ["login", "--instance", server.url, "--token-stdin", "--json"], { env, stdin: token, cwd: dir });
    expect(logged.code, logged.stdout + logged.stderr).toBe(0);
    const out = await cli(sb, ["logout", "--instance", server.url, "--json"], { env, cwd: dir });
    expect(out.json()).toEqual({ logged_out: [{ instance: server.url, deleted: true }] });
    // Where the unusable URL is the one chosen, it is still refused.
    expect((await cli(sb, ["status", "--offline", "--json"], { env })).code).toBe(2);
    expect((await cli(sb, ["status", "--offline", "--json"], { cwd: dir })).code).toBe(2);
  });

  it("refuses plain http to a remote host", async () => {
    const result = await cli(sb, ["status", "--json"], { env: { CAVELON_URL: "http://cavelon.example.com" } });
    expect(result.code).toBe(2);
  });
});

describe("status", () => {
  it("shows the solution and running operations", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA], defaultTenant: tenantA });
    await login(sb, server.url, token);
    const op = server.addOperation("test_run", tenantA, ["running"]);
    const dir = path.join(sb.home, "sol");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "cavelon.yaml"), `instance: ${server.url}\nharness: support\n`);
    const result = await cli(sb, ["status", "--json"], { cwd: dir });
    expect(result.code).toBe(0);
    const data = result.json<Record<string, any>>();
    expect(data.solution).toMatchObject({ harness: "support" });
    expect(data.operations.items.map((o: { id: string }) => o.id)).toContain(op.id);
    const text = await cli(sb, ["status"], { cwd: dir });
    expect(text.stdout).toContain(op.id);
  });

  it("explains a token in Platform mode instead of reporting an error", async () => {
    await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [], platform: true }));
    const result = await cli(sb, ["status", "--json"]);
    expect(result.code).toBe(0);
    const data = result.json<Record<string, any>>();
    expect(data.error).toBeUndefined();
    expect(data.operations.unavailable).toMatch(/No tenant chosen/);
  });

  it("never fails when the instance is unreachable", async () => {
    const result = await cli(sb, ["status", "--json"], { env: { CAVELON_URL: "http://127.0.0.1:9", CAVELON_TOKEN: "cvpat_x" } });
    expect(result.code).toBe(0);
    expect(result.json<{ error: { code: string } }>().error.code).toBe("network_error");
  });
});

describe("credential store", () => {
  it("uses the operating system's store when it works, and falls back to the file when it does not", async () => {
    const vault = new Map<string, string>();
    setKeyringFactoryForTests((service, account) => ({
      getPassword: () => vault.get(`${service}/${account}`) ?? null,
      setPassword: (v: string) => void vault.set(`${service}/${account}`, v),
      deletePassword: () => vault.delete(`${service}/${account}`),
    }));
    try {
      const env = { CAVELON_CREDENTIAL_STORE: "" };
      const token = server.addToken({ kind: "pat", tenantIds: [tenantA], defaultTenant: tenantA });
      const result = await cli(sb, ["login", "--instance", server.url, "--token-stdin", "--json"], { stdin: token, env });
      expect(result.json<{ credential: { store: string } }>().credential.store).toBe("keyring");
      expect(vault.get(`cavelon/${server.url}`)).toBe(token);
      expect(existsSync(path.join(sb.env.CAVELON_CONFIG_DIR!, "credentials.json"))).toBe(false);
      expect((await cli(sb, ["whoami", "--json"], { env })).json<{ credential: { store: string } }>().credential.store).toBe("keyring");

      const broken: KeyringEntry = {
        getPassword: () => null,
        setPassword: () => {
          throw new Error("no secret service");
        },
        deletePassword: () => false,
      };
      setKeyringFactoryForTests(() => broken);
      const again = await cli(sb, ["login", "--instance", server.url, "--token-stdin", "--json"], { stdin: token, env });
      expect(again.json<{ credential: { store: string } }>().credential.store).toBe("file");
    } finally {
      setKeyringFactoryForTests(undefined);
    }
  });
});

describe("the contract cache", () => {
  it("keeps instances apart that differ in port or path, in / or _, or in http and https", () => {
    const pairs = [
      ["https://cavelon.example.com:8443", "https://cavelon.example.com/8443"],
      ["https://a.example.com/team/a", "https://a.example.com/team_a"],
      ["http://localhost:8100", "https://localhost:8100"],
    ];
    for (const [a, b] of pairs) expect(instanceKey(a!), `${a} and ${b}`).not.toBe(instanceKey(b!));
    // Still readable, and the same for the same instance.
    expect(instanceKey("https://cavelon.example.com:8443")).toMatch(/^cavelon\.example\.com_8443-[0-9a-f]{8}$/);
    expect(instanceKey("https://cavelon.example.com:8443")).toBe(instanceKey("https://cavelon.example.com:8443"));
  });
});
