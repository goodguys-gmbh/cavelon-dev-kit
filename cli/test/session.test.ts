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
  type Refusal = { error: { code: string; message: string; hint: string; status: number } };
  const PLATFORM_REFUSAL = "This personal access token does not work in Platform mode; select a tenant with X-Tenant-Id";
  const credentials = () => path.join(sb.env.CAVELON_CONFIG_DIR!, "credentials.json");

  it("the fake refuses a token without Platform mode on every route, as the instance does, when it cannot place it in a tenant", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA, tenantB] });
    for (const route of ["/api/v1/auth/me", "/api/v1/meta/principal", "/api/v1/meta/capabilities", "/api/v1/tenants"]) {
      const response = await fetch(`${server.url}${route}`, { headers: { Authorization: `Bearer ${token}` } });
      expect([route, response.status]).toEqual([route, 403]);
      expect(await response.json()).toEqual({ detail: PLATFORM_REFUSAL });
    }
    const inTenant = await fetch(`${server.url}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tenantB } });
    expect(inTenant.status).toBe(200);
  });

  it("a token limited to one tenant: uses it and says so", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA], email: "ada@example.com" });
    const result = await cli(sb, ["login", "--instance", server.url, "--token-stdin"], { stdin: `${token}\n` });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Acting in tenant Acme (${tenantA}), the one the instance chooses for this token.`);
    expect(result.stderr).not.toMatch(/other tenants/);

    const json = await cli(sb, ["login", "--instance", server.url, "--token-stdin", "--json"], { stdin: `${token}\n` });
    expect(json.json<{ tenant: unknown }>().tenant).toEqual({ ref: null, id: tenantA, name: "Acme" });
    const who = await cli(sb, ["whoami", "--json"]);
    expect(who.code).toBe(0);
    expect(who.json<{ tenant: unknown }>().tenant).toMatchObject({ id: tenantA, name: "Acme", mode: "tenant" });
  });

  it("a token whose owner has a default tenant: acts there and names the other tenants", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA, tenantB], defaultTenant: tenantB });
    const result = await cli(sb, ["login", "--instance", server.url, "--token-stdin"], { stdin: `${token}\n` });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Acting in tenant Globex (${tenantB})`);
    expect(result.stderr).toMatch(/Your other tenants: Acme; `cavelon use <tenant>` chooses one/);
  });

  it("a token for several tenants that the instance cannot place: asks for --tenant and stores nothing", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA, tenantB] });
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
  });

  it("whoami and any first call without a tenant say to pass the tenant's id", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [tenantA, tenantB] });
    const env = { CAVELON_URL: server.url, CAVELON_TOKEN: token };
    const who = await cli(sb, ["whoami", "--json"], { env });
    expect(who.code).toBe(2);
    expect(who.json<Refusal>().error).toMatchObject({ code: "tenant_required", message: expect.stringContaining(PLATFORM_REFUSAL) });

    const limits = await cli(sb, ["limits", "--json"], { env });
    expect(limits.code).toBe(7);
    expect(limits.json<Refusal>().error.message).toContain(PLATFORM_REFUSAL);
    expect(limits.json<Refusal>().error.hint).toMatch(/^No tenant was named\..*--tenant <tenant-id>/);

    const inTenant = await cli(sb, ["whoami", "--json", "--tenant", tenantA], { env });
    expect(inTenant.code).toBe(0);
    expect(inTenant.json<{ tenant: unknown }>().tenant).toMatchObject({ id: tenantA, mode: "tenant" });
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

  it("tells a member who may not read the tenant's detail to use its name or id", async () => {
    const umbrella = server.addTenant("umbrella", "Umbrella Holdings");
    const token = server.addToken({ kind: "pat", tenantIds: [umbrella], defaultTenant: umbrella, permissions: ["agents.view"] });
    await login(sb, server.url, token);
    const result = await cli(sb, ["use", "umbrella", "--json"]);
    expect(result.code).toBe(1);
    const error = result.json<{ error: { code: string; message: string; hint: string; details: unknown } }>().error;
    expect(error.code).toBe("tenant_not_found");
    expect(error.hint).toMatch(/name or id/);
    // It names the tenants the instance told, so the person can pick one by name.
    expect(error.message).toContain(`Your tenants: Umbrella Holdings (${umbrella}).`);
    expect(error.details).toEqual({ tenants: [{ id: umbrella, name: "Umbrella Holdings" }] });
    expect((await cli(sb, ["use", "Umbrella Holdings", "--json"])).code).toBe(0);
    expect((await cli(sb, ["use", umbrella, "--json"])).code).toBe(0);
  });

  it("login --tenant with a slug the member's token cannot resolve names the tenants by name, and stores nothing", async () => {
    const initech = server.addTenant("initech-labs", "Initech");
    const token = server.addToken({ kind: "pat", tenantIds: [initech, tenantB], defaultTenant: initech, permissions: ["agents.view"] });
    const result = await cli(sb, ["login", "--instance", server.url, "--tenant", "initech-labs", "--token-stdin"], { stdin: `${token}\n` });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`No tenant "initech-labs" that this token can see. Your tenants: Initech (${initech}), Globex (${tenantB}).`);
    expect(existsSync(path.join(sb.env.CAVELON_CONFIG_DIR!, "credentials.json"))).toBe(false);
    const byName = await cli(sb, ["login", "--instance", server.url, "--tenant", "Initech", "--token-stdin", "--json"], { stdin: `${token}\n` });
    expect(byName.json<{ tenant: unknown }>().tenant).toMatchObject({ ref: "Initech", id: initech });
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
