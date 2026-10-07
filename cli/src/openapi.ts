import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { OpenApiDoc } from "./contracts.js";
import { CavelonError, ExitCode, validationError } from "./errors.js";
import { cavelonCommand, fill } from "./printed.js";

/**
 * The instance's OpenAPI as a list of operations `cavelon api` can call, and
 * the validation of arguments against it. Nothing here knows a product
 * entity: everything comes from the document the instance publishes.
 */

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;

export interface Parameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

export interface Operation {
  operationId: string;
  /** The operationId without FastAPI's generated path-and-method suffix. */
  alias: string;
  method: string;
  path: string;
  tags: string[];
  summary?: string;
  description?: string;
  deprecated?: boolean;
  parameters: Parameter[];
  requestBody?: { required?: boolean; content: Record<string, { schema?: Record<string, unknown> }> };
  responses: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }> }>;
  readOnly: boolean;
  /**
   * `x-cavelon-person-only`: the instance keeps the operation for a person
   * (absent where an instance does not publish the marker), with
   * `x-cavelon-person-only-reason`.
   */
  personOnly?: { marked: boolean; reason?: string };
  /**
   * `x-cavelon-confirmation: required`: a personal access token sends the
   * change with a confirmation id the person's yes gets (change-confirmation.ts),
   * when `x-cavelon-confirmation-when` holds.
   */
  confirmation?: true;
  confirmationWhen?: string;
}

/**
 * FastAPI builds an operationId as `<function name><path with non-word
 * characters as _>_<method>`. The function name alone is what a person reads,
 * so it is accepted as a short form when it is unique.
 */
export function aliasOf(operationId: string, path: string, method: string): string {
  const suffix = `${path.replace(/\W/g, "_")}_${method.toLowerCase()}`;
  if (operationId.endsWith(suffix) && operationId.length > suffix.length) return operationId.slice(0, -suffix.length);
  return operationId;
}

const indexCache = new WeakMap<OpenApiDoc, Operation[]>();

export function operations(doc: OpenApiDoc): Operation[] {
  const cached = indexCache.get(doc);
  if (cached) return cached;
  const out: Operation[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const shared = ((item as { parameters?: Parameter[] }).parameters ?? []).map((p) => deref(doc, p) as Parameter);
    for (const method of METHODS) {
      const raw = (item as Record<string, unknown>)[method] as Record<string, unknown> | undefined;
      if (!raw) continue;
      const operationId = (raw.operationId as string | undefined) ?? `${method}_${path}`;
      const own = ((raw.parameters as Parameter[] | undefined) ?? []).map((p) => deref(doc, p) as Parameter);
      const byKey = new Map<string, Parameter>();
      for (const p of [...shared, ...own]) byKey.set(`${p.in}:${p.name}`, p);
      out.push({
        operationId,
        alias: aliasOf(operationId, path, method),
        method: method.toUpperCase(),
        path,
        tags: (raw.tags as string[] | undefined) ?? [],
        summary: raw.summary as string | undefined,
        description: raw.description as string | undefined,
        deprecated: raw.deprecated as boolean | undefined,
        parameters: [...byKey.values()],
        requestBody: raw.requestBody ? (deref(doc, raw.requestBody) as Operation["requestBody"]) : undefined,
        responses: (raw.responses as Operation["responses"]) ?? {},
        readOnly: method === "get" || method === "head" || method === "options",
        personOnly: personOnlyOf(raw),
        ...confirmationOf(raw),
      });
    }
  }
  indexCache.set(doc, out);
  return out;
}

function personOnlyOf(raw: Record<string, unknown>): Operation["personOnly"] {
  if (!("x-cavelon-person-only" in raw)) return undefined;
  const reason = raw["x-cavelon-person-only-reason"];
  return {
    marked: raw["x-cavelon-person-only"] === true,
    ...(typeof reason === "string" && reason.trim() ? { reason: reason.trim() } : {}),
  };
}

function confirmationOf(raw: Record<string, unknown>): Pick<Operation, "confirmation" | "confirmationWhen"> {
  if (raw["x-cavelon-confirmation"] !== "required") return {};
  const when = raw["x-cavelon-confirmation-when"];
  return { confirmation: true, ...(typeof when === "string" && when.trim() ? { confirmationWhen: when.trim() } : {}) };
}

export function deref(doc: OpenApiDoc, value: unknown): unknown {
  let current = value as { $ref?: string };
  for (let i = 0; i < 10 && current && typeof current === "object" && typeof current.$ref === "string"; i++) {
    const ref = current.$ref;
    if (!ref.startsWith("#/")) break;
    current = ref
      .slice(2)
      .split("/")
      .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], doc) as {
      $ref?: string;
    };
  }
  return current;
}

