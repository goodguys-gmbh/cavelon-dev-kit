import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { AGENT_VARIABLES } from "../src/agent-env.js";
import { COMMANDS } from "../src/commands/index.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * Tenant variables and secrets. A secret value
 * reaches the instance from the terminal or standard input only, and appears
 * nowhere else: not in an argument, the output, a file or a request but its
 * own. A tenant API key is refused before anything is sent.
 */

let server: FakeServer;
let sb: Sandbox;
let keySb: Sandbox;
let tenant: string;
let apiKey: string;
let dirCount = 0;

/** Made at runtime, so it cannot be anywhere by accident. */
const SECRET = `s3cr3t-${Math.random().toString(36).slice(2)}-value`;

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const secretRequests = () => server.state.requests.filter((r) => r.path.startsWith("/api/v1/secrets"));
const stored = (name: string) => server.state.values.get(tenant)?.secrets.get(name)?.value;

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
  keySb = sandbox();
  apiKey = server.addToken({ kind: "key", tenantIds: [tenant], tokenName: "ci" });
  await login(keySb, server.url, apiKey);
  await cli(sb, ["harness", "new", "support", "--name", "Support"]);
});
beforeEach(() => {
  server.state.requests.length = 0;
  server.state.configs.clear();
  server.state.values.clear();
});
afterAll(async () => {
  sb.cleanup();
  keySb.cleanup();
  await server.close();
});

