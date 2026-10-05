import path from "node:path";
import { parseDocument } from "yaml";
import { CAPACITY_CONCEPT_PAGE, CAPACITY_TUTORIAL_PAGE, capacityCodeIn, capacityHint, MODEL_ENDPOINT_BUSY } from "../capacity.js";
import { boolOption, intOption, positional, stringOption, type CommandSpec, type Context } from "../command.js";
import type { WarningEntry } from "../context.js";
import { Contracts, type CachedContract, type ErrorCatalog, type PackageSchema } from "../contracts.js";
import { CavelonError, ExitCode, usageError, type ExitCodeValue } from "../errors.js";
import { drivenByAgent } from "../agent-env.js";
import { confirmation, confirmGiven, confirmTokenRequired, shellTokenRequired } from "../confirm-token.js";
import { clip, keyValues } from "../format.js";
import { readTextFile, writeFileAtomic } from "../fsutil.js";
import { uncommitted } from "../git.js";
import { callStable, workflowOperation } from "../invoke.js";
import { deref, jsonBodySchema } from "../openapi.js";
import { harnessNotFoundError, lookupHarness, SLUG } from "../harness-ref.js";
import { defaultChangeLine, defaultCommands, named, readDefaultRoute, setDefaultRoute } from "../default-route.js";
import { ceilingHint, LIMIT_ABOVE_CEILING, parseLimits, readLimits, type PublishedLimits } from "../limits.js";
import {
  digest,
  fileDigest,
  fileDigests,
  listPreviews,
  loadPreview,
  previewExpiry,
  readItemFiles,
  readPulledFiles,
  rememberAppliedFiles,
  retiredPreview,
  retirePreviews,
  savePreview,
  writePulledFiles,
  writeState,
  type ImportRequest,
  type PullRecord,
  type RetiredPreview,
  type StoredPreview,
} from "../local-state.js";
import { catalogEntry, checkPackage, KIT_CODES, packageVersionOf } from "../package-check.js";
import { cliFix, similarCodes } from "../code-hints.js";
import { KIT_ERROR_CODES } from "../kit-codes.js";
import { pairOrderHint, pairOrderPointer } from "../pair-order.js";
import { readPackage, tenantWideSections, writePackage, type Finding, type ItemFiles, type PackageOnDisk, type WriteOptions } from "../package-files.js";
import { blockerDetails, blockerLines, changeLines, fieldChanges, locateBlockers, notApplied, notAppliedLines, tenantWideReport } from "../preview-report.js";
import { readPrincipal } from "../principal.js";
import type { ProjectConfig } from "../project.js";
import { CASE_STATUSES, caseStatus, TESTING_PAGE, type CaseStatus } from "../results.js";
import { KNOWLEDGE_OUTCOME_AREA, KNOWLEDGE_OUTCOME_PAGE, KNOWLEDGE_OUTCOMES, knowledgeOutcome, type KnowledgeOutcome } from "../trace-view.js";
import { isUuid, requireInstance, type Session } from "../session.js";
import { listedPages } from "./docs.js";
import { readInventory, readInventoryKinds, writeInventory, type InventoryKind } from "./inventory.js";
import { checkedBy, MODEL_UNKNOWN_CODE, missingInventory, REFERENCE_UNKNOWN_CODE } from "../package-references.js";
import { cavelonCommand, printedCommand } from "../printed.js";
import { secretSetCommand, variableSetCommand } from "./values.js";
import { maySetSecrets, SECRET_SETTER } from "../secret-access.js";

/**
 * The repository loop (plan 04, "Working with a coding agent"): `pull` brings
 * the instance's package into the files, `validate` checks them offline,
 * `apply` previews them and imports exactly a confirmed preview, `activate`
 * goes through the readiness gate. The commands wrap the few stable
 * operations the plan names (export, preview, import, readiness, activate).
 */

const HARNESS_OPTION = { type: "string" as const, value: "<harness>", description: "The solution (harness): its name, slug or id; default: env file, then cavelon.yaml." };
const ENV_OPTION = { type: "string" as const, value: "<name>", description: "Use env/<name>.yaml: its tenant, solution and runtime bindings." };

interface Harness {
  id: string;
  slug: string;
  name: string;
  status: string;
}

/** The solution folder a command needs; without one, the `init` that makes it, in the tenant this command was given. */
export function requireSolution(session: Session, harness?: string): ProjectConfig {
  if (!session.project) {
    throw new CavelonError(ExitCode.usage, {
      code: "no_solution",
      message: "This folder is not a Cavelon solution (no cavelon.yaml here or above).",
      hint: harness
        ? `Make it the folder of that solution first: ${cavelonCommand("init", "--harness", harness)}, then run this command again.`
        : `Run \`${cavelonCommand("init")}\`: it asks which solution, or a new one, on a terminal. \`${cavelonCommand("harness", "list")}\` shows the solutions.`,
    });
  }
  return session.project;
}

/** The harness slug or id to work on: option, env file, cavelon.yaml. */
function harnessRef(session: Session, input: Parameters<CommandSpec["run"]>[1]): { ref?: string; source?: string } {
  const option = stringOption(input, "harness");
  if (option) return { ref: option, source: "option" };
  if (session.envFile?.harness) return { ref: session.envFile.harness, source: `env/${session.envFile.name}.yaml` };
  if (session.project?.harness) return { ref: session.project.harness, source: "cavelon.yaml" };
  return {};
}

async function findHarness(ctx: Context, ref: string, source?: string): Promise<Harness> {
  const { harness, candidates } = await lookupHarness<Harness>(ctx, ref);
  if (!harness) throw harnessNotFoundError(ref, candidates, source);
  return harness;
}

/** Which copy of the package schema a command checked against. */
export interface SchemaUsed {
  /** The package format the schema describes. */
  package_version: string | null;
  source: "cache" | "instance" | "none";
  /** The instance version the copy was cached under. */
  instance_version: string | null;
  fetched_at: string | null;
  etag: string | null;
  sha256: string | null;
  /** A development build's copy past its time-to-live, used because the instance was not asked or could not answer. */
  stale: boolean;
}

type CapsShape = { contracts?: { package_versions?: { current?: string; accepted?: string[] } } };

/**
 * A contract file as `validate` reads it: the cached copy while it is trusted
 * (a release's, or a development build's within its time-to-live), else the
 * instance's, else the stale copy with a warning. Never the network when
 * offline.
 */
async function cachedFirst<T>(
  ctx: Context,
  what: string,
  cached: CachedContract<T> | undefined,
  offline: boolean,
  fetch: () => Promise<T | null>,
): Promise<{ value: T | null; source: "cache" | "instance" | "none" }> {
  if (cached && (offline || !cached.stale)) return { value: cached.value, source: "cache" };
  if (offline) return { value: null, source: "none" };
  try {
    const value = await fetch();
    // An instance that publishes nothing now (or not without a tenant) leaves the copy it published before.
    if (value === null && cached) return { value: cached.value, source: "cache" };
    return { value, source: "instance" };
  } catch (error) {
    if (!cached) throw error;
    ctx.warn(
      `Could not read the ${what} again from the instance (${error instanceof Error ? error.message : String(error)}); ` +
        `using the copy cached at ${cached.fetched_at ?? "an unknown time"} for development build ${cached.version}.`,
    );
    return { value: cached.value, source: "cache" };
  }
}

/**
 * The package schema for a version: cached, else from the instance unless
 * offline. A development build keeps its version while its schema changes, so
 * its copy is read again once past the time-to-live.
 */
export async function schemaFor(ctx: Context, version: string | undefined, offline: boolean): Promise<{ schema: PackageSchema | null; used: SchemaUsed }> {
  const contracts = await ctx.contracts();
  let wanted = version ?? (await contracts.cachedOnly<CapsShape>("capabilities.json"))?.value?.contracts?.package_versions?.current;
  const cached = wanted ? await contracts.cachedOnly<PackageSchema>(Contracts.packageSchemaFile(wanted)) : undefined;
  const { value: schema, source } = await cachedFirst(ctx, "package schema", cached, offline, async () => {
    wanted ??= (await contracts.capabilities())?.contracts?.package_versions?.current;
    return contracts.packageSchema(wanted);
  });
  const copy = source === "instance" && schema ? await contracts.cachedOnly<PackageSchema>(Contracts.packageSchemaFile(wanted ?? "current")) : source === "cache" ? cached : undefined;
  return {
    schema,
    used: {
      package_version: schema?.["x-package-version"] ?? wanted ?? null,
      source: schema ? source : "none",
      instance_version: copy?.version ?? null,
      fetched_at: copy?.fetched_at ?? null,
      etag: copy?.etag ?? null,
      sha256: copy?.sha256 ?? null,
      stale: copy?.stale ?? false,
    },
  };
}

/** The instance's error catalog: the cached one first, else fetched; null when it publishes none. */
export async function catalogFor(ctx: Context, offline: boolean): Promise<ErrorCatalog | null> {
  const contracts = await ctx.contracts();
  const cached = await contracts.cachedOnly<ErrorCatalog>("error-catalog.json");
  return (await cachedFirst(ctx, "error catalog", cached, offline, () => contracts.errorCatalog()).catch(() => ({ value: null }))).value;
}

/** The capabilities the instance last published: the cached ones first, else read now (never offline). */
async function capabilitiesFor(ctx: Context, offline: boolean): Promise<Record<string, unknown> | null> {
  const contracts = await ctx.contracts();
  const cached = await contracts.cachedOnly<Record<string, unknown>>("capabilities.json");
  const read = () => contracts.capabilities() as Promise<Record<string, unknown> | null>;
  return (await cachedFirst(ctx, "capabilities", cached, offline, read).catch(() => ({ value: null }))).value;
}

/**
 * The limits the instance last published, for validate's branch concurrency
 * warnings. Undefined when nothing is known; then nothing is checked.
 */
async function limitsFor(ctx: Context, offline: boolean): Promise<PublishedLimits | undefined> {
  const caps = await capabilitiesFor(ctx, offline);
  return caps ? parseLimits(caps) : undefined;
}

async function acceptedVersions(ctx: Context, offline: boolean): Promise<string[] | undefined> {
  return ((await capabilitiesFor(ctx, offline)) as CapsShape | null)?.contracts?.package_versions?.accepted;
}

/** Warnings about what the import preview blocks on: a name it cannot resolve on the instance. */
const BLOCKING_WARNINGS = new Set([REFERENCE_UNKNOWN_CODE, MODEL_UNKNOWN_CODE]);

function findingLine(f: Finding): string {
  const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "";
  const at = f.path ? ` ${f.path}` : "";
  return `${f.severity === "error" ? "error" : "warning"} ${f.code}  ${where}${at}: ${f.message}`;
}

// ---------------------------------------------------------------------------
// pull
// ---------------------------------------------------------------------------

/** Set one key of cavelon.yaml, keeping its comments and everything else. */
export async function setProjectKey(project: ProjectConfig, key: string, value: string): Promise<void> {
  const text = (await readTextFile(project.file)) ?? "";
  const doc = parseDocument(text);
  if (doc.get(key) === value) return;
  doc.set(key, value);
  await writeFileAtomic(project.file, doc.toString({ lineWidth: 0 }));
}

function uncommittedChanges(files: string[], what: string): CavelonError {
  return new CavelonError(ExitCode.conflict, {
    code: "uncommitted_changes",
    message: `${what}: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` and ${files.length - 5} more` : ""}.`,
    hint: "Commit them first (then resolve the difference in git), apply them with `cavelon apply`, or pass --force to discard them.",
    details: { files },
  });
}

/** The files whose bytes are not what the last pull or apply left. */
async function unknownStates(root: string, files: string[], known: Record<string, string>): Promise<string[]> {
  const out: string[] = [];
  for (const file of files) {
    const current = await fileDigest(path.join(root, file));
    if (current === undefined || current !== known[file]) out.push(file);
  }
  return out;
}

/**
 * Outside git, the package files pull would change or remove whose bytes are
 * not what the last pull left: a local edit, or a file no pull wrote (a suite
 * not applied yet). With no record of a pull, that is every such file.
 */
async function editedSincePull(project: ProjectConfig, pkg: Record<string, unknown>, schema: PackageSchema | null, options: WriteOptions): Promise<string[]> {
  const planned = await writePackage(project.root, project.layout, pkg, schema, { ...options, dryRun: true, placed: undefined });
  const pulled = await readPulledFiles(project.root);
  const edited: string[] = [];
  for (const file of [...planned.written, ...planned.removed]) {
    const current = await fileDigest(path.join(project.root, file));
    if (current !== undefined && current !== pulled[file]) edited.push(file);
  }
  return edited.sort((a, b) => a.localeCompare(b, "en"));
}

