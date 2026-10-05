import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { BRANCH_WIDTH_KEY, branchConcurrency, offText } from "./branches.js";
import type { CatalogEntry, ErrorCatalog, PackageSchema } from "./contracts.js";
import type { PublishedLimits } from "./limits.js";
import type { TenantInventory } from "./commands/inventory.js";
import { locate, schemaSections, tenantWideSections, type Finding, type PackageOnDisk } from "./package-files.js";
import { MANIFEST_SECTION, PERSONA_SECTION, sectionFields } from "./package-format.js";
import { kitErrorEntry } from "./kit-codes.js";
import { cavelonCommand, fill, folderCommand } from "./printed.js";
import {
  branches,
  checkModels,
  checkReferences,
  checkUnknownFields,
  closest,
  DUPLICATE_CODE,
  FIELD_UNKNOWN_CODE,
  MODEL_UNKNOWN_CODE,
  REFERENCE_MISSING_CODE,
  REFERENCE_UNKNOWN_CODE,
  KNOWLEDGE_TOOL_KEYS,
} from "./package-references.js";

/**
 * The offline check behind `cavelon validate`: the package files against the
 * instance's published package schema, with every finding under a stable
 * code that `cavelon explain` looks up in the instance's error catalog. It is
 * a convenience; the import preview checks everything again on the server.
 */

export const SCHEMA_CODE = "package_schema_invalid";
/** Model Registry rows: an endpoint limit needs the endpoint. */
const ENDPOINT_LIMIT_CODE = "model_endpoint_limit_without_base_url";
const ENDPOINT_LIMIT_NOT_CARRIED = "model_endpoint_limit_not_in_package_schema";
const REGISTRY_SECTION = "model_registry";
const ENDPOINT_LIMIT_FIELD = "max_concurrent_requests";
const PACKAGE_DOCS = "/docs/reference/api-endpoints";
/** What a package carries and how its import resolves it: where a duplicate key or an ignored field matters. */
const IMPORT_DOCS = "/docs/concepts/harnesses#import-export-and-backup";
/** Branch concurrency: a node's width above the platform's, and branches that run in sequence. */
const BRANCH_WIDTH_CODE = "branch_width_capped";
const BRANCHES_SEQUENTIAL_CODE = "branches_run_in_sequence";
const BRANCH_DOCS = "/docs/concepts/capacity-and-concurrency#branch-concurrency";
/** Knowledge bases an agent is given without a tool that searches or lists them. */
const KB_WITHOUT_SEARCH_CODE = "knowledge_base_without_search_tool";
const SEARCH_DOCS = "/docs/reference/builtin-tools#binding-knowledge-bases-to-search_documents";
/** The built-in tool the check suggests: the search; `list_documents` reaches a knowledge base too. */
const SEARCH_TOOL = "search_documents";
const LIST_TOOL = "list_documents";

/** A persona that shows a greeting or a fallback whose text is empty. */
const PERSONA_MESSAGE_CODE = "persona_message_empty";
const PERSONA_DOCS = "/docs/concepts/personas";
/** Each persona switch and the text it shows; checked only where the instance's schema has both fields. */
const PERSONA_MESSAGES = [
  { switch: "greeting_enabled", text: "greeting_message", what: "greeting", when: "when a conversation starts" },
  { switch: "fallback_message_enabled", text: "fallback_message", what: "fallback message", when: "when the assistant has no answer" },
];

/** cavelon.yaml's solution and the one the package's harnesses (or an entry's harness_slug) name differ. */
const SOLUTION_MISMATCH_CODE = "solution_slug_mismatch";

/** A solution's folder holds a section the whole tenant shares (tenant_settings, model_registry, …). */
const TENANT_WIDE_CODE = "tenant_wide_section";

/** A test step's criterion with a `type`, on an instance whose schema does not describe a step's criteria. */
const ASSERTION_UNCHECKED_CODE = "test_assertion_unchecked";
const TESTING_DOCS = "/docs/concepts/regression-testing";

/**
 * The codes `validate` reports itself. The instance's catalog wins where it
 * lists the same code; these explain the rest without a round trip.
 */
