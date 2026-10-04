import { clip } from "./format.js";
import { locate, type PackageOnDisk } from "./package-files.js";
import { cavelonCommand } from "./shell.js";

/**
 * The parts of an import preview that recent instances add: structured
 * blockers, a per-field diff, and the fields an import does not apply. Each
 * is read with a fallback, so an instance that sends none of them keeps
 * today's output, and a shape the kit does not know is shown as it is rather
 * than dropped.
 */

export interface BlockerDetail {
  code: string | null;
  message: string;
  /** Where in the package, as the instance names it. */
  path: string | null;
  hint: string | null;
  /** The package file and line the path is in, when the kit finds it. */
  file?: string;
  line?: number;
}

export interface FieldChange {
  object: string;
  field: string;
  old: unknown;
  new: unknown;
}

export interface NotApplied {
  path: string;
  /** How to set it instead, as the instance says. */
  how: string | null;
  /** The cavelon command that sets it, where the kit has one. */
  command?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const first = (o: Record<string, unknown>, keys: string[]): unknown => keys.map((k) => o[k]).find((v) => v !== undefined);

/** `agents[0].system_prompt`, `agents.0.system_prompt` or `/agents/0/system_prompt` as a JSON pointer. */
export function pointerOf(path: string): string {
  if (path.startsWith("/")) return path;
  const keys = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  return `/${keys.map((k) => k.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

export function blockerDetails(raw: unknown, disk?: PackageOnDisk): BlockerDetail[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObject).map((b) => {
    const path = text(b.path) ?? text(b.pointer) ?? text(b.location);
    const detail: BlockerDetail = {
      code: text(b.code),
      message: text(b.message) ?? text(b.detail) ?? JSON.stringify(b),
      path,
      hint: text(b.hint),
    };
    if (path && disk) {
      const at = locate(disk, pointerOf(path));
      if (at.file) detail.file = at.file;
      if (at.line) detail.line = at.line;
    }
    return detail;
  });
}

/** One blocker as lines: code, where, what; then its hint and the command that explains the code. */
export function blockerLines(details: BlockerDetail[]): string {
  return details
    .map((b) => {
      const where = [b.file ? `${b.file}${b.line ? `:${b.line}` : ""}` : "", b.path ?? ""].filter(Boolean).join(" ");
      const head = `\n  - ${b.code ? `${b.code}  ` : ""}${where ? `${where}: ` : ""}${clip(b.message, 300)}`;
      const hint = b.hint ? `\n    hint: ${clip(b.hint, 300)}` : "";
      const explain = b.code ? `\n    more: ${cavelonCommand("explain", b.code)}` : "";
      return head + hint + explain;
    })
    .join("");
}

function change(object: string, field: string, raw: unknown): FieldChange | undefined {
  if (Array.isArray(raw) && raw.length === 2) return { object, field, old: raw[0], new: raw[1] };
  if (!isObject(raw)) return undefined;
  const before = first(raw, ["old", "before", "from", "old_value", "current"]);
  const after = first(raw, ["new", "after", "to", "new_value", "proposed"]);
  if (before === undefined && after === undefined) return undefined;
  return { object, field, old: before ?? null, new: after ?? null };
}

/** The object a change entry is about: its own name for it, else its kind and slug. */
function objectOf(entry: Record<string, unknown>): string {
  const named = text(entry.object) ?? text(entry.target);
  if (named) return named;
  const kind = text(entry.kind) ?? text(entry.entity) ?? text(entry.section) ?? text(entry.type);
  const id = text(entry.slug) ?? text(entry.name) ?? text(entry.key) ?? text(entry.id);
  return [kind, id].filter(Boolean).join(":") || "?";
}

/**
 * The per-field diff in one list. Takes a list of `{object, field, old, new}`
 * (or `before`/`after`), a list of objects each with their `fields`, or a map
 * of object to fields.
 */
export function fieldChanges(raw: unknown): FieldChange[] {
  const out: FieldChange[] = [];
  const fromFields = (object: string, fields: unknown) => {
    if (Array.isArray(fields)) {
      for (const f of fields.filter(isObject)) {
        const c = change(object, text(f.field) ?? text(f.path) ?? text(f.name) ?? "?", f);
        if (c) out.push(c);
      }
    } else if (isObject(fields)) {
      for (const [field, value] of Object.entries(fields)) {
        const c = change(object, field, value);
        if (c) out.push(c);
      }
    }
  };
  if (Array.isArray(raw)) {
    for (const entry of raw.filter(isObject)) {
      const object = objectOf(entry);
      const nested = first(entry, ["fields", "changes", "diff"]);
      if (nested !== undefined) fromFields(object, nested);
      else {
        const c = change(object, text(entry.field) ?? text(entry.path) ?? "?", entry);
        if (c) out.push(c);
      }
    }
  } else if (isObject(raw)) {
    for (const [object, fields] of Object.entries(raw)) fromFields(object, fields);
  }
  return out;
}

function shown(value: unknown): string {
  if (value === undefined || value === null) return "null";
  return clip(typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value), 80);
}

export function changeLines(changes: FieldChange[], max = 20): string {
  const lines = changes.slice(0, max).map((c) => `\n  - ${c.object}.${c.field}: ${shown(c.old)} → ${shown(c.new)}`);
  return lines.join("") + (changes.length > max ? `\n  … ${changes.length - max} more (--json)` : "");
}

/** The slug of the solution a `harnesses[<n>]` path names, from the package. */
function harnessSlugAt(path: string, pkg: Record<string, unknown> | undefined, fallback: string | undefined): string | undefined {
  const index = /^\/?harnesses[[/.](\d+)/.exec(path)?.[1];
  const list = Array.isArray(pkg?.harnesses) ? pkg.harnesses : [];
  const entry = index !== undefined ? list[Number(index)] : undefined;
  return (isObject(entry) && text(entry.slug)) || fallback;
}

/**
 * The fields the import leaves as they are, each with the way to set it. For
 * the fields cavelon has a command for (a solution's default route and its
 * status), that command.
 */
export function notApplied(raw: unknown, pkg?: Record<string, unknown>, harness?: string): NotApplied[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): NotApplied | undefined => {
      if (typeof entry === "string") return { path: entry, how: null };
      if (!isObject(entry)) return undefined;
      const path = text(entry.path) ?? text(entry.field) ?? text(entry.pointer);
      if (!path) return undefined;
      return { path, how: text(entry.how) ?? text(entry.hint) ?? text(entry.set_with) ?? text(entry.reason) ?? text(entry.message) };
    })
    .filter((n): n is NotApplied => n !== undefined)
    .map((n) => {
      const field = n.path.split(/[./]/).pop();
      const slug = harnessSlugAt(n.path, pkg, harness);
      if (field === "is_default") return { ...n, command: cavelonCommand("harness", "default", slug ?? "<solution>") };
      if (field === "status") return { ...n, command: slug ? cavelonCommand("activate", "--harness", slug) : cavelonCommand("activate") };
      return n;
    });
}

export function notAppliedLines(list: NotApplied[]): string {
  return list
    .slice(0, 20)
    .map((n) => {
      const how = n.command ? `set with ${n.command}` : n.how ? clip(n.how, 200) : "";
      return `\n  - ${n.path}${how ? ` (${how})` : ""}`;
    })
    .join("") + (list.length > 20 ? `\n  … ${list.length - 20} more (--json)` : "");
}
