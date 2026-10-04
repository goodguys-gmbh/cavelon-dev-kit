import path from "node:path";
import { parseDocument } from "yaml";
import { CAPACITY_CONCEPT_PAGE, CAPACITY_TUTORIAL_PAGE, capacityCodeIn, capacityHint, MODEL_ENDPOINT_BUSY } from "../capacity.js";
import { boolOption, intOption, positional, stringOption, type CommandSpec, type Context } from "../command.js";
import type { WarningEntry } from "../context.js";
import { Contracts, type CachedContract, type ErrorCatalog, type PackageSchema } from "../contracts.js";
import { CavelonError, ExitCode, usageError } from "../errors.js";
import { clip, keyValues } from "../format.js";
import { readTextFile, writeFileAtomic } from "../fsutil.js";
import { uncommitted } from "../git.js";
import { callStable } from "../invoke.js";
import { harnessNotFoundError, lookupHarness } from "../harness-ref.js";
import { ceilingHint, LIMIT_ABOVE_CEILING, parseLimits, readLimits, type PublishedLimits } from "../limits.js";
import {
  deletePreview,
  digest,
  fileDigest,
  listPreviews,
  loadPreview,
  readPulledFiles,
  savePreview,
  writePulledFiles,
  writeState,
  type ImportRequest,
  type PullRecord,
  type StoredPreview,
} from "../local-state.js";
import { catalogEntry, checkPackage, KIT_CODES, packageVersionOf } from "../package-check.js";
import { pairOrderHint, pairOrderPointer } from "../pair-order.js";
import { readPackage, writePackage, type Finding, type PackageOnDisk } from "../package-files.js";
import { readPrincipal } from "../principal.js";
import type { ProjectConfig } from "../project.js";
import { CASE_STATUSES, caseStatus, TESTING_PAGE, type CaseStatus } from "../results.js";
import { isUuid, requireInstance, type Session } from "../session.js";
import { listedPages } from "./docs.js";
import { writeInventory } from "./inventory.js";
import { cavelonCommand, shellWord } from "../shell.js";
import { secretSetCommand, targetFlags, variableSetCommand } from "./values.js";

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