export const KIT_CODES: CatalogEntry[] = [
  {
    code: SCHEMA_CODE,
    area: "package",
    message: "A package file does not match the instance's package schema.",
    hint: "Fix the field the finding names (file, line and path); copy the shape of a similar entry from `cavelon pull`.",
    docs: PACKAGE_DOCS,
  },
  {
    code: "package_section_unknown",
    area: "package",
    message: "A file in package/ holds a section this instance's package schema does not have.",
    hint: "Check the file name for a typo; a section from a newer instance is kept and sent, and this instance ignores it.",
    docs: PACKAGE_DOCS,
  },
  {
    code: "package_file_invalid",
    area: "package",
    message: "A package file is not valid YAML or JSON, or is a link to a file outside the solution or to none.",
    hint: "Fix the syntax at the line the finding names.",
    docs: PACKAGE_DOCS,
  },
  {
    code: ENDPOINT_LIMIT_CODE,
    area: "package",
    message: "A Model Registry row sets max_concurrent_requests without a base_url.",
    hint:
      "The limit belongs to a self-hosted endpoint: add the row's base_url, or remove max_concurrent_requests (empty means no limit). " +
      "In a solution's folder, apply sends model_registry only with --include-tenant-wide, for the whole tenant; `cavelon models set-limit` changes one row's limit without a package.",
    docs: PACKAGE_DOCS,
  },
  {
    code: ENDPOINT_LIMIT_NOT_CARRIED,
    area: "package",
    message: "This instance's package format does not carry max_concurrent_requests on Model Registry rows.",
    hint:
      "The import ignores it. Set it on the row in the Admin's model form, or with `cavelon models set-limit` (PATCH /api/v1/model-registry/{model_registry_id}). " +
      "In a solution's folder, apply sends model_registry only with --include-tenant-wide, for the whole tenant.",
    docs: PACKAGE_DOCS,
  },
  {
    code: BRANCH_WIDTH_CODE,
    area: "package",
    message: "A fan-out or Map loop sets max_concurrency above the branch width this instance publishes; it runs at the width.",
    hint: "Nothing fails: the node runs at most the published width at once. Lower max_concurrency to the width, or ask the operator to raise ORCHESTRATION_MAX_BRANCH_CONCURRENCY. `cavelon limits --key orchestration_max_branch_concurrency` shows it.",
    docs: BRANCH_DOCS,
  },
  {
    code: BRANCHES_SEQUENTIAL_CODE,
    area: "package",
    message: "This tenant runs fan-outs and Map loops in sequence: a switch for concurrent branches is off.",
    hint: "The result is the same, only slower. `cavelon limits --key orchestration_parallel_branches` names the switch that is off and who turns it on.",
    docs: BRANCH_DOCS,
  },
  {
    code: KB_WITHOUT_SEARCH_CODE,
    area: "package",
    message: "An agent is given knowledge bases, but no tool that searches or lists them reaches it, so it cannot read them.",
    hint:
      `A knowledge base reaches an agent only through a built-in document tool: add \`- tool_slug: ${SEARCH_TOOL}\` (or ${LIST_TOOL}, with read_document to read ` +
      "what it lists) to the tool_assignments of the skill that names the knowledge base, or of the agent. `cavelon docs get reference/builtin-tools` shows the binding.",
    docs: SEARCH_DOCS,
  },
  {
    code: ASSERTION_UNCHECKED_CODE,
    area: "package",
    message: "A test step has assertions (criteria with a type), and this instance's package schema does not describe a step's criteria, so validate cannot check them.",
    hint:
      "An instance that knows the type checks the assertion in code; one that does not grades it as a judge criterion. " +
      "`cavelon docs get concepts/regression-testing` says which types this instance knows; a newer instance publishes them in its package schema.",
    docs: TESTING_DOCS,
  },
  {
    code: PERSONA_MESSAGE_CODE,
    area: "package",
    message: "The persona turns a greeting or a fallback message on, but its text is empty.",
    hint:
      "Write the text in persona.yaml (greeting_message, fallback_message) in the language the assistant answers in, or set " +
      "greeting_enabled / fallback_message_enabled to false. The persona says who the assistant is for every agent of the solution.",
    docs: PERSONA_DOCS,
  },
  {
    code: DUPLICATE_CODE,
    area: "package",
    message: "Two entries of one section have the same key (slug, or name for a knowledge base).",
    hint: "Rename or remove one of them: the import keeps only one entry per key.",
    docs: IMPORT_DOCS,
  },
  {
    code: REFERENCE_MISSING_CODE,
    area: "package",
    message: "An agent hands off to an agent that is not in the package, or a test step's assertion (answered_by, handoff_to) names one.",
    hint: "Fix the to_agent_slug or the assertion's value (the finding suggests the closest slug), or add the agent to package/agents.yaml.",
    docs: PACKAGE_DOCS,
  },
  {
    code: REFERENCE_UNKNOWN_CODE,
    area: "package",
    message: "A skill, tool, knowledge base or solution is named (by an agent, a skill or a test step's assertion) that is neither in the package nor among what the tenant held at the last pull.",
    hint:
      "Fix the name (the finding suggests the closest one), or add the entry to the package. The import preview blocks a reference it cannot resolve, " +
      "so validate --strict fails on it. If it was created on the instance since, `cavelon pull` refreshes the list in .cavelon/inventory.json.",
    docs: PACKAGE_DOCS,
  },
  {
    code: FIELD_UNKNOWN_CODE,
    area: "package",
    message: "A package file sets a field this instance's package schema does not have; the import ignores it.",
    hint: "Check the field name for a typo (the finding suggests the closest field); a field from a newer instance is ignored by this one.",
    docs: IMPORT_DOCS,
  },
  {
    code: MODEL_UNKNOWN_CODE,
    area: "package",
    message: "An agent's llm_model is not in the tenant's model list as the kit last read it.",
    hint:
      "Fix the model id (the finding suggests the closest one), or register the model: the import preview blocks a model the tenant does not have. " +
      "`cavelon models list` shows the tenant's models and refreshes the list validate checks against.",
    docs: PACKAGE_DOCS,
  },
  {
    code: SOLUTION_MISMATCH_CODE,
    area: "package",
    message: "The package names another solution than cavelon.yaml: harnesses.yaml's slug, or an entry's harness_slug.",
    hint:
      "After copying a solution under another name, change the slug in package/harnesses.yaml and every harness_slug to the one cavelon.yaml names " +
      "(or set harness in cavelon.yaml to the package's); the import otherwise works on the solution the package names.",
    docs: PACKAGE_DOCS,
  },
  {
    code: TENANT_WIDE_CODE,
    area: "package",
    message: "A solution's folder holds a section the whole tenant shares, such as tenant_settings or model_registry.",
    hint:
      "`cavelon apply` leaves it out of the solution's import; `cavelon apply --include-tenant-wide` sends it, and then every solution of the tenant sees the change. " +
      "Remove the file unless that is meant. An instance that does not publish include_tenant_wide imports it with every apply.",
    docs: PACKAGE_DOCS,
  },
  {
    code: "package_file_duplicate",
    area: "package",
    message: "One section is in two files.",
    hint: "Keep one of them: package/<section>.yaml, or the section's own folder from cavelon.yaml's layout.",
    docs: PACKAGE_DOCS,
  },
];

