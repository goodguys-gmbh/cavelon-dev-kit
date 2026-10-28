import type { PackageSchema } from "./contracts.js";
import { locate, type Finding, type PackageOnDisk } from "./package-files.js";
import { branches } from "./package-references.js";

/**
 * The package fields a solution folder leaves to the Admin, as `cavelon.yaml`
 * names them: `unmanaged` lists JSON pointers to fields that `pull` does not
 * write and `apply` does not send, and `managed_kinds` names, for a list whose
 * entries carry a kind, the kinds the folder manages. An instance that takes
 * `<list>_kinds` beside such a list replaces only those kinds on import and
 * keeps the target's others, so campaigns made in the Admin survive an apply
 * of the folder's starter questions.
 */

export const UNMANAGED_SET_CODE = "unmanaged_field_set";
export const MANAGED_SETTING_UNKNOWN_CODE = "managed_setting_unknown";
export const MANAGED_KINDS_LEFT_OUT_CODE = "managed_kinds_left_out";
export const MANAGED_KINDS_UNSUPPORTED_CODE = "managed_kinds_unsupported";

export interface ManagedFields {
  /** JSON pointers to fields the folder does not manage. */
  unmanaged: string[];
  /** A list field's JSON pointer → the kinds of its entries the folder manages. */
  kinds: Record<string, string[]>;
}

export const NO_MANAGED_FIELDS: ManagedFields = { unmanaged: [], kinds: {} };

type Node = Record<string, unknown>;

const asObject = (v: unknown): Node | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Node) : undefined);

