import { promises as fs } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { boolOption, listOption, stringOption, type CommandSpec, type Context } from "../command.js";
import { AGENTS, bundledSkills, generatedCopy, parseAgents, SKILL_ROOTS, type AgentTarget, type McpTarget } from "../agents.js";
import { CavelonError, ExitCode, usageError } from "../errors.js";
import { readTextFile, writeFileAtomic } from "../fsutil.js";
import { git } from "../git.js";
import { ensureStateDir, STATE_DIR } from "../local-state.js";
import { isGenerated, upsertBlock, upsertJsonEntry, type BlockResult, type CommentStyle } from "../markers.js";
import { packageVersionOf } from "../package-check.js";
import { defaultLayoutFor, safeSectionName, schemaSections, toYaml, writePackage, type WriteReport } from "../package-files.js";
import { readPrincipal } from "../principal.js";
import { ENV_DIR, parseProject, PROJECT_FILE, type ProjectConfig } from "../project.js";
import { requireInstance, requireToken } from "../session.js";
import { schemaFor, setProjectKey } from "./solution.js";

/**
 * `cavelon init`: make the current folder a solution (plan 04, "Repository
 * layout" and "Files the kit writes"). It creates only its own files and
 * folders; a file that may be the customer's gets at most a marked block.
 */

export interface FileAction {
  /** Relative to the solution folder, with forward slashes. */
  file: string;
  action: "created" | "appended" | "updated" | "unchanged" | "skipped";
  reason?: string;
}

// Only an invalid package (exit 3) stops the commit; a check that cannot run
// (no cavelon, no network for npx) warns and lets it through.
const HOOK_LINES = (prefix: string) => [
  "# Check the Cavelon package before each commit (`cavelon init --hook`).",
  'cavelon_cmd="npx -y @cavelon/cli"; command -v cavelon >/dev/null 2>&1 && cavelon_cmd=cavelon',
  `if ( cd "./${prefix}" && $cavelon_cmd validate ); then cavelon_code=0; else cavelon_code=$?; fi`,
  'if [ "$cavelon_code" -eq 3 ]; then exit 1; fi',
  'if [ "$cavelon_code" -ne 0 ]; then echo "warning: cavelon validate could not run (exit $cavelon_code); the package was not checked." >&2; fi',
];

export const AGENTS_BLOCK = [
  "## Cavelon solution",
  "",
  "This folder is a Cavelon solution (`cavelon.yaml`): edit `package/`, `tests/` and `env/`, then run `cavelon validate` and `cavelon apply`.",
  "Use the Cavelon skills (cavelon-loop, cavelon-authoring, cavelon-testing, cavelon-long-running); without them, `cavelon --help` and `cavelon docs search <query>` lead on.",
  "`cavelon apply` only previews; show a preview that reaches an active solution or `env/prod` to a person before `cavelon apply --confirm <id>`.",
  "`cavelon status` shows the instance, tenant and open previews, and `.cavelon/inventory.md` the tenant's solutions, knowledge bases and tools. A person runs `cavelon login`; never handle a token.",
].join("\n");

const GITIGNORE_BLOCK = ["# Local cavelon state (inventory, previews); never committed.", `${STATE_DIR}/`].join("\n");

function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** The file a path names, through symlinks: a customer's link stays a link. */
async function realFile(file: string): Promise<string> {
  try {
    return await fs.realpath(file);
  } catch {
    return file;
  }
}

async function applyBlock(root: string, file: string, result: BlockResult, mode?: number): Promise<FileAction> {
  if (result.content !== undefined && result.outcome !== "unchanged" && result.outcome !== "skipped") {
    const target = await realFile(file);
    // An existing file keeps its permissions.
    const current = await fs.stat(target).then((st) => st.mode & 0o777, () => undefined);
    await writeFileAtomic(target, result.content, current ?? mode);
  }
  return { file: rel(root, file), action: result.outcome, ...(result.reason ? { reason: result.reason } : {}) };
}

