import { stringify } from "yaml";
import { boolOption, positional, type CommandSpec } from "../command.js";
import type { OpenApiDoc, PackageSchema } from "../contracts.js";
import { CavelonError, ExitCode, usageError } from "../errors.js";
import { clip, keyValues, table } from "../format.js";
import { deref, schemaTypes } from "../openapi.js";
import { DEFAULT_LAYOUT, type Layout } from "../package-files.js";
import { requireInstance } from "../session.js";
import { schemaFor, type SchemaUsed } from "./solution.js";

/**
 * `cavelon schema [section]`: the package schema the instance publishes, one
 * section at a time, with the smallest entry that has every required field.
 * A pulled file is often `[]` and shows no shape; this is where the shape is.
 * Everything comes from the published schema, cached like `validate` reads it.
 */

type Node = Record<string, unknown>;

/** Nested required objects are filled to this depth; deeper ones stay `{}`. */
const EXAMPLE_DEPTH = 4;

function resolve(schema: PackageSchema, node: unknown): Node {
  return (deref(schema as unknown as OpenApiDoc, node) ?? {}) as Node;
}

/** The branch of an `anyOf`/`oneOf` that is not `null`, as a nullable field writes it. */
function nonNull(schema: PackageSchema, node: Node): Node {
  const resolved = resolve(schema, node);
  for (const key of ["anyOf", "oneOf"]) {
    const branches = (resolved[key] as Node[] | undefined)?.map((b) => resolve(schema, b)).filter((b) => b.type !== "null");
    if (branches?.length === 1) return { ...resolved, ...branches[0]!, [key]: undefined };
  }
  return resolved;
}

function refName(node: Node): string | undefined {
  return typeof node.$ref === "string" ? node.$ref.split("/").pop() : undefined;
}

/** What one entry of a section looks like: the item of a list, the object itself otherwise. */
function entryOf(schema: PackageSchema, section: Node): { list: boolean; entry: Node } {
  const resolved = nonNull(schema, section);
  if (schemaTypes(resolved).includes("array") && resolved.items) return { list: true, entry: nonNull(schema, resolved.items as Node) };
  return { list: false, entry: resolved };
}

interface FieldRow {
  name: string;
  type: string;
  required: boolean;
  description: string | null;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
}

/** The named type of a field, through a nullable `anyOf`. */
function namedType(schema: PackageSchema, raw: Node): string | undefined {
  if (refName(raw)) return refName(raw);
  const resolved = resolve(schema, raw);
  for (const key of ["anyOf", "oneOf"]) {
    const named = ((resolved[key] as Node[] | undefined) ?? []).filter((b) => resolve(schema, b).type !== "null").map(refName);
    if (named.length === 1 && named[0]) return named[0];
  }
  return undefined;
}

function typeOf(schema: PackageSchema, raw: Node): string {
  const node = nonNull(schema, raw);
  const ref = namedType(schema, raw);
  const types = schemaTypes(node).filter((t) => t !== "null");
  if (types.includes("array") && node.items) {
    const item = node.items as Node;
    return `list of ${refName(item) ?? (schemaTypes(resolve(schema, item)).join("|") || "any")}`;
  }
  return ref ?? (types.join("|") || "object");
}

function fieldsOf(schema: PackageSchema, entry: Node): FieldRow[] {
  const props = (entry.properties ?? {}) as Record<string, Node>;
  const required = new Set((entry.required as string[] | undefined) ?? []);
  return Object.entries(props).map(([name, raw]) => {
    const node = nonNull(schema, raw);
    // A title is mostly the field's name in words ("Name"); only a description adds something.
    const description = (raw.description ?? node.description) as string | undefined;
    return {
      name,
      type: typeOf(schema, raw),
      required: required.has(name),
      description: description ? clip(description, 160) : null,
      ...(Array.isArray(node.enum) ? { enum: node.enum as unknown[] } : {}),
      ...(node.const !== undefined ? { const: node.const } : {}),
      ...(node.default !== undefined && node.default !== null ? { default: node.default } : {}),
    };
  });
}

/** A value of the right shape for a required field: its default, a listed value, or a placeholder naming it. */
function sample(schema: PackageSchema, raw: Node, name: string, depth: number): unknown {
  const node = nonNull(schema, raw);
  if (node.const !== undefined) return node.const;
  if (node.default !== undefined && node.default !== null) return node.default;
  if (Array.isArray(node.enum) && node.enum.length) return node.enum[0];
  const types = schemaTypes(node).filter((t) => t !== "null");
  if (types.includes("array")) return [];
  if (types.includes("boolean")) return false;
  if (types.includes("integer") || types.includes("number")) return typeof node.minimum === "number" ? node.minimum : 0;
  if (node.properties || types.includes("object")) return depth < EXAMPLE_DEPTH ? minimal(schema, node, depth + 1) : {};
  return `<${name}>`;
}