/**
 * The entry that explains a finding of `validate`: the instance's rule codes
 * first, then the kit's own, then its API error codes. An API error's hint
 * speaks of the response (`detail.errors`); validate's finding names a file
 * and a line, which the kit's hint is written for.
 */
function findingEntry(catalog: ErrorCatalog | null | undefined, code: string): CatalogEntry | undefined {
  return catalog?.rule_codes?.find((e) => e.code === code) ?? KIT_CODES.find((e) => e.code === code) ?? catalog?.api_error_codes?.find((e) => e.code === code);
}

/**
 * One catalog entry by code: the instance's rule codes, its API error codes,
 * then the kit's own: `validate`'s codes ("kit"), and the errors the CLI
 * raises itself ("cli").
 */
export function catalogEntry(catalog: ErrorCatalog | null | undefined, code: string): (CatalogEntry & { kind: "rule" | "api" | "kit" | "cli" }) | undefined {
  const rule = catalog?.rule_codes?.find((e) => e.code === code);
  if (rule) return { ...rule, kind: "rule" };
  const api = catalog?.api_error_codes?.find((e) => e.code === code);
  if (api) return { ...api, kind: "api" };
  const kit = KIT_CODES.find((e) => e.code === code);
  if (kit) return { ...kit, kind: "kit" };
  const cli = kitErrorEntry(code);
  return cli ? { ...cli, kind: "cli" } : undefined;
}

/** The package format version the manifest names. */
export function packageVersionOf(pkg: Record<string, unknown>): string | undefined {
  const manifest = pkg.manifest;
  if (!manifest || typeof manifest !== "object") return undefined;
  const version = (manifest as Record<string, unknown>).package_version;
  return typeof version === "string" ? version : undefined;
}

function compile(schema: PackageSchema) {
  // The schema's own $id is a path on the instance; ajv needs none to check.
  const { $id: _id, $schema: _schema, ...body } = schema;
  const ajv = new Ajv2020({ strict: false, allErrors: true, verbose: true, validateSchema: false, validateFormats: false });
  return ajv.compile(body);
}

/**
 * The errors worth showing. Where a value matches no branch of an
 * `anyOf`/`oneOf` (a step's criteria are a text, a judge criterion or one of
 * several assertions by `type`), only the errors of the branch it comes
 * closest to: a branch of another JSON type, or one whose `const` or `enum`
 * on a field of the value (its `type`) does not match, is far; otherwise the
 * fewer errors, the closer. Ajv reports an inner choice before the one around
 * it, so inner choices are made first and an outer one counts what is left of
 * them. An error inside a `$ref`'d branch carries the referenced definition's
 * path, which is how it is told to that branch; `verbose` errors carry the
 * choice's branches.
 */
function closestBranchErrors(errors: ErrorObject[]): ErrorObject[] {
  const dropped = new Set<ErrorObject>();
  // The schema path an error counts under once an inner choice kept it: that choice's own.
  const countedAt = new Map<ErrorObject, string>();
  const pathOf = (e: ErrorObject) => countedAt.get(e) ?? e.schemaPath;
  const isChoice = (e: ErrorObject) => e.keyword === "anyOf" || e.keyword === "oneOf";
  errors.forEach((choice, index) => {
    if (!isChoice(choice)) return;
    const list = choice.schema;
    if (!Array.isArray(list)) return;
    const prefixes = list.map((branch, i) => {
      const ref = branch && typeof branch === "object" ? (branch as Record<string, unknown>).$ref : undefined;
        return [`${choice.schemaPath}/${i}/`, ...(typeof ref === "string" && ref.startsWith("#/") ? [`${ref}/`] : [])];
    });
    const here = choice.instancePath;
    const byBranch = new Map<number, ErrorObject[]>();
    for (const error of errors.slice(0, index)) {
      if (dropped.has(error) || isChoice(error)) continue;
      if (error.instancePath !== here && !error.instancePath.startsWith(`${here}/`)) continue;
      const branch = prefixes.findIndex((list) => list.some((prefix) => pathOf(error).startsWith(prefix)));
      if (branch >= 0) byBranch.set(branch, [...(byBranch.get(branch) ?? []), error]);
    }
    const distance = (list: ErrorObject[]) =>
      list.reduce((sum, e) => {
        if (e.keyword === "type" && e.instancePath === here) return sum + 1000;
        const field = e.instancePath.startsWith(`${here}/`) && !e.instancePath.slice(here.length + 1).includes("/");
        return sum + ((e.keyword === "const" || e.keyword === "enum") && field ? 100 : 1);
      }, 0);
    const ranked = [...byBranch.values()].map((list) => ({ list, distance: distance(list) })).sort((a, b) => a.distance - b.distance);
    // A tie says nothing about which branch was meant: all of them stay.
    if (ranked.length < 2 || ranked[0]!.distance === ranked[1]!.distance) return;
    for (const other of ranked.slice(1)) for (const error of other.list) dropped.add(error);
    for (const error of ranked[0]!.list) countedAt.set(error, pathOf(choice));
  });
  return errors.filter((e) => !dropped.has(e));
}

function describe(error: ErrorObject): { pointer: string; message: string } {
  const params = error.params as Record<string, unknown>;
  if (error.keyword === "additionalProperties") {
    return { pointer: error.instancePath, message: `field "${String(params.additionalProperty)}" is not allowed here` };
  }
  if (error.keyword === "required") {
    return { pointer: error.instancePath, message: `missing required field "${String(params.missingProperty)}"` };
  }
  if (error.keyword === "enum") {
    return { pointer: error.instancePath, message: `must be one of ${(params.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(", ")}` };
  }
  if (error.keyword === "const") {
    return { pointer: error.instancePath, message: `must be ${JSON.stringify(params.allowedValue)}` };
  }
  return { pointer: error.instancePath, message: error.message ?? "is invalid" };
}