async function block(root: string, relative: string, body: string, style: CommentStyle, options: { onlyExisting?: boolean } = {}): Promise<FileAction> {
  const file = path.join(root, relative);
  return applyBlock(root, file, upsertBlock(await readTextFile(file), body, style, options));
}

/** CLAUDE.md gets the `@AGENTS.md` import, unless it is AGENTS.md itself (a symlink). */
async function claudeImport(root: string, onlyExisting: boolean): Promise<FileAction | undefined> {
  const claude = path.join(root, "CLAUDE.md");
  if ((await readTextFile(claude)) === undefined) return undefined;
  if ((await realFile(claude)) === (await realFile(path.join(root, "AGENTS.md")))) {
    return { file: "CLAUDE.md", action: "unchanged", reason: "it is AGENTS.md" };
  }
  return block(root, "CLAUDE.md", "@AGENTS.md", "html", { onlyExisting });
}

/** A file only the kit writes: created when missing, otherwise left as it is. */
async function ownFile(root: string, relative: string, content: string): Promise<FileAction> {
  const file = path.join(root, relative);
  if ((await readTextFile(file)) !== undefined) return { file: relative, action: "unchanged" };
  await writeFileAtomic(file, content);
  return { file: relative, action: "created" };
}

/** A generated fallback file: created, or replaced when the kit wrote it; never someone else's. */
async function generatedFile(root: string, relative: string, content: string): Promise<FileAction> {
  const file = path.join(root, relative);
  const existing = await readTextFile(file);
  if (existing === undefined) {
    await writeFileAtomic(file, content);
    return { file: relative, action: "created" };
  }
  if (!isGenerated(existing)) return { file: relative, action: "skipped", reason: "it was not written by cavelon" };
  if (existing === content) return { file: relative, action: "unchanged" };
  await writeFileAtomic(file, content);
  return { file: relative, action: "updated" };
}

async function folder(root: string, relative: string): Promise<FileAction[]> {
  const dir = path.join(root, relative);
  try {
    await fs.stat(dir);
    return [];
  } catch {
    await fs.mkdir(dir, { recursive: true });
    // Git keeps no empty folders; the placeholder keeps the layout in the repository.
    await writeFileAtomic(path.join(dir, ".gitkeep"), "");
    return [{ file: `${relative}/`, action: "created" }];
  }
}

async function writeSkills(root: string, roots: string[]): Promise<FileAction[]> {
  const skills = await bundledSkills();
  if (!skills.length) {
    throw new CavelonError(ExitCode.failure, {
      code: "skills_missing",
      message: "This cavelon has no skills to install (its package is incomplete).",
      hint: "Reinstall @cavelon/cli.",
    });
  }
  const actions: FileAction[] = [];
  for (const skillRoot of roots) {
    for (const skill of skills) {
      for (const file of skill.files) {
        actions.push(await generatedFile(root, `${skillRoot}/${skill.name}/${file.path}`, generatedCopy(file)));
      }
    }
  }
  return actions;
}

async function writeMcp(root: string, target: McpTarget, onlyExisting: boolean): Promise<FileAction> {
  const file = path.join(root, target.file);
  const existing = await readTextFile(file);
  if (target.format === "toml") return applyBlock(root, file, upsertBlock(existing, target.block, "hash", { onlyExisting }));
  if (onlyExisting) {
    let present = false;
    try {
      present = Boolean(existing && (JSON.parse(existing) as Record<string, Record<string, unknown>>)[target.keys[0]!]?.[target.keys[1]!]);
    } catch {
      present = false;
    }
    if (!present) return { file: target.file, action: "skipped", reason: "it has no cavelon entry" };
  }
  const result = upsertJsonEntry(existing, target.keys, target.entry);
  if (result.outcome === "skipped") {
    result.reason = `${result.reason}; add "${target.keys.join(".")}": ${JSON.stringify(target.entry)} yourself`;
  }
  return applyBlock(root, file, result);
}

