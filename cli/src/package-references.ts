import type { PackageSchema } from "./contracts.js";
import type { InventoryKind, TenantInventory } from "./commands/inventory.js";
import { locate, type Finding, type PackageOnDisk } from "./package-files.js";

/**
 * The offline checks `validate` adds to the schema's: references between the
 * package's own entries and to what the tenant held at the last pull, fields
 * the schema does not have, and models the tenant's list does not name. The
 * import preview finds the same, later and without a file or line.
 */

export const DUPLICATE_CODE = "package_duplicate_key";
export const REFERENCE_MISSING_CODE = "package_reference_missing";
export const REFERENCE_UNKNOWN_CODE = "package_reference_unknown";
export const FIELD_UNKNOWN_CODE = "package_field_unknown";
export const MODEL_UNKNOWN_CODE = "package_model_unknown";

/**
 * The built-in tool that searches knowledge bases, under its current and older
 * names: agents name it without the package or the tool list carrying it.
 */
export const SEARCH_TOOL_KEYS = new Set(["search_documents", "search_knowledge_base", "search_kb"]);

const asObject = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const list = (v: unknown): Array<Record<string, unknown> | undefined> => (Array.isArray(v) ? v.map(asObject) : []);
const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

// ---------------------------------------------------------------------------
// Did you mean
// ---------------------------------------------------------------------------

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * The closest of the candidates, when it is close enough to be a typo. The
 * `preferred` ones, the required fields an entry lacks, may be further off
 * ("target_agent_slug" for "to_agent_slug") and win a tie. Without a typo,
 * the shortest candidate that starts with the word, or holds it, or that the
 * word starts with: "description" for "description_override".
 */
export function closest(word: string, candidates: Iterable<string>, preferred: Iterable<string> = []): string | undefined {
  let best: { name: string; d: number } | undefined;
  const consider = (name: string, allowance: number) => {
    const d = distance(word.toLowerCase(), name.toLowerCase());
    if (d <= allowance && (!best || d < best.d)) best = { name, d };
  };
  const names = [...candidates];
  const wanted = [...preferred];
  for (const name of wanted) consider(name, Math.ceil(Math.max(word.length, name.length) / 2));
  for (const name of names) consider(name, typoAllowance(word));
  if (best) return best.name;
  const lower = word.toLowerCase();
  // Short words are parts of too many names to say which one was meant.
  if (lower.length < 4) return undefined;
  const related = [...wanted, ...names].filter((name) => {
    const other = name.toLowerCase();
    return other !== lower && (other.startsWith(lower) || lower.startsWith(other) || other.includes(lower)) && Math.min(other.length, lower.length) >= 4;
  });
  return related.sort((a, b) => Math.abs(a.length - word.length) - Math.abs(b.length - word.length))[0];
}

const typoAllowance = (word: string) => Math.max(2, Math.floor(word.length / 3));

const didYouMean = (name: string | undefined) => (name ? ` Did you mean "${name}"?` : "");
const suggested = (message: string, suggestion: string | undefined) => ({ message: message + didYouMean(suggestion), ...(suggestion ? { suggestion } : {}) });

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/** One kind of entry others refer to: where the package keeps it, by which field, and the tenant's list of it. */
interface Target {
  label: string;
  section: string;
  key: string;
  inventory?: InventoryKind;
  /** Names that need no entry: the built-in search tool. */
  builtin?: Set<string>;
}

const AGENT: Target = { label: "agent", section: "agents", key: "slug" };
const SKILL: Target = { label: "skill", section: "skills", key: "slug", inventory: "skills" };
const TOOL: Target = { label: "tool", section: "tools", key: "slug", inventory: "tools", builtin: SEARCH_TOOL_KEYS };
const KNOWLEDGE_BASE: Target = { label: "knowledge base", section: "knowledge_bases", key: "name", inventory: "knowledge_bases" };
const SOLUTION: Target = { label: "solution", section: "harnesses", key: "slug", inventory: "solutions" };
/** The sections whose entries must differ in their key: two with one key import as one. */
const KEYED: Target[] = [AGENT, SKILL, TOOL, KNOWLEDGE_BASE, SOLUTION, { label: "guardrail", section: "guardrails", key: "slug" }];

const INVENTORY_LABEL: Record<InventoryKind, string> = {
  solutions: "solutions",
  knowledge_bases: "knowledge bases",
  tools: "tools",
  skills: "skills",
  models: "models",
};

