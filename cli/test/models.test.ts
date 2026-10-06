import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { endpointOf } from "../src/commands/models.js";
import { modelRow, startFakeServer, type FakeModel, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * `cavelon models list` and `models set-limit`: a
 * Model Registry row is shown with its endpoint and max_concurrent_requests and
 * never with a key; the limit is changed only with --confirm, after showing the
 * old and new value, and a row without a base_url is refused before sending.
 */

let server: FakeServer;
let sb: Sandbox;
let tenant: string;

/** Secret material a row may carry: in its URL, and as the masked key the instance lists. */
const URL_PASSWORD = "hunter2-url-password";
const URL_KEY = "sk-live-in-the-query";
const MASKED_KEY = "sk-...9xyz";

function addModel(fields: Partial<FakeModel>): FakeModel {
  const row = modelRow(tenant, fields);
  server.state.models.push(row);
  return row;
}

const patches = () => server.state.requests.filter((r) => r.method === "PATCH" && r.path.startsWith("/api/v1/model-registry/"));

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
});
afterEach(() => {
  server.state.models = [];
  server.state.requests = [];
  server.state.serveDocs = true;
});
afterAll(async () => {
  sb.cleanup();
  await server.close();
});

describe("models list", () => {
  it("shows each row's endpoint and limit, and which rows share an endpoint", async () => {
    addModel({ model_id: "llama-70b", display_name: "Llama 70B", base_url: "http://vllm.internal:8000/v1/", max_concurrent_requests: 4 });
    addModel({ model_id: "llama-8b", display_name: "Llama 8B", base_url: "http://vllm.internal:8000/v1" });
    addModel({ model_id: "gpt-4.1" });
    const result = await cli(sb, ["models", "list"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/MODEL_ID\s+PROVIDER\s+ENDPOINT\s+MAX_CONCURRENT_REQUESTS\s+ACTIVE/);
    expect(result.stdout).toMatch(/llama-70b\s+openai\s+http:\/\/vllm\.internal:8000\/v1\s+4\s+yes/);
    expect(result.stdout).toMatch(/llama-8b\s+openai\s+http:\/\/vllm\.internal:8000\/v1\s+none\s+yes/);
    expect(result.stdout).toMatch(/gpt-4\.1\s+openai\s+\(platform route\)\s+none\s+yes/);
    expect(result.stdout).toMatch(/Rows with the same endpoint share one max_concurrent_requests count\. Change it with: cavelon models set-limit <model_id> <n\|none>/);
    expect(result.stdout).toMatch(/Plan it for a self-hosted endpoint: cavelon docs get tutorials\/plan-model-capacity/);

    const json = (await cli(sb, ["models", "list", "--json"])).json<{ items: Array<Record<string, unknown>>; total: number }>();
    expect(json.total).toBe(3);
    expect(json.items[0]).toMatchObject({ model_id: "llama-70b", endpoint: "http://vllm.internal:8000/v1", max_concurrent_requests: 4, shares_endpoint_with: ["llama-8b"] });
    expect(json.items[2]).toMatchObject({ model_id: "gpt-4.1", endpoint: null, max_concurrent_requests: null });
    expect(json.items[2]).not.toHaveProperty("shares_endpoint_with");
  });

  it("never shows a key or a secret, not even one in the base_url", async () => {
    addModel({
      model_id: "private-llm",
      base_url: `https://ops:${URL_PASSWORD}@llm.example.com:8443/v1/?api_key=${URL_KEY}#${URL_KEY}`,
      has_api_key: true,
      api_key_type: "direct",
      api_key_masked: MASKED_KEY,
      request_defaults: { provider: { order: ["a"] } },
      max_concurrent_requests: 2,
    });
    addModel({ model_id: "by-ref", base_url: "http://vllm:8000/v1", has_api_key: true, api_key_type: "secret_ref", api_key_masked: "{{secret:vllm_key}}" });
    for (const args of [["models", "list"], ["models", "list", "--json"], ["models", "set-limit", "private-llm", "3"], ["models", "set-limit", "private-llm", "3", "--json"]]) {
      const result = await cli(sb, args);
      expect(result.code, result.stderr).toBe(0);
      const all = result.stdout + result.stderr;
      for (const secret of [URL_PASSWORD, URL_KEY, MASKED_KEY, "ops:", "api_key_masked", "vllm_key"]) expect(all, `${args.join(" ")}: ${secret}`).not.toContain(secret);
    }
    const json = (await cli(sb, ["models", "list", "--json"])).json<{ items: Array<Record<string, unknown>> }>();
    expect(json.items[0]).toMatchObject({ endpoint: "https://llm.example.com:8443/v1", api_key_type: "direct" });
    expect(json.items[1]).toMatchObject({ api_key_type: "secret_ref" });
  });

  it("an empty registry says so", async () => {
    const result = await cli(sb, ["models", "list"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/has no rows/);
  });

  it("keeps an endpoint to scheme, host, port and path", () => {
    expect(endpointOf("https://u:p@h.example:8443/a/b//?k=v#f")).toBe("https://h.example:8443/a/b");
    expect(endpointOf("  ")).toBeNull();
    expect(endpointOf(null)).toBeNull();
    expect(endpointOf("not a url with sk-123")).toBe("(not a URL)");
  });
});

describe("models set-limit", () => {
  it("shows the old and new value and changes nothing without --confirm", async () => {
    const row = addModel({ model_id: "llama-70b", base_url: "http://vllm.internal:8000/v1", max_concurrent_requests: 4 });
    addModel({ model_id: "llama-8b", base_url: "http://vllm.internal:8000/v1" });
    const result = await cli(sb, ["models", "set-limit", "llama-70b", "8"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      "Model llama-70b (http://vllm.internal:8000/v1): max_concurrent_requests 4 → 8. It shares the count with llama-8b (same endpoint).\n" +
        `acts on: ${server.url}, tenant Acme (acme, ${tenant}) from \`cavelon use\`, tenant mode\n` +
        "Nothing was changed. Change it with: cavelon models set-limit llama-70b 8 --confirm\n",
    );
    expect(patches()).toEqual([]);
    expect(row.max_concurrent_requests).toBe(4);
    const json = (await cli(sb, ["models", "set-limit", "llama-70b", "8", "--json"])).json();
    expect(json).toMatchObject({ previous: 4, limit: 8, changed: false, sent: false, confirm: "cavelon models set-limit llama-70b 8 --confirm" });
  });

  it("with --confirm sends only the field, and says what changed; none clears it", async () => {
    const row = addModel({ model_id: "llama-70b", base_url: "http://vllm.internal:8000/v1", max_concurrent_requests: 4 });
    const changed = await cli(sb, ["models", "set-limit", "llama-70b", "8", "--confirm"]);
    expect(changed.code, changed.stderr).toBe(0);
    expect(changed.stdout).toBe("Changed Model llama-70b (http://vllm.internal:8000/v1): max_concurrent_requests 4 → 8.\n");
    expect(patches().map((r) => [r.path, r.body])).toEqual([[`/api/v1/model-registry/${row.id}`, { max_concurrent_requests: 8 }]]);
    expect(row.max_concurrent_requests).toBe(8);

    // By its id too; the same value again sends nothing.
    const same = await cli(sb, ["models", "set-limit", row.id, "8", "--confirm", "--json"]);
    expect(same.json()).toMatchObject({ previous: 8, limit: 8, changed: false, sent: false });
    expect(patches()).toHaveLength(1);

    const cleared = await cli(sb, ["models", "set-limit", "llama-70b", "none", "--confirm", "--json"]);
    expect(cleared.code).toBe(0);
    expect(cleared.json()).toMatchObject({ previous: 8, limit: null, changed: true, sent: true });
    expect(patches().at(-1)!.body).toEqual({ max_concurrent_requests: null });
    expect(row.max_concurrent_requests).toBeNull();
  });

  it("refuses a row without a base_url before sending (exit 3)", async () => {
    addModel({ model_id: "gpt-4.1", display_name: "GPT-4.1" });
    for (const args of [["models", "set-limit", "gpt-4.1", "4"], ["models", "set-limit", "GPT-4.1", "4", "--confirm"]]) {
      const result = await cli(sb, [...args, "--json"]);
      expect(result.code).toBe(3);
      const { error } = result.json<{ error: { code: string; message: string; hint: string; details: { sent: boolean } } }>();
      expect(error.code).toBe("model_endpoint_limit_without_base_url");
      expect(error.message).toBe('Model "gpt-4.1" has no base_url, so it takes no max_concurrent_requests; nothing was sent.');
      expect(error.hint).toMatch(/through the platform's routes, which have their own rate limits/);
      expect(error.details.sent).toBe(false);
    }
    expect(patches()).toEqual([]);
    // Clearing a limit it does not have is no change at all.
    expect((await cli(sb, ["models", "set-limit", "gpt-4.1", "none", "--confirm", "--json"])).json()).toMatchObject({ changed: false, sent: false });
    expect(patches()).toEqual([]);
  });

  it("checks the value before anything is sent: a whole number in the instance's bounds, or none", async () => {
    addModel({ model_id: "llama-70b", base_url: "http://vllm.internal:8000/v1" });
    const word = await cli(sb, ["models", "set-limit", "llama-70b", "many", "--confirm"]);
    expect(word.code).toBe(2);
    expect(word.stderr).toMatch(/<limit> must be a whole number of requests at once, or none to clear it; got "many"/);
    // The bounds come from the instance's ModelUpdateRequest schema.
    for (const value of ["0", "100001"]) {
      const out = await cli(sb, ["models", "set-limit", "llama-70b", value, "--confirm", "--json"]);
      expect(out.code, value).toBe(3);
      expect(out.json<{ error: { code: string } }>().error.code).toBe("validation_failed");
    }
    expect(patches()).toEqual([]);
  });

  it("names the rows when the model is unknown or ambiguous", async () => {
    addModel({ model_id: "a", display_name: "Llama" });
    addModel({ model_id: "b", display_name: "llama" });
    const unknown = await cli(sb, ["models", "set-limit", "nope", "4", "--json"]);
    expect(unknown.code).toBe(1);
    expect(unknown.json<{ error: { code: string } }>().error.code).toBe("model_not_found");
    const ambiguous = await cli(sb, ["models", "set-limit", "Llama", "4"]);
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.stderr).toMatch(/Several Model Registry rows are called "Llama": a, b\./);
  });

  it("is a changing, destructive command; models list is read-only", async () => {
    const listed = (await cli(sb, ["commands", "--json"])).json<{ items: Array<{ command: string; read_only: boolean; destructive: boolean; mcp_tool: string | null }> }>();
    const byName = Object.fromEntries(listed.items.map((c) => [c.command, c]));
    expect(byName["models list"]).toMatchObject({ read_only: true, destructive: false, mcp_tool: "models_list" });
    expect(byName["models set-limit"]).toMatchObject({ read_only: false, destructive: true, mcp_tool: "models_set_limit" });
  });
});