/** Skill folders and MCP entries a previous `init --agents` wrote, for `init --update`. */
async function installedFallback(root: string): Promise<{ skillRoots: string[]; agents: AgentTarget[] }> {
  const skillRoots: string[] = [];
  for (const skillRoot of SKILL_ROOTS) {
    try {
      const names = await fs.readdir(path.join(root, skillRoot));
      for (const name of names.filter((n) => n.startsWith("cavelon-"))) {
        if (isGenerated(await readTextFile(path.join(root, skillRoot, name, "SKILL.md")))) {
          skillRoots.push(skillRoot);
          break;
        }
      }
    } catch {
      // No skills there.
    }
  }
  const agents: AgentTarget[] = [];
  for (const agent of AGENTS) {
    if (!agent.mcp) continue;
    const text = await readTextFile(path.join(root, agent.mcp.file));
    if (text?.includes("cavelon")) agents.push(agent);
  }
  return { skillRoots, agents };
}

async function installHook(root: string, onlyExisting: boolean): Promise<FileAction> {
  const hooks = (await git(["rev-parse", "--git-path", "hooks"], root))?.trim();
  const prefix = (await git(["rev-parse", "--show-prefix"], root))?.trim();
  if (!hooks || prefix === undefined) {
    return { file: ".git/hooks/pre-commit", action: "skipped", reason: "this folder is not in a git repository" };
  }
  const file = path.resolve(root, hooks, "pre-commit");
  const body = HOOK_LINES(prefix).join("\n");
  const existing = await readTextFile(file);
  let result = upsertBlock(existing, body, "hash", { onlyExisting, afterShebang: true });
  if (result.outcome === "created") result = { ...result, content: `#!/bin/sh\n${result.content}` };
  // A new hook is the owner's alone; an existing one keeps its permissions.
  const action = await applyBlock(root, file, result, 0o700);
  if (action.action !== "skipped" && action.action !== "unchanged") {
    const mode = (await fs.stat(file)).mode & 0o777;
    if (!(mode & 0o100)) await fs.chmod(file, mode | 0o100).catch(() => undefined);
  }
  return action;
}

function solutionYaml(values: Record<string, unknown>): string {
  return [
    "# A Cavelon solution. `cavelon` finds this file from the working directory upwards;",
    "# it names the instance, tenant and solution, never a token.",
    toYaml(values).trimEnd(),
    "",
  ].join("\n");
}

function envYaml(name: string, harness: string | undefined): string {
  return [
    `# Where \`cavelon apply --env ${name}\` goes. Never a token or a secret value.`,
    "# tenant: <slug or id>        # default: the tenant in cavelon.yaml",
    harness ? `harness: ${harness}` : "# harness: <slug>             # created as a draft when it does not exist yet",
    "# mode: overwrite             # or replace",
    "# runtime_bindings:           # the package's runtime requirement key -> this tenant's resource id",
    "#   <key>: <id>",
    "",
  ].join("\n");
}

async function hasPackageFiles(root: string, dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(path.join(root, dir))).some((n) => /\.(ya?ml|json)$/i.test(n));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// init --from: an existing package file into the solution's layout
// ---------------------------------------------------------------------------

/** A package file bigger than this is not an export. */
const MAX_PACKAGE_FILE_BYTES = 50 * 1024 * 1024;

export interface ImportedPackage {
  /** The file as the user named it. */
  from: string;
  files: WriteReport;
  /** Top-level sections the instance's package schema does not know: written, and ignored by the instance. */
  ignored: string[];
  package_version: string | null;
}

function importFileError(from: string, reason: string, hint?: string): CavelonError {
  return new CavelonError(ExitCode.usage, {
    code: "package_import_invalid",
    message: `${from} is not a package file: ${reason}.`,
    hint: hint ?? "Pass a package export: a JSON or YAML file with one key per section (manifest, harnesses, agents, …).",
  });
}

