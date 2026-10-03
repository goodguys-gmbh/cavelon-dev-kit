import { describe, expect, it } from "vitest";
import { keptForPerson } from "../src/commands/api.js";
import type { Operation } from "../src/openapi.js";

function op(method: string, path: string): Operation {
  return { operationId: `${method} ${path}`, alias: `${method} ${path}`, method, path, tags: [], parameters: [], responses: {}, readOnly: method === "GET" };
}

describe("the operations api keeps for a person over MCP", () => {
  it.each([
    ["PUT", "/api/v1/secrets/{name}", "changes a secret"],
    ["DELETE", "/api/v1/secrets/{name}", "changes a secret"],
    ["POST", "/api/v1/webhooks/{id}/rotate-secret", "changes a secret"],
    ["POST", "/api/v1/personal-access-tokens", "creates or revokes a credential"],
    ["DELETE", "/api/v1/tenants/{tenant_id}/personal-access-tokens/{token_id}", "creates or revokes a credential"],
    ["POST", "/api/v1/tenants/{tenant_id}/api-keys", "creates or revokes a credential"],
    ["DELETE", "/api/v1/tenants/{tenant_id}/api-keys/{key_id}", "creates or revokes a credential"],
    ["POST", "/api/v1/auth/password", "creates or revokes a credential"],
    ["POST", "/api/v1/approvals/{approval_id}/decide", "decides an approval"],
    ["POST", "/api/v1/approvals/{approval_id}/cancel", "decides an approval"],
    ["POST", "/api/v1/runs/{run_id}/approve", "decides an approval"],
  ])("%s %s %s", (method, path, does) => {
    expect(keptForPerson(op(method, path))?.does).toBe(does);
  });

  it.each([
    ["GET", "/api/v1/secrets"],
    ["GET", "/api/v1/tenants/{tenant_id}/api-keys"],
    ["PUT", "/api/v1/variables/{name}"],
    ["POST", "/api/v1/knowledge-bases/{kb_id}/documents/upload"],
    ["PUT", "/api/v1/triggers/{trigger_id}/execution-identity"],
    ["POST", "/api/v1/harnesses"],
    // A path parameter's name is not a word of the path.
    ["PATCH", "/api/v1/things/{secret_ref}"],
  ])("leaves %s %s to confirm", (method, path) => {
    expect(keptForPerson(op(method, path))).toBeUndefined();
  });
});