const EXPORT_ROUTE = "/api/v1/agent-graph/export";
const PREVIEW_ROUTE = "/api/v1/agent-graph/import/preview";
/** The flag, on the export's query and the import's body, that takes a solution's tenant-wide sections along. */
const INCLUDE_TENANT_WIDE = "include_tenant_wide";

/**
 * Whether this instance's export (a query parameter) or import (a request
 * field) takes `include_tenant_wide`. An instance that does carries a
 * solution's tenant-wide sections only when asked; an older one exports and
 * imports them with every solution. An OpenAPI that cannot be read takes
 * neither, so nothing it might not know is sent.
 */
async function takesTenantWide(ctx: Context, where: "export" | "import"): Promise<boolean> {
  if (where === "export") {
    const { doc, op } = await workflowOperation(ctx, "GET", EXPORT_ROUTE, "exporting packages");
    return Boolean(doc) && op.parameters.some((p) => p.name === INCLUDE_TENANT_WIDE);
  }
  const { doc, op } = await workflowOperation(ctx, "POST", PREVIEW_ROUTE, "previewing imports");
  const schema = jsonBodySchema(op);
  const properties = doc && schema ? (deref(doc, schema) as { properties?: Record<string, unknown> } | undefined)?.properties : undefined;
  return Boolean(properties?.[INCLUDE_TENANT_WIDE]);
}

/** The package file each section is read from, relative to the solution folder. */
function sectionFiles(disk: PackageOnDisk, sections: string[]): string[] {
  return sections.flatMap((section) => {
    const source = disk.sources[section];
    return (Array.isArray(source) ? source : source ? [source] : []).map((s) => s.file);
  });
}

export const pull: CommandSpec = {
  name: "pull",
  summary: "Write the instance's package into package/ (split along the schema's sections) and the inventory into .cavelon/.",
  description:
    "With a solution (--harness, or cavelon.yaml's harness), exports that solution; without one, the tenant's full configuration.\n" +
    "A file whose content did not change keeps its bytes, so `git diff` shows what changed on the instance; a field the export\n" +
    "spells out that the file leaves out (an empty list, a default) is no change. A test suite goes back to the file it was\n" +
    "pulled into or applied from, whatever its name. Files of sections the schema does not know are kept byte for byte.\n" +
    "A solution's pull leaves the tenant-wide sections (the tenant's settings, its model list) out of the folder, unless\n" +
    "--include-tenant-wide; it says when the export carries none. Refuses when package files have uncommitted changes, unless --force;\n" +
    "outside a git repository, when a file it would overwrite or remove changed since the last pull. A file as the last pull\n" +
    "or apply left it (digests in .cavelon/) counts as unchanged, committed or not.",
  readOnly: false,
  destructive: true,
  mcpEffect:
    "Reads the instance and changes nothing there. Writes the package files and .cavelon/ in the solution folder; refuses to " +
    "overwrite or remove a package file that changed since the last pull or apply and is not committed, unless force.",
  idempotent: true,
  mcpTool: "pull",
  options: {
    harness: { type: "string", value: "<harness>", description: "The solution to export, by name, slug or id; its slug is recorded in cavelon.yaml when it names none." },
    force: { type: "boolean", description: "Overwrite package files that have uncommitted changes since the last pull or apply." },
    "include-tenant-wide": {
      type: "boolean",
      formerly: "tenant-wide",
      description:
        "With a solution, also write the tenant-wide sections (tenant_settings, model_registry, …): asked of the export where the instance takes include_tenant_wide. Only `apply --include-tenant-wide` sends them back, for the whole tenant.",
    },
  },
  examples: ["cavelon pull --harness support", "cavelon pull --include-tenant-wide", "cavelon pull && git status --short -- package tests"],
  async run(ctx, input) {
    const session = await ctx.session();
    const project = requireSolution(session, stringOption(input, "harness"));
    const url = requireInstance(session);
    const layoutDirs = [project.layout.package, ...Object.values(project.layout.items)];
    const force = boolOption(input, "force");
    // Only package files count; an untracked .gitkeep loses nothing. Undefined outside git.
    // A file as the last pull or apply left it holds nothing the instance lacks, committed or not.
    const known = force ? {} : await readPulledFiles(project.root);
    const changed = force ? [] : (await uncommitted(project.root, layoutDirs))?.filter((f) => /\.(ya?ml|json)$/i.test(f));
    const dirty = changed && (await unknownStates(project.root, changed, known));
    if (dirty?.length) throw uncommittedChanges(dirty, "pull would overwrite uncommitted changes");
    const { ref } = harnessRef(session, input);
    let harness: Harness | undefined;
    if (ref) {
      harness = await findHarness(ctx, ref);
    }
    const scope = harness ? "agent_graph" : "full_config";
    const tenantWide = boolOption(input, "include-tenant-wide");
    if (tenantWide && !harness) ctx.warn("--include-tenant-wide applies to a solution's pull; the tenant's full configuration carries the tenant-wide sections anyway.");
    // A recent instance's export carries a solution's tenant-wide sections only when asked.
    const askTenantWide = Boolean(harness) && tenantWide && (await takesTenantWide(ctx, "export"));
    const exported = await callStable<Record<string, unknown>>(ctx, "GET", EXPORT_ROUTE, "exporting packages", {
      query: { scope, harness_id: harness?.id, ...(askTenantWide ? { [INCLUDE_TENANT_WIDE]: true } : {}) },
      timeoutMs: 120_000,
    });
    if (!exported || typeof exported !== "object" || Array.isArray(exported)) {
      throw new CavelonError(ExitCode.server, { code: "export_invalid", message: "The instance's export is not a package." });
    }
    const version = packageVersionOf(exported);
    const { schema } = await schemaFor(ctx, version, false);
    if (!schema) ctx.warn("The instance does not publish its package schema; every top-level key became a file of its own.");
    // A solution's folder holds the solution; the tenant's settings travel with it only when asked.
    const shared = tenantWideSections(schema);
    const skip = harness && !tenantWide ? shared : new Set<string>();
    const placed: ItemFiles = {};
    const options: WriteOptions = { skip, itemFiles: await readItemFiles(project.root), placed };
    if (dirty === undefined) {
      const edited = await editedSincePull(project, exported, schema, options);
      if (edited.length) {
        throw uncommittedChanges(edited, "This folder is not in a git repository, and pull would overwrite or remove files that changed since the last pull");
      }
    }
    const report = await writePackage(project.root, project.layout, exported, schema, options);
    await writePulledFiles(project.root, [...report.written, ...report.unchanged], placed);

    if (harness && !project.harness) await setProjectKey(project, "harness", harness.slug);
    if (version && project.packageVersion !== version) await setProjectKey(project, "package_version", version);

    const client = await ctx.client();
    const inventory = await writeInventory(ctx, project.root, ctx.io.now());
    const record: PullRecord = {
      at: ctx.io.now().toISOString(),
      instance: url,
      tenant_id: client.target.tenantId ?? null,
      harness: harness ? { id: harness.id, slug: harness.slug } : null,
      scope,
      package_version: version ?? null,
      files: report,
    };
    await writeState(project.root, "pull.json", JSON.stringify(record, null, 2));
    for (const file of report.kept) {
      const section = path.posix.basename(file).replace(/\.(ya?ml|json)$/i, "");
      ctx.warn(
        report.tenant_wide.includes(section)
          ? `Kept ${file} as it is: it holds a tenant-wide section, which pull leaves out of a solution's folder. apply leaves it out too, and \`apply --include-tenant-wide\` sends it for the whole tenant; remove the file unless you mean that.`
          : `Kept ${file}: its section is not in this instance's package schema.`,
      );
    }
    for (const section of report.refused) ctx.warn(`Did not write section ${JSON.stringify(section)}: its name is not a plain file name.`);
    // What --include-tenant-wide brought, so an export without any says so instead of writing nothing silently.
    // A section the export carries empty ([], {} or null) holds nothing of the tenant's, so it is not named.
    const pulledShared = harness && tenantWide ? Object.keys(exported).filter((section) => shared.has(section) && !emptyValue(exported[section])) : undefined;

    const rewritten = report.written.length + report.removed.length;
    const lines = [
      `Pulled ${harness ? `solution ${harness.name} (${harness.slug})` : "the tenant's full configuration"} into ${project.layout.package}/` +
        (Object.keys(project.layout.items).length ? ` and ${Object.values(project.layout.items).join("/, ")}/` : "") +
        ` (format ${version ?? "unknown"}).`,
      ...report.written.map((f) => `written    ${f}`),
      ...report.removed.map((f) => `removed    ${f}`),
      `${report.unchanged.length} file${report.unchanged.length === 1 ? "" : "s"} unchanged.`,
      ...(report.tenant_wide.length
        ? [`Left out the tenant-wide section${report.tenant_wide.length === 1 ? "" : "s"} ${report.tenant_wide.join(", ")} (--include-tenant-wide writes them).`]
        : []),
      ...(pulledShared
        ? [
            pulledShared.length
              ? `Tenant-wide: ${pulledShared.join(", ")} (shared by every solution of the tenant; only \`apply --include-tenant-wide\` sends them back).`
              : Object.keys(exported).some((section) => shared.has(section))
                ? "The export's tenant-wide sections are empty: the tenant has none of their settings yet."
                : `The export carries no tenant-wide sections${askTenantWide ? "" : " (this instance's export does not take include_tenant_wide)"}, so --include-tenant-wide wrote none.`,
          ]
        : []),
      `Inventory: ${inventory.file} (${inventory.counts.map((c) => `${c.count} ${c.label}`).join(", ")})`,
      // `git diff` alone shows nothing for a file git does not track yet, as every file of a first pull is.
      !rewritten
        ? "Nothing changed on the instance since the last pull."
        : dirty === undefined
          ? "See what changed: the files listed above (this folder is not in a git repository)."
          : `See what changed: git status --short -- ${layoutDirs.join(" ")} (new files), then git diff -- ${layoutDirs.join(" ")}`,
    ];
    return { data: { ...record, inventory, ...(pulledShared ? { tenant_wide_pulled: pulledShared } : {}) }, text: lines.join("\n") };
  },
};

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

/** A check validate could not make, and why. */
interface SkippedCheck {
  check: string;
  kind: InventoryKind;
  reason: string;
}

/**
 * The tenant's lists validate checks references against, read now for the
 * kinds the package needs and no pull or `models list` has read yet; never
 * offline. What still lacks a list is a check skipped, and said.
 */
async function inventoryFor(ctx: Context, project: ProjectConfig, disk: PackageOnDisk, offline: boolean) {
  let inventory = await readInventory(project.root);
  const missing = missingInventory(disk, inventory);
  let failed = missing;
  if (missing.length && !offline) {
    failed = await readInventoryKinds(ctx, project.root, missing, ctx.io.now());
    inventory = await readInventory(project.root);
  }
  const skipped: SkippedCheck[] = failed.map((kind) => ({
    check: checkedBy(kind),
    kind,
    reason: offline
      ? `--offline, and no list of the tenant's ${kind.replace("_", " ")} is cached; \`cavelon ${kind === "models" ? "models list" : "pull"}\` reads it`
      : `the tenant's ${kind.replace("_", " ")} could not be read`,
  }));
  return { inventory, skipped };
}

async function validatePackage(
  ctx: Context,
  project: ProjectConfig,
  offline: boolean,
): Promise<{ disk: PackageOnDisk; findings: Finding[]; schema: PackageSchema; schemaVersion: string | null; used: SchemaUsed; skipped: SkippedCheck[] }> {
  const disk = await readPackage(project.root, project.layout);
  const version = packageVersionOf(disk.package) ?? project.packageVersion;
  const { schema, used } = await schemaFor(ctx, version, offline);
  if (!schema) {
    throw new CavelonError(ExitCode.failure, {
      code: "package_schema_unavailable",
      message: `No package schema${version ? ` for format ${version}` : ""} is cached for ${requireInstance(await ctx.session())}.`,
      hint: offline
        ? "Run `cavelon validate` once without --offline (or `cavelon pull`) while the instance is reachable."
        : "The instance does not publish its package schema (/api/v1/meta/package-schema).",
    });
  }
  const { inventory, skipped } = await inventoryFor(ctx, project, disk, offline);
  const findings = checkPackage(disk, {
    schema,
    catalog: await catalogFor(ctx, offline),
    accepted: await acceptedVersions(ctx, offline),
    limits: await limitsFor(ctx, offline),
    inventory,
    solution: project.harness,
  });
  return { disk, findings, schema, schemaVersion: schema["x-package-version"] ?? version ?? null, used, skipped };
}