export function findOperation(doc: OpenApiDoc, name: string): Operation {
  const all = operations(doc);
  const exact = all.find((o) => o.operationId === name);
  if (exact) return exact;
  const byAlias = all.filter((o) => o.alias === name);
  if (byAlias.length === 1) return byAlias[0]!;
  if (byAlias.length > 1) {
    throw new CavelonError(ExitCode.usage, {
      code: "operation_ambiguous",
      message: `"${name}" names ${byAlias.length} operations.`,
      hint: `Use the full operationId: ${byAlias.map((o) => o.operationId).join(", ")}`,
    });
  }
  // A name as people and other tools spell it: createTenant, create-tenant or CREATE_TENANT for create_tenant.
  const wanted = looseName(name);
  const loose = all.filter((o) => looseName(o.alias) === wanted || looseName(o.operationId) === wanted);
  if (loose.length === 1) return loose[0]!;
  const needle = name.toLowerCase();
  const similar = [
    ...loose,
    ...all.filter(
      (o) =>
        !loose.includes(o) &&
        (o.alias.toLowerCase().includes(needle) || needle.includes(o.alias.toLowerCase()) || looselyContains(looseName(o.alias), wanted)),
    ),
  ]
    .slice(0, 5)
    .map((o) => o.alias);
  throw new CavelonError(ExitCode.usage, {
    code: "operation_not_found",
    message: `This instance publishes no operation "${name}".`,
    hint: similar.length
      ? `Did you mean: ${similar.join(", ")}? (\`${cavelonCommand("api", "list", "--search", fill("text"))}\`)`
      : `Find it with \`${cavelonCommand("api", "list", "--search", fill("text"))}\`.`,
  });
}

/** A name without case, underscores or dashes, for a loose match. */
function looseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Whether one loose name holds the other, for names long enough to mean something. */
function looselyContains(a: string, b: string): boolean {
  return a.length > 3 && b.length > 3 && (a.includes(b) || b.includes(a));
}

/** Whether an operation was found by a looser spelling than its own names; the caller says which one it took. */
export function matchedLoosely(op: Operation, name: string): boolean {
  return name !== op.operationId && name !== op.alias;
}

/** The operation at a method and path template, for the workflow commands. */
export function operationAt(doc: OpenApiDoc, method: string, path: string): Operation | undefined {
  return operations(doc).find((o) => o.method === method.toUpperCase() && o.path === path);
}

/**
 * The operation behind a path an instance publishes with some parameters
 * already in place (`/api/v1/admin/feature-flags/{tenant_id}/ORCHESTRATION_PARALLEL_FANOUT_ENABLED`
 * for `/api/v1/admin/feature-flags/{tenant_id}/{flag_key}`), and the values
 * those literal segments give its parameters. An exact match fixes none.
 */
export function operationForPath(doc: OpenApiDoc, method: string, path: string): { op: Operation; fixed: Record<string, string[]> } | undefined {
  const exact = operationAt(doc, method, path);
  if (exact) return { op: exact, fixed: {} };
  const wanted = path.split("/");
  for (const op of operations(doc)) {
    if (op.method !== method.toUpperCase()) continue;
    const parts = op.path.split("/");
    if (parts.length !== wanted.length) continue;
    const fixed: Record<string, string[]> = {};
    const fits = parts.every((part, i) => {
      const given = wanted[i]!;
      if (part === given) return true;
      const isParam = part.startsWith("{") && part.endsWith("}");
      if (!isParam || !given || given.includes("{") || given.includes("}")) return false;
      fixed[part.slice(1, -1)] = [decodeURIComponent(given)];
      return true;
    });
    if (fits) return { op, fixed };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ajvCache = new WeakMap<OpenApiDoc, Ajv2020>();
const validatorCache = new WeakMap<object, ValidateFunction>();
const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;

function ajvFor(doc: OpenApiDoc): Ajv2020 {
  let ajv = ajvCache.get(doc);
  if (!ajv) {
    ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false, validateFormats: true });
    (addFormats as unknown as (a: Ajv2020) => void)(ajv);
    ajv.addSchema({ $id: "cavelon:openapi", components: doc.components ?? {} });
    ajvCache.set(doc, ajv);
  }
  return ajv;
}

