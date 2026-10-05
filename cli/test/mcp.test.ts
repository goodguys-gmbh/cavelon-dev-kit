import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundledSkills, generatedCopy, SKILL_ROOTS } from "../src/agents.js";
import { COMMANDS } from "../src/commands/index.js";
import { detectInstall, type Install } from "../src/install.js";
import type { InStream, Io } from "../src/io.js";
import { createMcpServer } from "../src/mcp.js";
import type { UpdateCheckOptions } from "../src/update-check.js";
import { KIT_VERSION } from "../src/version.js";
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
  it("never prompts for a tenant: use_tenant without one returns the choices and changes nothing, and init names them", async () => {
    const globex = server.addTenant("globex-mcp", "Globex");
    const multi = server.addToken({ kind: "pat", tenantIds: [tenant, globex] });
    const own = sandbox();
    const io: Io = {
      stdout: { write: () => true },
      stderr: { write: () => true },
      stdin: Object.assign(Readable.from([]), { isTTY: true }) as unknown as InStream,
      env: { ...own.env, CAVELON_URL: server.url, CAVELON_TOKEN: multi },
      cwd: own.home,
      now: () => new Date(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
    const mcp = createMcpServer(io, COMMANDS);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    const other = new Client({ name: "test", version: "0" });
    await other.connect(clientSide);
    try {
      const choices = payload(await other.callTool({ name: "use_tenant", arguments: {} }));
      expect(choices).toMatchObject({
        tenant: null,
        chosen: false,
        reaches_all_tenants: false,
        choices: [
          // Over MCP a printed command is the tool call.
          { id: tenant, slug: "acme", name: "Acme", command: 'use_tenant {"tenant":"acme"}' },
          { id: globex, slug: "globex-mcp", name: "Globex", command: 'use_tenant {"tenant":"globex-mcp"}' },
        ],
      });
      const init = await other.callTool({ name: "init", arguments: {} });
      expect(init.isError).toBe(true);
      expect(payload(init).error).toMatchObject({ code: "tenant_required", details: { tenants: [{ command: 'init {"tenant":"acme"}' }, { command: 'init {"tenant":"globex-mcp"}' }] } });

      const chosen = payload(await other.callTool({ name: "use_tenant", arguments: { tenant: "Globex" } }));
      expect(chosen).toMatchObject({ tenant: { ref: "globex-mcp", id: globex } });
    } finally {
      await other.close();
      own.cleanup();
    }
  });

  it("offers coarse tools, one per workflow command plus api and docs_search, with annotations", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "activate",
        "api",
        "artifacts_export",
        "chat",
        "deactivate",
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
        "fmt",
        "harness_clone",
        "harness_default",
        "harness_list",
        "harness_new",
        "init",
        "kb_upload",
        "limits",
        "limits_set",
        "models_list",
        "models_set_limit",
        "operation_status",
        "package_schema",
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
    expect(byName.deactivate!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.chat!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    // The loop and Sandbox tools: what may stop or replace something is marked destructive and takes confirm.
    for (const name of ["loop_cancel", "sandbox_seed", "trigger_identity"]) {
      expect(byName[name]!.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(Object.keys((byName[name]!.inputSchema as { properties: object }).properties), name).toContain("confirm");
    }
    for (const name of ["sandbox_list", "sandbox_files", "sandbox_cat", "sandbox_activity", "sandbox_logs", "sandbox_receipt", "loop_iterations"]) {
      expect(byName[name]!.annotations, name).toMatchObject({ readOnlyHint: true });
    }
    // Every tool that confirms a change takes its preview's token, a string; apply takes the preview's id.
    const confirming = tools.filter((t) => "confirm" in (t.inputSchema as { properties: object }).properties).map((t) => t.name);
    expect(confirming).toEqual(
      expect.arrayContaining(["api", "limits_set", "models_set_limit", "loop_cancel", "sandbox_seed", "trigger_identity", "harness_default", "activate", "deactivate", "kb_upload", "apply"]),
    );
    for (const name of confirming) {
      const confirm = (byName[name]!.inputSchema as { properties: Record<string, { type: unknown; description: string }> }).properties.confirm!;
      if (name === "apply") continue;
      expect(confirm.type, name).toBe("string");
      expect(confirm.description, name).toMatch(/the confirm_token this tool's preview returned.*true is refused/);
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
    expect((byName.use_tenant!.inputSchema as { properties: Record<string, { description: string }> }).properties.tenant!.description).toMatch(/name, slug or id/);
  });

  it("offers limits_set as a destructive tool that changes nothing without confirm", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "limits_set")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect((tool.inputSchema as { required: string[] }).required).toEqual(["key", "value"]);
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual(expect.arrayContaining(["key", "value", "confirm"]));
    const before = server.state.requests.length;
    expect((tool.inputSchema as { properties: Record<string, { type: string }> }).properties.confirm!.type).toBe("string");
    const preview = await client.callTool({ name: "limits_set", arguments: { key: "agent_max_turns", value: 40 } });
    expect(preview.isError).toBeFalsy();
    const shown = payload(preview);
    expect(shown).toMatchObject({ key: "agent_max_turns", previous: 25, value: 40, changed: false, sent: false, confirm_token: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(shown.confirm).toBe(`Show the person this, then call limits_set again with the same arguments and confirm: "${shown.confirm_token}" to make exactly this change.`);
    // true is refused, never taken as yes; a token of another change confirms nothing.
    const bare = await client.callTool({ name: "limits_set", arguments: { key: "agent_max_turns", value: 40, confirm: true } });
    expect(bare.isError).toBe(true);
    expect(payload(bare).error).toMatchObject({ code: "confirm_token_required", exit_code: 2 });
    const other = payload(await client.callTool({ name: "limits_set", arguments: { key: "agent_max_turns", value: 41, confirm: shown.confirm_token } }));
    expect(other).toMatchObject({ value: 41, changed: false, sent: false, token_mismatch: true, exit_code: 4 });
    expect(other.confirm_token).not.toBe(shown.confirm_token);
    expect(server.state.requests.slice(before).filter((r) => r.method === "PATCH")).toEqual([]);
    const done = await client.callTool({ name: "limits_set", arguments: { key: "agent_max_turns", value: 40, confirm: shown.confirm_token } });
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
    // Without a timeout it reads the state once: it did not wait, so it did not time out.
    expect(status).toMatchObject({ settled: false, timed_out: false, timeout_ms: 0, exit_code: 6 });
    expect(status.waited_ms).toBeLessThan(1000);
    expect(status.operations[0].status).toBe("running");
  });

  it("operation_status waits up to its timeout, reports waited_ms, and caps a long timeout", async () => {
    const op = server.addOperation("document_ingestion", tenant, ["queued", "running", "running", "running", "succeeded"]);
    const waited = payload(await client.callTool({ name: "operation_status", arguments: { operation: [op.id], timeout: "20s" } }));
    expect(waited).toMatchObject({ settled: true, timed_out: false, timeout_ms: 20_000 });
    expect(waited.operations[0].status).toBe("succeeded");
    expect(waited.waited_ms).toBeGreaterThan(0);

    const capped = server.addOperation("document_ingestion", tenant, ["running", "succeeded"]);
    const long = payload(await client.callTool({ name: "operation_status", arguments: { operation: [capped.id], timeout: "90s" } }));
    expect(long).toMatchObject({ settled: true, timeout_ms: 50_000 });
    expect(long.warnings.join()).toMatch(/waits at most 50 s, not 90s/);

    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "operation_status")!;
    expect(tool.description).toMatch(/returns the state at once unless given a timeout, and waits at most 50 s/);
  });

  it("describes init and pull as changing local files only, never the instance", async () => {
    const { tools } = await client.listTools();
    for (const name of ["init", "pull"]) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.description).not.toMatch(/Changes the instance/);
      expect(tool.description).toMatch(/changes nothing (on the instance|there)/i);
    }
    expect(tools.find((t) => t.name === "pull")!.description).toMatch(/Reads the instance/);
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
    expect(exported).toMatchObject({ status: "active", download: expect.stringMatching(/^artifacts_export \{"sandbox":"orders-test","job":"[0-9a-f-]+"\}$/) });
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
    // The archive is written only inside the solution folder.
    const outside = mkdtempSync(path.join(os.tmpdir(), "cavelon-outside-"));
    try {
      for (const [out, code] of [
        [path.join(outside, "export.tar"), "path_outside_solution"],
        [path.join(sb.env.CAVELON_CONFIG_DIR!, "export.tar"), "path_in_kit_directory"],
      ] as const) {
        const elsewhere = await client.callTool({ name: "artifacts_export", arguments: { sandbox: "orders-test", job: exported.job_id, out } });
        expect(elsewhere.isError).toBe(true);
        expect(payload(elsewhere).error).toMatchObject({ code, exit_code: 2 });
        expect(existsSync(out)).toBe(false);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("runs the repository loop: init, pull, validate, apply with an env, confirm", async () => {
    // The tools work in the folder the agent started `cavelon mcp` in.
    const init = payload(await client.callTool({ name: "init", arguments: { harness: "support", tenant: "acme" } }));
    expect(init.files.find((f: { file: string }) => f.file === "cavelon.yaml").action).toBe("created");
    expect(payload(await client.callTool({ name: "pull", arguments: {} })).harness.slug).toBe("support");
    expect(payload(await client.callTool({ name: "validate", arguments: { offline: true } }))).toMatchObject({ valid: true, warning_count: 0, warnings: [] });
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

  it("pull and apply take include_tenant_wide; apply returns the preview's tenant_wide report, and tenant_wide is still taken", async () => {
    // The folder the repository loop above set up for the solution support.
    const tool = (await client.listTools()).tools.find((t) => t.name === "apply")!;
    expect(Object.keys(tool.inputSchema.properties ?? {})).toContain("include_tenant_wide");
    expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain("tenant_wide");
    const asked = () => server.state.requests.filter((r) => r.path === "/api/v1/agent-graph/export").map((r) => r.query.get("include_tenant_wide"));
    // The import above left the tenant's settings out of the solution; the tenant still has its own.
    server.state.configs.get(tenant)!.pkg.tenant_settings = { default_guardrail_slugs: [] };
    server.state.requests.length = 0;
    const pulled = payload(await client.callTool({ name: "pull", arguments: { include_tenant_wide: true } }));
    expect(asked()).toEqual(["true"]);
    expect(pulled.tenant_wide_pulled).toEqual(expect.arrayContaining(["tenant_settings"]));

    const bodies = () => server.state.requests.filter((r) => r.path === "/api/v1/agent-graph/import/preview").map((r) => r.body as Record<string, unknown>);
    const preview = payload(await client.callTool({ name: "apply", arguments: { include_tenant_wide: true } }));
    expect(bodies().at(-1)).toMatchObject({ include_tenant_wide: true });
    expect(preview.tenant_wide).toMatchObject({
      applied: false,
      would_import: expect.arrayContaining(["tenant_settings"]),
      reported_by: "instance",
      sections: expect.arrayContaining(["tenant_settings"]),
    });
    expect(preview.show_to_person).toBe(true);

    const former = payload(await client.callTool({ name: "apply", arguments: { tenant_wide: true } }));
    expect(bodies().at(-1)).toMatchObject({ include_tenant_wide: true });
    expect(former.warnings).toEqual(expect.arrayContaining(['"tenant_wide" is now "include_tenant_wide"; "tenant_wide" is still taken for now and will be refused in a later release.']));
    // The CLI's spelling is refused, as for every argument.
    const kebab = await client.callTool({ name: "apply", arguments: { "tenant-wide": true } });
    expect(kebab.isError).toBe(true);
    expect(payload(kebab).error).toMatchObject({ code: "unknown_argument" });
    payload(await client.callTool({ name: "apply", arguments: { discard: "all" } }));
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
    const changed = payload(await client.callTool({ name: "models_set_limit", arguments: { model: "llama-70b", limit: "8", confirm: shown.confirm_token } }));
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

  it("sends a changing api operation only with confirm, and never one that is kept for a person", async () => {
    const { tools } = await client.listTools();
    const api = tools.find((t) => t.name === "api")!;
    expect(Object.keys((api.inputSchema as { properties: object }).properties)).toContain("confirm");
    expect(client.getInstructions()).toMatch(
      /api for an operation that is not read-only, return what they would do and a confirm_token, and change nothing until called again with the same arguments and confirm set to that token/,
    );
    expect(client.getInstructions()).toMatch(/a different change needs a new preview, and confirm: true is refused/);
    expect(client.getInstructions()).toMatch(/api refuses, even with confirm, an operation the instance marks for a person \(x-cavelon-person-only; its reason is in the error\), or on an instance that marks none, one that changes a secret, creates or revokes a credential/);
    const changes = (before: number) => server.state.requests.slice(before).filter((r) => r.method !== "GET");

    // Without confirm: what would be sent, and nothing is.
    let before = server.state.requests.length;
    const preview = await client.callTool({ name: "api", arguments: { operation: "set_variable", params: ["name=api_region"], body: '{"value":"eu"}' } });
    expect(preview.isError).toBeFalsy();
    const shown = payload(preview);
    expect(shown).toMatchObject({ operation: "set_variable", method: "PUT", path: "/api/v1/variables/api_region", body: { value: "eu" }, sent: false });
    expect(shown.confirm_token).toMatch(/^[0-9a-f]{12}$/);
    expect(changes(before)).toEqual([]);
    const missing = await client.callTool({ name: "api", arguments: { operation: "set_variable", body: '{"value":"eu"}' } });
    expect(payload(missing).error).toMatchObject({ code: "validation_failed" });
    // confirm without a preview's token sends nothing: true is refused, and so is the token of another body.
    const bare = await client.callTool({ name: "api", arguments: { operation: "set_variable", params: ["name=api_region"], body: '{"value":"eu"}', confirm: true } });
    expect(bare.isError).toBe(true);
    expect(payload(bare).error).toMatchObject({ code: "confirm_token_required", exit_code: 2 });
    const otherBody = payload(
      await client.callTool({ name: "api", arguments: { operation: "set_variable", params: ["name=api_region"], body: '{"value":"us"}', confirm: shown.confirm_token } }),
    );
    expect(otherBody).toMatchObject({ body: { value: "us" }, sent: false, token_mismatch: true, exit_code: 4 });
    expect(otherBody.confirm_token).not.toBe(shown.confirm_token);
    expect(changes(before)).toEqual([]);
    // The shown request's token sends it.
    const sent = await client.callTool({ name: "api", arguments: { operation: "set_variable", params: ["name=api_region"], body: '{"value":"eu"}', confirm: shown.confirm_token } });
    expect(sent.isError).toBeFalsy();
    expect(payload(await client.callTool({ name: "variables_get", arguments: { name: "api_region" } }))).toMatchObject({ value: "eu" });
    before = server.state.requests.length;
    expect(payload(await client.callTool({ name: "api", arguments: { operation: "delete_variable", params: ["name=api_region"] } }))).toMatchObject({ method: "DELETE", sent: false });
    expect(changes(before)).toEqual([]);
    expect(payload(await client.callTool({ name: "variables_get", arguments: { name: "api_region" } }))).toMatchObject({ value: "eu" });

    // A secret's value and its deletion stay with a person, confirm or not.
    expect((await cli(sb, ["secrets", "set", "smtp_password"], { stdin: "person-chosen" })).code).toBe(0);
    before = server.state.requests.length;
    for (const confirm of [false, true]) {
      for (const call of [
        { operation: "delete_secret", params: ["name=smtp_password"] },
        { operation: "set_secret", params: ["name=smtp_password"], body: '{"value":"agent-chosen"}' },
      ]) {
        const refused = await client.callTool({ name: "api", arguments: { ...call, confirm } });
        expect(refused.isError, `${call.operation} confirm=${confirm}`).toBe(true);
        expect(payload(refused).error).toMatchObject({ code: "operation_for_a_person", exit_code: 5 });
        expect(payload(refused).error.hint).toMatch(/cavelon secrets set <name>/);
      }
    }
    expect(changes(before)).toEqual([]);
    expect(payload(await client.callTool({ name: "secrets_list", arguments: {} })).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "smtp_password", status: "set" })]),
    );
    // The CLI is a person: it sends at once, as before.
    expect((await cli(sb, ["api", "delete_secret", "name=smtp_password", "--json"])).code).toBe(0);
  });

  it("reads and writes files only inside the solution folder, never in cavelon's own directories", async () => {
    const credentials = path.join(sb.env.CAVELON_CONFIG_DIR!, "credentials.json");
    expect(existsSync(credentials)).toBe(true);
    const kb = "0f0e0d0c-0000-4000-8000-0000000000d1";
    server.state.kbs.push({ id: kb, tenant_id: tenant, name: "Docs" });
    const outside = mkdtempSync(path.join(os.tmpdir(), "cavelon-outside-"));
    try {
      writeFileSync(path.join(outside, "notes.md"), "# outside\n");
      writeFileSync(path.join(outside, "body.json"), '{"value":"eu"}');
      const before = server.state.requests.length;
      const refusedWith = async (name: string, args: Record<string, unknown>, code: string) => {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
        expect(payload(result).error, `${name} ${JSON.stringify(args)}`).toMatchObject({ code, exit_code: 2 });
      };
      const upload = (file: string) => ({ operation: "upload_documents", params: [`kb_id=${kb}`], file: [`files=${file}`], confirm: true });
      await refusedWith("api", upload(credentials), "path_in_kit_directory");
      await refusedWith("api", upload(path.relative(sb.home, credentials)), "path_in_kit_directory");
      await refusedWith("api", upload(path.join(outside, "notes.md")), "path_outside_solution");
      await refusedWith("api", upload(`${sb.home}/../${path.basename(outside)}/notes.md`), "path_outside_solution");
      await refusedWith("api", { operation: "set_variable", params: ["name=x"], body: `@${credentials}` }, "path_in_kit_directory");
      await refusedWith("api", { operation: "set_variable", params: ["name=x"], body: `@${path.join(outside, "body.json")}` }, "path_outside_solution");
      await refusedWith("kb_upload", { dir: sb.env.CAVELON_CONFIG_DIR!, kb: "Docs" }, "path_in_kit_directory");
      await refusedWith("kb_upload", { dir: outside, kb: "Docs" }, "path_outside_solution");
      await refusedWith("sandbox_seed", { sandbox: "orders-test", source: outside }, "path_outside_solution");
      await refusedWith("sandbox_seed", { sandbox: "orders-test", source: sb.env.CAVELON_CACHE_DIR! }, "path_in_kit_directory");
      await refusedWith("init", { from: path.join(outside, "notes.md") }, "path_outside_solution");
      if (process.platform !== "win32") {
        // A link inside the folder is judged by where it leads.
        symlinkSync(credentials, path.join(sb.home, "linked.json"));
        symlinkSync(outside, path.join(sb.home, "linked-dir"));
        await refusedWith("api", upload("linked.json"), "path_in_kit_directory");
        await refusedWith("api", upload("linked-dir/notes.md"), "path_outside_solution");
        await refusedWith("kb_upload", { dir: "linked-dir", kb: "Docs" }, "path_outside_solution");
      }
      expect(server.state.requests.slice(before).filter((r) => r.method !== "GET")).toEqual([]);

      // A file inside the solution folder goes, once confirmed.
      writeFileSync(path.join(sb.home, "faq.md"), "# FAQ\n");
      const { confirm: _bare, ...unconfirmed } = upload("faq.md");
      const insidePreview = payload(await client.callTool({ name: "api", arguments: unconfirmed }));
      expect(insidePreview).toMatchObject({ sent: false, files: [{ field: "files", file: "faq.md" }] });
      const inside = await client.callTool({ name: "api", arguments: { ...unconfirmed, confirm: insidePreview.confirm_token } });
      expect(inside.isError).toBeFalsy();
      expect(payload(inside).sent).toBeUndefined();
      // The CLI is a person, who may name any file.
      expect((await cli(sb, ["api", "set_variable", "name=from_outside", "--json", `@${path.join(outside, "body.json")}`])).code).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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

describe("the update warning over MCP", () => {
  const SCRIPT: Install = detectInstall({ executable: true, file: "/u/ada/.local/bin/cavelon", platform: "linux", env: { HOME: "/u/ada" }, exists: () => false });
  const NPX: Install = detectInstall({ executable: false, file: "/u/ada/.npm/_npx/0123abcd/node_modules/@cavelon/cli", platform: "linux", env: {}, exists: () => false });
  const UPDATE = "curl -fsSL https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.sh | sh";
  const CLAUDE = "`claude plugin marketplace update cavelon-dev-kit` and `claude plugin update cavelon@cavelon-dev-kit`";
  const CODEX = "`codex plugin marketplace upgrade cavelon-dev-kit` and `codex plugin add cavelon@cavelon-dev-kit`";
  const RELEASES = "https://api.github.com/repos/goodguys-gmbh/cavelon-dev-kit/releases/latest";

  interface SessionOptions {
    install: Install;
    env?: Record<string, string>;
    fetch?: typeof fetch;
    /** The latest release, looked up earlier today. */
    cached?: string;
    /** The client's name in MCP's initialize, as Claude Code and Codex send theirs. */
    client?: string;
    /** The kit version that wrote this folder's skills with `init --agents`. */
    skills?: string;
  }

  /** An agent's session in a solution folder of its own, with a cache folder of its own. */
  async function session(options: SessionOptions) {
    const cache = mkdtempSync(path.join(os.tmpdir(), "cavelon-cache-"));
    const folder = mkdtempSync(path.join(os.tmpdir(), "cavelon-solution-"));
    if (options.cached) {
      const state = { source: "github", checked_at: new Date(Date.now() - 60_000).toISOString(), latest: options.cached };
      writeFileSync(path.join(cache, "update-check.json"), JSON.stringify(state));
    }
    if (options.skills) {
      const [skill] = await bundledSkills();
      const file = skill!.files.find((f) => f.path === "SKILL.md")!;
      for (const root of SKILL_ROOTS) {
        mkdirSync(path.join(folder, root, skill!.name), { recursive: true });
        writeFileSync(path.join(folder, root, skill!.name, "SKILL.md"), generatedCopy(file).replace(`(cavelon ${KIT_VERSION})`, `(cavelon ${options.skills})`));
      }
    }
    const calls: string[] = [];
    const fetchImpl =
      options.fetch ??
      ((async (input: string | URL | Request) => {
        calls.push(String(input));
        return Response.json({ tag_name: "v99.0.0" });
      }) as typeof fetch);
    const io: Io = {
      stdout: { write: () => true },
      stderr: { write: () => true },
      stdin: Readable.from([]) as unknown as InStream,
      env: { ...sb.env, CAVELON_CACHE_DIR: cache, ...options.env },
      cwd: folder,
      now: () => new Date(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
    const updates: UpdateCheckOptions = { install: options.install, fetch: fetchImpl };
    const mcp = createMcpServer(io, COMMANDS, updates);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    const agent = new Client({ name: options.client ?? "test", version: "0" });
    await agent.connect(clientSide);
    return {
      calls,
      whoami: async () => payload(await agent.callTool({ name: "whoami", arguments: {} })),
      call: (name: string, args: Record<string, unknown>) => agent.callTool({ name, arguments: args }),
      close: async () => {
        await agent.close();
        rmSync(cache, { recursive: true, force: true });
        rmSync(folder, { recursive: true, force: true });
      },
    };
  }

  async function inSession<T>(options: SessionOptions, use: (s: Awaited<ReturnType<typeof session>>) => Promise<T>): Promise<T> {
    const s = await session(options);
    try {
      return await use(s);
    } finally {
      await s.close();
    }
  }

  const KIT = ["is out; this is", "The Cavelon plugin is", "cavelon init --agents"];
  const updateWarnings = (result: Record<string, any>) => ((result.warnings ?? []) as string[]).filter((w) => KIT.some((k) => w.includes(k)));

  /** The first result's one warning; the second result carries none. */
  async function firstOnly(s: Awaited<ReturnType<typeof session>>): Promise<string> {
    const first = await s.whoami();
    expect(first.owner.email).toBe("ada@example.com");
    const found = updateWarnings(first);
    expect(found).toHaveLength(1);
    expect(updateWarnings(await s.whoami())).toEqual([]);
    return found[0]!;
  }

  it("adds one warning to the first tool result when a newer release is cached, naming this install's update command", async () => {
    await inSession({ install: SCRIPT, cached: "99.0.0" }, async (s) => {
      const warning = await firstOnly(s);
      expect(warning).toContain(`cavelon 99.0.0 is out; this is ${KIT_VERSION}. Tell the user: Update cavelon with \`${UPDATE}\`.`);
      expect(warning).toContain("Then start a new agent session.");
      expect(warning).toContain("docs/installation.md#updating");
      // An agent without the plugin hears nothing of it; the cached answer needed no request.
      expect(warning).not.toContain("plugin");
      expect(s.calls).toEqual([]);
    });
  });

  it("names the plugin's update for Claude Code when the plugin does not say its version", async () => {
    await inSession({ install: SCRIPT, cached: "99.0.0", client: "claude-code" }, async (s) => {
      expect(await firstOnly(s)).toContain(`If they use the Cavelon plugin, also update it with ${CLAUDE}.`);
    });
  });

  it("names an older plugin and its update for that client, even when cavelon runs through npx", async () => {
    await inSession({ install: NPX, cached: "99.0.0", client: "codex-mcp-client", env: { CAVELON_PLUGIN_VERSION: "0.1.7" } }, async (s) => {
      const warning = await firstOnly(s);
      expect(warning).toBe(
        "The Cavelon plugin is 0.1.7, older than cavelon 99.0.0. " +
          `Tell the user: Update the plugin with ${CODEX}. Then start a new agent session. ` +
          "More: https://github.com/goodguys-gmbh/cavelon-dev-kit/blob/main/docs/installation.md#updating",
      );
    });
    // Nothing cached: the plugin's version is compared with the GitHub release.
    await inSession({ install: NPX, env: { CAVELON_PLUGIN_VERSION: "0.1.7" } }, async (s) => {
      expect(await firstOnly(s)).toContain(`Update the plugin: in Claude Code with ${CLAUDE}; in Codex with ${CODEX}.`);
      expect(s.calls).toEqual([RELEASES]);
    });
  });

  it("reads an installed plugin's version from its manifest when Claude Code names the plugin's folder", async () => {
    // The plugin of this repository, as Claude Code installs it, from before its MCP entry said its version.
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../plugin");
    const manifest = JSON.parse(readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8")) as { version: string };
    await inSession({ install: NPX, client: "claude-code", env: { CLAUDE_PLUGIN_ROOT: root } }, async (s) => {
      const warning = await firstOnly(s);
      expect(warning).toContain(`The Cavelon plugin is ${manifest.version}, older than cavelon 99.0.0. Tell the user: Update the plugin with ${CLAUDE}.`);
      expect(s.calls).toEqual([RELEASES]);
    });
    // What the plugin's MCP entry says comes first.
    await inSession({ install: NPX, cached: "99.0.0", client: "claude-code", env: { CLAUDE_PLUGIN_ROOT: root, CAVELON_PLUGIN_VERSION: "99.0.0" } }, async (s) => {
      expect(updateWarnings(await s.whoami())).toEqual([]);
    });
  });

  it.each([
    ["another plugin's folder", { name: "other", version: "0.0.1" }],
    ["a manifest without a version", { name: "cavelon" }],
    ["a version that is not one", { name: "cavelon", version: "latest" }],
    ["no manifest", undefined],
  ])("guesses no plugin version from %s", async (_, manifest: Record<string, string> | undefined) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cavelon-plugin-"));
    try {
      if (manifest) {
        mkdirSync(path.join(root, ".claude-plugin"));
        writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify(manifest));
      }
      await inSession({ install: NPX, cached: "99.0.0", client: "claude-code", env: { CLAUDE_PLUGIN_ROOT: root } }, async (s) => {
        expect(updateWarnings(await s.whoami())).toEqual([]);
        expect(s.calls).toEqual([]);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says nothing of a plugin at the latest release", async () => {
    await inSession({ install: NPX, cached: "99.0.0", client: "claude-code", env: { CAVELON_PLUGIN_VERSION: "99.0.0" } }, async (s) => {
      expect(updateWarnings(await s.whoami())).toEqual([]);
    });
  });

  it("asks for cavelon init --update when this folder's skills are older than this cavelon", async () => {
    await inSession({ install: NPX, skills: "0.1.0" }, async (s) => {
      const warning = await firstOnly(s);
      expect(warning).toContain("The skills `cavelon init --agents` wrote in this solution folder are from cavelon 0.1.0.");
      expect(warning).toContain("Run `cavelon init --update` in it, and commit the result.");
      // Nothing to look up for npx without the plugin.
      expect(s.calls).toEqual([]);
    });
    await inSession({ install: NPX, skills: KIT_VERSION }, async (s) => {
      expect(updateWarnings(await s.whoami())).toEqual([]);
    });
  });

  it("says all of it in one warning", async () => {
    await inSession({ install: SCRIPT, cached: "99.0.0", client: "claude-code", skills: "0.1.0", env: { CAVELON_PLUGIN_VERSION: "0.1.0" } }, async (s) => {
      const warning = await firstOnly(s);
      expect(warning).toContain(`cavelon 99.0.0 is out; this is ${KIT_VERSION}. The Cavelon plugin is 0.1.0. The skills`);
      expect(warning).toContain(`Update cavelon with \`${UPDATE}\`. Update the plugin with ${CLAUDE}. Run \`cavelon init --update\` in it after updating cavelon`);
    });
  });

  it("rides on a failed first call too, beside the error", async () => {
    await inSession({ install: SCRIPT, cached: "99.0.0" }, async (s) => {
      const failed = await s.call("whoami", { no_such_argument: true });
      expect(failed.isError).toBe(true);
      const body = payload(failed);
      expect(body.error.code).toBe("unknown_argument");
      expect(updateWarnings(body)).toHaveLength(1);
      expect(updateWarnings(await s.whoami())).toEqual([]);
    });
  });

  it("looks the release up when nothing is cached, and keeps it for a day", async () => {
    await inSession({ install: SCRIPT }, async (s) => {
      expect(await firstOnly(s)).toContain("cavelon 99.0.0 is out");
      expect(s.calls).toEqual([RELEASES]);
    });
  });

  it.each([
    ["CAVELON_NO_UPDATE_CHECK=1", { env: { CAVELON_NO_UPDATE_CHECK: "1", CAVELON_PLUGIN_VERSION: "0.1.0" }, install: SCRIPT }],
    ["CI", { env: { CI: "true", CAVELON_PLUGIN_VERSION: "0.1.0" }, install: SCRIPT }],
    ["npx, which already runs the newest release", { install: NPX }],
    ["a build from a clone", { install: detectInstall({ executable: false, file: "/work/cavelon-dev-kit/cli", platform: "linux", env: {}, exists: () => false }), env: { CAVELON_PLUGIN_VERSION: "0.1.0" } }],
  ])("says nothing with %s, and looks nothing up", async (_, options: { env?: Record<string, string>; install: Install }) => {
    await inSession({ ...options, cached: "99.0.0", client: "claude-code", skills: options.install === NPX ? undefined : "0.1.0" }, async (s) => {
      expect(updateWarnings(await s.whoami())).toEqual([]);
      expect(updateWarnings(await s.whoami())).toEqual([]);
      expect(s.calls).toEqual([]);
    });
  });

  it("says nothing when this is the latest release", async () => {
    await inSession({ install: SCRIPT, cached: KIT_VERSION }, async (s) => {
      expect(updateWarnings(await s.whoami())).toEqual([]);
    });
  });

  it("never holds a tool call past the lookup's timeout, and stays silent when it fails", async () => {
    const hanging = ((_: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    await inSession({ install: SCRIPT, fetch: hanging }, async (s) => {
      const began = Date.now();
      const first = await s.whoami();
      expect(Date.now() - began).toBeLessThan(3000);
      expect(first.owner.email).toBe("ada@example.com");
      expect(updateWarnings(first)).toEqual([]);
      expect(updateWarnings(await s.whoami())).toEqual([]);
    });
  });
});
