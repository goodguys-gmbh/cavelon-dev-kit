import type { PackageSchema } from "./contracts.js";
import { kindedList } from "./managed-fields.js";
import { canonical, PERSONA_SECTION, sectionFields, settledForm } from "./package-format.js";

/**
 * The persona's widget fields in an apply: which of them reach visitors at
 * once on an active solution (the instance marks them `x-cavelon-live`), and
 * what an import does to the persona's engagement rules, rule by rule.
 */

/** How the instance marks a package field that takes effect without a publication. */
export const LIVE_MARK = "x-cavelon-live";

/**
 * The persona fields that take effect at once, as the instance's published
 * docs describe them, for an instance whose package schema marks none: the
 * engagement rules, the greeting and the teasers.
 */
const DOCUMENTED_LIVE = ["engagement_rules", "greeting_message", "greeting_enabled", "teaser_messages", "teaser_display_count"];

/**
 * The list field of the persona that holds engagement rules, for an instance
 * whose schema does not describe the rules' kinds yet.
 */
const RULES_FIELD = "engagement_rules";

const asObject = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** The persona fields that reach visitors without a publication: as the schema marks them, else as the docs describe. */
export function liveFields(schema: PackageSchema | null): { fields: string[]; marked: boolean } {
  const fields = sectionFields(schema, PERSONA_SECTION) ?? {};
  const marked = Object.entries(fields).filter(([, node]) => node[LIVE_MARK] === true).map(([name]) => name);
  if (marked.length) return { fields: marked, marked: true };
  const known = Object.keys(fields);
  return { fields: DOCUMENTED_LIVE.filter((name) => !known.length || known.includes(name)), marked: false };
}

/**
 * The live fields an import changes, as JSON pointers: the instance's
 * `publication.live_fields` where it sends them, else the persona fields its
 * per-field diff names that are live. Undefined when the preview says neither.
 */
export function previewLiveFields(preview: Record<string, unknown>, live: string[]): { pointers: string[]; reported_by: "instance" | "kit" } | undefined {
  const reported = asObject(preview.publication)?.live_fields;
  if (Array.isArray(reported)) return { pointers: reported.filter((p): p is string => typeof p === "string"), reported_by: "instance" };
  if (!Array.isArray(preview.changes)) return undefined;
  const pointers = new Set<string>();
  for (const entry of preview.changes) {
    const change = asObject(entry);
    if (change?.section !== PERSONA_SECTION) continue;
    const fields = Array.isArray(change.fields) ? change.fields : asObject(change.diff) ? Object.keys(change.diff as object) : [];
    for (const field of fields) {
      const name = typeof field === "string" ? field : asObject(field)?.field;
      if (typeof name === "string" && live.includes(name)) pointers.add(`/${PERSONA_SECTION}/${name}`);
    }
    // A persona the import creates sets every field it carries.
    if (change.action === "create") for (const name of live) pointers.add(`/${PERSONA_SECTION}/${name}`);
  }
  return { pointers: [...pointers], reported_by: "kit" };
}

/** The persona's list fields of engagement rules, as the schema describes them, or the documented one. */
export function ruleFields(schema: PackageSchema | null): Array<{ field: string; discriminator: string }> {
  const fields = sectionFields(schema, PERSONA_SECTION) ?? {};
  const kinded = schema
    ? Object.keys(fields).flatMap((field) => {
        const shape = kindedList(schema, `/${PERSONA_SECTION}/${field}`);
        return shape?.discriminator ? [{ field, discriminator: shape.discriminator }] : [];
      })
    : [];
  if (kinded.length) return kinded;
  return RULES_FIELD in fields || !schema ? [{ field: RULES_FIELD, discriminator: "kind" }] : [];
}

export interface RuleRef {
  id: string;
  kind: string;
  name: string;
}

export interface RulesChange {
  /** The pointer of the list, such as /persona/engagement_rules. */
  pointer: string;
  /** The kinds the import replaces; null for all of them. */
  kinds: string[] | null;
  /** Whether the solution's current rules could be read; without them, every rule sent is listed as sent. */
  current_known: boolean;
  added: RuleRef[];
  removed: RuleRef[];
  changed: RuleRef[];
  unchanged: number;
  /** Rules of other kinds the import keeps as they are. */
  kept: number;
}

