import { stringify } from "yaml";
import type { PackageSchema } from "./contracts.js";

/**
 * The shape the instance's export gives a package, worked out from the
 * published package schema: the order of its fields, the defaults it fills in,
 * and the persona file that shows every field it can hold. `pull` writes files
 * in this shape, and `fmt` brings hand-written files into it, so the first pull
 * after an apply rewrites only what really changed.
 */

type SchemaNode = Record<string, unknown>;

/**
 * The section whose every field `pull` and `init` write, the unset ones as
 * comments. The persona says who the assistant is; nothing else in a package
 * shows that it exists until one of its fields is set.
 */
export const PERSONA_SECTION = "persona";

export function toYaml(value: unknown): string {
  return stringify(value, { lineWidth: 0, aliasDuplicateObjects: false });
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** A node with its local `$ref` followed, a few levels deep. */
function resolve(schema: PackageSchema, node: unknown): SchemaNode | undefined {
  let current = isObject(node) ? node : undefined;
  for (let hops = 0; current && typeof current.$ref === "string" && hops < 10; hops++) {
    const ref = current.$ref as string;
    if (!ref.startsWith("#/$defs/")) return undefined;
    current = (schema.$defs as Record<string, SchemaNode> | undefined)?.[ref.slice("#/$defs/".length)];
  }
  return current;
}

/** The branches of an `anyOf`/`oneOf`, nested ones flattened, or the node itself. */
function branches(schema: PackageSchema, node: SchemaNode, depth = 0): SchemaNode[] {
  const list = (Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined) as unknown[] | undefined;
  if (!list || depth > 10) return [node];
  return list.map((b) => resolve(schema, b)).flatMap((b) => (b ? branches(schema, b, depth + 1) : []));
}

const propertiesOf = (node: SchemaNode | undefined) => (isObject(node?.properties) ? (node.properties as Record<string, unknown>) : undefined);

/** Whether a field's value is one its schema allows, as far as a `const` or an `enum` says. */
function allowed(schema: PackageSchema, node: unknown, value: unknown): boolean {
  const field = resolve(schema, node);
  if (!field) return true;
  if ("const" in field) return field.const === value;
  return Array.isArray(field.enum) ? field.enum.includes(value) : true;
}

/** Whether a value can be of this object shape: it holds the required fields, and every field it has the shape knows and allows. */
function fits(schema: PackageSchema, shape: SchemaNode, value: Record<string, unknown>): boolean {
  const props = propertiesOf(shape)!;
  const required = Array.isArray(shape.required) ? (shape.required as string[]) : [];
  return Object.entries(value).every(([k, v]) => k in props && allowed(schema, props[k], v)) && required.every((k) => k in value);
}

/** The object schema a value of this node follows, when one branch fits it. */
function objectBranch(schema: PackageSchema, node: SchemaNode, value: Record<string, unknown>): SchemaNode | undefined {
  const objects = branches(schema, node).filter((b) => propertiesOf(b));
  if (objects.length === 1) {
    // One shape that takes no other field: a value with another field is not of it, and stays as written.
    const only = objects[0]!;
    return only.additionalProperties === false && Object.keys(value).some((k) => !(k in propertiesOf(only)!)) ? undefined : only;
  }
  // Several object shapes (a step's criteria: judge criteria and assertions by `type`): the one the value fits.
  const fitting = objects.filter((b) => fits(schema, b, value));
  return fitting.length === 1 ? fitting[0] : undefined;
}

function arrayBranch(schema: PackageSchema, node: SchemaNode): SchemaNode | undefined {
  const arrays = branches(schema, node).filter((b) => b.type === "array");
  return arrays.length === 1 ? arrays[0] : undefined;
}

/** The fields of an object section, in the order the schema lists them; undefined for a list section. */
export function sectionFields(schema: PackageSchema | null, section: string): Record<string, SchemaNode> | undefined {
  if (!schema) return undefined;
  const node = resolve(schema, schema.properties?.[section]);
  if (!node) return undefined;
  const object = branches(schema, node).find((b) => propertiesOf(b));
  const props = propertiesOf(object);
  if (!props) return undefined;
  return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, resolve(schema, v) ?? {}]));
}