export function requireSolution(session: Session): ProjectConfig {
  if (!session.project) {
    throw new CavelonError(ExitCode.usage, {
      code: "no_solution",
      message: "This folder is not a Cavelon solution (no cavelon.yaml here or above).",
      hint: "Run `cavelon init`: it asks which solution, or a new one, on a terminal. `cavelon harness list` shows the solutions.",
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

/**
 * Outside git, the package files pull would change or remove whose bytes are
 * not what the last pull left: a local edit, or a file no pull wrote (a suite
 * not applied yet). With no record of a pull, that is every such file.
 */
async function editedSincePull(project: ProjectConfig, pkg: Record<string, unknown>, schema: PackageSchema | null): Promise<string[]> {
  const planned = await writePackage(project.root, project.layout, pkg, schema, { dryRun: true });
  const pulled = await readPulledFiles(project.root);
  const edited: string[] = [];
  for (const file of [...planned.written, ...planned.removed]) {
    const current = await fileDigest(path.join(project.root, file));
    if (current !== undefined && current !== pulled[file]) edited.push(file);
  }
  return edited.sort((a, b) => a.localeCompare(b, "en"));
}

export const pull: CommandSpec = {
  name: "pull",
  summary: "Write the instance's package into package/ (split along the schema's sections) and the inventory into .cavelon/.",
  description:
    "With a solution (--harness, or cavelon.yaml's harness), exports that solution; without one, the tenant's full configuration.\n" +
    "A file whose content did not change keeps its bytes, so `git diff` shows what changed on the instance. Files of sections\n" +
    "the schema does not know are kept byte for byte. Refuses when package files have uncommitted changes, unless --force;\n" +
    "outside a git repository, when a file it would overwrite or remove changed since the last pull.",
  readOnly: false,
  destructive: true,
  idempotent: true,
  mcpTool: "pull",
  options: {
    harness: { type: "string", value: "<harness>", description: "The solution to export, by name, slug or id; its slug is recorded in cavelon.yaml when it names none." },
    force: { type: "boolean", description: "Overwrite package files that have uncommitted changes (outside git: changes since the last pull)." },
  },
  examples: ["cavelon pull --harness support", "cavelon pull && git diff -- package tests"],
  async run(ctx, input) {
    const session = await ctx.session();
    const project = requireSolution(session);
    const url = requireInstance(session);
    const layoutDirs = [project.layout.package, ...Object.values(project.layout.items)];
    const force = boolOption(input, "force");
    // Only package files count; an untracked .gitkeep loses nothing. Undefined outside git.
    const dirty = force ? [] : (await uncommitted(project.root, layoutDirs))?.filter((f) => /\.(ya?ml|json)"?$/i.test(f));
    if (dirty?.length) throw uncommittedChanges(dirty, "pull would overwrite uncommitted changes");
    const { ref } = harnessRef(session, input);
    let harness: Harness | undefined;
    if (ref) {
      harness = await findHarness(ctx, ref);
    }
    const scope = harness ? "agent_graph" : "full_config";
    const exported = await callStable<Record<string, unknown>>(ctx, "GET", "/api/v1/agent-graph/export", "exporting packages", {
      query: { scope, harness_id: harness?.id },
      timeoutMs: 120_000,
    });
    if (!exported || typeof exported !== "object" || Array.isArray(exported)) {
      throw new CavelonError(ExitCode.server, { code: "export_invalid", message: "The instance's export is not a package." });
    }
    const version = packageVersionOf(exported);
    const { schema } = await schemaFor(ctx, version, false);
    if (!schema) ctx.warn("The instance does not publish its package schema; every top-level key became a file of its own.");
    if (dirty === undefined) {
      const edited = await editedSincePull(project, exported, schema);
      if (edited.length) {
        throw uncommittedChanges(edited, "This folder is not in a git repository, and pull would overwrite or remove files that changed since the last pull");
      }
    }
    const report = await writePackage(project.root, project.layout, exported, schema);
    await writePulledFiles(project.root, [...report.written, ...report.unchanged]);

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
    for (const file of report.kept) ctx.warn(`Kept ${file}: its section is not in this instance's package schema.`);
    for (const section of report.refused) ctx.warn(`Did not write section ${JSON.stringify(section)}: its name is not a plain file name.`);

    const changed = report.written.length + report.removed.length;
    const lines = [
      `Pulled ${harness ? `solution ${harness.name} (${harness.slug})` : "the tenant's full configuration"} into ${project.layout.package}/` +
        (Object.keys(project.layout.items).length ? ` and ${Object.values(project.layout.items).join("/, ")}/` : "") +
        ` (format ${version ?? "unknown"}).`,
      ...report.written.map((f) => `written    ${f}`),
      ...report.removed.map((f) => `removed    ${f}`),
      `${report.unchanged.length} file${report.unchanged.length === 1 ? "" : "s"} unchanged.`,
      `Inventory: ${inventory.file} (${inventory.counts.map((c) => `${c.count} ${c.label}`).join(", ")})`,
      changed ? `See what changed: git diff -- ${layoutDirs.join(" ")}` : "Nothing changed on the instance since the last pull.",
    ];
    return { data: { ...record, inventory }, text: lines.join("\n") };
  },
};

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

async function validatePackage(ctx: Context, project: ProjectConfig, offline: boolean): Promise<{ disk: PackageOnDisk; findings: Finding[]; schemaVersion: string | null; used: SchemaUsed }> {
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
  const findings = checkPackage(disk, {
    schema,
    catalog: await catalogFor(ctx, offline),
    accepted: await acceptedVersions(ctx, offline),
    limits: await limitsFor(ctx, offline),
  });
  return { disk, findings, schemaVersion: schema["x-package-version"] ?? version ?? null, used };
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
    "Each finding carries a code: `cavelon explain <code>` says more. The import preview checks everything again on the server.\n\n" +
    "With --json, `warnings` is always a list of `{code, message}` objects: the warning findings (at most --limit), then the\n" +
    "warnings about the run, such as a stale copy of the schema, with code null. `warning_count` counts them all and\n" +
    "`error_count` the errors (`errors` is the same number); `findings` has each finding's file, line and hint.",
  readOnly: true,
  idempotent: true,
  mcpTool: "validate",
  options: {
    offline: { type: "boolean", description: "Never contact the instance, even when nothing is cached." },
    limit: { type: "string", value: "<n>", description: "Print at most n findings (default 50)." },
    verbose: { type: "boolean", description: "Also say which copy of the package schema was used: cached or read now, when, and its hash." },
  },
  async run(ctx, input) {
    const session = await ctx.session();
    const project = requireSolution(session);
    requireInstance(session);
    const limit = intOption(input, "limit", { min: 1, max: 1000, fallback: 50 })!;
    const { disk, findings, schemaVersion, used } = await validatePackage(ctx, project, boolOption(input, "offline"));
    const errors = findings.filter((f) => f.severity === "error");
    const warnings = findings.filter((f) => f.severity === "warning");
    if (disk.empty) ctx.warn(`No package files in ${project.layout.package}/ yet; \`cavelon pull\` brings an existing solution.`);
    const contracts = await ctx.contracts();
    const shown = findings.slice(0, limit);
    // One shape whether or not a warning about the run fires: the package's warnings with their codes, then the run's.
    const listed: WarningEntry[] = [
      ...warnings.slice(0, limit).map((f) => ({ code: f.code, message: f.message })),
      ...ctx.warnings.map((message) => ({ code: null, message })),
    ];
    const data = {
      valid: errors.length === 0,
      schema_version: schemaVersion,
      schema: used,
      sections: Object.keys(disk.package).length,
      error_count: errors.length,
      warning_count: warnings.length + ctx.warnings.length,
      // Kept for readers written before error_count.
      errors: errors.length,
      warnings: listed,
      findings: shown,
      more: Math.max(0, findings.length - shown.length),
    };
    const text = [
      ...(boolOption(input, "verbose") ? [schemaUsedLine(used, (v) => contracts.ttlSeconds(v))] : []),
      ...shown.map(findingLine),
      ...(data.more ? [`… and ${data.more} more (--limit).`] : []),
      errors.length
        ? `${errors.length} error${errors.length === 1 ? "" : "s"}, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}. \`cavelon explain <code>\` says more.`
        : `Valid against package schema ${schemaVersion ?? "?"} (${data.sections} sections${warnings.length ? `, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : ""}).`,
    ].join("\n");
    return { data, text, exitCode: errors.length ? ExitCode.validation : ExitCode.ok };
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
  ignored?: { sections?: string[]; fields?: string[]; count?: number };
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
function setCommands(preview: Preview, flags: string): { secrets: string[]; variables: string[] } {
  const needs = preview.target_needs ?? {};
  return {
    secrets: valueNeeds(needs.secrets).map((n) => secretSetCommand(n.name!, flags)),
    variables: valueNeeds(needs.variables).map((n) => variableSetCommand(n.name!, flags)),
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
function needsLines(needs: NonNullable<Preview["target_needs"]>, flags: string): Array<[string, unknown]> {
  const lines: Array<[string, unknown]> = [];
  const secrets = valueNeeds(needs.secrets);
  if (secrets.length) {
    const each = needLines(secrets, (name) => secretSetCommand(name, flags), "cavelon secrets list --missing" + flags);
    lines.push(["needs secrets", `${each}\n  (a person runs these in a terminal, or sets them in the Admin; never the agent)`]);
  }
  const variables = valueNeeds(needs.variables);
  if (variables.length) lines.push(["needs variables", needLines(variables, (name) => variableSetCommand(name, flags), "cavelon variables list" + flags)]);
  const grants = (needs.oauth_grants ?? []).map((g) => [g.kind, g.tool_slug, g.capability].filter(Boolean).join(" "));
  if (grants.length) lines.push(["needs grants", `${list(grants)} (a person connects them in the Admin)`]);
  const bindings = (needs.runtime_bindings ?? []).map((b) => `${b.key}${b.kind ? ` (${b.kind})` : ""}`);
  if (bindings.length) lines.push(["needs bindings", `${list(bindings)} (runtime_bindings in env/<name>.yaml)`]);
  const triggers = (needs.trigger_identities ?? []).map((t) => `${t.harness_slug}/${t.trigger_slug}: ${(t.problems ?? []).join(", ")}${t.admin_path ? ` → ${t.admin_path}` : ""}`);
  if (triggers.length) lines.push(["needs identities", triggers.map((t) => `\n  - ${t}`).join("")]);
  return lines;
}

export function previewText(p: Preview, flags = ""): string {
  const lines: Array<[string, unknown]> = [["ready", p.ready ? "yes" : "no"]];
  const s = p.summary ?? {};
  for (const [label, map] of [["creates", s.creates], ["updates", s.updates], ["deletes", s.deletes]] as const) {
    const text = counts(map);
    if (text) lines.push([label, text]);
  }
  if (lines.length === 1) lines.push(["changes", "none"]);
  if (p.blockers?.length) lines.push(["blockers", p.blockers.map((b) => `\n  - ${clip(b, 300)}`).join("")]);
  if (p.warnings?.length) lines.push(["warnings", p.warnings.slice(0, 10).map((w) => `\n  - ${clip(w, 300)}`).join("") + (p.warnings.length > 10 ? `\n  … ${p.warnings.length - 10} more` : "")]);
  const ignored = [...(p.ignored?.sections ?? []), ...(p.ignored?.fields ?? [])];
  if (ignored.length) lines.push(["ignored", list(ignored)]);
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
  lines.push(...needsLines(p.target_needs ?? {}, flags));
  return keyValues(lines);
}

function previewIdOption(input: Parameters<CommandSpec["run"]>[1]): string | undefined {
  const id = stringOption(input, "confirm");
  if (id !== undefined && !id.trim()) throw usageError("--confirm needs the preview id that `cavelon apply` printed.");
  return id?.trim();
}

async function confirmPreview(ctx: Context, project: ProjectConfig, previewId: string) {
  const stored = await loadPreview(project.root, previewId);
  if (!stored) {
    throw new CavelonError(ExitCode.usage, {
      code: "preview_unknown",
      message: `No open preview ${previewId} in this solution.`,
      hint: "Run `cavelon apply` (with the same --env or --harness) for a new preview and confirm its id; `cavelon status` lists the open ones.",
    });
  }
  const session = await ctx.session();
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
  if (digest(disk.package) !== stored.package_digest) {
    ctx.warn("The package files changed since this preview; importing what the preview showed. Run `cavelon apply` to preview the files as they are now.");
  }
  try {
    const result = await callStable<Record<string, unknown>>(ctx, "POST", "/api/v1/agent-graph/import", "importing packages", {
      body: { ...stored.request, preview_id: stored.preview_id },
      timeoutMs: 300_000,
    });
    // Every other open preview was made against the state this import changed.
    for (const other of await listPreviews(project.root)) await deletePreview(project.root, other.preview_id);
    const summary = (result.summary ?? {}) as Preview["summary"];
    const flags = targetFlags(session, stored.env ?? session.envFile?.name);
    const still = setCommands(stored.preview as Preview, flags);
    const text = keyValues([
      ["applied", `preview ${stored.preview_id}${stored.harness ? ` to ${stored.harness.slug}` : ""}${stored.env ? ` (env ${stored.env})` : ""}`],
      ["created", counts(summary?.creates) || undefined],
      ["updated", counts(summary?.updates) || undefined],
      ["deleted", counts(summary?.deletes) || undefined],
      ["warnings", Array.isArray(result.warnings) && result.warnings.length ? (result.warnings as string[]).map((w) => `\n  - ${clip(w, 300)}`).join("") : undefined],
      ["set secrets", still.secrets.length ? indented(still.secrets) + "\n  (a person runs these; never the agent)" : undefined],
      ["set variables", still.variables.length ? indented(still.variables) : undefined],
    ]);
    const data: Record<string, unknown> = { applied: true, preview_id: stored.preview_id, env: stored.env, harness: stored.harness, result };
    if (still.secrets.length || still.variables.length) data.set_commands = still;
    return { data, text };
  } catch (error) {
    if (error instanceof CavelonError && error.code === REQUIREMENTS_CHANGED && error.blockers?.length) {
      await deletePreview(project.root, stored.preview_id);
      throw requirementsChanged(error, stored, session, await catalogFor(ctx, false));
    }
    if (error instanceof CavelonError && (error.code === "import_preview_stale" || (error.status === 409 && /preview/i.test(error.message)))) {
      await deletePreview(project.root, stored.preview_id);
      throw new CavelonError(ExitCode.conflict, {
        code: error.code === "conflict" ? "import_preview_stale" : error.code,
        status: 409,
        message: `The target changed since preview ${stored.preview_id}; nothing was imported.`,
        hint: `Run \`${previewAgain(stored, session)}\` again, show the new preview, and confirm its id.`,
        docs: error.docs,
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
function requirementsChanged(error: CavelonError, stored: StoredPreview, session: Session, catalog: ErrorCatalog | null): CavelonError {
  const blockers = error.blockers ?? [];
  const known = new Map<string, string>();
  for (const blocker of blockers) {
    const pair = pairOrderHint(catalog, [blocker]);
    if (pair && !known.has(pair.code)) known.set(pair.code, pair.hint);
  }
  return new CavelonError(ExitCode.conflict, {
    code: error.code,
    status: error.status,
    message: `The import's requirements changed since preview ${stored.preview_id}; nothing was imported; preview again.`,
    hint: [...known.values(), `Run \`${previewAgain(stored, session)}\` again, show the new preview, and confirm its id.`].join(" "),
    docs: error.docs,
    blockers,
  });
}

/**
 * The solution an apply imports into. One that an env file names and that
 * does not exist yet is created as a draft; one named on the command line
 * never is, so a typo cannot create a solution.
 */
/** The `apply` that previews the same target again, in the same tenant. */
function previewAgain(stored: StoredPreview, session: Session): string {
  const harness = !stored.env && stored.harness ? ` --harness ${shellWord(stored.harness.slug)}` : "";
  return `cavelon apply${harness}${targetFlags(session, stored.env)}`;
}

async function applyTarget(
  ctx: Context,
  session: Session,
  input: Parameters<CommandSpec["run"]>[1],
  pkg: Record<string, unknown>,
): Promise<(Harness & { created: boolean }) | undefined> {
  const { ref, source } = harnessRef(session, input);
  if (!ref) return undefined;
  const { harness: found, candidates } = await lookupHarness<Harness>(ctx, ref);
  if (found) return { ...found, created: false };
  if (!source?.startsWith("env/") || isUuid(ref)) throw harnessNotFoundError(ref, candidates, source);
  const name = packageHarnessName(pkg, ref) ?? ref;
  const created = await callStable<Harness>(ctx, "POST", "/api/v1/harnesses", "creating solutions", { body: { slug: ref, name } });
  ctx.warn(`Created the draft solution ${created.name} (${created.slug}) that ${source} names.`);
  return { ...created, created: true };
}

/**
 * The name the package gives the solution a draft is created for: the entry of
 * its harnesses section with that slug, else its only entry. None when the
 * package holds no harness, or several and none with the slug.
 */
function packageHarnessName(pkg: Record<string, unknown>, slug: string): string | undefined {
  const entries = (Array.isArray(pkg.harnesses) ? pkg.harnesses : []).filter(
    (h): h is Record<string, unknown> => Boolean(h) && typeof h === "object" && !Array.isArray(h),
  );
  const entry = entries.find((h) => h.slug === slug) ?? (entries.length === 1 ? entries[0] : undefined);
  const name = typeof entry?.name === "string" ? entry.name.trim() : "";
  return name ? name.slice(0, 255) : undefined;
}

/** Whether a preview needs a person's look before it is confirmed, and why. */
function personReason(preview: Preview, harness: Harness | undefined, mode: string, env: string | undefined): string | undefined {
  if (preview.impact?.active_harnesses?.length || harness?.status === "active") return "reaches an active solution";
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
    "budgets and ignored sections, and is stored in .cavelon/. When the env file names a solution that does not exist yet,\n" +
    "apply creates it as a draft first. A person sets the secrets (`cavelon secrets set <name>`), never the agent.\n" +
    "Show a preview that reaches an active solution or env/prod to a person before confirming. A stale preview exits 4;\n" +
    "so does an import its own check refuses when it applies, naming each blocker.",
  readOnly: false,
  destructive: true,
  mcpTool: "apply",
  options: {
    env: ENV_OPTION,
    harness: HARNESS_OPTION,
    confirm: { type: "string", value: "<preview-id>", description: "Import exactly this stored preview." },
    mode: { type: "string", value: "<mode>", description: "overwrite (default) or replace (deletes what the package does not hold)." },
  },
  examples: ["cavelon apply --env test", "cavelon apply --confirm <preview-id>", "cavelon apply --env prod --json"],
  async run(ctx, input) {
    const session = await ctx.session();
    const project = requireSolution(session);
    const url = requireInstance(session);
    const confirm = previewIdOption(input);
    if (confirm) return confirmPreview(ctx, project, confirm);

    const envFile = session.envFile;
    if (envFile?.tenant && session.tenantSource !== `env/${envFile.name}.yaml`) {
      ctx.warn(`${session.tenantSource} names tenant "${session.tenant}" and takes precedence over ${envFile.name}.yaml's "${envFile.tenant}".`);
    }
    const mode = (stringOption(input, "mode") ?? envFile?.mode ?? "overwrite") as ImportRequest["mode"];
    if (mode !== "overwrite" && mode !== "replace") throw usageError(`--mode must be overwrite or replace, got "${mode}".`);

    const { disk, findings } = await validatePackage(ctx, project, false);
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

    const client = await ctx.client();
    const preview = await callStable<Preview>(ctx, "POST", "/api/v1/agent-graph/import/preview", "previewing imports", {
      body: request,
      timeoutMs: 120_000,
    });
    const target = harness ? { id: harness.id, slug: harness.slug, created: harness.created } : null;
    const data: Record<string, unknown> = { previewed: true, ...preview, env: envFile?.name ?? null, harness: target };
    const flags = targetFlags(session);
    const commands = setCommands(preview, flags);
    if (commands.secrets.length || commands.variables.length) data.set_commands = commands;
    if (!preview.preview_id) {
      ctx.warn("This instance's preview returns no preview id, so `apply --confirm` cannot import exactly it; update the instance.");
    }
    if (!preview.ready) {
      // A Masterloop pair applied out of order: say which step, and the order.
      const pair = pairOrderHint(await catalogFor(ctx, false), preview.blockers ?? []);
      if (pair) data.hint = pair.hint;
      return {
        data,
        text: [
          previewText(preview, flags),
          "",
          ...(pair ? [`hint: ${pair.hint}`] : []),
          "The preview has blockers; fix them and run `cavelon apply` again.",
        ].join("\n"),
        exitCode: ExitCode.validation,
      };
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
        request,
        preview,
      };
      await savePreview(project.root, stored);
    }
    const reason = personReason(preview, harness, mode, envFile?.name);
    data.show_to_person = Boolean(reason);
    const confirmLine = preview.preview_id ? `${cavelonCommand("apply", "--confirm", preview.preview_id)}${flags}` : undefined;
    const text = [
      `Preview of ${project.layout.package}/ for ${harness ? `solution ${harness.slug}${harness.status ? ` (${harness.status})` : ""}` : "the tenant"}${envFile ? ` [env ${envFile.name}]` : ""}:`,
      previewText(preview, flags),
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

export const explain: CommandSpec = {
  name: "explain",
  summary: "Look a code up in the instance's error catalog: what it means and how to fix it.",
  description:
    "Rule codes come from the package and graph checks, API error codes from failed requests. Uses the cached catalog first.\n" +
    `Also explains the test-case statuses that are neither pass nor fail: ${CASE_STATUSES.map((s) => s.status).join(", ")}.`,
  readOnly: true,
  idempotent: true,
  mcpTool: "explain",
  positionals: [{ name: "code", description: "The code, e.g. from `cavelon validate` or an error's code, or a test-case status.", required: true }],
  async run(ctx, input) {
    const code = positional(input, "code")!.trim();
    const status = caseStatus(code);
    // A test-case status needs no instance; a catalog that lists the same name still wins.
    let catalog = status ? await catalogFor(ctx, false).catch(() => null) : await catalogFor(ctx, false);
    let entry = catalogEntry(catalog, code) ?? looseEntry(catalog, code);
    if (!entry && status) return caseStatusAnswer(ctx, status);
    if (!entry || entry.kind === "kit") {
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
      const all = [...(catalog?.rule_codes ?? []), ...(catalog?.api_error_codes ?? []), ...KIT_CODES, ...CASE_STATUSES.map((s) => ({ code: s.status }))].map((e) => e.code);
      const words = code.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      const similar = all.filter((c) => words.some((w) => c.toLowerCase().includes(w))).slice(0, 8);
      throw new CavelonError(ExitCode.failure, {
        code: "code_unknown",
        message: `"${code}" is not in this instance's error catalog.`,
        hint: similar.length ? `Similar codes: ${similar.join(", ")}.` : `Try \`cavelon docs search ${code}\`.`,
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
    const data = { ...entry, docs, ...(kitHint ? { kit_hint: kitHint } : {}), ...(read.length ? { read } : {}) };
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
              : `API error code${entry.area ? ` (${entry.area})` : ""}`,
        ],
        ["meaning", entry.message],
        ["fix", entry.hint ?? undefined],
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
}

interface Readiness {
  ready_to_activate: boolean;
  status?: string;
  checks?: ReadinessCheck[];
  blockers?: ReadinessCheck[];
  warnings?: ReadinessCheck[];
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

export const activate: CommandSpec = {
  name: "activate",
  summary: "Activate a solution through the readiness gate (never by force).",
  description:
    "Only when every readiness check passes, and with a personal access token only when it was created with \"may activate\".\n" +
    "Activating without the evidence stays a person's decision in the Admin.",
  readOnly: false,
  idempotent: true,
  mcpTool: "activate",
  options: { harness: HARNESS_OPTION, env: ENV_OPTION },
  async run(ctx, input) {
    const session = await ctx.session();
    const { ref, source } = harnessRef(session, input);
    if (!ref) throw usageError("Which solution?", "Pass --harness <name or slug> (`cavelon harness list` shows them), or set harness in cavelon.yaml or the env file.");
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
      return { data: { activated: false, already_active: true, harness }, text: `${harness.name} (${harness.slug}) is already active.` };
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
      return {
        data: { activated: false, harness, checks, warnings, readiness, ...(pair ? { hint: pair.hint } : {}) },
        text: [
          `${harness.name} (${harness.slug}) is not ready to activate:`,
          ...blockers.map((b) => `  - ${checkLine(b)}`),
          ...readinessText(checks, warnings),
          ...(pair ? [`hint: ${pair.hint}`] : []),
          "Resolve these (often: a passing test run), then activate again. Forcing past the gate is a person's decision in the Admin.",
        ].join("\n"),
        exitCode: ExitCode.validation,
      };
    }
    const activated = await callStable<Harness>(ctx, "POST", "/api/v1/harnesses/{harness_id}/activate", "activating solutions", {
      params: { harness_id: [harness.id] },
      body: { force: false },
    });
    return {
      data: { activated: true, harness: activated, checks, warnings, readiness },
      text: [`Activated ${activated.name} (${activated.slug}); status ${activated.status}.`, ...readinessText(checks, warnings)].join("\n"),
    };
  },
};