/** An entry with only its required fields. */
function minimal(schema: PackageSchema, entry: Node, depth = 0): Record<string, unknown> {
  const props = (entry.properties ?? {}) as Record<string, Node>;
  const out: Record<string, unknown> = {};
  for (const name of (entry.required as string[] | undefined) ?? []) {
    out[name] = props[name] ? sample(schema, props[name], name, depth) : `<${name}>`;
  }
  return out;
}

/** The shapes a node may take, a union's branches flattened, each with its type's name; never the null type. */
function variants(schema: PackageSchema, raw: Node, depth = 0): Array<{ name?: string; node: Node }> {
  const resolved = resolve(schema, raw);
  const list = (resolved.anyOf ?? resolved.oneOf) as Node[] | undefined;
  if (Array.isArray(list) && depth < 10) return list.flatMap((b) => variants(schema, b, depth + 1));
  return resolved.type === "null" ? [] : [{ name: refName(raw), node: resolved }];
}

/** The object shapes of a node's entries: the item of a list, or the node itself. */
function objectShapes(schema: PackageSchema, raw: Node): { list: boolean; shapes: Array<{ name?: string; node: Node }>; others: string[] } {
  const { list } = entryOf(schema, raw);
  // The item before it is resolved, so each shape keeps its type's name.
  const all = variants(schema, list ? (nonNull(schema, raw).items as Node) : raw);
  const shapes = all.filter((v) => v.node.properties);
  const others = all.filter((v) => !v.node.properties).map((v) => schemaTypes(v.node).join("|") || "any");
  return { list, shapes, others };
}

interface NestedField {
  field: string;
  type: string;
  path: string;
}

/** The fields of a shape whose entries are objects with fields of their own: where `cavelon schema <path>` goes next. */
function nestedOf(schema: PackageSchema, shape: Node, at: string): NestedField[] {
  const props = (shape.properties ?? {}) as Record<string, Node>;
  return Object.entries(props).flatMap(([field, raw]) =>
    objectShapes(schema, raw).shapes.length ? [{ field, type: typeOf(schema, raw), path: `${at}.${field}` }] : [],
  );
}

/** One entry of a list of these items: one of each shape a union offers (a text, a judge criterion, the first assertion). */
function itemSamples(schema: PackageSchema, items: Node, name: string, depth: number): unknown[] {
  const resolved = resolve(schema, items);
  const list = (resolved.anyOf ?? resolved.oneOf) as Node[] | undefined;
  const first = (node: Node): Node => {
    const at = resolve(schema, node);
    const inner = (at.anyOf ?? at.oneOf) as Node[] | undefined;
    return Array.isArray(inner) && inner.length ? first(inner[0]!) : at;
  };
  const branches = Array.isArray(list) ? list.map(first).filter((b) => b.type !== "null") : [resolved];
  return branches.map((b) => (b.properties ? fuller(schema, b, depth + 1) : sample(schema, b, name, depth)));
}

/** An entry with its required fields and one entry of each list of objects it holds, through the levels below. */
function fuller(schema: PackageSchema, entry: Node, depth = 0): Record<string, unknown> {
  const out = minimal(schema, entry, depth);
  if (depth >= EXAMPLE_DEPTH) return out;
  for (const [name, raw] of Object.entries((entry.properties ?? {}) as Record<string, Node>)) {
    if (name in out) continue;
    const node = nonNull(schema, raw);
    if (!schemaTypes(node).includes("array") || !node.items) continue;
    if (!objectShapes(schema, raw).shapes.length) continue;
    out[name] = itemSamples(schema, node.items as Node, name, depth);
  }
  return out;
}

/** Where a section lives in the solution folder. */
function fileOf(layout: Layout, section: string): string {
  const folder = layout.items[section];
  return folder ? `${folder}/<one file per entry>.yaml` : `${layout.package}/${section}.yaml`;
}

function sourceLine(used: SchemaUsed): string {
  const from = used.source === "instance" ? "read from the instance now" : `cached at ${used.fetched_at ?? "an unknown time"}`;
  return `package format ${used.package_version ?? "?"}, ${from}${used.instance_version ? ` (instance ${used.instance_version})` : ""}`;
}

/** A path into the package (`agents.handoffs`), followed field by field through the entries of each level. */
function descend(schema: PackageSchema, section: string, keys: string[]): { node: Node } | { at: string; key: string; options: string[] } {
  let node = schema.properties![section]! as Node;
  let at = section;
  for (const key of keys) {
    const { shapes } = objectShapes(schema, node);
    const field = shapes.map((s) => (s.node.properties as Record<string, Node>)[key]).find((f) => f !== undefined);
    if (!field) return { at, key, options: [...new Set(shapes.flatMap((s) => nestedOf(schema, s.node, at).map((n) => n.field)))] };
    node = field;
    at = `${at}.${key}`;
  }
  return { node };
}