function rebase(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(rebase);
  if (schema && typeof schema === "object") {
    return Object.fromEntries(
      Object.entries(schema).map(([k, v]) => [k, k === "$ref" && typeof v === "string" && v.startsWith("#/") ? `cavelon:openapi${v}` : rebase(v)]),
    );
  }
  return schema;
}

export function validatorFor(doc: OpenApiDoc, schema: Record<string, unknown>): ValidateFunction {
  let validate = validatorCache.get(schema);
  if (!validate) {
    validate = ajvFor(doc).compile(rebase(schema) as Record<string, unknown>);
    validatorCache.set(schema, validate);
  }
  return validate;
}

export function schemaErrors(doc: OpenApiDoc, schema: Record<string, unknown>, value: unknown): string[] {
  const validate = validatorFor(doc, schema);
  if (validate(value)) return [];
  return (validate.errors ?? []).slice(0, 10).map((e) => {
    const where = e.instancePath || "(body)";
    const extra = e.keyword === "additionalProperties" ? ` "${(e.params as { additionalProperty?: string }).additionalProperty}"` : "";
    return `${where} ${e.message ?? "is invalid"}${extra}`;
  });
}

export function jsonBodySchema(op: Operation): Record<string, unknown> | undefined {
  return op.requestBody?.content?.["application/json"]?.schema;
}

export function validateBody(doc: OpenApiDoc, op: Operation, body: unknown): void {
  const schema = jsonBodySchema(op);
  if (!schema) return;
  const errors = schemaErrors(doc, schema, body);
  if (errors.length) {
    throw validationError(`The body does not match ${op.alias}'s schema: ${errors.join("; ")}`, errors, `See \`${cavelonCommand("api", "describe", op.alias)}\`.`);
  }
}

/**
 * The fields a body sets that the instance marks as holding a secret value
 * (`x-cavelon-secret: true`, published with `writeOnly`), as paths such as
 * `credentials.api_key` or `headers[0].value`. It follows the body, not the
 * schema, so only fields that are present count, and one set to null (which
 * clears it) does not. A secret typed into a free-form map has no marker and
 * cannot be found. The walk is bounded: a schema may refer to itself.
 */
export function secretFields(doc: OpenApiDoc, schema: unknown, body: unknown): string[] {
  const found = new Set<string>();
  let budget = 10_000;
  const list = (value: unknown) => (Array.isArray(value) ? (value as unknown[]) : []);
  const walk = (raw: unknown, value: unknown, where: string, depth: number): void => {
    if (value === undefined || value === null || depth > 64 || --budget < 0) return;
    const node = deref(doc, raw);
    if (!node || typeof node !== "object") return;
    const s = node as Record<string, unknown>;
    if (s["x-cavelon-secret"] === true) {
      found.add(where || "(body)");
      return;
    }
    for (const key of ["allOf", "anyOf", "oneOf"]) for (const sub of list(s[key])) walk(sub, value, where, depth + 1);
    if (Array.isArray(value)) {
      const prefix = list(s.prefixItems);
      value.forEach((item, i) => walk(prefix[i] ?? s.items, item, `${where}[${i}]`, depth + 1));
    } else if (typeof value === "object") {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const patterns = Object.entries((s.patternProperties ?? {}) as Record<string, unknown>);
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const named = Object.hasOwn(props, key) ? [props[key]] : patterns.filter(([pattern]) => matches(pattern, key)).map(([, sub]) => sub);
        const subs = named.length ? named : [s.additionalProperties];
        for (const sub of subs) walk(sub, item, where ? `${where}.${key}` : key, depth + 1);
      }
    }
  };
  walk(schema, body, "", 0);
  return [...found];
}

/**
 * Every field of a schema the instance marks as a secret value, as paths
 * (`credentials.api_key`, `headers[].value`, `vault.*` for any key of a map),
 * for `api describe`. Bounded like `secretFields`: a schema may refer to itself.
 */
export function secretPaths(doc: OpenApiDoc, schema: unknown): string[] {
  const found = new Set<string>();
  let budget = 2_000;
  const list = (value: unknown) => (Array.isArray(value) ? (value as unknown[]) : []);
  const walk = (raw: unknown, where: string, depth: number): void => {
    if (depth > 6 || --budget < 0) return;
    const node = deref(doc, raw);
    if (!node || typeof node !== "object") return;
    const s = node as Record<string, unknown>;
    if (s["x-cavelon-secret"] === true) {
      found.add(where || "(body)");
      return;
    }
    for (const key of ["allOf", "anyOf", "oneOf"]) for (const sub of list(s[key])) walk(sub, where, depth + 1);
    if (s.items) walk(s.items, `${where}[]`, depth + 1);
    for (const [key, sub] of Object.entries((s.properties ?? {}) as Record<string, unknown>)) walk(sub, where ? `${where}.${key}` : key, depth + 1);
    if (s.additionalProperties && typeof s.additionalProperties === "object") walk(s.additionalProperties, where ? `${where}.*` : "*", depth + 1);
  };
  walk(schema, "", 0);
  return [...found];
}