export interface CheckOptions {
  schema: PackageSchema;
  catalog?: ErrorCatalog | null;
  /** The package versions the instance accepts, from its capabilities. */
  accepted?: string[];
  /** The instance's published limits, for the branch concurrency warnings; none checks nothing. */
  limits?: PublishedLimits;
  /** What the tenant held at the last pull, for references to it and agents' models; none checks only the package. */
  inventory?: TenantInventory;
  /** The solution cavelon.yaml names (slug or id), to check the package names the same. */
  solution?: string;
}

export function checkPackage(disk: PackageOnDisk, options: CheckOptions): Finding[] {
  const findings: Finding[] = [...disk.findings];
  const known = new Set(schemaSections(options.schema));
  for (const section of Object.keys(disk.package)) {
    if (known.has(section)) continue;
    const source = disk.sources[section];
    findings.push({
      code: "package_section_unknown",
      severity: "warning",
      file: Array.isArray(source) ? source[0]?.file : source?.file,
      path: section,
      message: `This instance's package schema has no section "${section}". apply sends it as it is, and the instance ignores it (the preview lists it under "ignored").`,
    });
  }

  const version = packageVersionOf(disk.package);
  if (version && options.accepted?.length && !options.accepted.includes(version)) {
    const at = locate(disk, "/manifest/package_version");
    findings.push({
      code: "package_version_unsupported",
      severity: "error",
      ...at,
      message: `The package is written in format ${version}; this instance accepts ${options.accepted.join(", ")}.`,
    });
  }

  const validate = compile(options.schema);
  if (!validate(disk.package)) {
    const seen = new Set<string>();
    const errors = validate.errors ?? [];
    // A value of a union whose `type` names none of its shapes: one finding with the type it comes closest to, not one per shape.
    const misnamed = misnamedVariants(options.schema, disk.package).filter((m) => errors.some((e) => within(e.instancePath, m.pointer)));
    for (const m of misnamed) {
      findings.push({
        code: SCHEMA_CODE,
        severity: "error",
        ...locate(disk, `${m.pointer}/${m.field}`),
        message:
          `${m.field} "${m.value}" is none of the types this field takes (${m.allowed.join(", ")}).` + (m.suggestion ? ` Did you mean "${m.suggestion}"?` : ""),
        ...(m.suggestion ? { suggestion: m.suggestion } : {}),
        hint: schemaHint(disk.package, m.pointer),
      });
    }
    const unreadable = new Set(disk.unreadable ?? []);
    for (const error of closestBranchErrors(errors)) {
      // anyOf reports each branch and then itself; the branches say more.
      if (error.keyword === "anyOf" || error.keyword === "oneOf") continue;
      if (misnamed.some((m) => within(error.instancePath, m.pointer))) continue;
      // A section whose file could not be read is missing here; its file's finding says why.
      if (error.keyword === "required" && error.instancePath === "" && unreadable.has(String((error.params as Record<string, unknown>).missingProperty))) continue;
      const { pointer, message } = describe(error);
      const key = `${pointer} ${message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // A missing manifest is the export's, not something to write by hand from the schema.
      const manifest = error.keyword === "required" && pointer === "" && (error.params as Record<string, unknown>).missingProperty === MANIFEST_SECTION;
      findings.push({ code: SCHEMA_CODE, severity: "error", ...locate(disk, pointer), message, hint: manifest ? manifestHint() : schemaHint(disk.package, pointer) });
    }
  }

  findings.push(...checkEndpointLimits(disk, options.schema));
  findings.push(...checkBranchConcurrency(disk, options.limits));
  findings.push(...checkKnowledgeSearch(disk));
  findings.push(...checkUnknownFields(disk, options.schema, findings));
  findings.push(...checkReferences(disk, options.inventory));
  findings.push(...checkModels(disk, options.inventory));
  findings.push(...checkPersonaMessages(disk, options.schema));
  findings.push(...checkUncheckedAssertions(disk, options.schema));
  findings.push(...checkSolutionSlug(disk, options.solution));
  findings.push(...checkTenantWide(disk, options.schema, options.solution));
  noteTenantWide(findings, options.schema, options.solution);

  for (const finding of findings) {
    const entry = findingEntry(options.catalog, finding.code);
    if (!entry) continue;
    finding.hint ??= entry.hint ?? undefined;
    finding.docs ??= entry.docs;
  }
  return findings;
}

/** The properties of a section's entries, following one local $ref. */
function entryProperties(schema: PackageSchema, section: string): Record<string, unknown> | undefined {
  let entry = (schema.properties?.[section] as { items?: Record<string, unknown> } | undefined)?.items;
  const ref = typeof entry?.$ref === "string" ? entry.$ref : undefined;
  if (ref?.startsWith("#/$defs/")) entry = (schema.$defs as Record<string, Record<string, unknown>> | undefined)?.[ref.slice("#/$defs/".length)];
  const properties = entry?.properties;
  return properties && typeof properties === "object" ? (properties as Record<string, unknown>) : undefined;
}

/**
 * A Model Registry row's max_concurrent_requests limits a self-hosted
 * endpoint, so the instance accepts it only with a base_url. Where the
 * package schema does not carry the field, the import ignores it: say so.
 */
function checkEndpointLimits(disk: PackageOnDisk, schema: PackageSchema): Finding[] {
  const rows = disk.package[REGISTRY_SECTION];
  if (!Array.isArray(rows)) return [];
  const carried = Boolean(entryProperties(schema, REGISTRY_SECTION)?.[ENDPOINT_LIMIT_FIELD]);
  const findings: Finding[] = [];
  rows.forEach((row: unknown, index) => {
    if (!row || typeof row !== "object") return;
    const entry = row as Record<string, unknown>;
    const limit = entry[ENDPOINT_LIMIT_FIELD];
    if (limit === undefined || limit === null) return;
    const at = locate(disk, `/${REGISTRY_SECTION}/${index}/${ENDPOINT_LIMIT_FIELD}`);
    const name = typeof entry.model_id === "string" ? ` "${entry.model_id}"` : "";
    if (!carried) {
      findings.push({
        code: ENDPOINT_LIMIT_NOT_CARRIED,
        severity: "warning",
        ...at,
        message: `Model${name} sets ${ENDPOINT_LIMIT_FIELD}, which this instance's package format does not carry; the import ignores it.`,
      });
    } else if (typeof entry.base_url !== "string" || !entry.base_url.trim()) {
      findings.push({
        code: ENDPOINT_LIMIT_CODE,
        severity: "error",
        ...at,
        message: `Model${name} sets ${ENDPOINT_LIMIT_FIELD} without a base_url; the limit belongs to a self-hosted endpoint.`,
      });
    }
  });
  return findings;
}