/** The paths at which a named type of the schema is used, found from the sections down. */
function usesOf(schema: PackageSchema, type: string): string[] {
  const found: string[] = [];
  const walk = (raw: Node, at: string, seen: Set<string>) => {
    for (const shape of objectShapes(schema, raw).shapes) {
      if (shape.name === type) found.push(at);
      if (shape.name && seen.has(shape.name)) continue;
      const next = new Set(seen);
      if (shape.name) next.add(shape.name);
      for (const [field, sub] of Object.entries((shape.node.properties ?? {}) as Record<string, Node>)) walk(sub, `${at}.${field}`, next);
    }
  };
  for (const [section, node] of Object.entries(schema.properties ?? {})) walk(node as Node, section, new Set());
  return [...new Set(found)];
}

function fieldRows(fields: FieldRow[]) {
  return fields.map((f) => ({
    field: f.name,
    type: f.type,
    required: f.required ? "yes" : "",
    notes: [f.enum ? `one of ${f.enum.map(String).join(", ")}` : "", f.const !== undefined ? `always ${JSON.stringify(f.const)}` : "", f.default !== undefined ? `default ${JSON.stringify(f.default)}` : "", f.description ?? ""]
      .filter(Boolean)
      .join("; "),
  }));
}

const yamlOf = (value: unknown) => stringify(value, { lineWidth: 0 }).trimEnd();