describe("cavelon variables", () => {
  it("sets, lists, reads and deletes a variable; delete needs --confirm", async () => {
    const created = await cli(sb, ["variables", "set", "crm_base_url", "https://crm.example.com", "--json"]);
    expect(created.code, created.stdout).toBe(0);
    expect(created.json()).toMatchObject({ name: "crm_base_url", value: "https://crm.example.com", created: true, previous: null });
    const replaced = await cli(sb, ["variables", "set", "crm_base_url", "https://crm2.example.com", "--confirm"]);
    expect(replaced.stdout).toMatch(/Replaced variable crm_base_url \(it was "https:\/\/crm\.example\.com"\)/);
    expect(server.state.values.get(tenant)!.variables.get("crm_base_url")).toBe("https://crm2.example.com");

    const fromStdin = await cli(sb, ["variables", "set", "greeting", "--stdin", "--json"], { stdin: "Hello\nthere\n" });
    expect(fromStdin.json()).toMatchObject({ value: "Hello\nthere" });

    const listed = await cli(sb, ["variables", "list", "--json"]);
    expect(listed.json<{ items: Array<{ name: string }>; total: number }>()).toMatchObject({ total: 2, items: [{ name: "crm_base_url" }, { name: "greeting" }] });
    expect((await cli(sb, ["variables", "list", "--limit", "1"])).stdout).toMatch(/More: cavelon variables list --cursor 1/);
    expect((await cli(sb, ["variables", "get", "greeting", "--json"])).json()).toEqual({ name: "greeting", value: "Hello\nthere", source: null });

    const missing = await cli(sb, ["variables", "get", "nope", "--json"]);
    expect(missing.code).toBe(1);
    expect(missing.json<{ error: { code: string; hint: string } }>().error).toMatchObject({ code: "variable_not_set", hint: expect.stringContaining("cavelon variables set nope <value>") });

    const shown = await cli(sb, ["variables", "delete", "greeting"]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toMatch(/Nothing was deleted\. Delete it with: cavelon variables delete greeting --confirm/);
    expect(server.state.requests.some((r) => r.method === "DELETE")).toBe(false);
    const deleted = await cli(sb, ["variables", "delete", "greeting", "--confirm", "--json"]);
    expect(deleted.json()).toMatchObject({ deleted: true, value: "Hello\nthere" });
    expect(server.state.values.get(tenant)!.variables.has("greeting")).toBe(false);
    expect((await cli(sb, ["variables", "delete", "greeting", "--confirm", "--json"])).json()).toMatchObject({ deleted: false, existed: false });
  });

  it("a tenant API key may set variables", async () => {
    const result = await cli(keySb, ["variables", "set", "region", "eu", "--json"]);
    expect(result.code, result.stdout).toBe(0);
    expect((await cli(keySb, ["variables", "list", "--json"])).json<{ items: unknown[] }>().items).toEqual([{ name: "region", value: "eu", source: null }]);
  });

  it("refuses a token as a variable value, and a name the instance's pattern rules out, before sending", async () => {
    const token = await cli(sb, ["variables", "set", "crm_token", "cbp_abcdef123456", "--json"]);
    expect(token.code).toBe(2);
    expect(token.stdout).not.toContain("cbp_abcdef123456");
    expect(token.json<{ error: { hint: string } }>().error.hint).toMatch(/cavelon secrets set crm_token/);
    const name = await cli(sb, ["variables", "set", "bad name!", "x", "--json"]);
    expect(name.code).toBe(3);
    expect(name.json<{ error: { message: string } }>().error.message).toMatch(/not a name this instance accepts: must match pattern/);
    expect(server.state.requests.some((r) => r.method === "PUT")).toBe(false);
  });
});

describe("an answer that breaks off", () => {
  afterEach(() => {
    server.state.interruptions = [];
  });

  it("after part of its body is a network error (exit 8), not an internal one", async () => {
    server.state.interruptions = [{ method: "GET", path: /^\/api\/v1\/variables$/, mode: "cut" }];
    const result = await cli(sb, ["variables", "list", "--json"]);
    expect(result.code, result.stdout).toBe(8);
    expect(result.json<{ error: { code: string } }>().error.code).toBe("network_error");
  });

  it("that stalls is a timeout (exit 8)", async () => {
    server.state.interruptions = [{ method: "GET", path: /^\/api\/v1\/variables$/, mode: "stall" }];
    const result = await cli(sb, ["variables", "list", "--json"], { env: { CAVELON_HTTP_TIMEOUT_MS: "500" } });
    expect(result.code, result.stdout).toBe(8);
    expect(result.json<{ error: { code: string; hint: string } }>().error).toMatchObject({ code: "request_timeout", hint: expect.stringMatching(/^Retry/) });
  });
});

describe("cavelon secrets", () => {
  it("sets a secret from standard input; the value appears in no output, file or other request", async () => {
    const result = await cli(sb, ["secrets", "set", "crm_api_token", "--json"], { stdin: `${SECRET}\n` });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.json()).toMatchObject({ name: "crm_api_token", status: "set", declared: false });
    // The instance got exactly the value, without the line break the pipe added.
    expect(stored("crm_api_token")).toBe(SECRET);
    const text = await cli(sb, ["secrets", "set", "crm_api_token"], { stdin: SECRET });
    expect(text.stdout).toMatch(/Secret crm_api_token is set .*Its value is never shown\./);

    const list = await cli(sb, ["secrets", "list", "--json"]);
    expect(list.json<{ items: unknown[] }>().items).toEqual([expect.objectContaining({ name: "crm_api_token", status: "set" })]);
    for (const output of [result.stdout, result.stderr, text.stdout, text.stderr, list.stdout, list.stderr]) expect(output).not.toContain(SECRET);
    // Only the PUT carried it; the config, cache and credentials files never hold it.
    const carrying = server.state.requests.filter((r) => JSON.stringify(r.body ?? "").includes(SECRET));
    expect(carrying.map((r) => `${r.method} ${r.path}`)).toEqual(["PUT /api/v1/secrets/crm_api_token", "PUT /api/v1/secrets/crm_api_token"]);
    const files = filesUnder(sb.home);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toContain(SECRET);
  });

  it("asks for the value without echoing it when run in a terminal", async () => {
    const result = await cli(sb, ["secrets", "set", "crm_api_token"], { stdin: `${SECRET}\r`, tty: true });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain("Value of secret crm_api_token (input hidden): ");
    expect(result.stdout + result.stderr).not.toContain(SECRET);
    expect(stored("crm_api_token")).toBe(SECRET);
  });

  it("never takes the value as an argument, and does not repeat it", async () => {
    const result = await cli(sb, ["secrets", "set", "crm_api_token", SECRET, "--json"]);
    expect(result.code).toBe(2);
    expect(result.stdout + result.stderr).not.toContain(SECRET);
    expect(result.json<{ error: { message: string } }>().error.message).toMatch(/never takes the value as an argument/);
    expect(secretRequests()).toHaveLength(0);
    // Nor is there any option for it.
    const set = COMMANDS.find((c) => c.name === "secrets set")!;
    expect(set.positionals!.map((p) => p.name)).toEqual(["name"]);
    expect(Object.keys(set.options ?? {})).toEqual(["env"]);
    expect(set.mcpTool).toBe(false);
  });

  it("refuses an empty value and a missing terminal without sending", async () => {
    const empty = await cli(sb, ["secrets", "set", "crm_api_token", "--json"], { stdin: "" });
    expect(empty.code).toBe(2);
    expect(empty.json<{ error: { hint: string } }>().error.hint).toMatch(/A person runs `cavelon secrets set crm_api_token` in a terminal/);
    expect(server.state.requests.some((r) => r.method === "PUT")).toBe(false);
  });

  it("refuses a tenant API key before asking for a value or sending anything, naming the Admin where the instance says a person sets it", async () => {
    // A recent instance lists setting and deleting a secret among what a person runs, not this key.
    const result = await cli(keySb, ["secrets", "set", "crm_api_token", "--json"], { stdin: SECRET });
    expect(result.code).toBe(5);
    const error = result.json<{ error: { code: string; message: string; hint: string; details: Record<string, unknown> } }>().error;
    expect(error).toMatchObject({
      code: "secret_needs_a_person",
      message: expect.stringMatching(/^A tenant API key cannot set a secret on this instance, so nothing was sent: only a person signed in to the Admin sets/),
      hint: "A person sets crm_api_token in the Admin under Settings › Secrets.",
      details: { sent: false, credential: "api_key" },
    });
    expect(result.stdout + result.stderr).not.toContain(SECRET);
    expect(secretRequests()).toHaveLength(0);
    expect(server.state.requests.some((r) => r.method === "PUT")).toBe(false);
    // `cavelon explain` knows the instance's code.
    expect((await cli(keySb, ["explain", "secret_needs_a_person"])).stdout).toMatch(/A personal access token or an API key cannot set or delete a secret value/);
  });

  it("on an older instance, refuses a tenant API key and names a person's token, as before", async () => {
    server.state.serveCredentialAccess = false;
    try {
      const result = await cli(keySb, ["secrets", "set", "crm_api_token", "--json"], { stdin: SECRET });
      expect(result.code).toBe(7);
      const error = result.json<{ error: { code: string; message: string; hint: string; details: Record<string, unknown> } }>().error;
      expect(error.code).toBe("secret_needs_a_person");
      expect(error.message).toMatch(/A tenant API key cannot set a secret, so nothing was sent: setting a secret needs a person/);
      expect(error.hint).toMatch(/personal access token \(`cavelon login`\) and runs `cavelon secrets set crm_api_token`/);
      expect(error.details).toEqual({ sent: false, credential: "api_key" });
      expect(result.stdout + result.stderr).not.toContain(SECRET);

      // The same through CAVELON_TOKEN, and for delete.
      const env = { CAVELON_URL: server.url, CAVELON_TOKEN: apiKey };
      const bare = sandbox();
      const fromEnv = await cli(bare, ["secrets", "delete", "crm_api_token", "--confirm", "--json"], { env }).finally(() => bare.cleanup());
      expect(fromEnv.code).toBe(7);
      expect(fromEnv.json<{ error: { code: string; hint: string } }>().error).toMatchObject({ code: "secret_needs_a_person", hint: expect.stringMatching(/^CAVELON_TOKEN holds a tenant API key/) });
      expect(server.state.requests.some((r) => r.method === "DELETE" || r.method === "PUT")).toBe(false);
    } finally {
      server.state.serveCredentialAccess = true;
    }
  });

  describe("on an instance that lets only a person signed in to the Admin set a secret", () => {
    beforeEach(() => {
      server.state.tokensRefusedOnSecrets = true;
    });
    afterEach(() => {
      server.state.tokensRefusedOnSecrets = false;
      server.state.servePrincipal = true;
    });

    it("refuses a person's token on set and delete before reading a value or sending anything, naming the Admin", async () => {
      server.state.requests.length = 0;
      const set = await cli(sb, ["secrets", "set", "crm_api_token", "--json"], { stdin: SECRET });
      expect(set.code).toBe(5);
      expect(set.json<{ error: Record<string, unknown> }>().error).toMatchObject({
        code: "secret_needs_a_person",
        message: expect.stringMatching(/^A personal access token cannot set a secret on this instance/),
        hint: "A person sets crm_api_token in the Admin under Settings › Secrets.",
        details: { sent: false, credential: "personal_access_token" },
      });
      expect(set.stdout + set.stderr).not.toContain(SECRET);
      const removed = await cli(sb, ["secrets", "delete", "crm_api_token", "--confirm", "--json"]);
      expect(removed.code).toBe(5);
      expect(removed.json<{ error: { hint: string } }>().error.hint).toBe("A person deletes crm_api_token in the Admin under Settings › Secrets.");
      // An agent hears the same: the Admin, not a command that would be refused.
      const agent = await cli(sb, ["secrets", "set", "crm_api_token", "--json"], { stdin: SECRET, env: { CLAUDECODE: "1" } });
      expect(agent.json<{ error: { code: string } }>().error.code).toBe("secret_needs_a_person");
      expect(server.state.requests.some((r) => r.method === "PUT" || r.method === "DELETE")).toBe(false);
    });

    it("passes the instance's own refusal on where the principal cannot be read, never naming a token", async () => {
      server.state.servePrincipal = false;
      const set = await cli(sb, ["secrets", "set", "crm_api_token", "--json"], { stdin: SECRET });
      expect(set.code).toBe(7);
      const error = set.json<{ error: { code: string; hint: string } }>().error;
      expect(error).toMatchObject({ code: "secret_needs_a_person", hint: "A person sets it, signed in to the Admin under Settings › Secrets." });
      expect(set.stdout + set.stderr).not.toContain(SECRET);
    });
  });

  describe("run by a coding agent in its shell", () => {
    type Refusal = { error: { code: string; message: string; hint: string; details: Record<string, unknown> } };

    it.each(AGENT_VARIABLES.map((v) => [v.variable, v.agent, v.value]))("refuses set and delete under %s (%s) before reading or sending anything", async (variable, _agent, value) => {
      await cli(sb, ["secrets", "set", "crm_api_token"], { stdin: SECRET });
      server.state.requests.length = 0;
      const env = { [variable]: value ?? "1" };
      const set = await cli(sb, ["secrets", "set", "crm_api_token", "--json"], { stdin: "agent-value", env });
      expect(set.code).toBe(5);
      expect(set.json<Refusal>().error).toEqual({
        code: "operation_for_a_person",
        message: "Setting a secret's value stays with a person, so cavelon does not do it when a coding agent runs it; nothing was sent.",
        hint: "A person runs this in their own terminal: `cavelon secrets set crm_api_token`, or does it in the Admin.",
        details: { sent: false },
        exit_code: 5,
      });
      for (const extra of [[], ["--confirm"], ["--confirm", "0123456789ab"]]) {
        const deleted = await cli(sb, ["secrets", "delete", "crm_api_token", ...extra, "--json"], { env });
        expect(deleted.code).toBe(5);
        expect(deleted.json<Refusal>().error).toMatchObject({
          code: "operation_for_a_person",
          message: expect.stringMatching(/^Deleting a secret's value stays with a person/),
          hint: "A person runs this in their own terminal: `cavelon secrets delete crm_api_token`, or does it in the Admin.",
        });
        // The refusal says who runs it, never what tells an agent from a person.
        expect(deleted.stdout + deleted.stderr).not.toContain(variable);
      }
      expect(set.stdout + set.stderr).not.toContain(variable);
      expect(secretRequests()).toEqual([]);
      expect(stored("crm_api_token")).toBe(SECRET);
    });

    it("a variable set to 0 or false is a person's terminal", async () => {
      const set = await cli(sb, ["secrets", "set", "crm_api_token"], { stdin: SECRET, env: { CAVELON_AGENT: "0", CLAUDECODE: "false" } });
      expect(set.code, set.stderr).toBe(0);
      expect(stored("crm_api_token")).toBe(SECRET);
    });
  });

  it("tells a role the instance refuses who sets secrets, and leaves the decision to the instance", async () => {
    const builder = sandbox();
    try {
      await login(builder, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, permissions: ["agents.manage", "agents.view"] }));
      type Refusal = { error: { code: string; message: string; hint: string; details: Record<string, unknown> } };
      const refused = await cli(builder, ["secrets", "set", "crm_api_token", "--json"], { stdin: SECRET });
      expect(refused.code).toBe(7);
      const error = refused.json<Refusal>().error;
      expect(error).toMatchObject({ code: "permission_missing", details: { sent: true, permissions: ["settings.manage", "settings.secrets.manage"] } });
      expect(error.message).toMatch(/^This token's role may not set secrets: the instance refused it, as that needs settings\.manage or settings\.secrets\.manage/);
      // This instance publishes needs_a_person, so it lets only a person signed in to the Admin set one: the Owner does it there.
      expect(error.hint).toBe("A tenant Owner (or another role allowed to manage secrets) sets it, signed in to the Admin under Settings › Secrets.");
      expect(refused.stdout + refused.stderr).not.toContain(SECRET);
      expect((await cli(builder, ["whoami"])).stdout).toMatch(/^may set secrets:\s+no \(a tenant Owner sets them, signed in to the Admin under Settings › Secrets\)$/m);
      // An older instance, whose tokens set secrets, names the Owner's own token and the command, with the --tenant given.
      server.state.serveCredentialAccess = false;
      try {
        const older = await cli(builder, ["secrets", "set", "crm_api_token", "--json"], { stdin: SECRET });
        expect(older.json<Refusal>().error.hint).toBe(
          "A tenant Owner (or another role allowed to manage secrets) sets it, in the Admin under Settings › Secrets or with their own token: `cavelon secrets set crm_api_token`.",
        );
        const elsewhere = await cli(builder, ["secrets", "set", "crm_api_token", "--tenant", tenant, "--json"], { stdin: SECRET });
        expect(elsewhere.json<Refusal>().error.hint).toMatch(new RegExp(`: \`cavelon secrets set crm_api_token --tenant ${tenant}\`\\.$`));
        expect((await cli(builder, ["whoami"])).stdout).toMatch(/^may set secrets:\s+no \(a tenant Owner sets them, in the Admin or with their own token\)$/m);
      } finally {
        server.state.serveCredentialAccess = true;
      }
      // The instance decided: the kit sent the request rather than refusing on permission names it only knows from a refusal.
      expect(secretRequests().filter((r) => r.method === "PUT")).toHaveLength(3);

      expect((await cli(builder, ["whoami", "--json"])).json<{ credential: { may_set_secrets: boolean } }>().credential.may_set_secrets).toBe(false);
      expect((await cli(sb, ["whoami", "--json"])).json<{ credential: { may_set_secrets: boolean } }>().credential.may_set_secrets).toBe(true);
      expect((await cli(keySb, ["whoami", "--json"])).json<{ credential: { may_set_secrets: boolean } }>().credential.may_set_secrets).toBe(false);
      server.state.servePermissions = false;
      expect((await cli(builder, ["whoami"])).stdout).not.toMatch(/may set secrets/);
    } finally {
      server.state.servePermissions = true;
      builder.cleanup();
    }
  });

  it("tells a role that may not set variables (a Builder's) who sets them, as for a secret", async () => {
    const builder = sandbox();
    try {
      await login(builder, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, permissions: ["agents.edit", "agents.view", "settings.view"] }));
      type Refusal = { error: { code: string; message: string; hint: string; details: Record<string, unknown> } };
      const refused = await cli(builder, ["variables", "set", "crm_base_url", "https://crm.example.com", "--json"]);
      expect(refused.code).toBe(7);
      const error = refused.json<Refusal>().error;
      expect(error).toMatchObject({ code: "permission_missing", details: { sent: true, permissions: ["settings.manage", "settings.secrets.manage"] } });
      expect(error.message).toMatch(/^This credential may not set tenant variables: the instance refused it, as that needs settings\.manage or settings\.secrets\.manage\. Variable crm_base_url is unchanged\.$/);
      expect(error.hint).toBe(
        "A tenant Owner (or another role allowed to manage the tenant's settings) sets it, in the Admin under Settings › Variables or with their own token: `cavelon variables set crm_base_url https://crm.example.com`.",
      );
      expect(server.state.values.get(tenant)?.variables.has("crm_base_url")).toBeFalsy();
      // A deletion is refused the same way; a value the hint would not repeat stays a placeholder.
      await cli(sb, ["variables", "set", "crm_base_url", "https://crm.example.com"]);
      const deletion = (await cli(builder, ["variables", "delete", "crm_base_url", "--confirm", "--json"])).json<Refusal>().error;
      expect(deletion.message).toMatch(/^This credential may not delete tenant variables/);
      expect(deletion.hint).toMatch(/: `cavelon variables set crm_base_url <value>`\.$/);
      expect((await cli(builder, ["whoami", "--json"])).json<{ credential: { may_set_variables: boolean } }>().credential.may_set_variables).toBe(false);
      expect((await cli(sb, ["whoami", "--json"])).json<{ credential: { may_set_variables: boolean } }>().credential.may_set_variables).toBe(true);
    } finally {
      builder.cleanup();
    }
  });

  it("sets a secret for a role the instance allows under a permission name the kit does not know", async () => {
    const renamed = sandbox();
    server.state.secretsPermissions = ["secrets.write"];
    try {
      await login(renamed, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, permissions: ["secrets.write"] }));
      const set = await cli(renamed, ["secrets", "set", "crm_api_token"], { stdin: SECRET });
      expect(set.code, set.stderr).toBe(0);
      expect(stored("crm_api_token")).toBe(SECRET);
    } finally {
      server.state.secretsPermissions = ["settings.manage", "settings.secrets.manage"];
      renamed.cleanup();
    }
  });

  it("a key may still list the names; nothing in the list is a value", async () => {
    await cli(sb, ["secrets", "set", "crm_api_token"], { stdin: SECRET });
    const list = await cli(keySb, ["secrets", "list", "--json"]);
    expect(list.code).toBe(0);
    expect(list.stdout).not.toContain(SECRET);
  });

  it("delete shows the status, and deletes only with --confirm", async () => {
    await cli(sb, ["secrets", "set", "crm_api_token"], { stdin: SECRET });
    const shown = await cli(sb, ["secrets", "delete", "crm_api_token"]);
    expect(shown.stdout).toMatch(/Nothing was deleted\. Delete it with: cavelon secrets delete crm_api_token --confirm/);
    expect(stored("crm_api_token")).toBe(SECRET);
    const deleted = await cli(sb, ["secrets", "delete", "crm_api_token", "--confirm"]);
    expect(deleted.stdout).toMatch(/A person sets it again with: cavelon secrets set crm_api_token/);
    expect(stored("crm_api_token")).toBeUndefined();
    expect((await cli(sb, ["secrets", "delete", "crm_api_token", "--confirm", "--json"])).json()).toMatchObject({ deleted: false, status: "not_set" });
  });

  it("an error from the instance never repeats the value", async () => {
    const long = `${SECRET}${"x".repeat(17_000)}`;
    const result = await cli(sb, ["secrets", "set", "crm_api_token", "--json"], { stdin: long });
    expect(result.code).toBe(3);
    expect(result.stdout + result.stderr).not.toContain(SECRET);
    expect(result.json<{ error: { message: string } }>().error.message).toMatch(/must NOT have more than 16384 characters/);
    // Checked against the published schema: nothing went out.
    expect(server.state.requests.some((r) => r.method === "PUT")).toBe(false);
  });
});