/** For --verbose: which copy of the schema validate checked against. */
function schemaUsedLine(used: SchemaUsed, ttlSeconds: (version: string) => number): string {
  const from = used.source === "instance" ? "read from the instance now" : `cached at ${used.fetched_at ?? "an unknown time"}`;
  const instance = used.instance_version ? `, instance ${used.instance_version}` : "";
  const id = [used.sha256 ? `sha256 ${used.sha256}` : "", used.etag ? `ETag ${used.etag}` : ""].filter(Boolean).join(", ");
  const kept =
    used.instance_version && Contracts.isDevelopment(used.instance_version)
      ? used.etag
        ? `; a development build: checked with its ETag after ${ttlSeconds(used.instance_version)} s`
        : `; a development build: read again after ${ttlSeconds(used.instance_version)} s`
      : "";
  const stale = used.stale ? " (past its time-to-live; the instance was not read)" : "";
  return `Schema: package format ${used.package_version ?? "?"}, ${from}${instance}${id ? ` (${id})` : ""}${kept}${stale}.`;
}

export const validate: CommandSpec = {
  name: "validate",
  summary: "Check the package files against the instance's package schema, offline.",
  description:
    "Uses the schema and error catalog cached by init, pull or apply; fetches them only when none is cached or a development\n" +
    "build's copy is past its time-to-live, and never with --offline. A development build keeps one version while its schema\n" +
    "changes, so its copy is read again after a minute (CAVELON_CONTRACT_TTL_SECONDS), or checked with the ETag the instance\n" +
    "sent with it; --verbose says which copy was used.\n" +
    "Warns (never fails) when a fan-out or Map loop's max_concurrency is above the instance's branch width, and when the\n" +
    "tenant runs fan-outs and Map loops in sequence, from the limits the instance last published.\n" +
    "References to skills, tools, knowledge bases, solutions and models outside the package are checked against the tenant's\n" +
    "lists in .cavelon/inventory.json (pull, models list); a list no command has read yet is read now, unless --offline, and a\n" +
    "check that cannot be made is named (`skipped` in --json). A reference that is in neither is a warning, as it may be created\n" +
    "on the instance before the import; the import preview blocks it otherwise, so validate does not say \"Valid\" then, and\n" +
    "--strict fails on every warning (exit 3).\n" +
    "Each finding carries a code: `cavelon explain <code>` says more. The import preview checks everything again on the server.\n\n" +
    "With --json, `warnings` is always a list of `{code, message}` objects: the warning findings (at most --limit), then the\n" +
    "warnings about the run, such as a stale copy of the schema, with code null. `warning_count` counts them all and\n" +
    "`error_count` the errors (`errors` is the same number); `findings` has each finding's file, line and hint; `blocking_count`\n" +
    "counts the warnings the import preview blocks on.",
  readOnly: true,
  idempotent: true,
  mcpTool: "validate",
  options: {
    offline: { type: "boolean", description: "Never contact the instance, even when nothing is cached." },
    limit: { type: "string", value: "<n>", description: "Print at most n findings (default 50)." },
    verbose: { type: "boolean", description: "Also say which copy of the package schema was used: cached or read now, when, and its hash." },
    strict: { type: "boolean", description: "Fail (exit 3) on warnings too, such as a reference the import preview will block unless it exists by then." },
  },
  async run(ctx, input) {
    const session = await ctx.session();
    const project = requireSolution(session);
    requireInstance(session);
    const limit = intOption(input, "limit", { min: 1, max: 1000, fallback: 50 })!;
    const strict = boolOption(input, "strict");
    const { disk, findings, schemaVersion, used, skipped } = await validatePackage(ctx, project, boolOption(input, "offline"));
    const errors = findings.filter((f) => f.severity === "error");
    const warnings = findings.filter((f) => f.severity === "warning");
    const blocking = warnings.filter((f) => BLOCKING_WARNINGS.has(f.code));
    const failed = errors.length > 0 || (strict && warnings.length > 0);
    if (disk.empty) ctx.warn(`No package files in ${project.layout.package}/ yet; \`cavelon pull\` brings an existing solution.`);
    const contracts = await ctx.contracts();
    const shown = findings.slice(0, limit);
    // One shape whether or not a warning about the run fires: the package's warnings with their codes, then the run's.
    const listed: WarningEntry[] = [
      ...warnings.slice(0, limit).map((f) => ({ code: f.code, message: f.message })),
      ...ctx.warnings.map((message) => ({ code: null, message })),
    ];
    const data = {
      valid: !failed,
      strict,
      schema_version: schemaVersion,
      schema: used,
      sections: Object.keys(disk.package).length,
      error_count: errors.length,
      warning_count: warnings.length + ctx.warnings.length,
      blocking_count: blocking.length,
      // Kept for readers written before error_count.
      errors: errors.length,
      warnings: listed,
      findings: shown,
      more: Math.max(0, findings.length - shown.length),
      skipped,
    };
    const counts = `${errors.length} error${errors.length === 1 ? "" : "s"}, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`;
    const verdict = errors.length
      ? `${counts}. \`cavelon explain <code>\` says more.`
      : strict && warnings.length
        ? `${counts}; --strict fails on warnings. \`cavelon explain <code>\` says more.`
        : blocking.length
          ? `No errors against package schema ${schemaVersion ?? "?"} (${data.sections} sections), but ${blocking.length === 1 ? "one reference" : `${blocking.length} references`} ` +
            `the import preview will block unless ${blocking.length === 1 ? "it exists" : "they exist"} on the instance by then (${counts}; --strict fails on warnings).`
          : `Valid against package schema ${schemaVersion ?? "?"} (${data.sections} sections${warnings.length ? `, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : ""}).`;
    const text = [
      ...(boolOption(input, "verbose") ? [schemaUsedLine(used, (v) => contracts.ttlSeconds(v))] : []),
      ...shown.map(findingLine),
      ...(data.more ? [`… and ${data.more} more (--limit).`] : []),
      ...skipped.map((s) => `Not checked: ${s.check} (${s.reason}).`),
      verdict,
    ].join("\n");
    return { data, text, exitCode: failed ? ExitCode.validation : ExitCode.ok };
  },
};

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

interface Preview {
  ready: boolean;
  preview_id?: string;
  mode?: string;
  summary?: { creates?: Record<string, number>; updates?: Record<string, number>; deletes?: Record<string, number>; references?: Record<string, number> };
  warnings?: string[];
  blockers?: string[];
  /** Recent instances: each blocker with its code, package path and hint. */
  blocker_details?: unknown;
  /** Recent instances: the per-field diff. */
  changes?: unknown;
  /** `not_applied` (recent instances): fields the import leaves as they are, with how to set them. */
  ignored?: { sections?: string[]; fields?: string[]; count?: number; not_applied?: unknown };
  impact?: {
    changed_tools?: string[];
    changed_knowledge_bases?: string[];
    active_harnesses?: Array<{ harness_slug?: string; name?: string; tools?: string[]; knowledge_bases?: string[]; sandboxes?: string[] }>;
    sandbox_writers?: Array<{ name?: string; sandbox_id?: string; writer_expires_at?: string }>;
  };
  loop_budgets?: Array<{ node_slug?: string; harness_slug?: string; limits?: Record<string, unknown>; worst_case_cost?: unknown }>;
  target_needs?: {
    secrets?: Array<ValueNeed | string>;
    variables?: Array<ValueNeed | string>;
    oauth_grants?: Array<{ kind?: string; tool_slug?: string | null; capability?: string }>;
    runtime_bindings?: Array<{ key?: string; kind?: string; label?: string }>;
    trigger_identities?: Array<{ trigger_slug?: string; harness_slug?: string; problems?: string[]; admin_path?: string }>;
  };
  [key: string]: unknown;
}

/** A secret or variable the target has no value for (declared by the package, or named as a placeholder in it). */
interface ValueNeed {
  name?: string;
  declared?: boolean;
  description?: string | null;
  references?: string[];
  redacted_on_export?: boolean;
}

function valueNeeds(list: Array<ValueNeed | string> | undefined): ValueNeed[] {
  return (list ?? []).map((n) => (typeof n === "string" ? { name: n } : n)).filter((n) => typeof n.name === "string" && n.name !== "");
}

/** The commands that set what the target still lacks: a person runs the secret ones, never the agent. */
function setCommands(preview: Preview, env?: string | null): { secrets: string[]; variables: string[] } {
  const needs = preview.target_needs ?? {};
  return {
    secrets: valueNeeds(needs.secrets).map((n) => secretSetCommand(n.name!, env)),
    variables: valueNeeds(needs.variables).map((n) => variableSetCommand(n.name!, env)),
  };
}

function needLines(needs: ValueNeed[], command: (name: string) => string, more: string): string {
  const shown = needs.slice(0, 10).map((n) => {
    const about = n.description ? ` (${clip(n.description, 80)})` : "";
    return `\n  - ${n.name}${about}: ${command(n.name!)}`;
  });
  return shown.join("") + (needs.length > 10 ? `\n  … ${needs.length - 10} more: ${more}` : "");
}

/** Each line on its own, indented under a key. */
function indented(lines: string[]): string {
  return lines.map((line) => "\n  " + line).join("");
}

function counts(map: Record<string, number> | undefined): string {
  const entries = Object.entries(map ?? {}).filter(([, n]) => n);
  return entries.length ? entries.map(([k, n]) => `${n} ${k}`).join(", ") : "";
}

function list(items: string[], max = 10): string {
  return items.length > max ? `${items.slice(0, max).join(", ")} and ${items.length - max} more` : items.join(", ");
}

/** What the target still needs, one line per kind, with the command or the Admin path that provides it. */
function needsLines(needs: NonNullable<Preview["target_needs"]>): Array<[string, unknown]> {
  const lines: Array<[string, unknown]> = [];
  const secrets = valueNeeds(needs.secrets);
  if (secrets.length) {
    const each = needLines(secrets, (name) => secretSetCommand(name), cavelonCommand("secrets", "list", "--missing"));
    lines.push(["needs secrets", `${each}\n  (a person runs these in a terminal, or sets them in the Admin; never the agent)`]);
  }
  const variables = valueNeeds(needs.variables);
  if (variables.length) lines.push(["needs variables", needLines(variables, (name) => variableSetCommand(name), cavelonCommand("variables", "list"))]);
  const grants = (needs.oauth_grants ?? []).map((g) => [g.kind, g.tool_slug, g.capability].filter(Boolean).join(" "));
  if (grants.length) lines.push(["needs grants", `${list(grants)} (a person connects them in the Admin)`]);
  const bindings = (needs.runtime_bindings ?? []).map((b) => `${b.key}${b.kind ? ` (${b.kind})` : ""}`);
  if (bindings.length) lines.push(["needs bindings", `${list(bindings)} (runtime_bindings in env/<name>.yaml)`]);
  const triggers = (needs.trigger_identities ?? []).map((t) => `${t.harness_slug}/${t.trigger_slug}: ${(t.problems ?? []).join(", ")}${t.admin_path ? ` → ${t.admin_path}` : ""}`);
  if (triggers.length) lines.push(["needs identities", triggers.map((t) => `\n  - ${t}`).join("")]);
  return lines;
}

/** What `apply` reads beside the preview: the package files, for the file and line of a blocker, and the solution. */
interface PreviewContext {
  disk?: PackageOnDisk;
  harness?: string;
}

function emptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

/**
 * The sections the preview says change: those its summary counts or its
 * field diff names. Undefined when it may change them without saying so by
 * section (its counts name other kinds only), so the kit cannot tell.
 */
function sectionsChanging(p: Preview, sections: string[]): string[] | undefined {
  if (changesNothing(p)) return [];
  const s = p.summary ?? {};
  const counted = new Set([s.creates, s.updates, s.deletes].flatMap((map) => Object.entries(map ?? {}).filter(([, n]) => n > 0).map(([kind]) => kind)));
  const objects = fieldChanges(p.changes).map((c) => c.object);
  const found = sections.filter((section) => counted.has(section) || objects.some((o) => o === section || o.startsWith(`${section}:`) || o.startsWith(`${section}.`) || o.startsWith(`${section}[`)));
  return found.length ? found : undefined;
}

/**
 * A preview that would change nothing: its summary counts nothing to create,
 * update or delete, and it lists no field change. An instance whose preview
 * publishes no summary is taken to change something.
 */
function changesNothing(p: Preview): boolean {
  const s = p.summary;
  if (!s || typeof s !== "object") return false;
  return !counts(s.creates) && !counts(s.updates) && !counts(s.deletes) && fieldChanges(p.changes).length === 0;
}

export function previewText(p: Preview, context: PreviewContext = {}): string {
  const lines: Array<[string, unknown]> = [["ready", p.ready ? "yes" : "no"]];
  const s = p.summary ?? {};
  for (const [label, map] of [["creates", s.creates], ["updates", s.updates], ["deletes", s.deletes]] as const) {
    const text = counts(map);
    if (text) lines.push([label, text]);
  }
  if (lines.length === 1) lines.push(["changes", "none"]);
  const changes = fieldChanges(p.changes);
  if (changes.length) lines.push(["field changes", changeLines(changes)]);
  const details = blockerDetails(p.blocker_details, context.disk);
  if (details.length) lines.push(["blockers", blockerLines(details)]);
  else if (p.blockers?.length) lines.push(["blockers", p.blockers.map((b) => `\n  - ${clip(b, 300)}`).join("")]);
  if (p.warnings?.length) lines.push(["warnings", p.warnings.slice(0, 10).map((w) => `\n  - ${clip(w, 300)}`).join("") + (p.warnings.length > 10 ? `\n  … ${p.warnings.length - 10} more` : "")]);
  const ignored = [...(p.ignored?.sections ?? []), ...(p.ignored?.fields ?? [])];
  if (ignored.length) lines.push(["ignored", list(ignored)]);
  const skipped = notApplied(p.ignored?.not_applied, context.disk?.package, context.harness);
  if (skipped.length) lines.push(["not applied", notAppliedLines(skipped)]);
  const impact = p.impact ?? {};
  const active = (impact.active_harnesses ?? []).map((h) => {
    const via = [...(h.tools ?? []), ...(h.knowledge_bases ?? []), ...(h.sandboxes ?? [])];
    return `${h.name ?? h.harness_slug} (${h.harness_slug})${via.length ? ` through ${list(via, 5)}` : ""}`;
  });
  if (active.length) lines.push(["reaches active", active.map((a) => `\n  - ${a}`).join("")]);
  if (impact.sandbox_writers?.length) lines.push(["busy sandboxes", list(impact.sandbox_writers.map((w) => w.name ?? w.sandbox_id ?? "?"))]);
  for (const budget of p.loop_budgets ?? []) {
    const limits = Object.entries(budget.limits ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
    lines.push([`loop ${budget.node_slug}`, `${limits}${budget.worst_case_cost != null ? `; worst case ${JSON.stringify(budget.worst_case_cost)}` : ""}`]);
  }
  lines.push(...needsLines(p.target_needs ?? {}));
  return keyValues(lines);
}

/** The structured parts of a preview, read once for --json and the MCP tool's result; empty on an instance without them. */
function previewReport(p: Preview, context: PreviewContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const details = blockerDetails(p.blocker_details, context.disk);
  if (details.length) out.blocker_details = details;
  const changes = fieldChanges(p.changes);
  if (changes.length) out.field_changes = changes;
  const skipped = notApplied(p.ignored?.not_applied, context.disk?.package, context.harness);
  if (skipped.length) out.not_applied = skipped;
  return out;
}

/** The package files a package on disk was read from, relative to the solution folder. */
function sourceFiles(disk: PackageOnDisk): string[] {
  return Object.values(disk.sources).flatMap((source) => (Array.isArray(source) ? source : [source]).map((s) => s.file));
}

function previewIdOption(input: Parameters<CommandSpec["run"]>[1]): string | undefined {
  const id = stringOption(input, "confirm");
  if (id !== undefined && !id.trim()) throw usageError(`--confirm needs the preview id that \`${cavelonCommand("apply")}\` printed.`);
  return id?.trim();
}

