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

/** Where a section lives in the solution folder. */
function fileOf(layout: Layout, section: string): string {
  const folder = layout.items[section];
  return folder ? `${folder}/<one file per entry>.yaml` : `${layout.package}/${section}.yaml`;
}

function sourceLine(used: SchemaUsed): string {
  const from = used.source === "instance" ? "read from the instance now" : `cached at ${used.fetched_at ?? "an unknown time"}`;
  return `package format ${used.package_version ?? "?"}, ${from}${used.instance_version ? ` (instance ${used.instance_version})` : ""}`;
}

export const schema: CommandSpec = {
  name: "schema",
  summary: "Show the package schema the instance publishes: its sections, or one section's fields with a minimal example.",
  description:
    "Without a section, lists the sections with the file each is kept in. With one, lists its fields (type, required,\n" +
    "allowed values, default) and prints the smallest entry that has every required field, ready to copy into the file.\n" +
    "Placeholders are written <field>. Reads the schema as `validate` does: the cached copy first, the instance otherwise.",
  readOnly: true,
  idempotent: true,
  mcpTool: "package_schema",
  positionals: [{ name: "section", description: "A section of the package, such as agents or knowledge_bases." }],
  options: { offline: { type: "boolean", description: "Use only the cached schema; never contact the instance." } },
  examples: ["cavelon schema", "cavelon schema agents", "cavelon schema knowledge_bases --json"],
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
          "One section's fields and a minimal example: cavelon schema <section>",
        ].join("\n"),
      };
    }
    const node = published.properties[name];
    if (!node) {
      const near = sections.filter((s) => s.includes(name) || name.includes(s)).slice(0, 5);
      throw usageError(
        `The package schema has no section "${name}".`,
        near.length ? `Did you mean: ${near.join(", ")}? (\`cavelon schema\` lists them)` : "`cavelon schema` lists the sections.",
      );
    }
    const { list, entry } = entryOf(published, node);
    const fields = fieldsOf(published, entry);
    const one = minimal(published, entry);
    const example = list ? [one] : one;
    const exampleYaml = stringify(example, { lineWidth: 0 });
    const data = {
      schema: used,
      section: name,
      kind: list ? "list" : "object",
      required: required.has(name),
      file: fileOf(layout, name),
      entry: (list ? namedType(published, nonNull(published, node).items as Node) : namedType(published, node)) ?? null,
      fields,
      example,
    };
    const rows = fields.map((f) => ({
      field: f.name,
      type: f.type,
      required: f.required ? "yes" : "",
      notes: [f.enum ? `one of ${f.enum.map(String).join(", ")}` : "", f.default !== undefined ? `default ${JSON.stringify(f.default)}` : "", f.description ?? ""]
        .filter(Boolean)
        .join("; "),
    }));
    const text = [
      keyValues([
        ["section", `${name} (${list ? "a list of entries" : "one object"}${data.entry ? `, each a ${data.entry}` : ""})`],
        ["file", data.file],
        ["schema", sourceLine(used)],
      ]),
      "",
      rows.length ? table(rows, ["field", "type", "required", "notes"]) : "No fields are published for this section.",
      "",
      Object.keys(one).length ? "Minimal example (required fields only):" : "No field is required; the smallest entry is empty:",
      exampleYaml.trimEnd(),
    ].join("\n");
    return { data, text };
  },
};