/** A pointer's keys, unescaped. */
export function pointerKeys(pointer: string): string[] {
  return pointer
    .split("/")
    .slice(1)
    .map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * Whether `cavelon.yaml` may name this pointer: a field inside a section
 * (`/persona/engagement_rules`), not a whole section, so pull never removes a
 * section's file for it.
 */
export function validManagedPointer(pointer: string): boolean {
  if (!pointer.startsWith("/")) return false;
  const keys = pointerKeys(pointer);
  return keys.length >= 2 && keys.every((k) => k.length > 0);
}

export function hasManagedFields(managed: ManagedFields | undefined): managed is ManagedFields {
  return Boolean(managed && (managed.unmanaged.length || Object.keys(managed.kinds).length));
}

/** The object holding a pointer's last key, through objects only; undefined where a list or nothing is in the way. */
function parentOf(value: unknown, keys: string[]): Node | undefined {
  let at = asObject(value);
  for (const key of keys.slice(0, -1)) {
    at = asObject(at?.[key]);
    if (!at) return undefined;
  }
  return at;
}

/** The schema of the field a pointer names, through object fields only. */
function fieldSchema(schema: PackageSchema, keys: string[]): Node | undefined {
  let node: unknown = schema.properties?.[keys[0]!];
  for (const key of keys.slice(1)) {
    const holder = branches(schema, node).find((b) => asObject(b.properties)?.[key] !== undefined);
    node = holder ? asObject(holder.properties)![key] : undefined;
    if (node === undefined) return undefined;
  }
  return asObject(node);
}

/** The siblings of a pointer's field: the properties of the object schema that holds it. */
function siblingFields(schema: PackageSchema, keys: string[]): Node | undefined {
  if (keys.length < 2) return undefined;
  const holder = keys.length === 2 ? schema.properties?.[keys[0]!] : fieldSchema(schema, keys.slice(0, -1));
  const object = branches(schema, holder).find((b) => asObject(b.properties)?.[keys[keys.length - 1]!] !== undefined);
  return asObject(object?.properties);
}

export interface KindedList {
  /** The field each entry names its kind in; unknown where the schema leaves the entries open. */
  discriminator?: string;
  /** The field beside the list that says which kinds it holds, where the instance takes one. */
  kindsField?: string;
  /** The kinds the instance knows, where its schema lists them. */
  known?: string[];
}

/**
 * How the published schema describes a list whose entries carry a kind: the
 * entries' discriminator (or the one field every entry shape restricts to a
 * constant), and `<list>_kinds` beside it where the instance takes a partial
 * list. Undefined when the pointer names no list.
 */
export function kindedList(schema: PackageSchema, pointer: string): KindedList | undefined {
  const keys = pointerKeys(pointer);
  const field = fieldSchema(schema, keys);
  if (!field) return undefined;
  const items = branches(schema, field).map((b) => b.items).find((i) => i !== undefined);
  if (items === undefined) return undefined;
  const itemNode = asObject(items) ?? {};
  const declared = asObject(itemNode.discriminator)?.propertyName;
  const shapes = branches(schema, items).filter((b) => asObject(b.properties));
  const constants = (name: string) =>
    shapes.map((s) => asObject(asObject(s.properties)![name])).map((p) => (p && "const" in p ? p.const : undefined));
  let discriminator = typeof declared === "string" ? declared : undefined;
  if (!discriminator && shapes.length) {
    discriminator = Object.keys(asObject(shapes[0]!.properties)!).find((name) => constants(name).every((c) => typeof c === "string"));
  }
  const siblings = siblingFields(schema, keys);
  const kindsName = `${keys[keys.length - 1]}_kinds`;
  const kindsNode = siblings?.[kindsName];
  const fromKinds = kindsNode
    ? branches(schema, kindsNode)
        .map((b) => asObject(b.items))
        .flatMap((i) => (i && Array.isArray(i.enum) ? i.enum : []))
        .filter((k): k is string => typeof k === "string")
    : [];
  const fromShapes = discriminator ? constants(discriminator).filter((c): c is string => typeof c === "string") : [];
  const known = fromKinds.length ? fromKinds : fromShapes;
  return { ...(discriminator ? { discriminator } : {}), ...(kindsNode ? { kindsField: kindsName } : {}), ...(known.length ? { known } : {}) };
}

const kindOf = (entry: unknown, discriminator: string) => asObject(entry)?.[discriminator];
const label = (entry: unknown) => {
  const id = asObject(entry)?.id;
  return typeof id === "string" ? id : "?";
};

export interface SentPackage {
  package: Record<string, unknown>;
  /** The pointers left out of the import because the folder does not manage them. */
  left_out: string[];
  /** For each kinded list: the kinds sent, or why the list was left out. */
  kinds: Array<{ pointer: string; kinds: string[]; sent: boolean; other_kinds_left_out: string[]; reason?: string }>;
}

/**
 * The package `apply` sends: without the unmanaged fields, and each kinded
 * list with only the kinds the folder manages, named in `<list>_kinds`. Where
 * the instance takes no `<list>_kinds`, the import would replace the whole
 * list, so the list stays out and the target keeps all of it.
 */
export function packageToSend(pkg: Record<string, unknown>, managed: ManagedFields, schema: PackageSchema | null): SentPackage {
  const out = structuredClone(pkg);
  const result: SentPackage = { package: out, left_out: [], kinds: [] };
  for (const pointer of managed.unmanaged) {
    const keys = pointerKeys(pointer);
    const parent = parentOf(out, keys);
    const last = keys[keys.length - 1]!;
    if (parent && last in parent) {
      delete parent[last];
      result.left_out.push(pointer);
    }
  }
  for (const [pointer, kinds] of Object.entries(managed.kinds)) {
    if (managed.unmanaged.includes(pointer)) continue;
    const keys = pointerKeys(pointer);
    const parent = parentOf(out, keys);
    const last = keys[keys.length - 1]!;
    const list = parent?.[last];
    // Left out (or null), the target keeps its list: nothing to narrow.
    if (!parent || !Array.isArray(list)) continue;
    const shape = schema ? kindedList(schema, pointer) : undefined;
    if (!shape?.kindsField || !shape.discriminator) {
      delete parent[last];
      result.left_out.push(pointer);
      result.kinds.push({
        pointer,
        kinds,
        sent: false,
        other_kinds_left_out: [],
        reason: shape ? `this instance does not take ${last}_kinds, so an import would replace the whole list` : "this instance's package schema has no list here",
      });
      continue;
    }
    const discriminator = shape.discriminator;
    const other = list.filter((entry) => !kinds.includes(String(kindOf(entry, discriminator))));
    parent[last] = list.filter((entry) => kinds.includes(String(kindOf(entry, discriminator))));
    parent[shape.kindsField] = [...kinds];
    result.kinds.push({ pointer, kinds, sent: true, other_kinds_left_out: other.map(label) });
  }
  return result;
}

/** The package `pull` writes: without the unmanaged fields, and each kinded list with only the kinds the folder manages. */
export function packageToWrite(pkg: Record<string, unknown>, managed: ManagedFields, schema: PackageSchema | null): Record<string, unknown> {
  if (!hasManagedFields(managed)) return pkg;
  const out = structuredClone(pkg);
  for (const pointer of managed.unmanaged) {
    const keys = pointerKeys(pointer);
    const parent = parentOf(out, keys);
    if (parent) delete parent[keys[keys.length - 1]!];
  }
  for (const [pointer, kinds] of Object.entries(managed.kinds)) {
    if (managed.unmanaged.includes(pointer)) continue;
    const keys = pointerKeys(pointer);
    const parent = parentOf(out, keys);
    const last = keys[keys.length - 1]!;
    const shape = schema ? kindedList(schema, pointer) : undefined;
    if (!parent || !shape) continue;
    // An instance that cannot import some kinds only: apply leaves the list out, so the folder holds none of it.
    if (!shape.kindsField || !shape.discriminator) {
      delete parent[last];
      continue;
    }
    const discriminator = shape.discriminator;
    const list = parent[last];
    if (Array.isArray(list)) parent[last] = list.filter((entry) => kinds.includes(String(kindOf(entry, discriminator))));
    delete parent[shape.kindsField];
  }
  return out;
}

/**
 * What `validate` says of cavelon.yaml's managed fields: a field the folder
 * sets although it does not manage it (apply leaves it out), a pointer or kind
 * this instance's schema does not have, entries of kinds the folder does not
 * manage, and a kinded list the instance can only replace whole.
 */
export function checkManagedFields(disk: PackageOnDisk, managed: ManagedFields | undefined, schema: PackageSchema): Finding[] {
  if (!hasManagedFields(managed)) return [];
  const findings: Finding[] = [];
  const unknown = (pointer: string, why: string) =>
    findings.push({ code: MANAGED_SETTING_UNKNOWN_CODE, severity: "warning", file: "cavelon.yaml", path: pointer, message: `cavelon.yaml names ${pointer}, ${why}.` });
  for (const pointer of managed.unmanaged) {
    const keys = pointerKeys(pointer);
    if (!fieldSchema(schema, keys)) unknown(pointer, "which is no field of this instance's package schema (a field inside a list cannot be named)");
    const parent = parentOf(disk.package, keys);
    if (parent && keys[keys.length - 1]! in parent) {
      findings.push({
        code: UNMANAGED_SET_CODE,
        severity: "warning",
        ...locate(disk, pointer),
        message: `cavelon.yaml lists ${pointer} as unmanaged, and the package sets it: apply leaves it out, so the instance keeps its own value.`,
      });
    }
  }
  for (const [pointer, kinds] of Object.entries(managed.kinds)) {
    const shape = kindedList(schema, pointer);
    if (!shape) {
      unknown(pointer, "which is no list of this instance's package schema");
      continue;
    }
    const strange = shape.known ? kinds.filter((k) => !shape.known!.includes(k)) : [];
    if (strange.length) unknown(pointer, `with the kind${strange.length === 1 ? "" : "s"} ${strange.join(", ")}, which this instance does not know (it knows ${shape.known!.join(", ")})`);
    const keys = pointerKeys(pointer);
    const list = parentOf(disk.package, keys)?.[keys[keys.length - 1]!];
    if (!Array.isArray(list)) continue;
    if (!shape.kindsField || !shape.discriminator) {
      findings.push({
        code: MANAGED_KINDS_UNSUPPORTED_CODE,
        severity: "warning",
        ...locate(disk, pointer),
        message: `This instance does not take ${keys[keys.length - 1]}_kinds, so an import of ${pointer} would replace all of the solution's entries, of every kind: apply leaves ${pointer} out.`,
      });
      continue;
    }
    const discriminator = shape.discriminator;
    list.forEach((entry, i) => {
      const kind = kindOf(entry, discriminator);
      if (typeof kind === "string" && !kinds.includes(kind)) {
        findings.push({
          code: MANAGED_KINDS_LEFT_OUT_CODE,
          severity: "warning",
          ...locate(disk, `${pointer}/${i}`),
          message: `"${label(entry)}" is of kind ${kind}, which cavelon.yaml's managed_kinds does not list for ${pointer} (${kinds.join(", ")}): apply leaves it out, and the instance keeps its own entries of that kind.`,
        });
      }
    });
  }
  return findings;
}