function previewUnknown(previewId: string): CavelonError {
  return new CavelonError(ExitCode.usage, {
    code: "preview_unknown",
    message: `No open preview ${previewId} in this solution.`,
    hint: `Run \`${cavelonCommand("apply")}\` (with the same --env or --harness) for a new preview and confirm its id; \`${cavelonCommand("status")}\` lists the open ones.`,
  });
}

/** The instance's code for an import whose target changed since its preview (in its error catalog). */
const PREVIEW_STALE = "import_preview_stale";

/**
 * A confirm of a preview this folder no longer holds, saying why it went: a
 * stale preview (exit 4), as the confirm of one still stored but stale is.
 */
function previewRetired(retired: RetiredPreview, again: string): CavelonError {
  const id = retired.preview_id;
  const fresh = `Run \`${again}\` for a new preview, show it, and confirm its id.`;
  const details = { preview_id: id, reason: retired.reason, at: retired.at, ...(retired.by ? { superseded_by: retired.by } : {}) };
  switch (retired.reason) {
    case "applied":
      return new CavelonError(ExitCode.conflict, {
        code: "preview_applied",
        message: `Preview ${id} was imported already (${retired.at}); nothing was imported again.`,
        hint: `To import the files as they are now: ${fresh}`,
        details,
      });
    case "superseded":
      return new CavelonError(ExitCode.conflict, {
        code: "preview_superseded",
        message: `Preview ${id} was superseded: preview ${retired.by ?? "another one"} was imported after it (${retired.at}), so what it showed is no longer what an import would do; nothing was imported.`,
        hint: fresh,
        details,
      });
    case "discarded":
      return new CavelonError(ExitCode.conflict, {
        code: "preview_discarded",
        message: `Preview ${id} was discarded (${retired.at}); nothing was imported.`,
        hint: fresh,
        details,
      });
    case "expired":
      return new CavelonError(ExitCode.conflict, {
        code: "preview_expired",
        message: `Preview ${id} expired and was removed (${retired.at}); nothing was imported.`,
        hint: fresh,
        details,
      });
    case "stale":
      return new CavelonError(ExitCode.conflict, {
        code: PREVIEW_STALE,
        message: `Preview ${id} was refused earlier because its target changed since (${retired.at}); nothing was imported.`,
        hint: fresh,
        details,
      });
  }
}

/** `apply --discard <id|all>`: forget stored previews, so no later agent confirms one nobody looks at any more. */
async function discardPreviews(ctx: Context, project: ProjectConfig, which: string) {
  const open = await listPreviews(project.root, ctx.io.now());
  const chosen = which === "all" ? open : open.filter((p) => p.preview_id === which);
  if (which !== "all" && chosen.length === 0) throw previewUnknown(which);
  const at = ctx.io.now().toISOString();
  await retirePreviews(project.root, chosen.map((p) => ({ preview_id: p.preview_id, reason: "discarded" as const, at })));
  const ids = chosen.map((p) => p.preview_id);
  return {
    data: { discarded: ids, count: ids.length },
    text: ids.length ? `Discarded ${ids.length === 1 ? "preview" : `${ids.length} previews`}: ${ids.join(", ")}. Nothing changed on the instance.` : "No open previews to discard.",
  };
}

/** The package files that differ from what a preview read: changed, added or removed since. */
async function filesChangedSince(project: ProjectConfig, stored: StoredPreview, disk: PackageOnDisk): Promise<string[]> {
  if (!stored.file_digests) return [];
  const previewed = stored.file_digests;
  const now = await fileDigests(project.root, sourceFiles(disk));
  const files = new Set([...Object.keys(previewed), ...Object.keys(now)]);
  return [...files].filter((file) => previewed[file] !== now[file]).sort((a, b) => a.localeCompare(b, "en"));
}

/**
 * After an import: the package files as the instance now holds them become
 * the base the next pull compares with. A file whose bytes are what the
 * preview read is the instance's. One that changed since (a stale confirm,
 * `fmt`) is the instance's only when the instance's export says the same;
 * otherwise it holds what the instance lacks, and pull must not overwrite it.
 */
async function rememberImported(ctx: Context, project: ProjectConfig, stored: StoredPreview, disk: PackageOnDisk, changed: string[]): Promise<void> {
  if (!stored.file_digests) return;
  const now = await fileDigests(project.root, sourceFiles(disk));
  const known: Record<string, string> = {};
  for (const [file, value] of Object.entries(stored.file_digests)) if (now[file] === value) known[file] = value;
  if (!changed.length) return rememberAppliedFiles(project.root, known);
  const holds = await instanceHolds(ctx, project, stored).catch((error: unknown) => {
    ctx.warn(`Could not read what the instance holds after the import (${error instanceof Error ? error.message : String(error)}); pull treats ${changed.join(", ")} as local changes.`);
    return undefined;
  });
  const unknown: string[] = [];
  for (const file of changed) {
    if (holds?.has(file) && now[file]) known[file] = now[file];
    else unknown.push(file);
  }
  await rememberAppliedFiles(project.root, known, unknown);
}

/** The package files whose content the instance's export holds as they are; undefined when there is nothing to export to compare. */
async function instanceHolds(ctx: Context, project: ProjectConfig, stored: StoredPreview): Promise<Set<string> | undefined> {
  const harnessId = stored.request.harness_id;
  const scope = harnessId ? "agent_graph" : ((stored.request.package.manifest as Record<string, unknown> | undefined)?.scope as string | undefined);
  if (scope !== "agent_graph" && scope !== "full_config") return undefined;
  if (scope === "agent_graph" && !harnessId) return undefined;
  // The tenant-wide sections this import sent are compared too, so their files count as the instance holds them.
  const shared = stored.request[INCLUDE_TENANT_WIDE] === true && scope === "agent_graph" && (await takesTenantWide(ctx, "export"));
  const exported = await callStable<Record<string, unknown>>(ctx, "GET", EXPORT_ROUTE, "exporting packages", {
    query: { scope, harness_id: harnessId, ...(shared ? { [INCLUDE_TENANT_WIDE]: true } : {}) },
    timeoutMs: 120_000,
  });
  if (!exported || typeof exported !== "object" || Array.isArray(exported)) return undefined;
  const { schema } = await schemaFor(ctx, packageVersionOf(exported), false);
  const planned = await writePackage(project.root, project.layout, exported, schema, { dryRun: true });
  return new Set(planned.unchanged);
}