/** A node or edge config that runs branches: its name and where it is. */
interface BranchingConfig {
  name: string;
  pointer: string;
  config: Record<string, unknown>;
}

const asObject = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/**
 * The configs in the package that may run branches concurrently: an
 * orchestration node or graph edge config, or an agent handoff's
 * `orchestration_config`, that sets `max_concurrency`, runs a Map loop
 * (`mode: map`) or fans out (`fanout`, `execution: parallel`).
 */
function branchingConfigs(pkg: Record<string, unknown>): BranchingConfig[] {
  const found: BranchingConfig[] = [];
  const runsBranches = (c: Record<string, unknown>) => typeof c.max_concurrency === "number" || c.mode === "map" || c.fanout === true || c.execution === "parallel";
  const registry = asObject(pkg.registry_entities);
  const nodes = Array.isArray(registry?.orchestration_nodes) ? registry.orchestration_nodes : [];
  nodes.forEach((raw: unknown, i) => {
    const node = asObject(raw);
    const config = asObject(node?.config);
    if (config && runsBranches(config)) found.push({ name: `node "${String(node!.slug ?? i)}"`, pointer: `/registry_entities/orchestration_nodes/${i}/config`, config });
  });
  const edges = Array.isArray(registry?.graph_edges) ? registry.graph_edges : [];
  edges.forEach((raw: unknown, i) => {
    const edge = asObject(raw);
    const config = asObject(edge?.config);
    const end = (ref: unknown) => String(asObject(ref)?.slug ?? "?");
    if (config && runsBranches(config)) found.push({ name: `edge ${end(edge!.from_node_ref)} → ${end(edge!.to_node_ref)}`, pointer: `/registry_entities/graph_edges/${i}/config`, config });
  });
  const agents = Array.isArray(pkg.agents) ? pkg.agents : [];
  agents.forEach((raw: unknown, i) => {
    const agent = asObject(raw);
    const handoffs = Array.isArray(agent?.handoffs) ? agent.handoffs : [];
    handoffs.forEach((h: unknown, j) => {
      const handoff = asObject(h);
      const config = asObject(handoff?.orchestration_config);
      if (config && runsBranches(config)) {
        found.push({ name: `edge ${String(agent!.slug ?? i)} → ${String(handoff!.to_agent_slug ?? "?")}`, pointer: `/agents/${i}/handoffs/${j}/orchestration_config`, config });
      }
    });
  });
  return found;
}

/**
 * Warnings, never errors: a node's `max_concurrency` above the published width
 * is capped to it, and with concurrent branches off for the tenant every
 * fan-out and Map loop runs in sequence. Both import and run the same.
 */
function checkBranchConcurrency(disk: PackageOnDisk, limits: PublishedLimits | undefined): Finding[] {
  const branches = branchConcurrency(limits);
  if (!branches) return [];
  const configs = branchingConfigs(disk.package);
  const findings: Finding[] = [];
  const width = branches.width;
  if (width !== null) {
    for (const c of configs) {
      const requested = c.config.max_concurrency;
      if (typeof requested !== "number" || requested <= width) continue;
      findings.push({
        code: BRANCH_WIDTH_CODE,
        severity: "warning",
        ...locate(disk, `${c.pointer}/max_concurrency`),
        message:
          `The ${c.name} sets max_concurrency ${requested}, above this instance's branch width of ${width} ` +
          `(${branches.width_setting ?? BRANCH_WIDTH_KEY}): it runs at most ${width} branches at once.`,
      });
    }
  }
  if (branches.parallel === false && configs.length) {
    const names = configs.slice(0, 3).map((c) => c.name).join(", ") + (configs.length > 3 ? `, and ${configs.length - 3} more` : "");
    findings.push({
      code: BRANCHES_SEQUENTIAL_CODE,
      severity: "warning",
      ...locate(disk, configs[0]!.pointer),
      message:
        `This tenant runs fan-outs and Map loops in sequence, so the ${names} run${configs.length === 1 ? "s" : ""} one branch after another ` +
        `(same result, slower): ${offText(branches)}.`,
    });
  }
  return findings;
}

const asList = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.map(asObject).filter((e): e is Record<string, unknown> => e !== undefined) : [];
const active = (e: Record<string, unknown>) => e.is_active !== false;
const quoted = (names: string[]) => names.map((n) => `"${n}"`).join(", ");

/**
 * A knowledge base named on a skill or an agent's tool assignment is only
 * scoping: the agent reads it through a built-in document tool that searches
 * or lists it, from its own tool assignments or from one of its skills. Naming
 * knowledge bases on another tool (a webhook, an MCP tool) reaches nothing. Without one, the agent cannot search
 * and answers from memory, while the import and the preview accept the
 * package. A warning: an agent may hold a skill this package does not carry,
 * and then the check stays silent.
 */