/** JSON with sorted keys: two values are the same when this is. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}

const requiredOf = (shape: SchemaNode | undefined) => new Set(Array.isArray(shape?.required) ? (shape.required as string[]) : []);

/** Whether a field may be null: it says so in its type, or one of its branches is the null type. */
function nullable(schema: PackageSchema, field: SchemaNode): boolean {
  if (field.type === "null" || (Array.isArray(field.type) && field.type.includes("null"))) return true;
  return branches(schema, field).some((b) => b.type === "null");
}

/**
 * The value the instance gives a field an entry leaves out. The schema's
 * default when it publishes one that is not null. A list or object field that
 * is neither required nor nullable and publishes no default has one the
 * schema cannot show (an empty list or object, made fresh for each entry);
 * the export writes it as `[]` or `{}`. With a position, an integer `…_order`
 * field of a list entry (sort_order, display_order, step_order) is the
 * entry's position counted from its default, which is what fmt writes: left
 * out, every entry imports with the default, and the instance orders entries
 * that all carry it its own way (test cases by name), not as written.
 */
function implicitDefault(schema: PackageSchema, key: string, sub: unknown, required: Set<string>, position: number | undefined): unknown {
  const field = resolve(schema, sub);
  if (!field || required.has(key)) return undefined;
  if (position !== undefined && key.endsWith("_order") && field.type === "integer" && typeof field.default === "number") return field.default + position;
  if (field.default !== undefined) return field.default === null ? undefined : field.default;
  if (nullable(schema, field)) return undefined;
  if (field.type === "array") return [];
  if (field.type === "object" || propertiesOf(field)) return {};
  return undefined;
}

/**
 * A value in the export's form: an object's fields in the schema's order
 * (fields the schema does not know after them, as written), and each field the
 * value leaves out set to the value the instance gives it (`implicitDefault`).
 * The instance fills the same values when it imports, so the value means the
 * same; only its spelling changes.
 */
export function exportForm(schema: PackageSchema, node: unknown, value: unknown, depth = 0, position?: number): unknown {
  const resolved = resolve(schema, node);
  if (!resolved || depth > 40) return value;
  if (Array.isArray(value)) {
    const array = arrayBranch(schema, resolved);
    return array?.items ? value.map((item, i) => exportForm(schema, array.items, item, depth + 1, i)) : value;
  }
  if (!isObject(value)) return value;
  const object = objectBranch(schema, resolved, value);
  const props = propertiesOf(object);
  if (!props) return value;
  const required = requiredOf(object);
  const out: Record<string, unknown> = {};
  for (const [key, sub] of Object.entries(props)) {
    if (key in value) out[key] = exportForm(schema, sub, value[key], depth + 1);
    else {
      const fallback = implicitDefault(schema, key, sub, required, position);
      if (fallback !== undefined) out[key] = structuredClone(fallback);
    }
  }
  for (const [key, inner] of Object.entries(value)) if (!(key in out) && !(key in props)) out[key] = inner;
  return out;
}

/** A whole package in the export's form, section by section; sections the schema does not know stay as they are. */
export function packageExportForm(schema: PackageSchema, pkg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [section, value] of Object.entries(pkg)) {
    const node = schema.properties?.[section];
    out[section] = node ? exportForm(schema, node, value) : value;
  }
  return out;
}

/**
 * A value without the object fields that are null: the export leaves an unset
 * field out where a hand-written file may spell it `null`, and the instance
 * reads both the same.
 */
export function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) if (inner !== null) out[key] = withoutNulls(inner);
  return out;
}

/** An empty value: what an all-commented file reads as, and what an export without the section means. */
function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (isObject(value) && Object.keys(value).length === 0);
}

/** Null, an empty list or an empty object: how the export spells a field nothing was set in. */
const isUnset = (value: unknown) => isEmpty(value) || (Array.isArray(value) && value.length === 0);

/**
 * A value with every field the instance reads as unset taken out, so two
 * spellings of one value compare equal: a field that is null, empty (`[]`,
 * `{}`) or holds the value the instance gives it when it is left out
 * (`implicitDefault`), unless it is required. The export writes such fields
 * out (`memory_config: {}`, `tags: []`, `max_output_tokens: null`) where a
 * hand-written or formatted file leaves them out; both import the same.
 */