function ref(entry: unknown, discriminator: string): RuleRef {
  const rule = asObject(entry) ?? {};
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  return { id: text(rule.id) || "?", kind: text(rule[discriminator]) || "?", name: text(rule.name) };
}

/**
 * What an import that sends `sent` does to the solution's rules (`current`),
 * by rule id: added, removed, changed (the rule says something else, defaults
 * counted as unset) and unchanged. With `kinds`, only the rules of those
 * kinds are replaced; the others stay. Without `current`, the solution's
 * rules are unknown, and every rule sent is listed as added.
 */
export function rulesChange(
  schema: PackageSchema | null,
  field: { field: string; discriminator: string },
  current: unknown[] | undefined,
  sent: unknown[],
  kinds: string[] | undefined,
): RulesChange {
  const listNode = sectionFields(schema, PERSONA_SECTION)?.[field.field];
  const same = (a: unknown, b: unknown) =>
    schema && listNode ? canonical(settledForm(schema, listNode, [a])) === canonical(settledForm(schema, listNode, [b])) : canonical(a) === canonical(b);
  const inScope = (entry: unknown) => !kinds || kinds.includes(ref(entry, field.discriminator).kind);
  const before = (current ?? []).filter(inScope);
  const byId = new Map(before.map((entry) => [ref(entry, field.discriminator).id, entry]));
  const sentIds = new Set(sent.map((entry) => ref(entry, field.discriminator).id));
  const change: RulesChange = {
    pointer: `/${PERSONA_SECTION}/${field.field}`,
    kinds: kinds ?? null,
    current_known: current !== undefined,
    added: [],
    removed: [],
    changed: [],
    unchanged: 0,
    kept: (current ?? []).length - before.length,
  };
  for (const entry of sent) {
    const old = byId.get(ref(entry, field.discriminator).id);
    if (old === undefined) change.added.push(ref(entry, field.discriminator));
    else if (same(old, entry)) change.unchanged++;
    else change.changed.push(ref(entry, field.discriminator));
  }
  for (const entry of before) if (!sentIds.has(ref(entry, field.discriminator).id)) change.removed.push(ref(entry, field.discriminator));
  return change;
}

const shownRule = (r: RuleRef) => `${r.kind} ${r.id}${r.name ? ` "${r.name}"` : ""}`;

/** The rules change as preview lines. */
export function rulesChangeLines(change: RulesChange, max = 10): string {
  const lines: string[] = [];
  const add = (sign: string, rules: RuleRef[]) => {
    for (const r of rules.slice(0, max)) lines.push(`\n  ${sign} ${shownRule(r)}`);
    if (rules.length > max) lines.push(`\n  … ${rules.length - max} more (--json)`);
  };
  add("+", change.added);
  add("-", change.removed);
  add("~", change.changed);
  const rest = [
    ...(change.unchanged ? [`${change.unchanged} unchanged`] : []),
    ...(change.kinds ? [`only ${change.kinds.join(", ")} replaced${change.kept ? `; ${change.kept} rule${change.kept === 1 ? "" : "s"} of other kinds kept` : ""}`] : []),
    ...(change.current_known ? [] : ["the solution's current rules could not be read, so every rule sent is listed as added"]),
  ];
  if (!lines.length && !rest.length) return " none";
  return lines.join("") + (rest.length ? `\n  (${rest.join("; ")})` : "");
}

/**
 * The warning for rules an import removes or replaces, where people may have
 * made them in the Admin (campaigns are edited there): removed rules always,
 * replaced ones when the folder manages every kind of the list.
 */
export function rulesWarning(change: RulesChange): string | undefined {
  const replaced = change.kinds ? [] : change.changed;
  if (!change.removed.length && !replaced.length) return undefined;
  const parts = [
    ...(change.removed.length ? [`removes ${change.removed.length} (${change.removed.slice(0, 5).map(shownRule).join(", ")}${change.removed.length > 5 ? ", …" : ""})`] : []),
    ...(replaced.length ? [`replaces ${replaced.length} (${replaced.slice(0, 5).map(shownRule).join(", ")}${replaced.length > 5 ? ", …" : ""})`] : []),
  ];
  return (
    `This import ${parts.join(" and ")} of the solution's engagement rules (${change.pointer}): a campaign edited in the Admin since the last pull is lost. ` +
    "Pull first to keep it, or name the kinds this folder manages in cavelon.yaml (managed_kinds) so the others stay as they are."
  );
}
