import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMANDS } from "../src/commands/index.js";
import type { InStream, Io } from "../src/io.js";
import { createMcpServer } from "../src/mcp.js";
import { modelRow, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

let server: FakeServer;
let sb: Sandbox;
let client: Client;
let tenant: string;
let stdout = "";

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  sb = sandbox();
  server.state.features = { ...server.state.features, sandbox_feature_enabled: true, sandbox_isolated_container_enabled: true, masterloop_enabled: true };
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, email: "ada@example.com" }));
  const io: Io = {
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: () => true },
    stdin: Readable.from([]) as unknown as InStream,
    env: sb.env,
    cwd: sb.home,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  const mcp = createMcpServer(io, COMMANDS);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
});
afterAll(async () => {
  await client.close();
  sb.cleanup();
  await server.close();
});

function payload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text);
}

describe("cavelon mcp", () => {
  it("offers coarse tools, one per workflow command plus api and docs_search, with annotations", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "activate",
        "api",
        "artifacts_export",
        "loop_cancel",
        "loop_iterations",
        "loop_pause",
        "loop_resume",
        "loop_start",
        "sandbox_activity",
        "sandbox_cat",
        "sandbox_files",
        "sandbox_list",
        "sandbox_logs",
        "sandbox_receipt",
        "sandbox_refresh",
        "sandbox_seed",
        "sandbox_validate",
        "trigger_identity",
        "api_describe",
        "api_list",
        "docs_get",
        "docs_search",
        "explain",
        "apply",
        "harness_clone",
        "harness_list",
        "harness_new",
        "init",
        "kb_upload",
        "limits",
        "limits_set",
        "models_list",
        "models_set_limit",
        "operation_status",
        "pull",
        "secrets_list",
        "status",
        "tenant_create",
        "tenant_list",
        "test_run",
        "trace",
        "use_tenant",
        "validate",
        "variables_get",
        "variables_list",
        "variables_set",
        "whoami",
      ].sort(),
    );
    // Never one tool per API operation, never login or logout.
    expect(names).not.toContain("login");
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.whoami!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.harness_new!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.api!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.validate!.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.explain!.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.apply!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.activate!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    // The loop and Sandbox tools: what may stop or replace something is marked destructive and takes confirm.
    for (const name of ["loop_cancel", "sandbox_seed", "trigger_identity"]) {
      expect(byName[name]!.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(Object.keys((byName[name]!.inputSchema as { properties: object }).properties), name).toContain("confirm");
    }
    for (const name of ["sandbox_list", "sandbox_files", "sandbox_cat", "sandbox_activity", "sandbox_logs", "sandbox_receipt", "loop_iterations"]) {
      expect(byName[name]!.annotations, name).toMatchObject({ readOnlyHint: true });
    }
    // loop watch streams, like watch: no tool; loop_iterations and operation_status follow a loop instead.
    expect(names).not.toContain("loop_watch");
    for (const name of ["loop_start", "sandbox_seed", "artifacts_export"]) {
      expect(Object.keys((byName[name]!.inputSchema as { properties: object }).properties), name).not.toContain("wait");
    }
    // apply's options carry over, --env included.
    expect(Object.keys((byName.apply!.inputSchema as { properties: object }).properties)).toEqual(expect.arrayContaining(["env", "harness", "confirm"]));
    // Blocking options are not offered.
    expect(Object.keys((byName.test_run!.inputSchema as { properties: object }).properties)).not.toContain("wait");
    expect((byName.docs_search!.inputSchema as { required: string[] }).required).toEqual(["query"]);
    // use_tenant's own argument is the tenant to choose, not an override.
    expect((byName.use_tenant!.inputSchema as { properties: Record<string, { description: string }> }).properties.tenant!.description).toMatch(/slug, name or id/);
  });

  it("offers limits_set as a destructive tool that changes nothing without confirm", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "limits_set")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect((tool.inputSchema as { required: string[] }).required).toEqual(["key", "value"]);
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual(expect.arrayContaining(["key", "value", "confirm"]));
    const before = server.state.requests.length;
    const preview = await client.callTool({ name: "limits_set", arguments: { key: "agent_max_turns", value: 40 } });
    expect(preview.isError).toBeFalsy();
    expect(payload(preview)).toMatchObject({ key: "agent_max_turns", previous: 25, value: 40, changed: false, sent: false });
    expect(server.state.requests.slice(before).filter((r) => r.method === "PATCH")).toEqual([]);
    const done = await client.callTool({ name: "limits_set", arguments: { key: "agent_max_turns", value: 40, confirm: true } });
    expect(done.isError).toBeFalsy();
    expect(payload(done)).toMatchObject({ now: 40, source: "tenant", changed: true, sent: true });
    server.state.tenantLimits.clear();
  });

  it("runs a read-only tool with the stored login", async () => {
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(payload(result).owner.email).toBe("ada@example.com");
  });

  it("offers the instance's limits as a read-only tool", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "limits")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const result = await client.callTool({ name: "limits", arguments: { key: ["kb_upload_max_file_size_mb"] } });
    expect(result.isError).toBeFalsy();
    const data = payload(result);
    expect(data.groups).toEqual([{ source: "platform", limits: [expect.objectContaining({ key: "kb_upload_max_file_size_mb", value: 25 })] }]);
  });

  it("returns an operation id at once instead of blocking", async () => {
    const created = payload(await client.callTool({ name: "harness_new", arguments: { slug: "support" } }));
    server.state.suites.push({ id: "5a17e000-0000-4000-8000-0000000000f1", tenant_id: tenant, name: "smoke", harness_id: created.id, archived_at: null });
    server.state.defaultSteps = ["running", "running", "running", "succeeded"];
    const started = payload(await client.callTool({ name: "test_run", arguments: { suite: ["smoke"] } }));
    expect(started.operation_ids).toHaveLength(1);
    const status = payload(await client.callTool({ name: "operation_status", arguments: { operation: started.operation_ids } }));
    expect(status).toMatchObject({ settled: false, exit_code: 6 });
    expect(status.operations[0].status).toBe("running");
  });

  it("starts a loop and an export without blocking, and downloads the export by job later", async () => {
    const parent = "0f0e0d0c-0000-4000-8000-0000000000a1";
    server.state.harnesses.push({ id: parent, tenant_id: tenant, slug: "orders-parent", name: "Orders" });
    const box = {
      id: "0f0e0d0c-0000-4000-8000-0000000000b1",
      tenant_id: tenant,
      name: "orders-test",
      execution_mode: "isolated_container" as const,
      lifecycle_state: "ready",
      config_version: 1,
      revision: 0,
      allowed_harness_ids: [parent],
      machine_api_key_ids: [],
      files: new Map([["output/result.json", Buffer.from("{}")]]),
      writer_owner_run_id: null,
      healthy: true,
      readiness: null,
      activity: [],
      refreshKeys: new Map(),
    };
    server.state.lr.sandboxes.push(box);
    server.state.lr.triggers.push({
      id: "0f0e0d0c-0000-4000-8000-0000000000c1",
      tenant_id: tenant,
      slug: "counter",
      name: "Counter",
      harness_id: parent,
      trigger_type: "webhook",
      is_active: true,
      identity: { api_key_id: null, version: 1 },
      required_solutions: [],
      loop: { iterations: 2 },
    });
    const started = payload(await client.callTool({ name: "loop_start", arguments: { trigger: "counter" } }));
    expect(started.operation_id).toMatch(/^op_trigger_run_/);
    const iterations = payload(await client.callTool({ name: "loop_iterations", arguments: { run: started.run_id } }));
    expect(iterations.loop.iteration).toBeGreaterThanOrEqual(1);

    const exported = payload(await client.callTool({ name: "artifacts_export", arguments: { sandbox: "orders-test", path: ["output"] } }));
    expect(exported).toMatchObject({ status: "active", download: expect.stringContaining("--job") });
    let status: Record<string, any> = {};
    for (let i = 0; i < 10; i++) {
      status = payload(await client.callTool({ name: "operation_status", arguments: { operation: [exported.operation_id] } }));
      if (status.settled) break;
    }
    expect(status.operations[0].status).toBe("succeeded");
    const downloaded = payload(await client.callTool({ name: "artifacts_export", arguments: { sandbox: "orders-test", job: exported.job_id, out: "result.tar" } }));
    expect(downloaded).toMatchObject({ file: "result.tar", status: "succeeded" });
    const refused = await client.callTool({ name: "sandbox_seed", arguments: { sandbox: "orders-test", source: "nowhere", confirm: true } });
    expect(refused.isError).toBe(true);
  });

  it("runs the repository loop: init, pull, validate, apply with an env, confirm", async () => {
    // The tools work in the folder the agent started `cavelon mcp` in.
    const init = payload(await client.callTool({ name: "init", arguments: { harness: "support", tenant: "acme" } }));
    expect(init.files.find((f: { file: string }) => f.file === "cavelon.yaml").action).toBe("created");
    expect(payload(await client.callTool({ name: "pull", arguments: {} })).harness.slug).toBe("support");
    expect(payload(await client.callTool({ name: "validate", arguments: { offline: true } }))).toMatchObject({ valid: true });
    const preview = payload(await client.callTool({ name: "apply", arguments: { env: "test" } }));
    expect(preview).toMatchObject({ previewed: true, env: "test", harness: { slug: "support" } });
    const applied = payload(await client.callTool({ name: "apply", arguments: { confirm: preview.preview_id } }));
    expect(applied).toMatchObject({ applied: true, preview_id: preview.preview_id });
    // A confirmed import its own check refuses names each blocker.
    const again = payload(await client.callTool({ name: "apply", arguments: { env: "test" } }));
    const blockers = ["Select valid destination runtime resources and preview again. runtime_external_iteration_harness_unavailable"];
    server.state.importRequirementsChanged = { blockers };
    const refused = await client.callTool({ name: "apply", arguments: { confirm: again.preview_id } });
    server.state.importRequirementsChanged = null;
    expect(refused.isError).toBe(true);
    const { error } = JSON.parse((refused.content as Array<{ text: string }>)[0]!.text);
    expect(error).toMatchObject({ code: "package_requirements_changed", exit_code: 4, blockers });
    expect(error.message).toMatch(/nothing was imported; preview again\.$/);
    expect(error.hint).toMatch(/^runtime_external_iteration_harness_unavailable: .*Step 1 comes first/);
    const explained = payload(await client.callTool({ name: "explain", arguments: { code: "package_version_unsupported" } }));
    expect(explained.kind).toBe("api");
  });

  it("reads and sets variables; lists secrets but never sets one or shows a value", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.variables_list!.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.variables_get!.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.variables_set!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.secrets_list!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    // No tool sets or deletes a secret, or deletes a variable; no secret tool takes a value.
    for (const name of ["secrets_set", "secrets_delete", "variables_delete"]) expect(byName[name], name).toBeUndefined();
    for (const tool of tools.filter((t) => t.name.startsWith("secrets"))) expect(Object.keys((tool.inputSchema as { properties: object }).properties)).not.toContain("value");
    expect(client.getInstructions()).toMatch(/tell them the exact `cavelon secrets set <name>` command/);
    expect(client.getInstructions()).toMatch(/Never approve or decide an approval/);

    const set = payload(await client.callTool({ name: "variables_set", arguments: { name: "region", value: "eu" } }));
    expect(set).toMatchObject({ name: "region", value: "eu", created: true });
    expect(payload(await client.callTool({ name: "variables_get", arguments: { name: "region" } }))).toMatchObject({ value: "eu" });
    expect(payload(await client.callTool({ name: "variables_list", arguments: {} })).items).toEqual([{ name: "region", value: "eu", source: null }]);
    const noValue = await client.callTool({ name: "variables_set", arguments: { name: "region" } });
    expect(noValue.isError).toBe(true);

    // A person sets the secret in a terminal; the agent sees only its status.
    const value = `v-${Math.random().toString(36).slice(2)}`;
    expect((await cli(sb, ["secrets", "set", "crm_api_token"], { stdin: value })).code).toBe(0);
    const listed = await client.callTool({ name: "secrets_list", arguments: {} });
    expect(listed.isError).toBeFalsy();
    expect(payload(listed).items).toEqual([expect.objectContaining({ name: "crm_api_token", status: "set" })]);
    expect(JSON.stringify(listed)).not.toContain(value);
  });

  it("lists Model Registry rows read-only, and sets an endpoint's limit only with confirm (destructive)", async () => {
    const row = modelRow(tenant, { model_id: "llama-70b", provider: "openai", base_url: "http://vllm.internal:8000/v1", max_concurrent_requests: 4 });
    server.state.models.push(row);
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.models_list!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.models_set_limit!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(Object.keys((byName.models_set_limit!.inputSchema as { properties: object }).properties)).toContain("confirm");
    expect(client.getInstructions()).toMatch(/Never change a limit on your own: propose the old and new value .*limits_set.*models_set_limit.* and let the person decide; an operator.s limit goes to the operator/);

    const listed = payload(await client.callTool({ name: "models_list", arguments: {} }));
    expect(listed.items).toEqual([expect.objectContaining({ model_id: "llama-70b", endpoint: "http://vllm.internal:8000/v1", max_concurrent_requests: 4 })]);
    const shown = payload(await client.callTool({ name: "models_set_limit", arguments: { model: "llama-70b", limit: "8" } }));
    expect(shown).toMatchObject({ previous: 4, limit: 8, changed: false, sent: false });
    expect(row.max_concurrent_requests).toBe(4);
    const changed = payload(await client.callTool({ name: "models_set_limit", arguments: { model: "llama-70b", limit: "8", confirm: true } }));
    expect(changed).toMatchObject({ previous: 4, limit: 8, changed: true });
    expect(row.max_concurrent_requests).toBe(8);
  });

  it("calls any operation through api, and reports errors as tool errors", async () => {
    const list = await client.callTool({ name: "api", arguments: { operation: "list_harnesses" } });
    expect(list.isError).toBeFalsy();
    const bad = await client.callTool({ name: "api", arguments: { operation: "create_harness", body: '{"name":"x"}' } });
    expect(bad.isError).toBe(true);
    expect(payload(bad).error).toMatchObject({ code: "validation_failed", exit_code: 3 });
    const stdinBody = await client.callTool({ name: "api", arguments: { operation: "create_harness", body: "-" } });
    expect(stdinBody.isError).toBe(true);
    expect(payload(stdinBody).error.exit_code).toBe(2);
    const missing = await client.callTool({ name: "docs_search", arguments: {} });
    expect(missing.isError).toBe(true);
    expect(payload(missing).error.exit_code).toBe(2);
  });

  it("searches the docs", async () => {
    const result = payload(await client.callTool({ name: "docs_search", arguments: { query: ["regression testing"], limit: 3 } }));
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.length).toBeLessThanOrEqual(3);
  });

  it("writes nothing to stdout itself (stdout belongs to the protocol)", () => {
    expect(stdout).toBe("");
  });
});
