import { statSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setKeyringFactoryForTests, type KeyringEntry } from "../src/credentials.js";
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
    const cached = readdirSync(path.join(sb.env.CAVELON_CACHE_DIR!, `127.0.0.1_${new URL(server.url).port}`, "v0.0.0-dev"));
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

  it("logs in with a platform token that has no tenant yet, and says to choose one", async () => {
    const token = server.addToken({ kind: "pat", tenantIds: [], platform: true });
    const result = await cli(sb, ["login", "--instance", server.url, "--token-stdin"], { stdin: token });
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/cavelon use <tenant>/);
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