function checkKnowledgeSearch(disk: PackageOnDisk): Finding[] {
  const pkg = disk.package;
  // A tenant may carry the built-in under another slug; its builtin_key says what it is.
  const searchSlugs = new Set(KNOWLEDGE_TOOL_KEYS);
  for (const tool of asList(pkg.tools)) {
    if (typeof tool.slug === "string" && typeof tool.builtin_key === "string" && KNOWLEDGE_TOOL_KEYS.has(tool.builtin_key)) searchSlugs.add(tool.slug);
  }
  const searches = (assignments: unknown) => asList(assignments).some((a) => active(a) && typeof a.tool_slug === "string" && searchSlugs.has(a.tool_slug));
  const skills = asList(pkg.skills);
  const skillIndex = new Map<string, number>();
  skills.forEach((skill, i) => {
    if (typeof skill.slug === "string") skillIndex.set(skill.slug, i);
  });

  const findings: Finding[] = [];
  asList(pkg.agents).forEach((agent, i) => {
    if (!active(agent)) return;
    const named: Array<{ names: string[]; pointer: string; via?: string }> = [];
    let reached = searches(agent.tool_assignments);
    let unseen = false;
    asList(agent.tool_assignments).forEach((assignment, j) => {
      const names = asObject(assignment.config_overrides)?.knowledge_base_names;
      const list = Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [];
      if (active(assignment) && list.length) named.push({ names: list, pointer: `/agents/${i}/tool_assignments/${j}/config_overrides/knowledge_base_names` });
    });
    for (const assignment of asList(agent.skill_assignments)) {
      if (!active(assignment) || typeof assignment.skill_slug !== "string") continue;
      const k = skillIndex.get(assignment.skill_slug);
      if (k === undefined) {
        unseen = true;
        continue;
      }
      const skill = skills[k]!;
      if (!active(skill)) continue;
      if (searches(skill.tool_assignments)) reached = true;
      const names = asList(skill.knowledge_base_assignments)
        .filter(active)
        .map((a) => a.knowledge_base_name)
        .filter((n): n is string => typeof n === "string");
      if (names.length) named.push({ names, pointer: `/skills/${k}/knowledge_base_assignments`, via: assignment.skill_slug });
    }
    if (reached || unseen || !named.length) return;
    const names = [...new Set(named.flatMap((n) => n.names))];
    const first = named[0]!;
    const agentName = typeof agent.slug === "string" ? ` "${agent.slug}"` : "";
    findings.push({
      code: KB_WITHOUT_SEARCH_CODE,
      severity: "warning",
      ...locate(disk, first.pointer),
      message:
        `The agent${agentName} is given the knowledge base${names.length === 1 ? "" : "s"} ${quoted(names)}` +
        `${first.via ? ` through the skill "${first.via}"` : ""}, but no tool that searches or lists ${names.length === 1 ? "it" : "them"} reaches the agent, ` +
        `so it cannot read ${names.length === 1 ? "it" : "them"}: add ${SEARCH_TOOL} (or ${LIST_TOOL}) to the ${first.via ? "skill's" : "agent's"} tool_assignments.`,
    });
  });
  return findings;
}

/**
 * A greeting or fallback that is on with no text: the instance shows nothing,
 * or its own wording, where the solution meant its own. A switch the file
 * leaves out counts as the schema's default.
 */
/** A schema node with its local `$ref` followed. */
function schemaNode(schema: PackageSchema, node: unknown): Record<string, unknown> | undefined {
  let at = asObject(node);
  for (let hops = 0; at && typeof at.$ref === "string" && hops < 10; hops++) {
    const ref = at.$ref as string;
    at = ref.startsWith("#/$defs/") ? asObject((schema.$defs as Record<string, unknown> | undefined)?.[ref.slice("#/$defs/".length)]) : undefined;
  }
  return at;
}

/** The schema of a list field's entries: the `items` of its one array branch. */
function listItems(schema: PackageSchema, node: unknown): Record<string, unknown> | undefined {
  const at = schemaNode(schema, node);
  if (!at) return undefined;
  const branches = Array.isArray(at.anyOf) ? at.anyOf.map((b) => schemaNode(schema, b)) : [at];
  const arrays = branches.filter((b) => b?.type === "array");
  return arrays.length === 1 && "items" in arrays[0]! ? (asObject(arrays[0]!.items) ?? {}) : undefined;
}

/**
 * A step's assertions (criteria with a `type`) on an instance whose schema
 * says nothing of a step's criteria: validate cannot check them, and an
 * instance that does not know a type grades it as a judge criterion. Said
 * once per suite file. An instance that describes them is checked by the
 * schema instead.
 */