async function confirmPreview(ctx: Context, project: ProjectConfig, previewId: string, allowStale: boolean) {
  const stored = await loadPreview(project.root, previewId);
  const session = await ctx.session();
  if (!stored) {
    const retired = await retiredPreview(project.root, previewId);
    throw retired ? previewRetired(retired, cavelonCommand("apply")) : previewUnknown(previewId);
  }
  const now = ctx.io.now().toISOString();
  const retire = (reason: RetiredPreview["reason"]) => retirePreviews(project.root, [{ preview_id: stored.preview_id, reason, at: now }]);
  const expiry = previewExpiry(stored.created_at, ctx.io.now());
  if (expiry.expired) {
    await retire("expired");
    throw new CavelonError(ExitCode.conflict, {
      code: "preview_expired",
      message: `Preview ${previewId} was made at ${stored.created_at} and expired${expiry.expires_at ? ` at ${expiry.expires_at}` : ""}; nothing was imported.`,
      hint: `Run \`${previewAgain(stored)}\` again, show the new preview, and confirm its id.`,
      details: { preview_id: stored.preview_id, created_at: stored.created_at, expires_at: expiry.expires_at },
    });
  }
  if (requireInstance(session) !== stored.instance) {
    throw new CavelonError(ExitCode.conflict, {
      code: "preview_other_instance",
      message: `Preview ${previewId} was made on ${stored.instance}, not ${session.url}.`,
      hint: "Confirm it with the instance it was made on, or preview again here.",
    });
  }
  const client = await ctx.client();
  if (stored.tenant_id && session.tokenKind !== "api_key" && client.target.tenantId && client.target.tenantId !== stored.tenant_id) {
    throw new CavelonError(ExitCode.conflict, {
      code: "preview_other_tenant",
      message: `Preview ${previewId} was made for tenant ${stored.tenant_id}, but this command acts in ${client.target.tenantId}.`,
      hint: "Run the confirm command the preview printed; it names the preview's --env and --tenant. Or preview again here.",
    });
  }
  if (stored.tenant_id && session.tokenKind !== "api_key") client.target.tenantId = stored.tenant_id;
  const disk = await readPackage(project.root, project.layout);
  const changed = await filesChangedSince(project, stored, disk);
  if (digest(disk.package) !== stored.package_digest) {
    if (!allowStale) {
      throw new CavelonError(ExitCode.conflict, {
        code: "preview_files_changed",
        message: `The package files changed since preview ${previewId}${changed.length ? ` (${list(changed, 5)})` : ""}; nothing was imported.`,
        hint:
          `Run \`${previewAgain(stored)}\` for a preview of the files as they are now, show it, and confirm its id. ` +
          `To import what preview ${previewId} showed instead, add --allow-stale to the confirm.`,
        details: { preview_id: stored.preview_id, files: changed },
      });
    }
    ctx.warn(
      `The package files changed since this preview${changed.length ? ` (${list(changed, 5)})` : ""}; importing what the preview showed (--allow-stale). ` +
        `The files keep their changes, which the instance does not hold; run \`${cavelonCommand("apply")}\` to preview them.`,
    );
  }
  try {
    const result = await callStable<Record<string, unknown>>(ctx, "POST", "/api/v1/agent-graph/import", "importing packages", {
      body: { ...stored.request, preview_id: stored.preview_id },
      timeoutMs: 300_000,
    });
    // Every other open preview was made against the state this import changed.
    const others = (await listPreviews(project.root, ctx.io.now())).filter((p) => p.preview_id !== stored.preview_id);
    await retirePreviews(project.root, [
      { preview_id: stored.preview_id, reason: "applied", at: now },
      ...others.map((p) => ({ preview_id: p.preview_id, reason: "superseded" as const, at: now, by: stored.preview_id })),
    ]);
    await rememberImported(ctx, project, stored, disk, changed);
    const summary = (result.summary ?? {}) as Preview["summary"];
    const still = setCommands(stored.preview as Preview, stored.env ?? undefined);
    // The tenant-wide sections this import took along: as its result says on a recent instance, else as its preview reported them.
    const sharedSent = stored.request[INCLUDE_TENANT_WIDE] === true;
    const resultReport = tenantWideReport(result.tenant_wide);
    const sharedReport = resultReport ?? (sharedSent ? tenantWideReport((stored.preview as Preview).tenant_wide) : undefined);
    const sharedImported = sharedReport ? sharedReport.imports : [];
    const sharedReaches = sharedReport?.reaches_active_solutions ?? [];
    const sharedText =
      sharedSent || sharedImported.length
        ? `${sharedImported.length ? sharedImported.join(", ") : resultReport ? "none" : "the package's tenant-wide sections"}` +
          (sharedImported.length || !resultReport ? ", for every solution of the tenant" : "") +
          (sharedReaches.length ? ` (active: ${list(sharedReaches, 10)})` : "")
        : undefined;
    const text = keyValues([
      ["applied", `preview ${stored.preview_id}${stored.harness ? ` to ${stored.harness.slug}` : ""}${stored.env ? ` (env ${stored.env})` : ""}`],
      ["tenant-wide", sharedText],
      ["created", counts(summary?.creates) || undefined],
      ["updated", counts(summary?.updates) || undefined],
      ["deleted", counts(summary?.deletes) || undefined],
      ["warnings", Array.isArray(result.warnings) && result.warnings.length ? (result.warnings as string[]).map((w) => `\n  - ${clip(w, 300)}`).join("") : undefined],
      ["set secrets", still.secrets.length ? indented(still.secrets) + "\n  (a person runs these; never the agent)" : undefined],
      ["set variables", still.variables.length ? indented(still.variables) : undefined],
    ]);
    const data: Record<string, unknown> = { applied: true, preview_id: stored.preview_id, env: stored.env, harness: stored.harness, result };
    if (sharedSent || sharedImported.length) {
      data.tenant_wide = {
        applied: resultReport ? resultReport.applied : true,
        sections: sharedReport?.sections ?? null,
        imported: sharedReport ? sharedImported : null,
        left_out: sharedReport ? sharedReport.left_out : null,
        reaches_active_solutions: sharedReaches,
        reported_by: resultReport ? "import" : sharedReport ? "preview" : "kit",
      };
    }
    if (still.secrets.length || still.variables.length) data.set_commands = still;
    return { data, text };
  } catch (error) {
    if (error instanceof CavelonError && error.code === REQUIREMENTS_CHANGED && (error.blockers?.length || error.blockerDetails?.length)) {
      await retire("stale");
      throw requirementsChanged(error, stored, session, await catalogFor(ctx, false), disk);
    }
    // A refused import with structured blockers: each with its package file and line, as a preview shows them.
    if (error instanceof CavelonError && error.blockerDetails?.length) throw withBlockersLocated(error, disk, stored);
    if (error instanceof CavelonError && (error.code === "import_preview_stale" || (error.status === 409 && /preview/i.test(error.message)))) {
      await retire("stale");
      // What changed, where the instance still knows what the preview was made over; an older one says nothing more.
      const said = (error.details as { changed?: unknown } | undefined)?.changed;
      const changed = Array.isArray(said) ? said.filter((c): c is string => typeof c === "string") : [];
      throw new CavelonError(ExitCode.conflict, {
        code: error.code === "conflict" ? "import_preview_stale" : error.code,
        status: 409,
        message: `The target changed since preview ${stored.preview_id}${changed.length ? `: ${changed.join("; ")}` : ""}; nothing was imported.`,
        hint: `Run \`${previewAgain(stored)}\` again, show the new preview, and confirm its id.`,
        docs: error.docs,
        ...(changed.length ? { details: { preview_id: stored.preview_id, changed } } : {}),
      });
    }
    throw error;
  }
}

const REQUIREMENTS_CHANGED = "package_requirements_changed";

/**
 * The import's own check, re-run when it applies, found what the preview did
 * not: the refusal names each blocker, worded as a
 * preview words it, and the kit adds its hint for a code it knows. An instance
 * without `blockers` reads as a stale preview.
 */
function requirementsChanged(error: CavelonError, stored: StoredPreview, session: Session, catalog: ErrorCatalog | null, disk: PackageOnDisk): CavelonError {
  const details = locateBlockers(error.blockerDetails ?? [], disk);
  const blockers = error.blockers?.length ? error.blockers : details.map((b) => b.message);
  const known = new Map<string, string>();
  for (const blocker of blockers) {
    const pair = pairOrderHint(catalog, [blocker]);
    if (pair && !known.has(pair.code)) known.set(pair.code, pair.hint);
  }
  return new CavelonError(ExitCode.conflict, {
    code: error.code,
    status: error.status,
    message: `The import's requirements changed since preview ${stored.preview_id}; nothing was imported; preview again.`,
    hint: [...known.values(), `Run \`${previewAgain(stored)}\` again, show the new preview, and confirm its id.`].join(" "),
    docs: error.docs,
    blockers,
    blockerDetails: details.length ? details : undefined,
  });
}

/** The same refusal, its structured blockers located in the package files. */
function withBlockersLocated(error: CavelonError, disk: PackageOnDisk, stored: StoredPreview): CavelonError {
  return new CavelonError(error.exitCode, {
    code: error.code,
    message: `The import's own check refused preview ${stored.preview_id} when it applied; nothing was imported.`,
    hint: error.hint ?? `Fix what each blocker names, run \`${previewAgain(stored)}\` again, show the new preview, and confirm its id.`,
    docs: error.docs,
    status: error.status,
    details: error.details,
    blockers: error.blockers,
    blockerDetails: locateBlockers(error.blockerDetails ?? [], disk),
  });
}

/** The `apply` that previews the same target again, in the same tenant. */
function previewAgain(stored: StoredPreview): string {
  return printedCommand(["apply", ...(!stored.env && stored.harness ? ["--harness", stored.harness.slug] : [])], { env: stored.env });
}

/**
 * The solution an apply imports into. A preview changes nothing, so it never
 * creates one: a slug an env file names that is not on the instance yet gets
 * the command that creates it as a draft (`init` does the same when it is
 * given the solution).
 */
async function applyTarget(
  ctx: Context,
  session: Session,
  input: Parameters<CommandSpec["run"]>[1],
  pkg: Record<string, unknown>,
): Promise<Harness | undefined> {
  const { ref, source } = harnessRef(session, input);
  if (!ref) return undefined;
  const { harness: found, candidates } = await lookupHarness<Harness>(ctx, ref);
  if (found) return found;
  if (!source || source === "option" || isUuid(ref) || !SLUG.test(ref)) throw harnessNotFoundError(ref, candidates, source);
  const name = packageHarnessName(pkg, ref) ?? ref;
  // In the tenant the preview was for: a --tenant given here goes into the command, or the draft lands in another one.
  const create = cavelonCommand("harness", "new", ref, ...(name !== ref ? ["--name", name] : []));
  throw new CavelonError(ExitCode.failure, {
    code: "solution_not_found",
    message: `Solution ${ref}, which ${source} names, is not on the instance yet; apply previews into an existing solution and creates none.`,
    hint: `Create it as a draft: ${create}, then run \`${cavelonCommand("apply")}\` again.`,
    details: { slug: ref, name, create },
  });
}

/**
 * The name the package gives the solution: its harnesses entry with that
 * slug. None when no entry has the slug, so a copied package never names
 * someone else's solution.
 */
function packageHarnessName(pkg: Record<string, unknown>, slug: string): string | undefined {
  const entries = (Array.isArray(pkg.harnesses) ? pkg.harnesses : []).filter(
    (h): h is Record<string, unknown> => Boolean(h) && typeof h === "object" && !Array.isArray(h),
  );
  const entry = entries.find((h) => h.slug === slug);
  const name = typeof entry?.name === "string" ? entry.name.trim() : "";
  return name ? name.slice(0, 255) : undefined;
}

/**
 * Whether a preview needs a person's look before it is confirmed, and why; naming the active solutions it reaches. Tenant-wide
 * sections it imports come first: they change every solution of the tenant, active or not.
 */
function personReason(
  preview: Preview,
  harness: Harness | undefined,
  mode: string,
  env: string | undefined,
  shared: string[] = [],
  sharedReaches: string[] = [],
): string | undefined {
  if (shared.length) {
    const reaching = sharedReaches.length ? `, reaching the active solution${sharedReaches.length === 1 ? "" : "s"} ${list(sharedReaches, 5)}` : "";
    return `changes what the whole tenant shares (${list(shared, 5)})${reaching}`;
  }
  const active = (preview.impact?.active_harnesses ?? []).map((h) => h.harness_slug ?? h.name).filter((n): n is string => Boolean(n));
  if (harness?.status === "active" && !active.includes(harness.slug)) active.unshift(harness.slug);
  if (active.length) return `reaches the active solution${active.length === 1 ? "" : "s"} ${list(active, 5)}`;
  if (preview.impact?.active_harnesses?.length) return "reaches an active solution";
  if (counts(preview.summary?.deletes) || mode === "replace") return "deletes";
  if (env === "prod") return "goes to env/prod";
  return undefined;
}

