import { promises as fs } from "node:fs";
import path from "node:path";
import type { Context } from "./command.js";
import type { OpenApiDoc } from "./contracts.js";
import { CavelonError, ExitCode, validationError } from "./errors.js";
import { bodyBytes, type ApiClient, type QueryValue } from "./http.js";
import { coerceParameter, isArrayParameter, operationAt, validateBody, type Operation } from "./openapi.js";

/**
 * Call one operation the instance publishes. `cavelon api` comes here with
 * whatever the user named; the workflow commands come here with the few
 * stable operations they wrap, so both get the same checks against the
 * instance's own OpenAPI.
 */

export interface CallArguments {
  /** Values by parameter name, as text; repeated for array parameters. */
  params?: Record<string, string[]>;
  body?: unknown;
  files?: Array<{ field: string; path: string }>;
  /** A raw body (application/octet-stream), sent by the caller itself. */
  bytes?: Uint8Array;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Platform calls send no tenant. */
  sendTenant?: boolean;
}

export interface CallResult {
  status: number;
  contentType: string;
  data: unknown;
  bytes?: Uint8Array;
}

/** The OpenAPI, or undefined (with a warning) when the instance does not serve it. */
export async function openapiOrWarn(ctx: Context): Promise<OpenApiDoc | undefined> {
  try {
    return await (await ctx.contracts()).openapi();
  } catch (error) {
    if (error instanceof CavelonError && error.code === "openapi_unavailable") {
      ctx.warn(`${error.message} Arguments are not checked before sending.`);
      return undefined;
    }
    throw error;
  }
}

/** Fill a path template, check required parameters, split the rest into query and headers. */
export function buildRequest(op: Operation, args: CallArguments): { path: string; query: Record<string, QueryValue>; headers: Record<string, string> } {
  const given = { ...(args.params ?? {}) };
  const query: Record<string, QueryValue> = {};
  const headers: Record<string, string> = { ...(args.headers ?? {}) };
  const sentHeaders = new Set(Object.keys(headers).map((h) => h.toLowerCase()));
  let filled = op.path;
  const missing: string[] = [];
  for (const param of op.parameters) {
    const values = given[param.name];
    delete given[param.name];
    if (!values || values.length === 0) {
      if (param.required && !(param.in === "header" && sentHeaders.has(param.name.toLowerCase()))) missing.push(`${param.name} (${param.in})`);
      continue;
    }
    if (param.in === "path") {
      filled = filled.replace(`{${param.name}}`, encodeURIComponent(values[values.length - 1]!));
    } else if (param.in === "query") {
      query[param.name] = isArrayParameter(param)
        ? values.map((v) => coerceParameter(param, v) as string)
        : (coerceParameter(param, values[values.length - 1]!) as string);
    } else if (param.in === "header") {
      const name = param.name.toLowerCase();
      if (name === "authorization" || name === "x-tenant-id" || name === "cookie") continue;
      headers[param.name] = values[values.length - 1]!;
    }
  }
  const unknown = Object.keys(given);
  if (unknown.length) {
    const known = op.parameters.map((p) => p.name);
    throw validationError(
      `${op.alias} has no parameter ${unknown.map((u) => `"${u}"`).join(", ")}.`,
      { unknown, known },
      known.length ? `Its parameters: ${known.join(", ")}.` : `${op.alias} takes no parameters.`,
    );
  }
  if (missing.length) {
    throw validationError(`${op.alias} needs ${missing.join(", ")}.`, { missing }, "Pass each as -p name=value.");
  }
  if (op.requestBody?.required && args.body === undefined && !args.files?.length && !args.bytes) {
    throw validationError(`${op.alias} needs a request body.`, undefined, "Pass it with --json '<body>' (or @file, or - for stdin).");
  }
  return { path: filled, query, headers };
}

function isMultipart(op: Operation, args: CallArguments): boolean {
  const contentTypes = Object.keys(op.requestBody?.content ?? {});
  return (contentTypes.includes("multipart/form-data") && !contentTypes.includes("application/json")) || Boolean(args.files?.length);
}

/** What callOperation would send, checked as it checks it, without sending anything or reading a file. */
export function previewRequest(doc: OpenApiDoc | undefined, op: Operation, args: CallArguments) {
  const { path: target, query, headers } = buildRequest(op, args);
  if (!isMultipart(op, args) && args.body !== undefined && doc) validateBody(doc, op, args.body);
  return { method: op.method, path: target, query, headers, body: args.body ?? null };
}

