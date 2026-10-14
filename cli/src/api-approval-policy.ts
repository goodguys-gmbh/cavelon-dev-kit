import type { CallArguments } from "./invoke.js";
import type { Operation } from "./openapi.js";

export type ApiApproval = "read" | "routine" | "person";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(body: unknown, allowed: readonly string[]): body is Record<string, unknown> {
  return object(body) && Object.keys(body).every(key => allowed.includes(key));
}

function optionalText(body: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every(key => body[key] === undefined || body[key] === null || typeof body[key] === "string");
}

/**
 * Only effects already covered by typed commands receive a lighter API gate.
 * A new field, parameter or instance guard can change that effect; absence of
 * a confirmation marker alone never establishes that a request is routine.
 * The caller still validates the exact request against the live OpenAPI.
 */
export function apiApproval(op: Operation, args: CallArguments): ApiApproval {
  if (op.confirmation || op.personOnly?.marked) return "person";
  if (op.readOnly) return "read";
  if (op.method !== "POST" || args.files?.length || args.bytes || Object.keys(args.headers ?? {}).length) return "person";
  const params = Object.keys(args.params ?? {});
  const onlyParams = (...names: string[]) => params.every(key => names.includes(key));
  const uuidParam = (name: string) => {
    const values = args.params?.[name];
    return values?.length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values[0]!);
  };
  const body = args.body;

  if (op.path === "/api/v1/harnesses" && onlyParams("Idempotency-Key") &&
      fields(body, ["slug", "name", "description"]) && typeof body.slug === "string" && typeof body.name === "string" &&
      optionalText(body, ["description"])) return "routine";

  if (op.path === "/api/v1/harnesses/{harness_id}/clone" && onlyParams("harness_id", "Idempotency-Key") && uuidParam("harness_id") &&
      fields(body, ["slug", "name", "description", "element_slug_suffix", "include_tests", "include_triggers"]) &&
      optionalText(body, ["slug", "name", "description", "element_slug_suffix"]) &&
      ["include_tests", "include_triggers"].every(key => body[key] === undefined || typeof body[key] === "boolean")) return "routine";

  // Preview stores an expiring plan, never imports it; tenant-wide/live effects
  // in that plan still need the separate import command's approval.
  if (op.path === "/api/v1/agent-graph/import/preview" && onlyParams() &&
      fields(body, ["package", "mode", "harness_id", "runtime_bindings", "include_tenant_wide"]) && object(body.package) &&
      (body.mode === undefined || body.mode === "overwrite" || body.mode === "replace") && optionalText(body, ["harness_id"]) &&
      (body.runtime_bindings === undefined || object(body.runtime_bindings) && Object.values(body.runtime_bindings).every(value => typeof value === "string")) &&
      (body.include_tenant_wide === undefined || typeof body.include_tenant_wide === "boolean")) return "read";

  // This is the same catalog-only boundary used by `db schema`, not query
  // execution: a saved query may be a write or require an end-user identity.
  if (op.path === "/api/v1/database-connectors/connections/{connection_id}/schema" && onlyParams("connection_id") && uuidParam("connection_id") &&
      (body === undefined || body === null || fields(body, ["schema"]) && optionalText(body, ["schema"]))) return "read";

  return "person";
}