export const apply: CommandSpec = {
  name: "apply",
  summary: "Preview the package files against the instance and print a preview id; --confirm <id> imports exactly that preview.",
  description:
    "Without --confirm nothing is imported: the preview shows what changes, which active solutions it reaches, what the target\n" +
    "still needs (secrets and variables with the command that sets each, grants, runtime bindings, trigger identities), loop\n" +
    "budgets and ignored sections, and is stored in .cavelon/. A preview never creates the solution: one the env file names\n" +
    "that is not on the instance yet gets the `cavelon harness new` command that creates it as a draft. A person sets the\n" +
    "secrets (`cavelon secrets set <name>`), never the agent.\n" +
    "Show a preview that reaches an active solution or env/prod to a person before confirming. A stale preview exits 4 and\n" +
    "imports nothing: one whose target changed on the instance since, one whose package files changed since (what they\n" +
    "hold, not their formatting; --allow-stale imports what the preview showed anyway), and one older than a day. So does\n" +
    "an import its own check refuses when it applies, naming each blocker. --discard <id|all> forgets stored previews;\n" +
    "`cavelon status` lists them with when each expires.\n" +
    "A solution's import leaves the package's tenant-wide sections (tenant_settings, model_registry, …) out; --include-tenant-wide\n" +
    "imports them, for every solution of the tenant. An instance that does not publish include_tenant_wide imports them with\n" +
    "every solution's package, and apply says so.",
  readOnly: false,
  destructive: true,
  mcpTool: "apply",
  options: {
    env: ENV_OPTION,
    harness: HARNESS_OPTION,
    confirm: { type: "string", value: "<preview-id>", description: "Import exactly this stored preview." },
    "allow-stale": {
      type: "boolean",
      description: "With --confirm: import what the preview showed although the package files changed since it.",
    },
    discard: { type: "string", value: "<preview-id|all>", description: "Forget this stored preview, or all of them; changes nothing on the instance." },
    mode: { type: "string", value: "<mode>", description: "overwrite (default) or replace (deletes what the package does not hold)." },
    "include-tenant-wide": {
      type: "boolean",
      formerly: "tenant-wide",
      description:
        "With a solution, also import the package's tenant-wide sections (tenant_settings, model_registry, …): they change for every solution of the tenant, so a person sees the preview first.",
    },
  },
  examples: [
    "cavelon apply --env test",
    "cavelon apply --confirm <preview-id>",
    "cavelon apply --env test --include-tenant-wide",
    "cavelon apply --env prod --json",
    "cavelon apply --discard all",
  ],
  async run(ctx, input) {
    const session = await ctx.session();
    const project = requireSolution(session, stringOption(input, "harness"));
    const url = requireInstance(session);
    const confirm = previewIdOption(input);
    const discard = stringOption(input, "discard")?.trim();
    const allowStale = boolOption(input, "allow-stale");
    if (discard !== undefined && confirm) throw usageError("Pass --confirm or --discard, not both.");
    if (allowStale && !confirm) throw usageError("--allow-stale only applies to --confirm <preview-id>.");
    if (discard !== undefined) {
      if (!discard) throw usageError("--discard needs a preview id, or all.", "`cavelon status` lists the open previews.");
      return discardPreviews(ctx, project, discard);
    }
    if (confirm) return confirmPreview(ctx, project, confirm, allowStale);

    const envFile = session.envFile;
    if (envFile?.tenant && session.tenantSource !== `env/${envFile.name}.yaml`) {
      ctx.warn(`${session.tenantSource} names tenant "${session.tenant}" and takes precedence over ${envFile.name}.yaml's "${envFile.tenant}".`);
    }
    const mode = (stringOption(input, "mode") ?? envFile?.mode ?? "overwrite") as ImportRequest["mode"];
    if (mode !== "overwrite" && mode !== "replace") throw usageError(`--mode must be overwrite or replace, got "${mode}".`);

    const { disk, findings, schema } = await validatePackage(ctx, project, false);
    if (disk.empty) throw usageError(`No package files in ${project.layout.package}/.`, "Run `cavelon pull --harness <name or slug>` first (`cavelon harness list` shows them), or write the package files.");
    const errors = findings.filter((f) => f.severity === "error");
    if (errors.length) {
      return {
        data: { previewed: false, errors: errors.length, findings: errors.slice(0, 50) },
        text: [...errors.slice(0, 20).map(findingLine), `${errors.length} error(s); fix them first (\`cavelon validate\`).`].join("\n"),
        exitCode: ExitCode.validation,
      };
    }

    const harness = await applyTarget(ctx, session, input, disk.package);
    const scope = ((disk.package.manifest as Record<string, unknown> | undefined)?.scope as string | undefined) ?? "agent_graph";
    if (harness && scope === "full_config") ctx.warn("The package is a full configuration; the instance imports it tenant-wide, whatever the solution.");

    const request: ImportRequest = { package: disk.package, mode };
    if (harness) request.harness_id = harness.id;
    if (envFile && Object.keys(envFile.runtimeBindings).length) request.runtime_bindings = envFile.runtimeBindings;

    // A solution's import leaves the sections the whole tenant shares out unless asked; an older instance imports them always.
    const tenantWide = boolOption(input, "include-tenant-wide");
    const solutionImport = Boolean(harness) && scope !== "full_config";
    if (tenantWide && !solutionImport) ctx.warn("--include-tenant-wide applies to a solution's import; this one goes to the whole tenant anyway.");
    const shared = solutionImport ? [...tenantWideSections(schema)].filter((section) => section in disk.package) : [];
    const takes = solutionImport && (tenantWide || shared.length > 0) && (await takesTenantWide(ctx, "import"));
    if (tenantWide && takes) request[INCLUDE_TENANT_WIDE] = true;
    if (tenantWide && solutionImport && !shared.length) ctx.warn("--include-tenant-wide: the package holds no tenant-wide section, so this import changes nothing the whole tenant shares.");

    const client = await ctx.client();
    const preview = await callStable<Preview>(ctx, "POST", "/api/v1/agent-graph/import/preview", "previewing imports", {
      body: request,
      timeoutMs: 120_000,
    });
    const target = harness ? { id: harness.id, slug: harness.slug } : null;
    const data: Record<string, unknown> = { previewed: true, ...preview, env: envFile?.name ?? null, harness: target };
    // The instance's own report wins where it sends one: it decides what it leaves out, and knows the active solutions it reaches.
    const reported = solutionImport ? tenantWideReport(preview.tenant_wide) : undefined;
    const sections = reported?.sections ?? shared;
    const applied = reported ? reported.applied : tenantWide || !takes;
    const sharedImported = reported ? reported.imports : applied ? sections : [];
    const sharedLeftOut = reported ? reported.left_out : applied ? [] : sections;
    const reaches = reported?.reaches_active_solutions ?? [];
    // A tenant-wide section equal to the instance's changes nothing, so it is only sent, never announced as a change.
    const sharedChanging = sharedImported.length ? sectionsChanging(preview, sharedImported) : [];
    const sharedSame = sharedImported.length > 0 && sharedChanging !== undefined && !sharedChanging.length;
    if (sharedImported.length && !sharedSame) {
      const files = sectionFiles(disk, sharedImported).join(", ") || sharedImported.join(", ");
      const what = sharedChanging?.length
        ? `this import changes ${sharedChanging.join(", ")} for every solution of the tenant`
        : `this import sends ${sharedImported.join(", ")}, and what in ${sharedImported.length === 1 ? "it" : "them"} differs from the instance changes for every solution of the tenant`;
      ctx.warn(
        `${files} ${sharedImported.length === 1 ? "holds a section" : "hold sections"} the whole tenant shares: ${what}` +
          (takes ? "." : " (this instance does not publish include_tenant_wide and imports them with every solution's package); remove the file unless that is meant."),
      );
    }
    if (sections.length || tenantWide) {
      // Nothing is applied by a preview: what the confirm would import is would_import.
      data.tenant_wide = {
        sections,
        applied: false,
        would_import: sharedImported,
        left_out: sharedLeftOut,
        changing: sharedImported.length ? (sharedChanging ?? null) : [],
        reaches_active_solutions: reaches,
        reported_by: reported ? "instance" : "kit",
      };
    }
    const reachText = reaches.length ? `the active solution${reaches.length === 1 ? "" : "s"} ${list(reaches, 10)}` : "";
    const sharedLine = sharedSame
      ? `tenant-wide: ${sharedImported.join(", ")} sent as the instance holds ${sharedImported.length === 1 ? "it" : "them"}; nothing changes for the tenant's solutions`
      : sharedImported.length
        ? `tenant-wide: ${sharedChanging?.length ? sharedChanging.join(", ") : sharedImported.join(", ")} change for every solution of the tenant${reachText ? `, reaching ${reachText}` : ""}`
        : sharedLeftOut.length
          ? `tenant-wide: ${sharedLeftOut.join(", ")} left out (\`${cavelonCommand("apply", "--include-tenant-wide")}\` imports them, for every solution of the tenant${reachText ? `; they would reach ${reachText}` : ""})`
          : undefined;
    const commands = setCommands(preview);
    if (commands.secrets.length || commands.variables.length) data.set_commands = commands;
    const context: PreviewContext = { disk, harness: harness?.slug };
    Object.assign(data, previewReport(preview, context));
    // A blocked preview has no id on recent instances: its blockers come first, never a call to update the instance.
    if (!preview.ready) {
      // A Masterloop pair applied out of order: say which step, and the order.
      const pair = pairOrderHint(await catalogFor(ctx, false), [
        ...(preview.blockers ?? []),
        ...blockerDetails(preview.blocker_details).map((b) => `${b.code ?? ""}: ${b.message}`),
      ]);
      if (pair) data.hint = pair.hint;
      // The instance checks a tenant-wide section it leaves out of the import, so a blocker there needs the file gone or fixed.
      const blockedShared = sharedLeftOut.filter((section) =>
        blockerDetails(preview.blocker_details).some((b) => b.path === section || b.path?.startsWith(`${section}.`) || b.path?.startsWith(`${section}[`)),
      );
      const sharedHint = blockedShared.length
        ? `A blocker is in ${sectionFiles(disk, blockedShared).join(", ")}, which this import leaves out (tenant-wide); the instance checks it anyway: remove the file, or fix it.`
        : undefined;
      if (sharedHint) data.tenant_wide_hint = sharedHint;
      return {
        data,
        text: [
          previewText(preview, context),
          ...(sharedLine ? [sharedLine] : []),
          "",
          ...(pair ? [`hint: ${pair.hint}`] : []),
          ...(sharedHint ? [`hint: ${sharedHint}`] : []),
          `The preview has blockers; fix them and run \`${cavelonCommand("apply")}\` again.`,
        ].join("\n"),
        exitCode: ExitCode.validation,
      };
    }
    // Nothing to confirm: no preview is stored, so no later agent finds one to import.
    if (changesNothing(preview)) {
      data.nothing_to_import = true;
      delete data.preview_id;
      return {
        data,
        text: [
          `Preview of ${project.layout.package}/ for ${harness ? `solution ${harness.slug}${harness.status ? ` (${harness.status})` : ""}` : "the tenant"}${envFile ? ` [env ${envFile.name}]` : ""}:`,
          previewText(preview, context),
          ...(sharedLine ? [sharedLine] : []),
          "",
          "Nothing to import: the instance already holds what the package files say. No preview was stored.",
        ].join("\n"),
      };
    }
    if (!preview.preview_id) {
      ctx.warn("This instance's preview returns no preview id, so `apply --confirm` cannot import exactly it; update the instance.");
    }
    if (preview.preview_id) {
      const stored: StoredPreview = {
        preview_id: preview.preview_id,
        created_at: ctx.io.now().toISOString(),
        instance: url,
        tenant_id: client.target.tenantId ?? null,
        env: envFile?.name ?? null,
        harness: target,
        package_digest: digest(disk.package),
        file_digests: await fileDigests(project.root, sourceFiles(disk)),
        request,
        preview,
      };
      await savePreview(project.root, stored);
      // An expired preview can no longer be confirmed; it would only pile up for a later agent to find.
      const at = ctx.io.now().toISOString();
      const expired = (await listPreviews(project.root, ctx.io.now())).filter((old) => old.expired);
      await retirePreviews(project.root, expired.map((old) => ({ preview_id: old.preview_id, reason: "expired" as const, at })));
    }
    const reason = personReason(preview, harness, mode, envFile?.name, sharedImported, reaches);
    data.show_to_person = Boolean(reason);
    const confirmLine = preview.preview_id ? cavelonCommand("apply", "--confirm", preview.preview_id) : undefined;
    const text = [
      `Preview of ${project.layout.package}/ for ${harness ? `solution ${harness.slug}${harness.status ? ` (${harness.status})` : ""}` : "the tenant"}${envFile ? ` [env ${envFile.name}]` : ""}:`,
      previewText(preview, context),
      ...(sharedLine ? [sharedLine] : []),
      "",
      ...(preview.preview_id ? [`preview id: ${preview.preview_id}`] : []),
      ...(reason ? [`This ${reason}: show this preview to a person before confirming.`] : []),
      ...(confirmLine ? [`Import exactly this: ${confirmLine}`] : []),
    ].join("\n");
    return { data, text };
  },
};

// ---------------------------------------------------------------------------
// explain
// ---------------------------------------------------------------------------

/** The refusal of new work at the monthly Processing Step cap. */
const PROCESSING_STEP_CAP_CODE = "PROCESSING_STEP_CAP_REACHED";

/**
 * A code as people and refusals spell it: in any case, or without its last
 * word (`processing_step_cap` for `PROCESSING_STEP_CAP_REACHED`), when exactly
 * one catalog code matches.
 */
function looseEntry(catalog: ErrorCatalog | null | undefined, code: string): ReturnType<typeof catalogEntry> {
  const wanted = code.toLowerCase();
  const all = [...(catalog?.rule_codes ?? []), ...(catalog?.api_error_codes ?? [])].map((e) => e.code);
  const same = all.filter((c) => c.toLowerCase() === wanted);
  const prefixed = all.filter((c) => c.toLowerCase().startsWith(`${wanted}_`));
  const hit = same.length === 1 ? same[0] : same.length === 0 && prefixed.length === 1 ? prefixed[0] : undefined;
  return hit ? catalogEntry(catalog, hit) : undefined;
}

/** Which cap stopped new work, its use this month, and who raises it, from the published quota. */
function processingStepCapHint(limits: PublishedLimits | undefined): string {
  const cap = limits?.tenantQuotas?.values.find((v) => v.key === "monthly_processing_step_cap");
  const raise = "A Tenant Owner raises or removes it with `cavelon limits set monthly_processing_step_cap <n|none> --confirm` (settings.manage), or in the Admin; started work finishes.";
  if (!cap) return `New work starts again when the billing month resets. ${raise}`;
  const value = cap.value === null ? "no cap" : `${cap.value} Processing Steps`;
  const used = cap.used === null ? "" : `, ${cap.used} used${cap.period ? ` in ${cap.period.key}` : ""}`;
  const resets = cap.period ? ` It resets at ${cap.period.resets_at}.` : "";
  return `monthly_processing_step_cap is ${value}${used} (state: ${cap.state}).${resets} ${raise}`;
}

/** What a test-case status that is neither pass nor fail means, and what to do next. */
async function caseStatusAnswer(ctx: Context, status: CaseStatus) {
  const instance = (await ctx.session().catch(() => undefined))?.url;
  const page = `/docs/${TESTING_PAGE}#${status.section}`;
  const data = {
    code: status.status,
    kind: "test_case_status",
    message: status.meaning,
    hint: status.next,
    summary_counts: status.counts,
    docs: instance ? `${instance}${page}` : page,
    read: [{ page: TESTING_PAGE, command: cavelonCommand("docs", "get", TESTING_PAGE) }],
  };
  return {
    data,
    text: keyValues([
      ["code", status.status],
      ["kind", "test-case status (neither pass nor fail)"],
      ["meaning", status.meaning],
      ["next", status.next],
      ["counted as", status.counts.join(", ")],
      ["docs", data.docs],
      ["read", data.read[0]!.command],
    ]),
  };
}

