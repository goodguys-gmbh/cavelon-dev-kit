import { promises as fs } from "node:fs";
import path from "node:path";
import { LineCounter, parseDocument, stringify, type Document } from "yaml";
import type { PackageSchema } from "./contracts.js";
import { CavelonError, ExitCode } from "./errors.js";
import { readTextFile, withoutBom, writeFileAtomic } from "./fsutil.js";

/**
 * A solution package as files in the repository, split along the top-level
 * sections of the instance's published package schema (plan 02, coupling
 * rule 1): one `package/<section>.yaml` per section, never a hard-coded
 * entity type. A layout may keep a section's items one file each in another
 * folder (`tests/` for the test suites). Sections the schema does not know
 * are kept byte for byte and sent as they are; the instance's preview lists
 * them as ignored.
 */

export interface Layout {
  /** The folder of the section files, relative to the solution root. */
  package: string;
  /** Sections kept one file per item, by folder: `{ test_suites: "tests" }`. */
  items: Record<string, string>;
}

export const DEFAULT_LAYOUT: Layout = { package: "package", items: {} };

const PACKAGE_FILE = /\.(ya?ml|json)$/i;

/** The layout `cavelon.yaml` names, or the default one. */
export function layoutFrom(raw: Record<string, unknown>): Layout {
  const value = raw.layout;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_LAYOUT, items: {} };
  const map = value as Record<string, unknown>;
  const items: Record<string, string> = {};
  if (map.items && typeof map.items === "object" && !Array.isArray(map.items)) {
    for (const [section, folder] of Object.entries(map.items as Record<string, unknown>)) {
      if (typeof folder === "string" && safeFolder(folder)) items[section] = folder;
    }
  }
  const pkg = typeof map.package === "string" && safeFolder(map.package) ? map.package : DEFAULT_LAYOUT.package;
  return { package: pkg, items };
}

/** A folder inside the solution: relative, no `..`. */
function safeFolder(folder: string): boolean {
  const normalized = path.posix.normalize(folder.replace(/\\/g, "/"));
  return normalized !== "." && !normalized.startsWith("..") && !path.isAbsolute(folder) && !normalized.startsWith("/");
}

/** The layout for a new solution: the schema's test-suite section, if it has one, lives in `tests/`. */
export function defaultLayoutFor(schema: PackageSchema | null): Layout {
  const items: Record<string, string> = {};
  const suites = schema?.properties?.test_suites;
  if (suites && suites.type === "array") items.test_suites = "tests";
  return { package: DEFAULT_LAYOUT.package, items };
}

