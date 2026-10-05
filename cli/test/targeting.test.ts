import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../src/commands/index.js";
import { modelRow, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * Where a command acts, and where the commands it prints act. `--tenant`
 * beats the tenant an env file names, so a printed follow-up carries both;
 * agents run printed commands as they stand. An `--env` that names no env
 * file is refused before anything is sent, never read as "no env file".
 */

let server: FakeServer;
let sb: Sandbox;
let acme: string;
let beta: string;
let dir: string;

/** The words after `cavelon` of a printed command whose words are all bare. */
const argsOf = (line: string) => line.split(" ").slice(1);
const changesIn = (tenantId: string) => server.state.requests.filter((r) => r.method !== "GET" && r.headers["x-tenant-id"] === tenantId);

beforeAll(async () => {
  server = await startFakeServer();
  acme = server.addTenant("acme", "Acme");
  beta = server.addTenant("beta", "Beta");
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [acme, beta], defaultTenant: acme }));
  for (const tenant of ["acme", "beta"]) await cli(sb, ["harness", "new", "support", "--name", "Support", "--tenant", tenant]);
  dir = path.join(sb.home, "solution");
  mkdirSync(dir, { recursive: true });
  expect((await cli(sb, ["init", "--instance", server.url, "--tenant", "acme", "--harness", "support"], { cwd: dir })).code).toBe(0);
  expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
  // env/prod.yaml names acme; every command below overrides it with --tenant beta.
  writeFileSync(path.join(dir, "env", "prod.yaml"), "tenant: acme\n");
});
beforeEach(() => {
  server.state.requests.length = 0;
  server.state.tenantLimits.clear();
  server.state.tenantRunCaps.clear();
  server.state.models = [];
  server.state.values.clear();
});
afterAll(async () => {
  sb.cleanup();
  await server.close();
});