/**
 * A `knowledge_outcome` value on an instance whose catalog does not list it:
 * what the kit knows from the instance's regression-testing docs.
 */
async function knowledgeOutcomeAnswer(ctx: Context, outcome: KnowledgeOutcome) {
  const instance = (await ctx.session().catch(() => undefined))?.url;
  const page = `/docs/${KNOWLEDGE_OUTCOME_PAGE}`;
  const data = {
    code: outcome.value,
    kind: "knowledge_outcome",
    message: outcome.message,
    hint: outcome.hint,
    ...(outcome.recorded_as ? { recorded_as: outcome.recorded_as } : {}),
    docs: instance ? `${instance}${page}` : page,
    read: [{ page: KNOWLEDGE_OUTCOME_PAGE, command: cavelonCommand("docs", "get", KNOWLEDGE_OUTCOME_PAGE) }],
  };
  return {
    data,
    text: keyValues([
      ["code", outcome.value],
      ["kind", OUTCOME_KIND],
      ["meaning", outcome.message],
      ["next", outcome.hint],
      ["recorded as", outcome.recorded_as],
      ["docs", data.docs],
      ["read", data.read[0]!.command],
    ]),
  };
}

const OUTCOME_KIND = "knowledge outcome (what a knowledge search found, as its retrieval span's knowledge_outcome says)";

export const explain: CommandSpec = {
  name: "explain",
  tenantless: true,
  summary: "Look a code up in the instance's error catalog: what it means and how to fix it.",
  description:
    "Rule codes come from the package and graph checks, API error codes from failed requests; cavelon's own codes (validate's\n" +
    "findings, and errors the CLI raises itself, such as operation_not_found or uncommitted_changes) are known too. Uses the\n" +
    "cached catalog first. Where the instance's fix names an API route, the command that does the same is added. An unknown\n" +
    "code gets the closest known ones (a typo away, the same start).\n" +
    `Also explains the test-case statuses that are neither pass nor fail: ${CASE_STATUSES.map((s) => s.status).join(", ")};\n` +
    `and the values of a retrieval span's knowledge_outcome (${KNOWLEDGE_OUTCOMES.map((o) => o.value).join(", ")}), from the\n` +
    "instance's catalog (area knowledge_outcome) where it lists them.",
  readOnly: true,
  idempotent: true,
  mcpTool: "explain",
  positionals: [{ name: "code", description: "The code, e.g. from `cavelon validate` or an error's code, or a test-case status.", required: true }],
  async run(ctx, input) {
    const code = positional(input, "code")!.trim();
    const status = caseStatus(code);
    const outcome = knowledgeOutcome(code);
    // A test-case status or a knowledge outcome needs no instance; a catalog that lists the same name still wins.
    let catalog = status || outcome ? await catalogFor(ctx, false).catch(() => null) : await catalogFor(ctx, false);
    let entry = catalogEntry(catalog, code) ?? looseEntry(catalog, code);
    if (!entry && outcome && catalog) {
      // A newer instance may list the outcomes the cached catalog does not.
      catalog = await (await ctx.contracts()).errorCatalog({ refresh: true }).catch(() => catalog);
      entry = catalogEntry(catalog, outcome.value);
    }
    if (!entry && status) return caseStatusAnswer(ctx, status);
    if (!entry && outcome) return knowledgeOutcomeAnswer(ctx, outcome);
    if (!entry || entry.kind === "kit" || entry.kind === "cli") {
      // A newer instance may know a code the cached catalog does not.
      catalog = await (await ctx.contracts()).errorCatalog({ refresh: true }).catch(() => catalog);
      entry = catalogEntry(catalog, code) ?? looseEntry(catalog, code) ?? entry;
    }
    if (!catalog && !entry) {
      throw new CavelonError(ExitCode.failure, {
        code: "error_catalog_unavailable",
        message: "This instance does not publish its error catalog (/api/v1/meta/error-catalog).",
        hint: "Try `cavelon docs search <code>`.",
      });
    }
    if (!entry) {
      const all = [
        ...(catalog?.rule_codes ?? []),
        ...(catalog?.api_error_codes ?? []),
        ...KIT_CODES,
        ...KIT_ERROR_CODES,
        ...CASE_STATUSES.map((s) => ({ code: s.status })),
        ...KNOWLEDGE_OUTCOMES.map((o) => ({ code: o.value })),
      ].map((e) => e.code);
      const similar = similarCodes(code, all);
      throw new CavelonError(ExitCode.failure, {
        code: "code_unknown",
        message: `"${code}" is neither in this instance's error catalog nor one of cavelon's own codes.`,
        hint: similar.length ? `Similar codes: ${similar.join(", ")}.` : `Try \`cavelon docs search ${code}\`.`,
        details: { similar },
      });
    }
    const docs = entry.docs?.startsWith("/") ? `${requireInstance(await ctx.session())}${entry.docs}` : entry.docs;
    // A capacity refusal: the kit adds which limit to raise and who can, with today's values.
    const capacity = capacityCodeIn(entry.code);
    const stepCap = entry.code.toUpperCase() === PROCESSING_STEP_CAP_CODE;
    // A value above a platform ceiling: today's ceilings and who raises them.
    const ceiling = entry.code === LIMIT_ABOVE_CEILING;
    const kitHint = capacity
      ? capacityHint(capacity, await readLimits(ctx).catch(() => undefined))
      : stepCap
        ? processingStepCapHint(await readLimits(ctx).catch(() => undefined))
        : ceiling
          ? ceilingHint(await readLimits(ctx).catch(() => undefined))
          : pairOrderPointer(entry.code);
    // The instance's own pages on capacity, where it lists them; an endpoint's limit is planned in the tutorial.
    const pages = capacity === MODEL_ENDPOINT_BUSY ? [CAPACITY_TUTORIAL_PAGE, CAPACITY_CONCEPT_PAGE] : [CAPACITY_CONCEPT_PAGE, CAPACITY_TUTORIAL_PAGE];
    const read = capacity ? (await listedPages(ctx, pages)).map((page) => ({ page, command: cavelonCommand("docs", "get", page) })) : [];
    // The instance's fix may name an API route; the command that does the same is easier to follow.
    const cli = entry.kind === "cli" ? undefined : cliFix(entry);
    const data = { ...entry, ...(entry.area === KNOWLEDGE_OUTCOME_AREA ? { kind: "knowledge_outcome" } : {}), docs, ...(cli ? { cli_fix: cli } : {}), ...(kitHint ? { kit_hint: kitHint } : {}), ...(read.length ? { read } : {}) };
    return {
      data,
      text: keyValues([
        ["code", entry.code],
        [
          "kind",
          entry.kind === "rule"
            ? `rule code${entry.rule ? ` (rule ${entry.rule})` : ""}`
            : entry.kind === "kit"
              ? "cavelon validate code"
              : entry.kind === "cli"
                ? "cavelon error code (raised by the CLI, not the instance)"
                : entry.area === KNOWLEDGE_OUTCOME_AREA
                  ? OUTCOME_KIND
                  : `API error code${entry.area ? ` (${entry.area})` : ""}`,
        ],
        ["meaning", entry.message],
        ["fix", entry.hint ?? undefined],
        ["with the CLI", cli],
        [capacity || stepCap || ceiling ? "raise" : "order", kitHint],
        ["why", entry.explanation ? clip(entry.explanation.replace(/\s+/g, " "), 600) : undefined],
        ["docs", docs],
        ["read", read.length ? read.map((r) => r.command).join("; ") : undefined],
      ]),
    };
  },
};

// ---------------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------------

interface ReadinessCheck {
  key?: string | null;
  label?: string | null;
  state?: string | null;
  detail?: string | null;
  /** Not in the published readiness schema; kept for an instance that words a check this way. */
  message?: string | null;
  /** What a check needs, one entry each (a secret, a variable, a binding), on a recent instance. */
  items?: Array<{ key?: string | null; label?: string | null; kind?: string | null; status?: string | null; confirmed?: boolean | null }> | null;
}

const SATISFIED = /^(set|ok|configured|confirmed|satisfied|complete|ready|bound)$/i;

/**
 * The secrets the readiness gate's blockers name as not set: the items of
 * kind secret, else, from an instance that lists no items, the "Secret <name>"
 * its words name.
 */
function missingSecrets(blockers: ReadinessCheck[]): string[] {
  const names = new Set<string>();
  for (const check of blockers) {
    const items = Array.isArray(check.items) ? check.items : [];
    for (const item of items) {
      if (!/secret/i.test(item.kind ?? "") || item.confirmed === true || SATISFIED.test(item.status ?? "")) continue;
      const name = (item.key ?? "").replace(/^secrets?[:./]/i, "") || (item.label ?? "").replace(/^secret\s+/i, "");
      if (name) names.add(name);
    }
    if (items.length) continue;
    for (const match of `${check.label ?? ""} ${check.detail ?? check.message ?? ""}`.matchAll(/\bSecret ([A-Za-z0-9_.-]+)/g)) names.add(match[1]!);
  }
  return [...names];
}

/** What to do about secrets the gate names as not set: who sets each, by whether this credential may. */
function missingSecretsLine(names: string[], may: boolean | null): string {
  const which = `Secret${names.length === 1 ? "" : "s"} ${names.join(", ")} ${names.length === 1 ? "is" : "are"} not set`;
  const commands = names.map((n) => secretSetCommand(n)).join("; ");
  if (may === false) return `${which}, and this token's role cannot set secrets. ${SECRET_SETTER}: ${commands}`;
  return `${which}: a person sets ${names.length === 1 ? "it" : "each"} (never the agent): ${commands}`;
}

interface Readiness {
  ready_to_activate: boolean;
  status?: string;
  checks?: ReadinessCheck[];
  blockers?: ReadinessCheck[];
  warnings?: ReadinessCheck[];
  /** The solution's latest test run; absent on an instance that does not publish it. */
  latest_test_run?: { id?: string; status?: string; summary?: Record<string, unknown> | null; created_at?: string | null; completed_at?: string | null } | null;
}

/** A solution's state as `status` shows it: draft or active, whether it may activate, and its latest test run. */
export interface SolutionState {
  harness: { id: string; slug: string; name: string; status: string } | null;
  ready_to_activate?: boolean | null;
  blockers?: string[];
  /** Null when the solution has no test run yet; undefined when the instance does not publish it. */
  latest_test_run?: { id: string | null; status: string | null; passed: number | null; failed: number | null; total: number | null; at: string | null } | null;
  /**
   * Whether it is the tenant's default route, and which solution is: `is_default` null when the
   * instance does not say. Undefined when the solution list could not be read.
   */
  default_route?: { is_default: boolean | null; current: { id: string; slug: string; name: string } | null };
  /** The secrets readiness names as not set, and whether this credential may set them (null: the instance does not say). */
  missing_secrets?: { names: string[]; may_set: boolean | null };
  /** Why part of it could not be read; the rest stands. */
  unavailable?: string;
}

const count = (value: unknown) => (typeof value === "number" ? value : null);

/**
 * The state of the solution a folder holds, from the instance: one lookup
 * and its readiness, which carries the latest test run. Never throws: a
 * solution that cannot be read says why.
 */