export function schemaSections(schema: PackageSchema | null): string[] {
  return Object.keys(schema?.properties ?? {});
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface Finding {
  code: string;
  severity: "error" | "warning";
  message: string;
  /** The file, relative to the solution root, with forward slashes. */
  file?: string;
  line?: number;
  /** Where in the package, e.g. `agents[0].name`. */
  path?: string;
  hint?: string;
  docs?: string;
  /** The name the finding suggests instead of a misspelt one ("did you mean"). */
  suggestion?: string;
}

interface Source {
  file: string;
  doc?: Document;
  lines?: LineCounter;
}

export interface PackageOnDisk {
  /** The package as the instance receives it. */
  package: Record<string, unknown>;
  /** Where each section came from: one file, or one file per item. */
  sources: Record<string, Source | Source[]>;
  findings: Finding[];
  /** True when the solution has no package files yet (before the first pull). */
  empty: boolean;
}

function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/**
 * The package files in a folder. A symlink counts as the file it leads to, so
 * a section kept elsewhere in the solution is neither dropped from validate
 * nor from apply; a link to a folder is not a file.
 */
async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const names: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".") || !PACKAGE_FILE.test(e.name)) continue;
      if (e.isFile()) names.push(e.name);
      else if (e.isSymbolicLink() && !(await fs.stat(path.join(dir, e.name)).then((st) => st.isDirectory(), () => false))) names.push(e.name);
    }
    return names.sort((a, b) => a.localeCompare(b, "en"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Where a package file's content is: the file itself, or the file a symlink
 * leads to when that is inside the solution. Undefined for a link out of it:
 * a cloned repository's link could otherwise send any file of the machine to
 * the instance with apply, or have pull write over it.
 */
export async function contentPath(root: string, file: string): Promise<string | undefined> {
  let real: string;
  try {
    real = await fs.realpath(file);
  } catch {
    return file;
  }
  const relative = path.relative(await fs.realpath(root).catch(() => root), real);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? real : undefined;
}

/** A package file's text through its link, or the finding that it cannot be read. */
async function readSource(root: string, file: string): Promise<{ text: string } | { finding: Finding }> {
  const relative = rel(root, file);
  const target = await contentPath(root, file);
  const invalid = (message: string, hint: string): { finding: Finding } => ({
    finding: { code: "package_file_invalid", severity: "error", file: relative, message, hint },
  });
  if (target === undefined) {
    return invalid("It is a link to a file outside the solution folder.", "Move the file into the solution folder and link to it there, or copy it in.");
  }
  const text = await readTextFile(target);
  if (text === undefined) return invalid("It is a link to a file that does not exist.", "Point the link at an existing file, or remove it.");
  return { text: withoutBom(text) };
}

async function exists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

function parseFile(root: string, file: string, text: string): { value?: unknown; source: Source; finding?: Finding } {
  const relative = rel(root, file);
  if (/\.json$/i.test(file)) {
    try {
      return { value: JSON.parse(text), source: { file: relative } };
    } catch (error) {
      return {
        source: { file: relative },
        finding: { code: "package_file_invalid", severity: "error", file: relative, message: `Not valid JSON: ${(error as Error).message}` },
      };
    }
  }
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length) {
    const first = doc.errors[0]!;
    return {
      source: { file: relative },
      finding: {
        code: "package_file_invalid",
        severity: "error",
        file: relative,
        line: first.linePos?.[0]?.line,
        message: `Not valid YAML: ${first.message.split("\n")[0]}`,
      },
    };
  }
  return { value: doc.toJS({ maxAliasCount: 1000 }), source: { file: relative, doc, lines } };
}

/** Read the package files of a solution into one package. */
export async function readPackage(root: string, layout: Layout): Promise<PackageOnDisk> {
  const pkg: Record<string, unknown> = {};
  const sources: PackageOnDisk["sources"] = {};
  const findings: Finding[] = [];
  const dir = path.join(root, layout.package);
  let empty = true;
  for (const name of await listFiles(dir)) {
    empty = false;
    const section = name.replace(PACKAGE_FILE, "");
    const file = path.join(dir, name);
    if (section in sources) {
      findings.push({
        code: "package_file_duplicate",
        severity: "error",
        file: rel(root, file),
        message: `Section "${section}" has two files; keep one of them.`,
      });
      continue;
    }
    const read = await readSource(root, file);
    if ("finding" in read) {
      sources[section] = { file: rel(root, file) };
      findings.push(read.finding);
      continue;
    }
    const parsed = parseFile(root, file, read.text);
    sources[section] = parsed.source;
    if (parsed.finding) findings.push(parsed.finding);
    else pkg[section] = parsed.value;
  }
  for (const [section, folder] of Object.entries(layout.items)) {
    const itemDir = path.join(root, folder);
    if (!(await exists(itemDir))) continue;
    const names = await listFiles(itemDir);
    // `init` makes the folder; it holds the section once it holds a file.
    if (names.length) empty = false;
    else if (section in sources) continue;
    if (section in sources) {
      findings.push({
        code: "package_file_duplicate",
        severity: "error",
        file: rel(root, itemDir),
        message: `Section "${section}" is both in ${layout.package}/ and in ${folder}/; keep one of them.`,
      });
      continue;
    }
    const items: unknown[] = [];
    const itemSources: Source[] = [];
    for (const name of names) {
      const file = path.join(itemDir, name);
      const read = await readSource(root, file);
      if ("finding" in read) {
        itemSources.push({ file: rel(root, file) });
        findings.push(read.finding);
        continue;
      }
      const parsed = parseFile(root, file, read.text);
      itemSources.push(parsed.source);
      if (parsed.finding) findings.push(parsed.finding);
      else items.push(parsed.value);
    }
    sources[section] = itemSources;
    pkg[section] = items;
  }
  return { package: pkg, sources, findings, empty };
}

/** The file and line a location in the package (`/agents/0/name`) comes from. */
export function locate(disk: PackageOnDisk, pointer: string): { file?: string; line?: number; path: string } {
  const keys = pointer
    .split("/")
    .slice(1)
    .map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
  const section = keys[0];
  const display = keys.slice(1).reduce((acc, key) => (/^\d+$/.test(key) ? `${acc}[${key}]` : `${acc}.${key}`), section ?? "");
  if (section === undefined) return { path: "(package)" };
  const source = disk.sources[section];
  if (!source) return { path: display };
  let target: Source;
  let inner: string[];
  if (Array.isArray(source)) {
    const index = Number(keys[1]);
    if (!Number.isInteger(index) || !source[index]) return { file: source[0]?.file, path: display };
    target = source[index]!;
    inner = keys.slice(2);
  } else {
    target = source;
    inner = keys.slice(1);
  }
  return { file: target.file, line: lineOf(target, inner), path: display };
}

function lineOf(source: Source, keys: string[]): number | undefined {
  if (!source.doc || !source.lines) return undefined;
  // The deepest node that exists: a missing field points at its parent.
  for (let n = keys.length; n >= 0; n--) {
    const path = keys.slice(0, n).map((k) => (/^\d+$/.test(k) ? Number(k) : k));
    const node = n === 0 ? source.doc.contents : source.doc.getIn(path, true);
    const range = (node as { range?: [number, number, number] } | null | undefined)?.range;
    if (range) return source.lines.linePos(range[0]).line;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface WriteReport {
  written: string[];
  unchanged: string[];
  removed: string[];
  /** Files of sections the schema does not know, left byte for byte. */
  kept: string[];
  /** Sections whose name cannot be a file name here; never written. */
  refused: string[];
}

/** A section name that is a plain file name: no path, no leading dot. */
export function safeSectionName(section: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(section) && !section.includes("..");
}

/** JSON with sorted keys: two values are the same when this is. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}

export function toYaml(value: unknown): string {
  return stringify(value, { lineWidth: 0, aliasDuplicateObjects: false });
}

async function readValue(root: string, file: string): Promise<{ value?: unknown; ok: boolean }> {
  const target = await contentPath(root, file);
  const text = target === undefined ? undefined : await readTextFile(target);
  if (text === undefined) return { ok: false };
  try {
    const plain = withoutBom(text);
    const value = /\.json$/i.test(file) ? JSON.parse(plain) : parseDocument(plain, { uniqueKeys: true }).toJS({ maxAliasCount: 1000 });
    return { value, ok: true };
  } catch {
    return { ok: false };
  }
}

/** A file name for one item: its slug or name, made safe, unique in the folder. */
function itemFileName(item: unknown, index: number, taken: Set<string>): string {
  const record = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
  const label = [record.slug, record.name, record.key].find((v): v is string => typeof v === "string" && v.trim() !== "");
  const base =
    trimDashesAndDots(
      (label ?? `item-${index + 1}`)
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9._-]+/g, "-"),
    ).slice(0, 80) || `item-${index + 1}`;
  let name = `${base}.yaml`;
  let n = 1;
  while (taken.has(name)) name = `${base}-${++n}.yaml`;
  taken.add(name);
  return name;
}

/**
 * Write an exported package into the solution. A file whose content is
 * already the same value keeps its bytes, so `git diff` shows only what
 * changed on the instance. Files of known sections the export no longer has
 * are removed; files of sections the schema does not know are kept.
 * `dryRun` reports what a write would do and touches nothing.
 */
export async function writePackage(
  root: string,
  layout: Layout,
  pkg: Record<string, unknown>,
  schema: PackageSchema | null,
  options: { dryRun?: boolean } = {},
): Promise<WriteReport> {
  const dryRun = options.dryRun === true;
  const report: WriteReport = { written: [], unchanged: [], removed: [], kept: [], refused: [] };
  const known = new Set(schemaSections(schema));
  const required = new Set(schema?.required ?? []);
  const dir = path.join(root, layout.package);
  const existing = new Map<string, string>();
  for (const name of await listFiles(dir)) existing.set(name.replace(PACKAGE_FILE, ""), name);

  // Writes are planned first: a required section (the manifest, with its
  // export time) is rewritten only when anything else changed.
  const plans: Array<{ file: string; content: string; section: string }> = [];
  const same: Array<{ file: string; section: string }> = [];
  // Removing a link removes the link only; it never reaches the file behind it.
  const removals: string[] = [];
  for (const [section, value] of Object.entries(pkg)) {
    if (section in layout.items && Array.isArray(value)) continue;
    // The export's keys come from the instance; none of them may name a path.
    if (!safeSectionName(section)) {
      report.refused.push(section);
      continue;
    }
    const current = existing.get(section);
    const file = path.join(dir, current ?? `${section}.yaml`);
    const old = await readValue(root, file);
    if (old.ok && canonical(old.value) === canonical(value)) same.push({ file, section });
    else plans.push({ file, section, content: /\.json$/i.test(file) ? JSON.stringify(value, null, 2) + "\n" : toYaml(value) });
  }

  for (const [section, folder] of Object.entries(layout.items)) {
    const value = pkg[section];
    if (!Array.isArray(value)) continue;
    const itemDir = path.join(root, folder);
    const before = new Map<string, unknown>();
    for (const name of await listFiles(itemDir)) {
      const old = await readValue(root, path.join(itemDir, name));
      if (old.ok) before.set(name, old.value);
    }
    const taken = new Set<string>();
    const unclaimed = new Map(before);
    // An item whose file already holds it keeps that file, whatever its name.
    const placed = value.map((item) => {
      for (const [name, old] of unclaimed) {
        if (canonical(old) === canonical(item)) {
          unclaimed.delete(name);
          taken.add(name);
          return name;
        }
      }
      return undefined;
    });
    value.forEach((item, index) => {
      const name = placed[index];
      if (name) {
        same.push({ file: path.join(itemDir, name), section });
        return;
      }
      plans.push({ file: path.join(itemDir, itemFileName(item, index, taken)), section, content: toYaml(item) });
    });
    for (const name of before.keys()) if (!taken.has(name)) removals.push(path.join(itemDir, name));
    if (!dryRun) await fs.mkdir(itemDir, { recursive: true });
  }

  for (const [section, name] of existing) {
    if (section in pkg) continue;
    const file = path.join(dir, name);
    if (known.has(section)) removals.push(file);
    else report.kept.push(rel(root, file));
  }

  const othersChanged = plans.some((p) => !required.has(p.section));
  const writes: Array<{ file: string; target: string; content: string }> = [];
  const outside: string[] = [];
  for (const plan of plans) {
    if (required.has(plan.section) && !othersChanged && existing.has(plan.section)) {
      same.push({ file: plan.file, section: plan.section });
      continue;
    }
    // A file kept behind a link is written there, so the link stays a link.
    const target = await contentPath(root, plan.file);
    if (target === undefined) outside.push(rel(root, plan.file));
    else writes.push({ file: plan.file, target, content: plan.content });
  }
  if (outside.length) {
    throw new CavelonError(ExitCode.conflict, {
      code: "package_file_outside",
      message: `${outside.join(", ")} ${outside.length === 1 ? "is a link" : "are links"} to a file outside the solution folder; nothing was written.`,
      hint: "Move the file into the solution folder and link to it there, or replace the link with the file.",
      details: { files: outside },
    });
  }
  for (const write of writes) {
    if (!dryRun) await writeFileAtomic(write.target, write.content);
    report.written.push(rel(root, write.file));
  }
  for (const file of removals) {
    if (!dryRun) await fs.rm(file, { force: true });
    report.removed.push(rel(root, file));
  }
  report.unchanged.push(...same.map((s) => rel(root, s.file)));

  for (const list of Object.values(report)) list.sort();
  return report;
}

/** `text` without leading and trailing `-` and `.`; a loop, not a regex anchored at the end. */
function trimDashesAndDots(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && (text[start] === "-" || text[start] === ".")) start++;
  while (end > start && (text[end - 1] === "-" || text[end - 1] === ".")) end--;
  return text.slice(start, end);
}
