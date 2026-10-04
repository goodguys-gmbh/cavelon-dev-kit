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

/** The branches of an `anyOf`/`oneOf`, or the node itself. */
function branches(schema: PackageSchema, node: SchemaNode): SchemaNode[] {
  const list = (Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined) as unknown[] | undefined;
  if (!list) return [node];
  return list.map((b) => resolve(schema, b)).filter((b): b is SchemaNode => b !== undefined);
}

const propertiesOf = (node: SchemaNode | undefined) => (isObject(node?.properties) ? (node.properties as Record<string, unknown>) : undefined);

/** The object schema a value of this node follows, when one branch fits it. */
function objectBranch(schema: PackageSchema, node: SchemaNode, value: Record<string, unknown>): SchemaNode | undefined {
  const objects = branches(schema, node).filter((b) => propertiesOf(b));
  if (objects.length <= 1) return objects[0];
  // Several object shapes: the one that knows every key the value has and holds its required ones.
  const fits = objects.filter((b) => {
    const props = propertiesOf(b)!;
    const required = Array.isArray(b.required) ? (b.required as string[]) : [];
    return Object.keys(value).every((k) => k in props) && required.every((k) => k in value);
  });
  return fits.length === 1 ? fits[0] : undefined;
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

/**
 * A value in the export's form: an object's fields in the schema's order
 * (fields the schema does not know after them, as written), and each field the
 * value leaves out set to the schema's default when that is not null. The
 * instance fills the same defaults when it imports, so the value means the
 * same; only its spelling changes.
 */
export function exportForm(schema: PackageSchema, node: unknown, value: unknown, depth = 0): unknown {
  const resolved = resolve(schema, node);
  if (!resolved || depth > 40) return value;
  if (Array.isArray(value)) {
    const array = arrayBranch(schema, resolved);
    return array?.items ? value.map((item) => exportForm(schema, array.items, item, depth + 1)) : value;
  }
  if (!isObject(value)) return value;
  const object = objectBranch(schema, resolved, value);
  const props = propertiesOf(object);
  if (!props) return value;
  const out: Record<string, unknown> = {};
  for (const [key, sub] of Object.entries(props)) {
    if (key in value) out[key] = exportForm(schema, sub, value[key], depth + 1);
    else {
      const fallback = resolve(schema, sub)?.default;
      if (fallback !== undefined && fallback !== null) out[key] = structuredClone(fallback);
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

/** Whether two values of a section say the same, with null fields and an empty persona counted as unset. */
export function sameSectionValue(section: string, a: unknown, b: unknown, key: (v: unknown) => string): boolean {
  const left = withoutNulls(a);
  const right = withoutNulls(b);
  if (section === PERSONA_SECTION && isEmpty(left) && isEmpty(right)) return true;
  return key(left) === key(right);
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