/** Read a package export (JSON or YAML) that `--from` names. */
async function readImportFile(cwd: string, from: string): Promise<Record<string, unknown>> {
  const file = path.resolve(cwd, from);
  const stat = await fs.stat(file).catch(() => undefined);
  if (!stat?.isFile()) throw usageError(`No file ${from}.`, "Pass the path of a package export (JSON or YAML) to --from.");
  if (stat.size > MAX_PACKAGE_FILE_BYTES) throw importFileError(from, `it is larger than ${MAX_PACKAGE_FILE_BYTES / 1024 / 1024} MB`);
  const text = (await readTextFile(file)) ?? "";
  let value: unknown;
  if (/\.json$/i.test(file)) {
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw importFileError(from, `not valid JSON (${(error as Error).message})`);
    }
  } else {
    const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
    if (doc.errors.length) throw importFileError(from, `not valid YAML (${doc.errors[0]!.message.split("\n")[0]})`);
    value = doc.toJS({ maxAliasCount: 1000 });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw importFileError(from, "its top level is not a mapping of sections");
  return value as Record<string, unknown>;
}

/** The slug of the package's only harness: the solution the folder holds when no --harness names one. */
function onlyHarnessSlug(pkg: Record<string, unknown>): string | undefined {
  const harnesses = Array.isArray(pkg.harnesses) ? pkg.harnesses : [];
  if (harnesses.length !== 1) return undefined;
  const slug = (harnesses[0] as Record<string, unknown> | null)?.slug;
  return typeof slug === "string" && slug.trim() ? slug.trim() : undefined;
}

/**
 * Write a package file into the solution as `pull` writes an export. A file
 * that already holds the same value keeps its bytes; one that would change or
 * go away is a conflict that stops the import before anything is written,
 * unless `force`.
 */
async function importPackage(ctx: Context, project: ProjectConfig, from: string, pkg: Record<string, unknown>, force: boolean): Promise<ImportedPackage> {
  const version = packageVersionOf(pkg);
  const { schema } = await schemaFor(ctx, version ?? project.packageVersion, false);
  if (!schema) ctx.warn("The instance does not publish its package schema; every top-level key became a file of its own.");
  const planned = await writePackage(project.root, project.layout, pkg, schema, { dryRun: true });
  const overwritten: string[] = [];
  for (const file of planned.written) {
    if ((await readTextFile(path.join(project.root, file))) !== undefined) overwritten.push(file);
  }
  const conflicts = [...overwritten, ...planned.removed].sort((a, b) => a.localeCompare(b, "en"));
  if (conflicts.length && !force) {
    throw new CavelonError(ExitCode.conflict, {
      code: "package_files_differ",
      message:
        `${from} would change or remove package files that hold something else: ${conflicts.slice(0, 5).join(", ")}` +
        `${conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : ""}. Nothing was written.`,
      hint: "Commit or compare them first, then pass --force to replace them with the file's package.",
      details: { files: conflicts },
    });
  }
  const files = await writePackage(project.root, project.layout, pkg, schema, {});
  if (version && project.packageVersion !== version) await setProjectKey(project, "package_version", version);
  const known = new Set(schemaSections(schema));
  const ignored = schema ? Object.keys(pkg).filter((section) => !known.has(section) && safeSectionName(section)) : [];
  for (const section of ignored) {
    ctx.warn(`This instance's package schema has no section "${section}"; it was written, apply sends it as it is, and the instance ignores it.`);
  }
  for (const section of files.refused) ctx.warn(`Did not write section ${JSON.stringify(section)}: its name is not a plain file name.`);
  return { from, files, ignored, package_version: version ?? null };
}