describe("a printed command acts where the command that printed it did", () => {
  it("limits set --env prod --tenant beta: the confirm command keeps --tenant beta, and changes beta", async () => {
    const preview = await cli(sb, ["limits", "set", "agent_max_turns", "7", "--env", "prod", "--tenant", "beta", "--json"], { cwd: dir });
    expect(preview.code, preview.stderr).toBe(0);
    const { confirm } = preview.json<{ confirm: string }>();
    expect(confirm).toBe("cavelon limits set agent_max_turns 7 --env prod --tenant beta --confirm");
    const result = await cli(sb, argsOf(confirm), { cwd: dir });
    expect(result.code, result.stderr).toBe(0);
    expect(changesIn(beta)).toHaveLength(1);
    expect(changesIn(acme)).toEqual([]);
  });

  it("an operator's one-tenant change keeps its tenant, so its confirm never becomes the platform's cap", async () => {
    const env = {
      CAVELON_URL: server.url,
      CAVELON_TOKEN: server.addToken({ kind: "pat", tenantIds: [acme, beta], platform: true, globalRole: "superadmin", tokenName: "ops" }),
    };
    const preview = await cli(sb, ["limits", "set", "max_concurrent_agent_runs_per_tenant", "11", "--env", "prod", "--tenant", "beta", "--json"], { cwd: dir, env });
    expect(preview.code, preview.stderr).toBe(0);
    const data = preview.json<{ confirm: string; operation: { path: string } }>();
    expect(data.operation.path).toBe("/api/v1/tenants/{tenant_id}/limits");
    expect(data.confirm).toContain("--tenant beta");
    const result = await cli(sb, argsOf(data.confirm), { cwd: dir, env });
    expect(result.code, result.stderr).toBe(0);
    const sent = server.state.requests.filter((r) => r.method === "PATCH");
    expect(sent.map((r) => r.path)).toEqual([`/api/v1/tenants/${beta}/limits`]);
  });

  it("models set-limit --env prod --tenant beta", async () => {
    server.state.models.push(modelRow(beta, { model_id: "llama-70b", base_url: "http://vllm.internal:8000/v1" }));
    const preview = await cli(sb, ["models", "set-limit", "llama-70b", "4", "--env", "prod", "--tenant", "beta", "--json"], { cwd: dir });
    expect(preview.code, preview.stderr).toBe(0);
    const { confirm } = preview.json<{ confirm: string }>();
    expect(confirm).toBe("cavelon models set-limit llama-70b 4 --env prod --tenant beta --confirm");
    expect((await cli(sb, argsOf(confirm), { cwd: dir })).code).toBe(0);
    expect(changesIn(beta).map((r) => r.method)).toEqual(["PATCH"]);
  });

  it("apply --env prod --tenant beta: the confirm line and the set commands keep --tenant beta", async () => {
    writeFileSync(path.join(dir, "package", "required_secrets.yaml"), "- name: crm_api_token\n  description: Token of the CRM integration user\n");
    const preview = await cli(sb, ["apply", "--env", "prod", "--tenant", "beta"], { cwd: dir });
    expect(preview.code, preview.stdout + preview.stderr).toBe(0);
    expect(preview.stdout).toMatch(/crm_api_token \(Token of the CRM integration user\): cavelon secrets set crm_api_token --env prod --tenant beta\n/);
    const confirmLine = /Import exactly this: (.+)/.exec(preview.stdout)![1]!;
    expect(confirmLine).toMatch(/^cavelon apply --env prod --tenant beta --confirm \S+$/);
    const json = (await cli(sb, ["apply", "--env", "prod", "--tenant", "beta", "--json"], { cwd: dir })).json<{ set_commands: { secrets: string[] } }>();
    expect(json.set_commands.secrets[0]).toBe("cavelon secrets set crm_api_token --env prod --tenant beta");

    const confirmed = await cli(sb, argsOf(/Import exactly this: (.+)/.exec(preview.stdout)![1]!), { cwd: dir });
    expect(confirmed.code, confirmed.stdout + confirmed.stderr).toBe(0);
    expect(confirmed.stdout).toMatch(/set secrets:\s+cavelon secrets set crm_api_token --env prod --tenant beta\n/);
    expect(server.state.requests.find((r) => r.path === "/api/v1/agent-graph/import")!.headers["x-tenant-id"]).toBe(beta);

    // The printed secret command reaches beta too.
    const secret = await cli(sb, argsOf(json.set_commands.secrets[0]!), { cwd: dir, stdin: "a-value-a-person-typed" });
    expect(secret.code, secret.stderr).toBe(0);
    expect(server.state.values.get(beta)?.secrets.has("crm_api_token")).toBe(true);
    expect(server.state.values.get(acme)?.secrets.has("crm_api_token") ?? false).toBe(false);
  });

  it("--instance stays on the printed command, so it never goes to cavelon.yaml's instance", async () => {
    const elsewhere = path.join(sb.home, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const preview = await cli(sb, ["limits", "set", "agent_max_turns", "7", "--instance", server.url, "--tenant", "beta", "--json"], { cwd: elsewhere });
    expect(preview.code, preview.stderr).toBe(0);
    expect(preview.json<{ confirm: string }>().confirm).toBe(`cavelon limits set agent_max_turns 7 --instance ${server.url} --tenant beta --confirm`);
  });
});

describe("--env with no env file", () => {
  const withEnv = COMMANDS.filter((spec) => spec.options?.env);

  it("covers every command that takes --env", () => {
    expect(withEnv.map((spec) => spec.name).sort()).toEqual(
      expect.arrayContaining(["activate", "apply", "limits set", "models list", "models set-limit", "secrets set", "variables set"]),
    );
  });

  it.each(withEnv.map((spec) => [spec.name, spec] as const))("%s --env nosuch is refused before anything is sent", async (_name, spec) => {
    const positionals = (spec.positionals ?? []).map(() => "1");
    server.state.requests.length = 0;
    const result = await cli(sb, [...spec.name.split(" "), ...positionals, "--env", "nosuch", "--json"], { cwd: dir, stdin: "a-value" });
    expect(result.code, result.stdout + result.stderr).toBe(2);
    const error = result.json<{ error: { message: string; hint: string } }>().error;
    expect(error.message).toMatch(/No env\/nosuch\.yaml/);
    expect(error.hint).toMatch(/prod, test/);
    expect(server.state.requests).toEqual([]);
  });
});