describe("apply names the variables and secrets the target still needs", () => {
  async function solution(): Promise<string> {
    const dir = path.join(sb.home, `solution-${++dirCount}`);
    mkdirSync(dir, { recursive: true });
    expect((await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--harness", "support"], { cwd: dir })).code).toBe(0);
    expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
    return dir;
  }

  function declare(dir: string) {
    writeFileSync(path.join(dir, "package", "required_variables.yaml"), "- name: crm_base_url\n  description: Base URL of the CRM API\n");
    writeFileSync(path.join(dir, "package", "required_secrets.yaml"), "- name: crm_api_token\n  description: Token of the CRM integration user\n");
  }

  it("with the command that sets each; a person sets the secrets", async () => {
    const dir = await solution();
    declare(dir);
    expect((await cli(sb, ["validate"], { cwd: dir })).code).toBe(0);
    const text = await cli(sb, ["apply", "--env", "test"], { cwd: dir });
    expect(text.code, text.stdout + text.stderr).toBe(0);
    expect(text.stdout).toMatch(/needs secrets:\s+- crm_api_token \(Token of the CRM integration user\): cavelon secrets set crm_api_token --env test/);
    expect(text.stdout).toMatch(/a person runs these in a terminal, or sets them in the Admin; never the agent/);
    expect(text.stdout).toMatch(/needs variables:\s+- crm_base_url \(Base URL of the CRM API\): cavelon variables set crm_base_url <value> --env test/);
    const json = await cli(sb, ["apply", "--env", "test", "--json"], { cwd: dir });
    const data = json.json<{ preview_id: string; set_commands: unknown; target_needs: { secrets: Array<Record<string, unknown>> } }>();
    // The declared secret, and the one the sample package's webhook tool names as {{secret:crm_token}}.
    expect(data.set_commands).toEqual({
      secrets: ["cavelon secrets set crm_api_token --env test", "cavelon secrets set crm_token --env test"],
      variables: ["cavelon variables set crm_base_url <value> --env test"],
    });
    expect(data.target_needs.secrets).toEqual([expect.objectContaining({ name: "crm_api_token", declared: true }), expect.objectContaining({ name: "crm_token", declared: false })]);

    // After the import, the reminder names what is still not set.
    const confirmed = await cli(sb, ["apply", "--confirm", data.preview_id, "--env", "test"], { cwd: dir });
    expect(confirmed.code, confirmed.stdout).toBe(0);
    expect(confirmed.stdout).toMatch(/set secrets:\s+cavelon secrets set crm_api_token --env test/);
    // The declaration lands in the tenant's secrets list, as not set, with the command for the person.
    const missing = await cli(sb, ["secrets", "list", "--missing", "--json"]);
    expect(missing.json()).toMatchObject({
      not_set: 1,
      items: [{ name: "crm_api_token", status: "not_set", declared: true, set_by_person: "cavelon secrets set crm_api_token" }],
    });
    expect((await cli(sb, ["secrets", "list"])).stdout).toMatch(/1 not set\. A person sets each with: cavelon secrets set <name>/);

    // Once set, the preview no longer lists them.
    await cli(sb, ["secrets", "set", "crm_api_token"], { stdin: SECRET });
    await cli(sb, ["secrets", "set", "crm_token"], { stdin: SECRET });
    await cli(sb, ["variables", "set", "crm_base_url", "https://crm.example.com"]);
    const after = await cli(sb, ["apply", "--json"], { cwd: dir });
    expect(after.json()).not.toHaveProperty("set_commands");
    // The import recorded the declaration: the secrets list shows it as declared.
    expect((await cli(sb, ["secrets", "list", "--json"])).json<{ items: unknown[] }>().items).toEqual([
      expect.objectContaining({ name: "crm_api_token", status: "set", declared: true, description: "Token of the CRM integration user" }),
      expect.objectContaining({ name: "crm_token", status: "set", declared: false }),
    ]);
  });

  it("names the Admin for each secret where the instance lets no token set one", async () => {
    const dir = await solution();
    declare(dir);
    server.state.tokensRefusedOnSecrets = true;
    try {
      const text = await cli(sb, ["apply", "--env", "test"], { cwd: dir });
      expect(text.code, text.stdout + text.stderr).toBe(0);
      expect(text.stdout).toMatch(/needs secrets:\s+- crm_api_token \(Token of the CRM integration user\): in the Admin under Settings › Secrets \(crm_api_token\)/);
      expect(text.stdout).toMatch(/\(a person sets them, signed in to the Admin; never the agent\)/);
      expect(text.stdout).not.toMatch(/cavelon secrets set/);
      // Variables are not person-only: their commands stay.
      expect(text.stdout).toMatch(/cavelon variables set crm_base_url <value> --env test/);
      const data = (await cli(sb, ["apply", "--env", "test", "--json"], { cwd: dir })).json<{ set_commands: { secrets: string[] } }>();
      expect(data.set_commands.secrets).toEqual(["in the Admin under Settings › Secrets (crm_api_token)", "in the Admin under Settings › Secrets (crm_token)"]);
      const list = await cli(sb, ["secrets", "list", "--json"], { cwd: dir });
      expect(list.json<{ declared_locally: unknown[] }>().declared_locally.length).toBeGreaterThan(0);
      expect((await cli(sb, ["secrets", "list"], { cwd: dir })).stdout).toMatch(/A person may set it before that: in the Admin under Settings › Secrets \(crm_api_token\)/);
    } finally {
      server.state.tokensRefusedOnSecrets = false;
    }
  });

  it("tells a credential that may not set variables who sets them", async () => {
    const dir = await solution();
    declare(dir);
    const builder = sandbox();
    try {
      await login(builder, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, permissions: ["agents.edit", "agents.view", "settings.view"] }));
      const text = await cli(builder, ["apply"], { cwd: dir });
      expect(text.code, text.stderr).toBe(0);
      expect(text.stdout).toMatch(/needs variables:\s+- crm_base_url \(Base URL of the CRM API\): cavelon variables set crm_base_url <value>\n {2}\(this credential may not set variables\. A tenant Owner \(or another role allowed to manage the tenant's settings\) sets it/);
      // One that may hears the command alone.
      expect((await cli(sb, ["apply"], { cwd: dir })).stdout).not.toMatch(/may not set variables/);
    } finally {
      builder.cleanup();
    }
  });

  it("pull and apply keep the package's declarations in the solution files, unchanged", async () => {
    const dir = await solution();
    declare(dir);
    const preview = (await cli(sb, ["apply", "--json"], { cwd: dir })).json<{ preview_id: string }>();
    server.state.requests.length = 0;
    expect((await cli(sb, ["apply", "--confirm", preview.preview_id], { cwd: dir })).code).toBe(0);
    const sent = server.state.requests.find((r) => r.path === "/api/v1/agent-graph/import")!.body as { package: Record<string, unknown> };
    expect(sent.package.required_secrets).toEqual([{ name: "crm_api_token", description: "Token of the CRM integration user" }]);
    expect(sent.package.required_variables).toEqual([{ name: "crm_base_url", description: "Base URL of the CRM API" }]);

    const before = readFileSync(path.join(dir, "package", "required_secrets.yaml"), "utf8");
    const mtime = statSync(path.join(dir, "package", "required_secrets.yaml")).mtimeMs;
    const pulled = await cli(sb, ["pull", "--force", "--json"], { cwd: dir });
    expect(pulled.code, pulled.stdout).toBe(0);
    const report = pulled.json<{ files: { unchanged: string[]; removed: string[] } }>().files;
    expect(report.unchanged).toEqual(expect.arrayContaining(["package/required_secrets.yaml", "package/required_variables.yaml"]));
    expect(report.removed).toEqual([]);
    expect(readFileSync(path.join(dir, "package", "required_secrets.yaml"), "utf8")).toBe(before);
    expect(statSync(path.join(dir, "package", "required_secrets.yaml")).mtimeMs).toBe(mtime);

    // A fresh folder pulls them from the instance.
    const fresh = await solution();
    expect(parse(readFileSync(path.join(fresh, "package", "required_variables.yaml"), "utf8"))).toEqual([{ name: "crm_base_url", description: "Base URL of the CRM API" }]);
    expect(parse(readFileSync(path.join(fresh, "package", "required_secrets.yaml"), "utf8"))).toEqual([{ name: "crm_api_token", description: "Token of the CRM integration user" }]);
  });

  it("list names what this folder's package declares before the first apply", async () => {
    const dir = await solution();
    writeFileSync(path.join(dir, "package", "required_secrets.yaml"), "- name: crm_api_token\n  description: Token of the CRM integration user\n");
    const listed = await cli(sb, ["secrets", "list"], { cwd: dir });
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toMatch(/^This tenant has no secrets, and no package applied to it declared one\./);
    expect(listed.stdout).toContain("package/required_secrets.yaml declares crm_api_token, which the tenant does not know yet");
    expect(listed.stdout).toContain("cavelon secrets set crm_api_token");
    const json = (await cli(sb, ["secrets", "list", "--json"], { cwd: dir })).json<{ declared_locally: Array<{ name: string; file: string }> }>();
    expect(json.declared_locally).toEqual([{ name: "crm_api_token", file: "package/required_secrets.yaml" }]);
  });
});