export async function callOperation(ctx: Context, client: ApiClient, doc: OpenApiDoc | undefined, op: Operation, args: CallArguments): Promise<CallResult> {
  const { path: target, query, headers } = buildRequest(op, args);
  let form: FormData | undefined;
  let json: unknown;
  if (isMultipart(op, args)) {
    form = new FormData();
    if (args.body && typeof args.body === "object") {
      for (const [key, value] of Object.entries(args.body as Record<string, unknown>)) {
        if (value === undefined || value === null) continue;
        form.append(key, typeof value === "string" ? value : JSON.stringify(value));
      }
    }
    for (const file of args.files ?? []) {
      const content = await fs.readFile(file.path);
      form.append(file.field, new Blob([content]), path.basename(file.path));
    }
  } else if (args.body !== undefined) {
    if (doc) validateBody(doc, op, args.body);
    json = args.body;
  }
  const signal = AbortSignal.timeout(args.timeoutMs ?? (Number(ctx.io.env.CAVELON_HTTP_TIMEOUT_MS) || 30_000));
  const response = await client.fetchRaw(op.method, target, { query, headers, json, form, sendTenant: args.sendTenant, signal });
  const contentType = response.headers.get("content-type") ?? "";
  const bytes = await bodyBytes(response, client.resolve(target), signal);
  const isText = /json|text|xml|yaml|markdown|event-stream/.test(contentType) || bytes.length === 0;
  const text = isText ? new TextDecoder().decode(bytes) : "";
  let data: unknown = text;
  if (contentType.includes("json") && text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) throw await client.refusal(response.status, data, `${op.method} ${new URL(client.resolve(target)).pathname}`, response.headers);
  return { status: response.status, contentType, data: isText ? (text ? data : null) : undefined, bytes: isText ? undefined : bytes };
}

/**
 * The stable operation a workflow command wraps, from the instance's OpenAPI.
 * When the instance does not publish the OpenAPI, a minimal description lets
 * the call go ahead unchecked; when it publishes one without this operation,
 * the instance does not offer the feature and the command says so.
 */
export async function workflowOperation(ctx: Context, method: string, pathTemplate: string, what: string): Promise<{ doc?: OpenApiDoc; op: Operation }> {
  const doc = await openapiOrWarn(ctx);
  if (doc) {
    const op = operationAt(doc, method, pathTemplate);
    if (!op) {
      throw new CavelonError(ExitCode.failure, {
        code: "operation_unavailable",
        message: `This instance does not offer ${what} (${method} ${pathTemplate} is not in its OpenAPI).`,
        hint: "The instance may be older than this feature; `cavelon status` shows its version.",
      });
    }
    return { doc, op };
  }
  const names = [...pathTemplate.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  return {
    op: {
      operationId: `${method} ${pathTemplate}`,
      alias: `${method} ${pathTemplate}`,
      method,
      path: pathTemplate,
      tags: [],
      parameters: names.map((name) => ({ name, in: "path" as const, required: true })),
      responses: {},
      readOnly: method === "GET",
    },
  };
}

/** Workflow helper: call a stable operation and return its JSON. */
export async function callStable<T>(
  ctx: Context,
  method: string,
  pathTemplate: string,
  what: string,
  args: CallArguments & { query?: Record<string, QueryValue> } = {},
): Promise<T> {
  const client = await ctx.client({ tenant: args.sendTenant !== false });
  const { doc, op } = await workflowOperation(ctx, method, pathTemplate, what);
  const params: Record<string, string[]> = { ...(args.params ?? {}) };
  for (const [key, value] of Object.entries(args.query ?? {})) {
    if (value === undefined || value === null) continue;
    params[key] = Array.isArray(value) ? value.map(String) : [String(value)];
  }
  // A parameter the instance does not declare is refused, never dropped: a
  // filter that silently disappears could widen what a command changes.
  if (doc) {
    const unknown = Object.keys(params).filter((key) => !op.parameters.some((p) => p.name === key));
    if (unknown.length) {
      throw new CavelonError(ExitCode.failure, {
        code: "operation_unavailable",
        message: `This instance's ${method} ${pathTemplate} does not take ${unknown.join(", ")}, so it cannot do this (${what}).`,
        hint: "The instance may be older than this feature; `cavelon status` shows its version.",
      });
    }
  } else {
    for (const key of Object.keys(args.query ?? {})) op.parameters.push({ name: key, in: "query" });
  }
  const result = await callOperation(ctx, client, doc, op, { ...args, params });
  return result.data as T;
}
