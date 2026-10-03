import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { BRANCH_WIDTH_KEY, branchConcurrency, offText } from "./branches.js";
import type { CatalogEntry, ErrorCatalog, PackageSchema } from "./contracts.js";
import type { PublishedLimits } from "./limits.js";
import { locate, schemaSections, type Finding, type PackageOnDisk } from "./package-files.js";

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
/** Branch concurrency: a node's width above the platform's, and branches that run in sequence. */
const BRANCH_WIDTH_CODE = "branch_width_capped";
const BRANCHES_SEQUENTIAL_CODE = "branches_run_in_sequence";
const BRANCH_DOCS = "/docs/concepts/capacity-and-concurrency#branch-concurrency";

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
    message: "A package file is not valid YAML or JSON.",
    hint: "Fix the syntax at the line the finding names.",
    docs: PACKAGE_DOCS,
  },
  {
    code: ENDPOINT_LIMIT_CODE,
    area: "package",
    message: "A Model Registry row sets max_concurrent_requests without a base_url.",
    hint: "The limit belongs to a self-hosted endpoint: add the row's base_url, or remove max_concurrent_requests (empty means no limit).",
    docs: PACKAGE_DOCS,
  },
  {
    code: ENDPOINT_LIMIT_NOT_CARRIED,
    area: "package",
    message: "This instance's package format does not carry max_concurrent_requests on Model Registry rows.",
    hint: "The import ignores it. Set it on the row in the Admin's model form, or with PATCH /api/v1/model-registry/{model_registry_id}.",
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
    code: "package_file_duplicate",
    area: "package",
    message: "One section is in two files.",
    hint: "Keep one of them: package/<section>.yaml, or the section's own folder from cavelon.yaml's layout.",
    docs: PACKAGE_DOCS,
  },
];

/** One catalog entry by code: the instance's rule codes, its API error codes, then the kit's own. */
export function catalogEntry(catalog: ErrorCatalog | null | undefined, code: string): (CatalogEntry & { kind: "rule" | "api" | "kit" }) | undefined {
  const rule = catalog?.rule_codes?.find((e) => e.code === code);
  if (rule) return { ...rule, kind: "rule" };
  const api = catalog?.api_error_codes?.find((e) => e.code === code);
  if (api) return { ...api, kind: "api" };
  const kit = KIT_CODES.find((e) => e.code === code);
  return kit ? { ...kit, kind: "kit" } : undefined;
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
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false, validateFormats: false });
  return ajv.compile(body);
}

function describe(error: ErrorObject): { pointer: string; message: string } {
  const params = error.params as Record<string, unknown>;
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
    for (const error of validate.errors ?? []) {
      // anyOf reports each branch and then itself; the branches say more.
      if (error.keyword === "anyOf" || error.keyword === "oneOf") continue;
      const { pointer, message } = describe(error);
      const key = `${pointer} ${message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ code: SCHEMA_CODE, severity: "error", ...locate(disk, pointer), message });
    }
  }

  findings.push(...checkEndpointLimits(disk, options.schema));
  findings.push(...checkBranchConcurrency(disk, options.limits));

  for (const finding of findings) {
    const entry = catalogEntry(options.catalog, finding.code);
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