async function runInit(ctx: Context, input: Parameters<CommandSpec["run"]>[1]) {
  const update = boolOption(input, "update");
  const from = stringOption(input, "from");
  const agentNames = listOption(input, "agents");
  const agents = agentNames.length ? parseAgents(agentNames) : [];
  const session = await ctx.session();
  const actions: FileAction[] = [];
  const next: string[] = [];
  if (from !== undefined && !from.trim()) throw usageError("--from needs the path of a package file.");
  if (from && update) throw usageError("--from and --update do not go together.", "Run `cavelon init --from <file>` and `cavelon init --update` one after the other.");
  if (boolOption(input, "force") && !from) throw usageError("--force only applies to --from.");
  // Read the file before anything is written: a wrong path changes nothing.
  const imported = from ? await readImportFile(ctx.io.cwd, from) : undefined;

  if (update) {
    if (!session.project) throw usageError("No cavelon.yaml here or above.", "Run `cavelon init` first.");
    const root = session.project.root;
    actions.push(await block(root, "AGENTS.md", AGENTS_BLOCK, "html", { onlyExisting: true }));
    const claude = await claudeImport(root, true);
    if (claude) actions.push(claude);
    actions.push(await block(root, ".gitignore", GITIGNORE_BLOCK, "hash", { onlyExisting: true }));
    actions.push(await installHook(root, !boolOption(input, "hook")));
    const installed = await installedFallback(root);
    const skillRoots = agents.length ? SKILL_ROOTS : installed.skillRoots;
    if (skillRoots.length) actions.push(...(await writeSkills(root, skillRoots)));
    for (const agent of new Set([...installed.agents, ...agents])) {
      if (agent.mcp) actions.push(await writeMcp(root, agent.mcp, !agents.includes(agent)));
    }
    return { root, actions: actions.filter((a) => !(a.action === "skipped" && /does not exist|no cavelon (block|entry)/.test(a.reason ?? ""))), next, imported: undefined };
  }
  const packageHarness = imported ? onlyHarnessSlug(imported) : undefined;

  const root = ctx.io.cwd;
  const existing = await readTextFile(path.join(root, PROJECT_FILE));
  if (existing !== undefined) {
    actions.push({ file: PROJECT_FILE, action: "unchanged" });
  } else {
    const url = requireInstance(session);
    requireToken(session);
    const contracts = await ctx.contracts();
    const caps = await contracts.capabilities();
    if (contracts.needsTenant) {
      throw new CavelonError(ExitCode.usage, {
        code: "tenant_required",
        message: "A solution belongs to one tenant, and none is chosen.",
        hint: "Pass --tenant <slug>, or run `cavelon use <tenant>` first.",
      });
    }
    // Cache the schema and the catalog now, so `validate` works offline from here on.
    const schema = await contracts.packageSchema();
    await contracts.errorCatalog().catch(() => null);
    if (!schema) ctx.warn("The instance does not publish its package schema; `validate` will have nothing to check against.");
    let tenant = session.tenant;
    if (!tenant && session.tokenKind !== "api_key") {
      const principal = await readPrincipal(await ctx.client());
      tenant = principal?.tenant_id ?? undefined;
    }
    const harness = stringOption(input, "harness") ?? packageHarness;
    const values: Record<string, unknown> = { instance: url };
    if (tenant) values.tenant = tenant;
    if (harness) values.harness = harness;
    const version = caps?.contracts?.package_versions?.current ?? schema?.["x-package-version"];
    if (version) values.package_version = version;
    values.layout = defaultLayoutFor(schema);
    await writeFileAtomic(path.join(root, PROJECT_FILE), solutionYaml(values));
    actions.push({ file: PROJECT_FILE, action: "created" });
  }

  const project = parseProject(path.join(root, PROJECT_FILE), (await readTextFile(path.join(root, PROJECT_FILE)))!);
  for (const dir of new Set([project.layout.package, "tests", ...Object.values(project.layout.items)])) {
    actions.push(...(await folder(root, dir)));
  }
  actions.push(...(await folder(root, "seeds")));
  const harness = stringOption(input, "harness") ?? project.harness ?? packageHarness;
  actions.push(await ownFile(root, `${ENV_DIR}/test.yaml`, envYaml("test", harness)));
  actions.push(await ownFile(root, `${ENV_DIR}/prod.yaml`, envYaml("prod", undefined)));
  if (await ensureStateDir(root)) actions.push({ file: `${STATE_DIR}/`, action: "created" });
  actions.push(await block(root, ".gitignore", GITIGNORE_BLOCK, "hash"));
  actions.push(await block(root, "AGENTS.md", AGENTS_BLOCK, "html"));
  const claude = await claudeImport(root, false);
  if (claude) actions.push(claude);
  if (agents.length) {
    actions.push(...(await writeSkills(root, SKILL_ROOTS)));
    for (const agent of agents) if (agent.mcp) actions.push(await writeMcp(root, agent.mcp, false));
  }
  if (boolOption(input, "hook")) actions.push(await installHook(root, false));
  else next.push("Catch an invalid package before each commit: cavelon init --hook");
  let result: ImportedPackage | undefined;
  if (imported && from) {
    result = await importPackage(ctx, project, from, imported, boolOption(input, "force"));
    if (packageHarness && !project.harness && !stringOption(input, "harness")) await setProjectKey(project, "harness", packageHarness);
    next.unshift("Check it offline: cavelon validate", `Preview it on the instance: cavelon apply${harness ? " --env test" : " --harness <slug>"}`);
  } else if (!(await hasPackageFiles(root, project.layout.package))) {
    next.unshift(
      harness
        ? `Bring the solution into package/: cavelon pull`
        : "Bring an existing solution into package/: cavelon pull --harness <slug>  (or write package files, then cavelon validate)",
    );
  }
  return { root, actions, next, imported: result };
}