function checkUncheckedAssertions(disk: PackageOnDisk, schema: PackageSchema): Finding[] {
  const field = (node: Record<string, unknown> | undefined, name: string) => (asObject(schemaNode(schema, node)?.properties) ?? {})[name];
  const step = schemaNode(schema, listItems(schema, field(listItems(schema, field(listItems(schema, schema.properties?.test_suites), "test_cases")), "steps")));
  const criteria = listItems(schema, field(step, "evaluation_criteria"));
  const described = !criteria || Object.keys(criteria).some((k) => k !== "title" && k !== "description");
  if (described) return [];
  const suites = Array.isArray(disk.package.test_suites) ? disk.package.test_suites : [];
  const byFile = new Map<string, { at: ReturnType<typeof locate>; types: Set<string> }>();
  suites.forEach((suite, s) => {
    (Array.isArray(asObject(suite)?.test_cases) ? (asObject(suite)!.test_cases as unknown[]) : []).forEach((testCase, c) => {
      (Array.isArray(asObject(testCase)?.steps) ? (asObject(testCase)!.steps as unknown[]) : []).forEach((step, t) => {
        const list = asObject(step)?.evaluation_criteria;
        (Array.isArray(list) ? list : []).forEach((criterion, i) => {
          const type = asObject(criterion)?.type;
          if (typeof type !== "string") return;
          const at = locate(disk, `/test_suites/${s}/test_cases/${c}/steps/${t}/evaluation_criteria/${i}`);
          const key = at.file ?? "";
          if (!byFile.has(key)) byFile.set(key, { at, types: new Set() });
          byFile.get(key)!.types.add(type);
        });
      });
    });
  });
  return [...byFile.values()].map(({ at, types }) => ({
    code: ASSERTION_UNCHECKED_CODE,
    severity: "warning" as const,
    ...at,
    message:
      `This instance's package schema does not describe a step's criteria, so the assertions here (${[...types].join(", ")}) are not checked. ` +
      "An instance that does not know a type grades it as a judge criterion instead of checking it in code.",
  }));
}

function checkPersonaMessages(disk: PackageOnDisk, schema: PackageSchema): Finding[] {
  const persona = asObject(disk.package[PERSONA_SECTION]);
  const fields = sectionFields(schema, PERSONA_SECTION);
  if (!persona || !fields) return [];
  const findings: Finding[] = [];
  for (const pair of PERSONA_MESSAGES) {
    if (!fields[pair.switch] || !fields[pair.text]) continue;
    const on = persona[pair.switch] ?? fields[pair.switch]!.default;
    const text = persona[pair.text];
    if (on !== true || (typeof text === "string" && text.trim())) continue;
    const at = locate(disk, `/${PERSONA_SECTION}/${pair.switch in persona ? pair.switch : pair.text}`);
    findings.push({
      code: PERSONA_MESSAGE_CODE,
      severity: "warning",
      ...at,
      message:
        `${pair.switch} is ${pair.switch in persona ? "true" : "true by default"}, but ${pair.text} is empty: ` +
        `the solution shows no ${pair.what} of its own ${pair.when}. Write ${pair.text}, or set ${pair.switch} to false.`,
    });
  }
  return findings;
}

/** Whether a JSON pointer is the other or inside it. */
const within = (pointer: string, outer: string) => pointer === outer || pointer.startsWith(`${outer}/`);

/**
 * The `cavelon schema` path of a place in the package: its keys without the
 * list indexes, ending at the object or list that holds the field
 * (`agents.handoffs` for /agents/0/handoffs/1/edge_type).
 */
export function schemaPathOf(pkg: Record<string, unknown>, pointer: string): string {
  const keys = pointer.split("/").slice(1).map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
  let value: unknown = pkg;
  const names: string[] = [];
  for (const key of keys) {
    const inner: unknown = Array.isArray(value) ? value[Number(key)] : asObject(value)?.[key];
    // A scalar is a field of the object around it, which is what `cavelon schema` shows.
    if (inner === undefined || inner === null || typeof inner !== "object") break;
    if (!Array.isArray(value)) names.push(key);
    value = inner;
  }
  return names.join(".");
}

/** Where a missing manifest comes from: the folder's cavelon.yaml names the instance and tenant both commands act in. */
function manifestHint(): string {
  return (
    `\`${folderCommand("pull")}\` writes the instance's manifest (the package format and the tenant the package is for); for a solution not on the instance ` +
    `yet, run \`${folderCommand("init")}\` again in this folder: it writes a minimal one.`
  );
}

/** The kit's hint for a schema finding: the command that shows the fields where it is. */
function schemaHint(pkg: Record<string, unknown>, pointer: string): string {
  const at = schemaPathOf(pkg, pointer);
  return at
    ? `Fix the field the finding names; \`${cavelonCommand("schema", at)}\` lists the fields there (type, required, allowed values) with a minimal entry.`
    : `Fix the field the finding names; \`${cavelonCommand("schema")}\` lists the sections, and \`${cavelonCommand("schema", fill("section"))}\` their fields.`;
}

interface MisnamedVariant {
  pointer: string;
  field: string;
  value: string;
  allowed: string[];
  suggestion?: string;
}

const propertiesIn = (node: Record<string, unknown>) => asObject(node.properties);

/** The values a field may hold, where its schema lists them (`const`, `enum`); undefined where it takes any. */
function listedValues(schema: PackageSchema, node: unknown): unknown[] | undefined {
  const values: unknown[] = [];
  for (const branch of branches(schema, node)) {
    if ("const" in branch) values.push(branch.const);
    else if (Array.isArray(branch.enum)) values.push(...branch.enum);
    else if (branch.type !== "null") return undefined;
  }
  return values.length ? values : undefined;
}

/**
 * Objects of a union of several shapes told apart by one field (a step's
 * criteria by `type`) whose field names none of them: the schema check would
 * report every shape's complaint. Read from the published schema: the field
 * that each shape defining it restricts to listed values.
 */
