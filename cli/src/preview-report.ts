import { clip } from "./format.js";
import { locate, type PackageOnDisk } from "./package-files.js";
import { cavelonCommand } from "./printed.js";

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
  const details = raw.filter(isObject).map((b) => ({
    code: text(b.code),
    message: text(b.message) ?? text(b.detail) ?? JSON.stringify(b),
    path: text(b.path) ?? text(b.pointer) ?? text(b.location),
    hint: text(b.hint),
  }));
  return locateBlockers(details, disk);
}

/** Each blocker with the package file and line its path is in, where the kit finds it. */
export function locateBlockers(details: BlockerDetail[], disk?: PackageOnDisk): BlockerDetail[] {
  if (!disk) return details;
  return details.map((b) => {
    if (!b.path) return b;
    const at = locate(disk, pointerOf(b.path));
    return { ...b, ...(at.file ? { file: at.file } : {}), ...(at.line ? { line: at.line } : {}) };
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

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function shown(value: unknown): string {
  if (value === undefined || value === null) return "null";
  return clip(JSON.stringify(value), 80);
}

/** Characters shown on each side of where two long texts differ. */
const DIFF_CONTEXT = 30;

/**
 * Both sides of a change. Two long texts are shown from a little before
 * where they start to differ to a little after where they agree again: cut
 * at the same prefix, an edit at the end of a long prompt would not show.
 */
export function shownPair(before: unknown, after: unknown): [string, string] {
  if (typeof before !== "string" || typeof after !== "string" || (JSON.stringify(before).length <= 80 && JSON.stringify(after).length <= 80)) {
    return [shown(before), shown(after)];
  }
  const start = commonPrefix(before, after);
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const from = Math.max(0, start - DIFF_CONTEXT);
  const window = (value: string) => {
    const to = Math.min(value.length, value.length - end + DIFF_CONTEXT);
    const part = JSON.stringify(value.slice(from, to));
    return `${from > 0 ? "…" : ""}${clip(part, 160)}${to < value.length ? "…" : ""}`;
  };
  return [window(before), window(after)];
}

export function changeLines(changes: FieldChange[], max = 20): string {
  const lines = changes.slice(0, max).map((c) => {
    const [before, after] = shownPair(c.old, c.new);
    const at = typeof c.old === "string" && typeof c.new === "string" && (before.startsWith("…") || after.startsWith("…")) ? ` (from character ${commonPrefix(c.old, c.new) + 1})` : "";
    return `\n  - ${c.object}.${c.field}: ${before} → ${after}${at}`;
  });
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

/** What an instance reports on a solution package's tenant-wide sections, in a preview or an import's result. */
export interface TenantWideReport {
  /** The tenant-wide sections the package holds. */
  sections: string[];
  /** Whether this import takes them along (include_tenant_wide), or leaves them out. */
  applied: boolean;
  /** The sections the import takes along: a preview's `would_import`, a result's `imported`, else all of them when `applied`. */
  imports: string[];
  /** The sections it leaves out: `left_out`, else all of them when not `applied`. */
  left_out: string[];
  /** Whether the instance named `imports` and `left_out` itself, rather than the kit reading them from `applied`. */
  listed: boolean;
  /** The active solutions that see them change, by slug or name, when applied. */
  reaches_active_solutions: string[];
}

const names = (raw: unknown): string[] | undefined => (Array.isArray(raw) ? raw.map(text).filter((s): s is string => s !== null) : undefined);

/**
 * The `tenant_wide` of a preview or an import's result: `{sections, applied,
 * reaches_active_solutions}`, an active solution named by a string or an
 * object with its slug or name. A recent instance also names what the import
 * takes along (`would_import` in a preview, `imported` in a result) and what
 * it leaves out (`left_out`); an older one says only `applied`, which then
 * stands for all of the sections. Undefined on an instance that sends none,
 * or a shape without sections.
 */
export function tenantWideReport(raw: unknown): TenantWideReport | undefined {
  if (!isObject(raw) || !Array.isArray(raw.sections)) return undefined;
  const sections = names(raw.sections)!;
  const reaches = Array.isArray(raw.reaches_active_solutions) ? raw.reaches_active_solutions : [];
  const solutions = reaches
    .map((h) => (isObject(h) ? (text(h.slug) ?? text(h.harness_slug) ?? text(h.name) ?? text(h.id)) : text(h)))
    .filter((n): n is string => n !== null);
  const applied = raw.applied === true;
  const said = names(raw.would_import) ?? names(raw.imported);
  const leftOut = names(raw.left_out);
  const imports = said ?? (leftOut ? sections.filter((s) => !leftOut.includes(s)) : applied ? sections : []);
  return {
    sections,
    applied,
    imports,
    left_out: leftOut ?? sections.filter((s) => !imports.includes(s)),
    listed: said !== undefined || leftOut !== undefined,
    reaches_active_solutions: [...new Set(solutions)],
  };
}