function matches(pattern: string, key: string): boolean {
  try {
    return new RegExp(pattern, "u").test(key);
  } catch {
    return false;
  }
}

/** Convert a text argument to the parameter's schema type. */
export function coerceParameter(param: Parameter, raw: string): unknown {
  const types = schemaTypes(param.schema);
  if (types.includes("integer") && /^-?\d+$/.test(raw)) return Number(raw);
  if (types.includes("number") && raw.trim() !== "" && !Number.isNaN(Number(raw))) return Number(raw);
  if (types.includes("boolean") && (raw === "true" || raw === "false")) return raw === "true";
  return raw;
}

export function schemaTypes(schema: Record<string, unknown> | undefined): string[] {
  if (!schema) return [];
  const out: string[] = [];
  if (typeof schema.type === "string") out.push(schema.type);
  if (Array.isArray(schema.type)) out.push(...(schema.type as string[]));
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    for (const sub of (schema[key] as Array<Record<string, unknown>> | undefined) ?? []) out.push(...schemaTypes(sub));
  }
  return out;
}

export function isArrayParameter(param: Parameter): boolean {
  return schemaTypes(param.schema).includes("array");
}

/**
 * The object schema of an array field's items, through `$ref` and a
 * nullable `anyOf`; undefined when the field is no array of objects.
 */
function arrayItemObject(doc: OpenApiDoc, field: Record<string, unknown>): Record<string, unknown> | undefined {
  const options = [field, ...((field.anyOf ?? field.oneOf ?? []) as Array<Record<string, unknown>>).map((b) => deref(doc, b) as Record<string, unknown>)];
  const array = options.find((o) => o?.type === "array" && o.items);
  if (!array) return undefined;
  const items = deref(doc, array.items) as Record<string, unknown> | undefined;
  return items && typeof items.properties === "object" ? (array.items as Record<string, unknown>) : undefined;
}

/**
 * A compact description of a schema for `api describe`: top-level fields and
 * types, and for a field that is an array of objects, its items' fields under
 * `<field>[]` (a few levels deep), so a body such as `updates: [{id, …}]` shows
 * what each item needs.
 */
export function describeSchema(doc: OpenApiDoc, schema: Record<string, unknown> | undefined, depth = 0): unknown {
  if (!schema) return null;
  const resolved = deref(doc, schema) as Record<string, unknown>;
  const props = resolved.properties as Record<string, Record<string, unknown>> | undefined;
  const ref = typeof schema.$ref === "string" ? schema.$ref.split("/").pop() : undefined;
  if (!props) {
    if (resolved.type === "array" && resolved.items) return { type: "array", items: describeSchema(doc, resolved.items as Record<string, unknown>, depth + 1) };
    return { ...(ref ? { name: ref } : {}), type: resolved.type ?? (schemaTypes(resolved).join("|") || "any") };
  }
  const required = new Set((resolved.required as string[] | undefined) ?? []);
  const fields: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(props)) {
    const sub = deref(doc, p) as Record<string, unknown>;
    const subRef = typeof p.$ref === "string" ? p.$ref.split("/").pop() : undefined;
    const items = arrayItemObject(doc, sub);
    const itemName = items && typeof items.$ref === "string" ? items.$ref.split("/").pop() : undefined;
    const type = subRef ?? (items ? `array of ${itemName ?? "object"}` : schemaTypes(sub).filter((t) => t !== "null").join("|") || "object");
    const parts = [type];
    if (required.has(name)) parts.push("required");
    if (Array.isArray(sub.enum)) parts.push(`one of ${(sub.enum as unknown[]).join(", ")}`);
    if (sub.default !== undefined) parts.push(`default ${JSON.stringify(sub.default)}`);
    if (secretPaths(doc, p).includes("(body)")) parts.push("secret value (x-cavelon-secret): a person enters it");
    fields[name] = parts.join(", ");
    // Three levels are enough for a body, and stop a schema that refers to itself.
    if (items && depth < 3) fields[`${name}[]`] = describeSchema(doc, items, depth + 1);
  }
  return { ...(ref ? { name: ref } : {}), type: "object", fields };
}