export const schema: CommandSpec = {
  name: "schema",
  summary: "Show the package schema the instance publishes: its sections, or the fields of a section or a nested type, with a minimal example.",
  description:
    "Without an argument, lists the sections with the file each is kept in. With a section, lists its fields (type, required,\n" +
    "allowed values, default) and prints the smallest entry that has every required field, ready to copy into the file, and an\n" +
    "example with one entry of each nested list. A field whose entries have fields of their own is reached by its path\n" +
    "(`agents.handoffs`, `test_suites.test_cases.steps`) or by its type's name (`PackageAgentHandoff`); the section's\n" +
    "output names them. Where entries take one of several shapes (a step's evaluation_criteria: a text, a judge criterion, an\n" +
    "assertion by type), each shape is listed with its fields. Placeholders are written <field>. Reads the schema as `validate`\n" +
    "does: the cached copy first, the instance otherwise.",
  readOnly: true,
  idempotent: true,
  mcpTool: "package_schema",
  positionals: [
    {
      name: "section",
      description: "A section of the package (agents), a path to a nested field (agents.handoffs, test_suites.test_cases.steps), or a type name (PackageAgentHandoff).",
    },
  ],
  options: { offline: { type: "boolean", description: "Use only the cached schema; never contact the instance." } },
  examples: ["cavelon schema", "cavelon schema agents", "cavelon schema agents.handoffs", "cavelon schema test_suites.test_cases.steps.evaluation_criteria --json"],
  async run(ctx, input) {
    const session = await ctx.session();
    requireInstance(session);
    const offline = boolOption(input, "offline");
    const { schema: published, used } = await schemaFor(ctx, session.project?.packageVersion, offline);
    if (!published?.properties) {
      throw new CavelonError(ExitCode.failure, {
        code: "package_schema_unavailable",
        message: "No package schema is cached for this instance, and it was not read.",
        hint: offline
          ? "Run `cavelon schema` once without --offline while the instance is reachable."
          : "The instance does not publish its package schema (/api/v1/meta/package-schema).",
      });
    }
    const layout = session.project?.layout ?? DEFAULT_LAYOUT;
    const required = new Set(published.required ?? []);
    const sections = Object.keys(published.properties);
    const name = positional(input, "section");
    if (!name) {
      const items = sections.map((section) => {
        const node = published.properties![section]!;
        const { list } = entryOf(published, node);
        const description = (node.description ?? node.title ?? resolve(published, node).title) as string | undefined;
        return { section, kind: list ? "list" : "object", required: required.has(section), file: fileOf(layout, section), title: description ? clip(description, 80) : null };
      });
      return {
        data: { schema: used, sections: items },
        text: [
          `Package schema: ${sourceLine(used)}.`,
          "",
          table(items, ["section", "kind", "required", "file"]),
          "",
          "One section's fields and a minimal example: cavelon schema <section>; a nested field's: cavelon schema <section>.<field>",
        ].join("\n"),
      };
    }

    const defs = (published.$defs ?? {}) as Record<string, Node>;
    const [section, ...keys] = name.split(".");
    let node: Node;
    let at = name;
    let usedIn: string[] | undefined;
    if (section && published.properties[section]) {
      const found = descend(published, section, keys);
      if ("options" in found) {
        const near = found.options.filter((o) => o.includes(found.key) || found.key.includes(o)).slice(0, 5);
        throw usageError(
          `The package schema has no nested field "${found.key}" under ${found.at}.`,
          found.options.length
            ? `${near.length ? `Did you mean: ${near.map((o) => `${found.at}.${o}`).join(", ")}? ` : ""}Nested under ${found.at}: ${found.options.join(", ")}.`
            : `Nothing under ${found.at} has fields of its own; \`cavelon schema ${found.at}\` shows its fields.`,
        );
      }
      node = found.node;
    } else if (!keys.length && Object.hasOwn(defs, name)) {
      node = { $ref: `#/$defs/${name}` };
      usedIn = usesOf(published, name);
      at = usedIn[0] ?? name;
    } else {
      const near = [...sections, ...Object.keys(defs)].filter((s) => s.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(s.toLowerCase())).slice(0, 5);
      throw usageError(
        `The package schema has no section or type "${name}".`,
        near.length ? `Did you mean: ${near.join(", ")}? (\`cavelon schema\` lists them)` : "`cavelon schema` lists the sections.",
      );
    }

    const top = (usedIn?.[0] ?? name).split(".")[0]!;
    const { list, shapes, others } = objectShapes(published, node);
    const one = shapes.length === 1 ? shapes[0]! : undefined;
    const entryNode = entryOf(published, node).entry;
    const fields = one ? fieldsOf(published, one.node) : [];
    const minimalOne = one ? minimal(published, one.node) : undefined;
    const fullOne = one ? fuller(published, one.node) : undefined;
    const wrap = (value: unknown) => (list ? [value] : value);
    const shapeList = shapes.length > 1 ? shapes.map((s) => ({ type: s.name ?? null, fields: fieldsOf(published, s.node), example: minimal(published, s.node) })) : undefined;
    const nested = one ? nestedOf(published, one.node, at) : [];
    const data = {
      schema: used,
      section: usedIn ? (usedIn.length ? top : null) : top,
      path: usedIn ? (usedIn[0] ?? null) : name,
      ...(usedIn ? { used_in: usedIn } : {}),
      kind: list ? "list" : "object",
      required: !usedIn && !keys.length ? required.has(name) : false,
      file: usedIn && !usedIn.length ? null : fileOf(layout, top),
      entry: (one?.name ?? (list ? namedType(published, nonNull(published, node).items as Node) : namedType(published, node))) ?? null,
      fields,
      example: minimalOne !== undefined ? wrap(minimalOne) : null,
      ...(fullOne && minimalOne && JSON.stringify(fullOne) !== JSON.stringify(minimalOne) ? { nested_example: wrap(fullOne) } : {}),
      nested,
      ...(shapeList ? { shapes: shapeList, other_shapes: others } : {}),
    };

    const where = usedIn ? (usedIn.length ? usedIn.join(", ") : "not used by any section") : name;
    const what = list ? "a list of entries" : "one object";
    const lines = [
      keyValues([
        [usedIn ? "type" : keys.length ? "field" : "section", usedIn ? `${name} (an object)` : `${name} (${what}${data.entry ? `, each a ${data.entry}` : ""})`],
        ...(usedIn ? [["used at", where] as [string, unknown]] : []),
        ["file", data.file ?? "(none)"],
        ["schema", sourceLine(used)],
      ]),
      "",
    ];
    if (shapeList) {
      lines.push(
        `Each entry takes one of ${shapeList.length + others.length} shapes${others.length ? ` (${others.map((o) => `a ${o}`).join(", ")}, or an object below)` : ""}:`,
        "",
      );
      for (const shape of shapeList) {
        lines.push(`${shape.type ?? "object"}:`, table(fieldRows(shape.fields), ["field", "type", "required", "notes"]), yamlOf(list ? [shape.example] : shape.example), "");
      }
    } else if (one) {
      lines.push(fields.length ? table(fieldRows(fields), ["field", "type", "required", "notes"]) : "No fields are published here.", "");
      lines.push(Object.keys(minimalOne!).length ? "Minimal example (required fields only):" : "No field is required; the smallest entry is empty:", yamlOf(data.example));
      if (data.nested_example) lines.push("", "With one entry of each nested list:", yamlOf(data.nested_example));
      if (nested.length) {
        lines.push("", "Fields with fields of their own:", table(nested.map((n) => ({ command: `cavelon schema ${n.path}`, type: n.type })), ["command", "type"]));
      }
    } else {
      lines.push(`Each entry is a ${others.join(" or ") || typeOf(published, entryNode)}; there are no fields to list.`);
    }
    return { data, text: lines.join("\n").trimEnd() };
  },
};