function misnamedVariants(schema: PackageSchema, pkg: Record<string, unknown>): MisnamedVariant[] {
  const found: MisnamedVariant[] = [];
  const walk = (value: unknown, node: unknown, pointer: string, depth: number) => {
    if (depth > 40) return;
    if (Array.isArray(value)) {
      const items = branches(schema, node).map((b) => b.items).find((i) => i !== undefined);
      if (items !== undefined) value.forEach((item, i) => walk(item, items, `${pointer}/${i}`, depth + 1));
      return;
    }
    const object = asObject(value);
    if (!object) return;
    const shapes = branches(schema, node).filter((b) => propertiesIn(b));
    if (shapes.length > 1) {
      for (const [field, given] of Object.entries(object)) {
        if (typeof given !== "string") continue;
        const defining = shapes.filter((shape) => propertiesIn(shape)![field] !== undefined);
        if (defining.length < 2) continue;
        const lists = defining.map((shape) => listedValues(schema, propertiesIn(shape)![field]));
        if (lists.some((l) => l === undefined)) continue;
        const allowed = [...new Set(lists.flat().filter((v): v is string => typeof v === "string"))];
        if (allowed.includes(given)) {
          const shape = defining.find((_, i) => lists[i]!.includes(given))!;
          for (const [key, inner] of Object.entries(object)) {
            const sub = propertiesIn(shape)![key];
            if (sub !== undefined) walk(inner, sub, `${pointer}/${key}`, depth + 1);
          }
          return;
        }
        found.push({ pointer, field, value: given, allowed: allowed.sort((a, b) => a.localeCompare(b, "en")), suggestion: closest(given, allowed) });
        return;
      }
    }
    const shape = shapes.length === 1 ? shapes[0]! : undefined;
    if (!shape) return;
    for (const [key, inner] of Object.entries(object)) {
      const sub = propertiesIn(shape)![key];
      if (sub !== undefined) walk(inner, sub, `${pointer}/${key}`, depth + 1);
    }
  };
  const sections = asObject(schema.properties) ?? {};
  for (const [section, value] of Object.entries(pkg)) if (section in sections) walk(value, sections[section], `/${section}`, 0);
  return found;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sections the whole tenant shares in a solution's folder: a pull leaves them
 * out unless asked, and an apply sends them only with --include-tenant-wide, so a
 * file of one is either meant for the tenant or left over. One warning each.
 */
function checkTenantWide(disk: PackageOnDisk, schema: PackageSchema, solution: string | undefined): Finding[] {
  if (!solution) return [];
  const shared = tenantWideSections(schema);
  return Object.keys(disk.package)
    .filter((section) => shared.has(section))
    .map((section) => {
      const source = disk.sources[section];
      return {
        code: TENANT_WIDE_CODE,
        severity: "warning" as const,
        file: Array.isArray(source) ? source[0]?.file : source?.file,
        path: section,
        message:
          `${section} is shared by the whole tenant, not this solution's: apply leaves it out unless --include-tenant-wide, which changes it for every solution ` +
          "(an instance that does not publish include_tenant_wide imports it with every apply). Remove the file unless that is meant.",
      };
    });
}

/**
 * A finding inside a tenant-wide section of a solution's folder (a Model
 * Registry row's limit, a schema error in tenant_settings) is about what a
 * solution's apply leaves out unless asked: say so, so that fixing it is not
 * taken to change the tenant with the next apply.
 */
function noteTenantWide(findings: Finding[], schema: PackageSchema, solution: string | undefined): void {
  if (!solution) return;
  const shared = tenantWideSections(schema);
  for (const finding of findings) {
    if (finding.code === TENANT_WIDE_CODE || !finding.path) continue;
    const section = /^\/?([A-Za-z0-9_]+)/.exec(finding.path)?.[1];
    if (!section || !shared.has(section)) continue;
    finding.message +=
      ` ${section} is tenant-wide: a solution's apply leaves it out unless --include-tenant-wide, which changes it for every solution of the tenant.`;
  }
}

/**
 * The package names another solution than cavelon.yaml, as after copying an
 * example under another name: harnesses.yaml holds no entry of that slug (or
 * name), or an agent's or suite's harness_slug names another. One warning per
 * section. Where the package has harnesses, an agent's harness_slug naming
 * one of them belongs to that one, and one naming none of them is a reference
 * the reference check reports; a suite's harness_slug, which that check does
 * not follow, warns here when it names none of them either. A solution named
 * by its id is not checked: the package cannot say it.
 */
function checkSolutionSlug(disk: PackageOnDisk, solution: string | undefined): Finding[] {
  if (!solution || UUID.test(solution)) return [];
  const pkg = disk.package;
  const harnesses = asList(pkg.harnesses);
  const own = harnesses.find((h) => h.slug === solution || h.name === solution);
  const slug = typeof own?.slug === "string" ? own.slug : solution;
  const findings: Finding[] = [];
  if (harnesses.length && !own) {
    const named = harnesses.map((h) => h.slug).filter((v): v is string => typeof v === "string");
    findings.push({
      code: SOLUTION_MISMATCH_CODE,
      severity: "warning",
      ...locate(disk, "/harnesses/0/slug"),
      message:
        `cavelon.yaml names the solution "${solution}", and the package's harnesses name ${quoted(named)}: ` +
        `rename the slug (and every harness_slug) to "${solution}", or set harness in cavelon.yaml to the package's.`,
    });
  }
  const packaged = new Set(harnesses.map((h) => h.slug).filter((v): v is string => typeof v === "string"));
  for (const section of harnesses.length ? ["test_suites"] : ["agents", "test_suites"]) {
    const entries = asList(pkg[section]);
    const fits = (name: string) => name === slug || packaged.has(name);
    const off = entries.flatMap((entry, i) => (typeof entry.harness_slug === "string" && !fits(entry.harness_slug) ? [{ i, name: entry.harness_slug }] : []));
    if (!off.length) continue;
    const names = [...new Set(off.map((o) => o.name))];
    findings.push({
      code: SOLUTION_MISMATCH_CODE,
      severity: "warning",
      ...locate(disk, `/${section}/${off[0]!.i}/harness_slug`),
      message:
        `${off.length} of the ${section} name${off.length === 1 ? "s" : ""} the solution ${quoted(names)} in harness_slug, and cavelon.yaml names "${slug}": ` +
        `set harness_slug to "${slug}".`,
    });
  }
  return findings;
}