export function settledForm(schema: PackageSchema, node: unknown, value: unknown, depth = 0): unknown {
  const resolved = resolve(schema, node);
  if (!resolved || depth > 40) return withoutNulls(value);
  if (Array.isArray(value)) {
    const array = arrayBranch(schema, resolved);
    return array?.items ? value.map((item) => settledForm(schema, array.items, item, depth + 1)) : withoutNulls(value);
  }
  if (!isObject(value)) return value;
  const object = objectBranch(schema, resolved, value);
  const props = propertiesOf(object);
  if (!props) return withoutNulls(value);
  const required = requiredOf(object);
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (!(key in props)) {
      if (inner !== null) out[key] = withoutNulls(inner);
      continue;
    }
    const settled = settledForm(schema, props[key], inner, depth + 1);
    if (!required.has(key)) {
      // An order field left out imports as its default, not as the position fmt writes.
      const fallback = implicitDefault(schema, key, props[key], required, undefined);
      if (isUnset(settled) && (fallback === undefined || isUnset(fallback))) continue;
      if (fallback !== undefined && canonical(settled) === canonical(settledForm(schema, props[key], fallback, depth + 1))) continue;
    }
    out[key] = settled;
  }
  return out;
}

/** Whether two values of a section say the same, with null fields and an empty persona counted as unset. */
export function sameSectionValue(section: string, a: unknown, b: unknown, schema: PackageSchema | null = null): boolean {
  const node = schema?.properties?.[section];
  const left = schema && node ? settledForm(schema, node, a) : withoutNulls(a);
  const right = schema && node ? settledForm(schema, node, b) : withoutNulls(b);
  if (section === PERSONA_SECTION && isEmpty(left) && isEmpty(right)) return true;
  return canonical(left) === canonical(right);
}

/** Whether two entries of a list section (one file each) say the same, as `sameSectionValue` compares. */
export function sameEntry(section: string, a: unknown, b: unknown, schema: PackageSchema | null = null): boolean {
  const node = schema?.properties?.[section];
  if (!schema || !node) return canonical(withoutNulls(a)) === canonical(withoutNulls(b));
  return canonical(settledForm(schema, node, [a])) === canonical(settledForm(schema, node, [b]));
}

/** One field as a placeholder comment, with the schema's default. */
function placeholder(key: string, field: SchemaNode): string {
  const fallback = field.default !== undefined ? field.default : field.type === "array" ? [] : null;
  return `# ${toYaml({ [key]: fallback }).trimEnd().split("\n").join("\n# ")}`;
}

const PERSONA_HEADER = [
  "# The persona: who the assistant is, shared by every agent of this solution (an agent's",
  "# system_prompt says what that agent does). A commented field is not set; remove its #",
  "# to set it. Write the greeting and fallback texts in the language the assistant answers in.",
];

/**
 * The persona file: every field the schema lists, in its order; a field the
 * value does not set (or sets to null) as a commented placeholder with its
 * default. Fields the schema does not know follow as they are.
 */
export function personaYaml(value: unknown, fields: Record<string, SchemaNode>): string {
  const set = isObject(value) ? value : {};
  const lines = [...PERSONA_HEADER];
  for (const [key, field] of Object.entries(fields)) {
    if (set[key] === undefined || set[key] === null) lines.push(placeholder(key, field));
    else lines.push(toYaml({ [key]: set[key] }).trimEnd());
  }
  for (const [key, inner] of Object.entries(set)) {
    if (!(key in fields) && inner !== undefined) lines.push(toYaml({ [key]: inner }).trimEnd());
  }
  return lines.join("\n") + "\n";
}

/** A section file's content, as pull writes it: JSON for a .json file, the persona with its placeholders, else YAML. */
export function sectionContent(section: string, value: unknown, schema: PackageSchema | null, json: boolean): string {
  if (json) return JSON.stringify(value, null, 2) + "\n";
  const fields = section === PERSONA_SECTION ? sectionFields(schema, section) : undefined;
  return fields ? personaYaml(value, fields) : toYaml(value);
}