/** A reference from one entry to another: where it is, what it names, and what it must name. */
interface Reference {
  pointer: string;
  from: string;
  name: string;
  target: Target;
  /** How the entry names it, for the message: "hands off to", "checks answered_by". */
  how?: string;
}

/**
 * The assertions of a test step that name an entry of the package, by
 * `type`, and the field that names it: an agent for the routing checks, a
 * tool for the tool checks. The regression-testing page of the instance's
 * docs lists them; the package schema gives the field a plain text.
 */
const ASSERTION_TARGETS: Record<string, { target: Target; field: string }> = {
  answered_by: { target: AGENT, field: "value" },
  handoff_to: { target: AGENT, field: "value" },
  tool_called: { target: TOOL, field: "value" },
  tool_not_called: { target: TOOL, field: "value" },
  min_results: { target: TOOL, field: "tool" },
};

/** Every reference the package makes, from agents, skills and test steps' assertions, as the package schema names the fields. */
function references(pkg: Record<string, unknown>): Reference[] {
  const found: Reference[] = [];
  const add = (pointer: string, from: string, value: unknown, target: Target, how?: string) => {
    const name = text(value);
    if (name) found.push({ pointer, from, name, target, ...(how ? { how } : {}) });
  };
  list(pkg.agents).forEach((agent, i) => {
    if (!agent) return;
    const from = `The agent "${text(agent.slug) ?? i}"`;
    add(`/agents/${i}/harness_slug`, from, agent.harness_slug, SOLUTION);
    list(agent.skill_assignments).forEach((a, j) => add(`/agents/${i}/skill_assignments/${j}/skill_slug`, from, a?.skill_slug, SKILL));
    list(agent.tool_assignments).forEach((a, j) => add(`/agents/${i}/tool_assignments/${j}/tool_slug`, from, a?.tool_slug, TOOL));
    list(agent.handoffs).forEach((h, j) => add(`/agents/${i}/handoffs/${j}/to_agent_slug`, from, h?.to_agent_slug, AGENT));
  });
  list(pkg.skills).forEach((skill, i) => {
    if (!skill) return;
    const from = `The skill "${text(skill.slug) ?? i}"`;
    list(skill.knowledge_base_assignments).forEach((a, j) =>
      add(`/skills/${i}/knowledge_base_assignments/${j}/knowledge_base_name`, from, a?.knowledge_base_name, KNOWLEDGE_BASE),
    );
    list(skill.tool_assignments).forEach((a, j) => add(`/skills/${i}/tool_assignments/${j}/tool_slug`, from, a?.tool_slug, TOOL));
  });
  list(pkg.test_suites).forEach((suite, s) => {
    list(suite?.test_cases).forEach((testCase, c) => {
      const from = `The test case "${text(testCase?.name) ?? c}"${text(suite?.name) ? ` of the suite "${suite!.name as string}"` : ""}`;
      list(testCase?.steps).forEach((step, t) => {
        list(step?.evaluation_criteria).forEach((criterion, k) => {
          const type = text(criterion?.type);
          const named = type !== undefined && Object.hasOwn(ASSERTION_TARGETS, type) ? ASSERTION_TARGETS[type]! : undefined;
          if (!named) return;
          const pointer = `/test_suites/${s}/test_cases/${c}/steps/${t}/evaluation_criteria/${k}/${named.field}`;
          add(pointer, from, criterion![named.field], named.target, `checks ${type}`);
        });
      });
    });
  });
  return found;
}

function keysIn(pkg: Record<string, unknown>, target: Target): string[] {
  return list(pkg[target.section]).flatMap((e) => (text(e?.[target.key]) ? [e![target.key] as string] : []));
}

function pulledAt(inventory: TenantInventory, kind: InventoryKind): string {
  return inventory.refreshed_at?.[kind] ?? inventory.written_at;
}

/**
 * Two entries of one section with the same key, and references the package
 * cannot satisfy. A handoff names an agent of the same graph, which the
 * package carries, so a missing one is an error. A skill, tool, knowledge base
 * or solution may be on the instance instead: one that is in neither the
 * package nor the tenant's list from the last pull is a warning, as the list
 * may be older than the tenant; without that list it is not checked.
 */