export async function solutionState(ctx: Context, ref: string): Promise<SolutionState> {
  let harness: Harness | undefined;
  try {
    harness = (await lookupHarness<Harness>(ctx, ref)).harness;
  } catch (error) {
    return { harness: null, unavailable: error instanceof Error ? error.message : String(error) };
  }
  if (!harness) return { harness: null, unavailable: `This tenant has no solution "${ref}".` };
  const state: SolutionState = { harness: { id: harness.id, slug: harness.slug, name: harness.name, status: harness.status } };
  try {
    const route = await readDefaultRoute(ctx);
    const current = route.current ? { id: route.current.id, slug: route.current.slug, name: route.current.name } : null;
    state.default_route = { is_default: route.known ? route.current?.id === harness.id : null, current };
  } catch (error) {
    ctx.warn(`Could not read the tenant's default route: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const readiness = await callStable<Readiness>(ctx, "GET", "/api/v1/harnesses/{harness_id}/readiness", "reading readiness", {
      params: { harness_id: [harness.id] },
    });
    state.ready_to_activate = typeof readiness.ready_to_activate === "boolean" ? readiness.ready_to_activate : null;
    state.blockers = (readiness.blockers ?? []).map((b) => clip(String(b.label ?? b.key ?? b.detail ?? "?"), 80));
    const secrets = missingSecrets(readiness.blockers ?? []);
    if (secrets.length) {
      const principal = await readPrincipal(await ctx.client()).catch(() => undefined);
      state.missing_secrets = { names: secrets, may_set: maySetSecrets(principal) };
    }
    if ("latest_test_run" in readiness) {
      const run = readiness.latest_test_run;
      const summary = run?.summary ?? {};
      state.latest_test_run = run
        ? {
            id: run.id ?? null,
            status: run.status ?? null,
            passed: count(summary.passed),
            failed: count(summary.failed),
            total: count(summary.total_cases) ?? count(summary.total),
            at: run.completed_at ?? run.created_at ?? null,
          }
        : null;
    }
  } catch (error) {
    state.unavailable = `readiness: ${error instanceof Error ? error.message : String(error)}`;
  }
  return state;
}

/** The lines `status` prints for a solution's state. */
export function solutionStateLines(state: SolutionState): Array<[string, unknown]> {
  if (!state.harness) return [["state", `not readable: ${state.unavailable ?? "unknown"}`]];
  // Readiness says whether a draft may activate; an active solution is past that gate (a recent instance sends null).
  const active = state.harness.status === "active";
  const ready =
    active
      ? undefined
      : state.ready_to_activate === true
        ? "ready to activate"
        : state.ready_to_activate === false
          ? `not ready to activate${state.blockers?.length ? ` (${list(state.blockers, 3)})` : ""}`
          : undefined;
  const lines: Array<[string, unknown]> = [["state", [state.harness.status, ready].filter(Boolean).join(", ")]];
  if (state.missing_secrets) lines.push(["secrets", missingSecretsLine(state.missing_secrets.names, state.missing_secrets.may_set)]);
  const route = state.default_route;
  if (route) lines.push(["default route", defaultRouteText(state.harness, route)]);
  const run = state.latest_test_run;
  if (run === null) lines.push(["last test run", "none yet (`cavelon test run`)"]);
  else if (run) {
    const counts = run.total !== null ? `: ${run.passed ?? "?"} of ${run.total} passed${run.failed ? `, ${run.failed} failed` : ""}` : "";
    lines.push(["last test run", `${run.status ?? "?"}${counts}${run.at ? ` (${run.at})` : ""}${run.id ? `  ${run.id}` : ""}`]);
  } else if (!state.unavailable) lines.push(["last test run", "not published by this instance"]);
  if (state.unavailable) lines.push(["state error", state.unavailable]);
  return lines;
}

/** Whether the folder's solution answers the tenant's chat and widget, and if not, which one does and how to change it. */
function defaultRouteText(harness: { slug: string; name: string; status: string }, route: NonNullable<SolutionState["default_route"]>): string {
  if (route.is_default === null) return "unknown (this instance does not say which solution is the default)";
  if (route.is_default) return "yes: the tenant's chat and widget answer with it where a conversation names no solution";
  const now = route.current ? named(route.current) : "no solution";
  const how = harness.status === "active" ? cavelonCommand("harness", "default", harness.slug) : cavelonCommand("activate", "--harness", harness.slug, "--make-default");
  return `no: ${now} answers the tenant's chat and widget; preview a change with ${how}`;
}

function checkLine(c: ReadinessCheck): string {
  return clip([c.label ?? c.key, c.message ?? c.detail].filter(Boolean).join(": "), 300);
}

/**
 * Every check the gate ran, with its result. An instance that publishes no
 * `checks` still names its blockers and warnings, so those stand in for it.
 */
function readinessChecks(readiness: Readiness): Array<{ key: string | null; label: string | null; state: string; detail: string | null }> {
  const fallback = [
    ...(readiness.blockers ?? []).map((c) => ({ ...c, state: c.state ?? "blocker" })),
    ...(readiness.warnings ?? []).map((c) => ({ ...c, state: c.state ?? "warning" })),
  ];
  return (readiness.checks ?? fallback).map((c) => ({
    key: c.key ?? null,
    label: c.label ?? null,
    state: c.state ?? "unknown",
    detail: c.detail ?? c.message ?? null,
  }));
}

/** The checks and warnings as lines, so a non-blocking warning is read, not only logged. */
function readinessText(checks: ReturnType<typeof readinessChecks>, warnings: string[]): string[] {
  const width = Math.max(0, ...checks.map((c) => c.state.length));
  return [
    ...(checks.length ? ["Readiness checks:", ...checks.map((c) => `  ${c.state.padEnd(width)}  ${checkLine(c)}`)] : []),
    ...(warnings.length ? ["Warnings:", ...warnings.map((w) => `  - ${w}`)] : []),
  ];
}

/**
 * After an activation: whether the solution is the tenant's default route,
 * and, with --make-default, the change of it, previewed until --confirm. Never
 * fails the activation: a default route that cannot be read is a warning.
 */
async function defaultRouteAfterActivation(
  ctx: Context,
  harness: Harness,
  input: Parameters<CommandSpec["run"]>[1],
): Promise<{ data: Record<string, unknown>; lines: string[]; failed?: boolean; exitCode?: ExitCodeValue }> {
  const make = boolOption(input, "make-default");
  let route;
  try {
    route = await readDefaultRoute(ctx);
  } catch (error) {
    ctx.warn(`Could not read the tenant's default route: ${error instanceof Error ? error.message : String(error)}`);
    return { data: {}, lines: [] };
  }
  const current = route.current ? { id: route.current.id, slug: route.current.slug, name: route.current.name } : null;
  if (route.current?.id === harness.id) return { data: { default_route: { is_default: true, current } }, lines: [`${named(harness)} is the tenant's default route.`] };
  const commands = defaultCommands(harness.slug);
  const gate = make ? await confirmation(ctx, input, "activate", { harness: harness.id, from: current?.id ?? null }) : undefined;
  if (gate?.confirmed) {
    try {
      await setDefaultRoute(ctx, harness.id);
    } catch (error) {
      // The activation stands; only the default route stayed as it was.
      const said = error instanceof Error ? error.message : String(error);
      const code = error instanceof CavelonError ? error.code : undefined;
      ctx.warn(`The default route was not changed: ${said}`);
      return {
        data: { default_route: { is_default: false, changed: false, current, error: { code: code ?? null, message: said } } },
        lines: [`The default route stays ${current ? named(current) : "as it was"}: ${said}`],
        failed: true,
      };
    }
    return {
      data: { default_route: { is_default: true, changed: true, previous: current } },
      lines: [`Default route: ${named(harness)}${current ? ` (was ${named(current)})` : ""}.`],
    };
  }
  if (!route.known && !make) return { data: { default_route: { is_default: null, known: false } }, lines: [] };
  if (gate) {
    const confirm = cavelonCommand("activate", "--harness", harness.slug, "--make-default", "--confirm");
    return {
      data: { default_route: { is_default: false, known: route.known, current, preview: commands.preview, confirm: gate.confirm(confirm), ...gate.fields } },
      lines: [defaultChangeLine(harness, route), ...(gate.mismatch ? [gate.mismatch] : []), `Show this to a person; with their yes: ${gate.confirm(confirm)}`],
      ...(gate.exitCode ? { exitCode: gate.exitCode } : {}),
    };
  }
  const lines = [
    `Not the default route: ${current ? `the tenant's chat and widget answer with ${named(current)}` : "the tenant has none"} where a conversation names no solution.`,
    `Ask the person whether ${named(harness)} should answer there; that changes live traffic. Preview: ${commands.preview}`,
  ];
  return { data: { default_route: { is_default: false, known: route.known, current, preview: commands.preview, confirm: commands.confirm } }, lines };
}

export const activate: CommandSpec = {
  name: "activate",
  summary: "Activate a solution through the readiness gate (never by force); says whether it is the tenant's default route.",
  description:
    "Only when every readiness check passes, and with a personal access token only when it was created with \"may activate\".\n" +
    "Activating without the evidence stays a person's decision in the Admin.\n" +
    "Afterwards it says whether the solution is the tenant's default route (the one the tenant's chat and widget answer with\n" +
    "where no solution is named). --make-default previews making it the default; with --confirm as well, it changes it. That\n" +
    "changes live traffic: show the preview to a person and confirm only with their yes. `cavelon harness default` does the\n" +
    "same for an active solution.",
  readOnly: false,
  idempotent: true,
  mcpTool: "activate",
  options: {
    harness: HARNESS_OPTION,
    env: ENV_OPTION,
    "make-default": { type: "boolean", description: "Also make it the tenant's default route: previews the change; with --confirm, makes it." },
    confirm: { type: "boolean", mcpToken: true, description: "With --make-default: change the default route (after a person saw the preview)." },
  },
  examples: ["cavelon activate", "cavelon activate --make-default", "cavelon activate --make-default --confirm", "cavelon activate --make-default --confirm <token>"],
  async run(ctx, input) {
    const session = await ctx.session();
    const { ref, source } = harnessRef(session, input);
    if (!ref) throw usageError("Which solution?", "Pass --harness <name or slug> (`cavelon harness list` shows them), or set harness in cavelon.yaml or the env file.");
    if (confirmGiven(input) && !boolOption(input, "make-default")) {
      throw usageError("--confirm only applies to --make-default.", "Activation itself needs no confirmation; the default route does.");
    }
    // Refused before the activation, so a refused confirm never leaves half of the call done.
    if (ctx.mode === "mcp" && input.options.confirm === true) throw confirmTokenRequired("activate");
    const driven = drivenByAgent(ctx);
    if (driven?.by === "agent" && input.options.confirm === true) {
      throw shellTokenRequired(cavelonCommand("activate", "--harness", ref, "--make-default"), driven.variable);
    }
    const client = await ctx.client();
    const principal = await readPrincipal(client);
    if (principal?.kind === "personal_access_token" && principal.token && !principal.token.may_activate) {
      throw new CavelonError(ExitCode.unauthorized, {
        code: "token_activation_refused",
        message: `The personal access token "${principal.token.name}" was not created with "may activate", so it cannot activate solutions.`,
        hint: "A person activates the solution in the Admin, or creates a token with \"may activate\" on /account/access-tokens.",
      });
    }
    const harness = await findHarness(ctx, ref, source);
    if (harness.status === "active") {
      const route = await defaultRouteAfterActivation(ctx, harness, input);
      return {
        data: { activated: false, already_active: true, harness, ...route.data },
        text: [`${harness.name} (${harness.slug}) is already active.`, ...route.lines].join("\n"),
        ...(route.failed ? { exitCode: ExitCode.failure } : route.exitCode ? { exitCode: route.exitCode } : {}),
      };
    }
    const readiness = await callStable<Readiness>(ctx, "GET", "/api/v1/harnesses/{harness_id}/readiness", "reading readiness", {
      params: { harness_id: [harness.id] },
    });
    const checks = readinessChecks(readiness);
    const warnings = (readiness.warnings ?? []).map(checkLine);
    if (!readiness.ready_to_activate) {
      const blockers = readiness.blockers ?? [];
      // A Masterloop parent activated before its iteration solution.
      const pair = pairOrderHint(await catalogFor(ctx, false), blockers.flatMap((b) => [b.message ?? undefined, b.detail ?? undefined]));
      // A secret the package declares is a person's to set, and with a role that may not, someone else's.
      const secrets = missingSecrets(blockers);
      const maySet = maySetSecrets(principal);
      const secretsLine = secrets.length ? missingSecretsLine(secrets, maySet) : undefined;
      return {
        data: {
          activated: false,
          harness,
          checks,
          warnings,
          readiness,
          ...(pair ? { hint: pair.hint } : {}),
          ...(secrets.length ? { missing_secrets: { names: secrets, may_set: maySet, next: secretsLine } } : {}),
        },
        text: [
          `${harness.name} (${harness.slug}) is not ready to activate:`,
          ...blockers.map((b) => `  - ${checkLine(b)}`),
          ...readinessText(checks, warnings),
          ...(pair ? [`hint: ${pair.hint}`] : []),
          ...(secretsLine ? [secretsLine] : []),
          "Resolve these (often: a passing test run), then activate again. Forcing past the gate is a person's decision in the Admin.",
        ].join("\n"),
        exitCode: ExitCode.validation,
      };
    }
    const activated = await callStable<Harness>(ctx, "POST", "/api/v1/harnesses/{harness_id}/activate", "activating solutions", {
      params: { harness_id: [harness.id] },
      body: { force: false },
    });
    const route = await defaultRouteAfterActivation(ctx, activated, input);
    return {
      data: { activated: true, harness: activated, checks, warnings, readiness, ...route.data },
      text: [`Activated ${activated.name} (${activated.slug}); status ${activated.status}.`, ...readinessText(checks, warnings), ...route.lines].join("\n"),
      // Activated, but the default route the person asked for did not change.
      ...(route.failed ? { exitCode: ExitCode.failure } : route.exitCode ? { exitCode: route.exitCode } : {}),
    };
  },
};