export const init: CommandSpec = {
  name: "init",
  summary: "Make this folder a Cavelon solution: cavelon.yaml, package/, tests/, env/ and .cavelon/.",
  description:
    "Never overwrites a file it did not create. AGENTS.md, .gitignore and an existing CLAUDE.md get at most a block between\n" +
    "cavelon:begin and cavelon:end markers. --agents also writes the skills to .agents/skills/ and .claude/skills/ and each\n" +
    "named agent's `cavelon mcp` entry, for agents without the Cavelon plugin. --update changes only those marked blocks and\n" +
    "the fallback files a previous init wrote. --from writes an existing package file (JSON or YAML export) into package/ and\n" +
    "tests/ as `pull` writes an export, so validate and apply take it from there; it refuses to change or remove a package\n" +
    "file that holds something else unless --force, and names the sections the instance's schema does not know.",
  readOnly: false,
  destructive: true,
  idempotent: true,
  mcpTool: "init",
  options: {
    harness: { type: "string", value: "<slug>", description: "The solution (harness) this folder holds; pull and apply use it." },
    agents: {
      type: "string",
      value: "<list>",
      multiple: true,
      description: `Write the fallback for these agents: ${AGENTS.map((a) => a.name).join(", ")} or all (comma-separated).`,
    },
    hook: { type: "boolean", description: "Add a git pre-commit hook that runs `cavelon validate`." },
    update: { type: "boolean", description: "Only bring the marked blocks and fallback files to this version." },
    from: { type: "string", value: "<file>", description: "Write this package file (a JSON or YAML export) into package/ and tests/." },
    force: { type: "boolean", description: "With --from: replace package files that hold something else." },
  },
  examples: [
    "cavelon init --instance https://cavelon.example.com --tenant acme --harness support",
    "cavelon init --agents codex,cursor --hook",
    "cavelon init --update",
    "cavelon init --instance https://cavelon.example.com --tenant acme --from ./blueprint.json",
  ],
  async run(ctx, input) {
    const { root, actions, next, imported } = await runInit(ctx, input);
    const changed = actions.filter((a) => a.action !== "unchanged");
    const skipped = actions.filter((a) => a.action === "skipped");
    for (const s of skipped) ctx.warn(`Left ${s.file} as it is: ${s.reason}.`);
    const lines = changed.filter((a) => a.action !== "skipped").map((a) => `${a.action.padEnd(9)} ${a.file}`);
    if (imported) {
      lines.push(...imported.files.written.map((f) => `written   ${f}`), ...imported.files.removed.map((f) => `removed   ${f}`));
      const same = imported.files.unchanged.length;
      lines.push(`Wrote ${imported.from} into the solution${same ? ` (${same} file${same === 1 ? "" : "s"} already held it)` : ""}.`);
      if (imported.ignored.length) lines.push(`ignored   ${imported.ignored.join(", ")} (not in this instance's package schema)`);
    }
    const text = [
      lines.length ? lines.join("\n") : "Nothing to change.",
      ...(next.length ? ["", "Next:", ...next.map((n) => `  ${n}`)] : []),
    ].join("\n");
    return { data: { solution: root, files: actions, ...(imported ? { imported } : {}), next }, text };
  },
};