export function checkReferences(disk: PackageOnDisk, inventory: TenantInventory | undefined): Finding[] {
  const pkg = disk.package;
  const findings: Finding[] = [];
  // A section whose file could not be read says nothing yet: what names its entries is not checked.
  const unreadable = new Set(disk.unreadable ?? []);
  for (const target of KEYED) {
    const seen = new Map<string, number>();
    list(pkg[target.section]).forEach((entry, i) => {
      const key = text(entry?.[target.key]);
      if (!key) return;
      const first = seen.get(key);
      if (first === undefined) {
        seen.set(key, i);
        return;
      }
      const earlier = locate(disk, `/${target.section}/${first}/${target.key}`);
      findings.push({
        code: DUPLICATE_CODE,
        severity: "error",
        ...locate(disk, `/${target.section}/${i}/${target.key}`),
        message: `Two ${target.section} have the ${target.key} "${key}" (also ${earlier.file ?? earlier.path}${earlier.line ? `:${earlier.line}` : ""}); the import keeps one of them.`,
      });
    });
  }

  for (const ref of references(pkg)) {
    const { target } = ref;
    if (unreadable.has(target.section)) continue;
    const inPackage = keysIn(pkg, target);
    if (inPackage.includes(ref.name) || target.builtin?.has(ref.name)) continue;
    const tenant = target.inventory ? inventory?.names[target.inventory] : undefined;
    if (target === AGENT) {
      // A package without agents (tests kept apart from the solution) cannot say which agents there are.
      if (ref.how && !Array.isArray(pkg.agents)) continue;
      findings.push({
        code: REFERENCE_MISSING_CODE,
        severity: "error",
        ...locate(disk, ref.pointer),
        ...suggested(`${ref.from} ${ref.how ?? "hands off to"} the agent "${ref.name}", which is not in the package.`, closest(ref.name, inPackage)),
      });
      continue;
    }
    if (!Array.isArray(tenant) || tenant.includes(ref.name)) continue;
    const kind = INVENTORY_LABEL[target.inventory!];
    findings.push({
      code: REFERENCE_UNKNOWN_CODE,
      severity: "warning",
      ...locate(disk, ref.pointer),
      ...suggested(
        `${ref.from} ${ref.how ?? "names"} the ${target.label} "${ref.name}", which is neither in the package nor among the tenant's ${kind} ` +
          `at the last pull (${pulledAt(inventory!, target.inventory!)}).`,
        closest(ref.name, [...inPackage, ...tenant, ...(target.builtin ?? [])]),
      ),
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Unknown fields
// ---------------------------------------------------------------------------

type SchemaNode = Record<string, unknown>;

function resolve(schema: PackageSchema, node: unknown): SchemaNode | undefined {
  let current = asObject(node);
  for (let i = 0; i < 10 && current && typeof current.$ref === "string"; i++) {
    const ref = current.$ref;
    if (!ref.startsWith("#/$defs/")) return undefined;
    current = asObject((schema.$defs as Record<string, unknown> | undefined)?.[ref.slice("#/$defs/".length)]);
  }
  return current;
}

/** The schemas a value may match: a union's branches, each resolved. */
export function branches(schema: PackageSchema, node: unknown): SchemaNode[] {
  const resolved = resolve(schema, node);
  if (!resolved) return [];
  const union = [resolved.anyOf, resolved.oneOf, resolved.allOf].find(Array.isArray) as unknown[] | undefined;
  return union ? union.flatMap((b) => branches(schema, b)) : [resolved];
}

/**
 * Fields the package schema does not have, which the import ignores as it
 * ignores an unknown section. Only an object whose schema lists its fields
 * and allows no others is checked: a free-form config, or one that takes more
 * fields than it lists, is left alone; where the schema forbids extra fields,
 * the schema check already reports them.
 */
export function checkUnknownFields(disk: PackageOnDisk, schema: PackageSchema, schemaFindings: Finding[] = []): Finding[] {
  const findings: Finding[] = [];
  const walk = (value: unknown, node: unknown, pointer: string) => {
    if (Array.isArray(value)) {
      const items = branches(schema, node).map((b) => b.items).find((i) => i !== undefined);
      if (items !== undefined) value.forEach((item, i) => walk(item, items, `${pointer}/${i}`));
      return;
    }
    const object = asObject(value);
    if (!object) return;
    const shapes = branches(schema, node).filter((b) => b.type === "object" || asObject(b.properties));
    if (!shapes.length) return;
    const open = shapes.some((b) => !asObject(b.properties) || (b.additionalProperties !== undefined && b.additionalProperties !== false));
    const closed = shapes.every((b) => b.additionalProperties === false);
    const known = new Map<string, unknown>();
    const required = new Set<string>();
    for (const shape of shapes) {
      for (const [key, sub] of Object.entries(asObject(shape.properties) ?? {})) if (!known.has(key)) known.set(key, sub);
      if (Array.isArray(shape.required)) for (const r of shape.required) if (typeof r === "string") required.add(r);
    }
    const missing = [...required].filter((r) => !(r in object));
    for (const [key, inner] of Object.entries(object)) {
      const at = `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      if (known.has(key)) {
        walk(inner, known.get(key), at);
        continue;
      }
      if (open || closed) continue;
      const suggestion = closest(key, known.keys(), missing);
      // A required field under another name: the schema check already reports it missing; say there what was meant.
      const parent = locate(disk, pointer).path;
      const required = suggestion && missing.includes(suggestion) ? schemaFindings.find((f) => f.path === parent && f.message === `missing required field "${suggestion}"`) : undefined;
      if (required) {
        required.message += ` ("${key}" is set, which the package schema does not have; did you mean "${suggestion}"?)`;
        required.suggestion = suggestion;
        // The line of the misspelt field, which is what to fix, rather than the entry's first line.
        const misspelt = locate(disk, at);
        if (misspelt.line !== undefined && misspelt.file === required.file) required.line = misspelt.line;
        continue;
      }
      const where = locate(disk, at);
      findings.push({
        code: FIELD_UNKNOWN_CODE,
        severity: "warning",
        ...where,
        message: `"${key}" is not a field of the package schema here; the import ignores it.${didYouMean(suggestion)}`,
        ...(suggestion ? { suggestion } : {}),
      });
    }
  };
  const sections = asObject(schema.properties) ?? {};
  for (const [section, value] of Object.entries(disk.package)) {
    if (section in sections) walk(value, sections[section], `/${section}`);
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/**
 * An agent's model that the tenant's Model Registry did not list when it was
 * last read (`pull`, `models list`), nor the package's own rows. A warning:
 * the list may be older than the tenant. An empty list is not checked, as the
 * instance's defaults then serve the agents.
 */
export function checkModels(disk: PackageOnDisk, inventory: TenantInventory | undefined): Finding[] {
  const tenant = inventory?.names.models;
  if (!Array.isArray(tenant) || !tenant.length) return [];
  // The package's own rows may hold the model; a file of them that cannot be read says nothing yet.
  if (disk.unreadable?.includes("model_registry")) return [];
  const known = new Set([...tenant, ...list(disk.package.model_registry).flatMap((row) => (text(row?.model_id) ? [row!.model_id as string] : []))]);
  const findings: Finding[] = [];
  list(disk.package.agents).forEach((agent, i) => {
    const model = text(agent?.llm_model);
    if (!model || known.has(model)) return;
    findings.push({
      code: MODEL_UNKNOWN_CODE,
      severity: "warning",
      ...locate(disk, `/agents/${i}/llm_model`),
      ...suggested(
        `The agent "${text(agent!.slug) ?? i}" uses the model "${model}", which is not in the tenant's model list ` +
          `(${pulledAt(inventory!, "models")}).`,
        closest(model, known),
      ),
    });
  });
  return findings;
}

// ---------------------------------------------------------------------------
// What could not be checked
// ---------------------------------------------------------------------------

/** What each list of the tenant checks, for the line that says it was not checked. */
const CHECKED_BY: Record<InventoryKind, string> = {
  solutions: "the solutions the package names",
  knowledge_bases: "the knowledge bases the package names",
  tools: "the tools the package names",
  skills: "the skills the package names",
  models: "the agents' models",
};

export const checkedBy = (kind: InventoryKind) => CHECKED_BY[kind];

/**
 * The tenant's lists the package needs and the kit has not read: a reference
 * to an entry the package does not carry, or an agent's model, with no list
 * of that kind in .cavelon/inventory.json. Those references are not checked
 * until the list is read (`pull`, `models list`, or validate when online).
 */
export function missingInventory(disk: PackageOnDisk, inventory: TenantInventory | undefined): InventoryKind[] {
  const needed = new Set<InventoryKind>();
  const pkg = disk.package;
  for (const ref of references(pkg)) {
    const kind = ref.target.inventory;
    if (!kind || keysIn(pkg, ref.target).includes(ref.name) || ref.target.builtin?.has(ref.name)) continue;
    needed.add(kind);
  }
  const own = new Set(list(pkg.model_registry).flatMap((row) => (text(row?.model_id) ? [row!.model_id as string] : [])));
  if (list(pkg.agents).some((agent) => text(agent?.llm_model) && !own.has(agent!.llm_model as string))) needed.add("models");
  return [...needed].filter((kind) => !Array.isArray(inventory?.names[kind]));
}
