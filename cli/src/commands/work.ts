import { promises as fs } from "node:fs";
import path from "node:path";
import {
  boolOption,
  CURSOR_OPTION,
  intOption,
  LIMIT_OPTION,
  listOption,
  pageOf,
  positional,
  stringOption,
  type CommandSpec,
  type Context,
} from "../command.js";
import { capacityCodeIn, capacityHint, noteLines, runCapacityNote, type CapacityNote, type RunState } from "../capacity.js";
import { CavelonError, ExitCode, usageError, type ExitCodeValue } from "../errors.js";
import { confinedPath } from "../paths.js";
import { clip, keyValues, moreHint, table } from "../format.js";
import type { OpenApiDoc } from "../contracts.js";
import { callStable, workflowOperation } from "../invoke.js";
import { deref, type Operation } from "../openapi.js";
import { bindsNow, changedBy, limitError, limitsOrWarn, readLimits, type Limit, type PublishedLimits } from "../limits.js";
import { getOperation } from "../operations.js";
import { caseCounts, caseLabel, countsText, failedCase, NOT_PASSED, runVerdict, type TestResultState } from "../results.js";
import { isUuid } from "../session.js";
import { cavelonCommand, shellWord } from "../shell.js";
import { readZipSummary, ZipError, type ZipSummary } from "../zip.js";
import { TIMEOUT_OPTION, timeoutMs, waitAndReport } from "./async.js";
import { stageErrors, stageErrorText, type StageError } from "./loops.js";
import { resolveHarnessId } from "../harness-ref.js";

/** Seeding, testing and tracing: the commands that start work and read its result. */

const WAIT_OPTION = { type: "boolean" as const, description: "Wait for the work to finish (see `cavelon wait`).", cliOnly: true };

// ---------------------------------------------------------------------------
// kb upload
// ---------------------------------------------------------------------------

interface KnowledgeBase {
  id: string;
  name: string;
}

interface UploadedDocument {
  id: string;
  filename: string;
  status: string;
  operation_id?: string | null;
  /** The documents this upload replaced, newest first; absent on an instance that does not report it. */
  replaced_document_ids?: string[] | null;
}

/** A document already in the knowledge base, as the instance lists it. */
interface ExistingDocument {
  id: string;
  filename: string;
  is_active?: boolean;
  created_at?: string;
}

const UPLOAD_ROUTE = "/api/v1/knowledge-bases/{kb_id}/documents/upload";
const DOCUMENTS_ROUTE = "/api/v1/knowledge-bases/{kb_id}/documents";
const ACTIVE_ROUTE = "/api/v1/knowledge-bases/{kb_id}/documents/active";

/**
 * How this instance's upload treats a file named like an existing document,
 * from the fields its upload form publishes: `replace_doc_ids` replaces the
 * documents it names once the new files are verified, and an instance that
 * offers `replace_existing` replaces a same-named active document by default.
 * An instance whose OpenAPI cannot be read is taken to do neither.
 */
interface ReplaceSupport {
  byIds: boolean;
  byName: boolean;
}

function replaceSupport(doc: OpenApiDoc | undefined, op: Operation): ReplaceSupport {
  const schema = op.requestBody?.content?.["multipart/form-data"]?.schema;
  const properties = doc && schema ? (deref(doc, schema) as { properties?: Record<string, unknown> } | undefined)?.properties : undefined;
  return { byIds: Boolean(properties?.replace_doc_ids), byName: Boolean(properties?.replace_existing) };
}

/**
 * What happens to an existing document named like a file: it stays active, the
 * instance replaces it by name or by the id the kit sends, or the kit
 * deactivates it after the upload.
 */
type ReplacePlan = "stays_active" | "replaced_by_name" | "replace_by_id" | "deactivate";
type ReplaceOutcome = "stays_active" | "replaced" | "replace_requested" | "deactivated" | "not_uploaded";

interface NameMatch {
  /** The local file, relative to the working folder. */
  file: string;
  filename: string;
  document_id: string;
  plan: ReplacePlan;
  outcome?: ReplaceOutcome;
}

const shortId = (id: string) => `${id.slice(0, 8)}…`;

/** The active documents of the knowledge base; undefined, with a warning, when the instance does not list them here. */
async function existingDocuments(ctx: Context, kbId: string): Promise<ExistingDocument[] | undefined> {
  try {
    const list = await callStable<ExistingDocument[]>(ctx, "GET", DOCUMENTS_ROUTE, "listing a knowledge base's documents", { params: { kb_id: [kbId] } });
    return (Array.isArray(list) ? list : []).filter((d) => d.is_active !== false && typeof d.filename === "string");
  } catch (error) {
    if (!(error instanceof CavelonError)) throw error;
    ctx.warn(`Could not list the knowledge base's documents (${error.message}); files named like an existing document are not reported.`);
    return undefined;
  }
}

/**
 * Each active document named like a file to upload, with what this upload
 * does to it. With --replace the newest one of a name goes to the instance's
 * own replacement where it offers one; whatever it does not replace, the kit
 * deactivates after the upload.
 */
function nameMatches(files: string[], cwd: string, existing: ExistingDocument[], mode: "replace" | "keep-both" | "default", support: ReplaceSupport): NameMatch[] {
  const matches: NameMatch[] = [];
  const mapped = new Set<string>();
  for (const file of files) {
    const filename = path.basename(file);
    const same = existing.filter((d) => d.filename === filename).sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    same.forEach((document, index) => {
      let plan: ReplacePlan = "stays_active";
      if (mode === "default" && support.byName) plan = "replaced_by_name";
      if (mode === "replace") plan = index === 0 && support.byIds && !mapped.has(filename) ? "replace_by_id" : "deactivate";
      matches.push({ file: path.relative(cwd, file) || file, filename, document_id: document.id, plan });
    });
    mapped.add(filename);
  }
  return matches;
}

/** One line per match, as the dry run and the preview say it. */
function plannedLine(match: NameMatch): string {
  const head = `${match.filename} exists (${shortId(match.document_id)})`;
  switch (match.plan) {
    case "stays_active":
      return `${head} and stays active`;
    case "replaced_by_name":
      return `${head} and is replaced by the upload (--keep-both keeps it)`;
    case "replace_by_id":
      return `${head} and is replaced once the new file is verified`;
    case "deactivate":
      return `${head} and is deactivated after the upload`;
  }
}

function outcomeLine(match: NameMatch): string {
  const head = `${match.filename} exists (${shortId(match.document_id)})`;
  switch (match.outcome) {
    case "replaced":
      return `${head}: replaced`;
    case "replace_requested":
      return `${head}: replaced once the new file is verified`;
    case "deactivated":
      return `${head}: deactivated`;
    case "not_uploaded":
      return `${head} and stays active: its new version was not uploaded`;
    default:
      return `${head} and stays active`;
  }
}

/** The hint after the lines, when a same-named document stays active without being asked to. */
function staysActiveHint(matches: NameMatch[], mode: "replace" | "keep-both" | "default"): string {
  return mode === "default" && matches.some((m) => (m.outcome ?? m.plan) === "stays_active")
    ? "Both versions answer. --replace replaces the existing document; --keep-both keeps both without this note."
    : "";
}

/**
 * The outcome of each match from the upload's answer: an instance that reports
 * `replaced_document_ids` says what it replaced; an older one replaces the ids
 * the kit sent once the new files are verified, and replaces nothing by name.
 */
function settleMatches(matches: NameMatch[], uploaded: UploadedDocument[], uploadedFiles: Set<string>): void {
  const reported = uploaded.some((d) => Array.isArray(d.replaced_document_ids));
  const replaced = new Set(uploaded.flatMap((d) => (Array.isArray(d.replaced_document_ids) ? d.replaced_document_ids : [])));
  for (const match of matches) {
    if (!uploadedFiles.has(match.file)) match.outcome = "not_uploaded";
    else if (replaced.has(match.document_id)) match.outcome = "replaced";
    else if (match.plan === "replace_by_id" && !reported) match.outcome = "replace_requested";
    else if (match.plan === "deactivate") match.outcome = undefined;
    else match.outcome = "stays_active";
  }
}

/** Deactivate the documents the kit replaces itself; undefined when all went, else the error. */
async function deactivate(ctx: Context, kbId: string, matches: NameMatch[]): Promise<CavelonError | undefined> {
  const due = matches.filter((m) => m.plan === "deactivate" && m.outcome === undefined);
  if (!due.length) return undefined;
  try {
    await callStable(ctx, "PATCH", ACTIVE_ROUTE, "deactivating a document", {
      params: { kb_id: [kbId] },
      body: { updates: due.map((m) => ({ id: m.document_id, is_active: false })) },
    });
    for (const m of due) m.outcome = "deactivated";
    return undefined;
  } catch (error) {
    if (!(error instanceof CavelonError)) throw error;
    for (const m of due) m.outcome = "stays_active";
    return error;
  }
}

async function resolveKbId(ctx: Context, ref: string): Promise<{ id: string; name?: string }> {
  if (isUuid(ref)) return { id: ref };
  const page = await callStable<{ items: KnowledgeBase[] }>(ctx, "GET", "/api/v1/knowledge-bases", "knowledge bases", {
    query: { search: ref, page_size: 100 },
  });
  const wanted = ref.toLowerCase();
  const hits = (page.items ?? []).filter((kb) => kb.name.toLowerCase() === wanted);
  if (hits.length === 1) return { id: hits[0]!.id, name: hits[0]!.name };
  throw new CavelonError(ExitCode.failure, {
    code: hits.length ? "kb_ambiguous" : "kb_not_found",
    message: hits.length ? `${hits.length} knowledge bases are named "${ref}".` : `No knowledge base named "${ref}".`,
    hint: "Pass its id; `cavelon api list_knowledge_bases` lists them.",
  });
}

async function collectFiles(dir: string, recursive: boolean, extensions: string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string) => {
    const entries = (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive) await walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (extensions.length === 0 || extensions.includes(ext)) out.push(full);
      }
    }
  };
  await walk(dir);
  return out;
}

type Reason =
  | "too_large"
  | "type_not_allowed"
  | "archive_not_expanded"
  | "not_a_zip"
  | "archive_too_many_files"
  | "archive_too_large_unpacked"
  | "archive_ratio_too_high";

interface Refusal {
  file: string;
  size_bytes: number;
  extension: string;
  reason: Reason;
  /** What a zip archive declares, for the archive reasons. */
  archive?: { files: number; unpacked_bytes: number; max_ratio: number | null; max_ratio_entry: string | null };
}

/** The published limits an upload is checked against; each is undefined when the instance does not publish it. */
interface UploadLimits {
  size?: Limit;
  types?: Limit;
  /**
   * kb_upload_archive_enabled: whether the tenant expands archives at all;
   * absent on an older instance, where an empty
   * list of formats says archives are off.
   */
  enabled?: Limit;
  /** kb_upload_archive_formats: the archive types the instance expands; absent on an older instance. */
  archives?: Limit;
  entries?: Limit;
  unpacked?: Limit;
  ratio?: Limit;
}

const MB = 1024 * 1024;
const mb = (bytes: number) => (bytes / MB).toFixed(1);
const fileWith = (r: Refusal, what: string) => `${r.file} (${what})`;
/** "kb_upload_max_file_size_mb, source tenant; a tenant admin changes upload_defaults.max_file_size_mb". */
const limitNote = (limit: Limit) => `${limit.key}, source ${limit.source}; ${changedBy(limit)} changes ${limit.setting}`;

/**
 * Whether the tenant has archive uploads off: the switch says so where the
 * instance publishes it, whatever the formats
 * list; an older instance says it with an empty list of formats.
 */
function archivesOff(limits: UploadLimits): boolean {
  if (typeof limits.enabled?.value === "boolean") return !limits.enabled.value;
  return !(Array.isArray(limits.archives?.value) && limits.archives.value.length);
}

/** The entry that refuses a zip: the switch while archives are off, else the formats. */
function archiveLimit(limits: UploadLimits): Limit | undefined {
  return archivesOff(limits) && limits.enabled ? limits.enabled : (limits.archives ?? limits.enabled);
}

function formatsText(limits: UploadLimits): string {
  if (archivesOff(limits)) return "has archive uploads turned off";
  const formats = Array.isArray(limits.archives?.value) ? limits.archives.value : [];
  return formats.length ? `expands only ${formats.join(", ")}` : "expands no archive type";
}

function disabledCode(limits: UploadLimits): string {
  return archivesOff(limits) ? "archive_uploads_disabled" : "archive_format_disabled";
}

interface ReasonSpec {
  /** The limit a refusal breaks. */
  limit: (limits: UploadLimits) => Limit | undefined;
  /** The instance's own code for the same refusal. */
  code: (limits: UploadLimits) => string;
  /** How a refusal reads: each file, the verb for one file and for several, and what they break. */
  item: (r: Refusal) => string;
  verb: [string, string];
  rest: (limit: Limit, limits: UploadLimits) => string;
}

/** Each refusal, in the order the error names them; the first one present gives the code. */
const REASONS: Record<Reason, ReasonSpec> = {
  too_large: {
    limit: (l) => l.size,
    code: () => "upload_file_too_large",
    item: (r) => fileWith(r, `${mb(r.size_bytes)} MB`),
    verb: ["is", "are"],
    rest: (l) => `larger than ${String(l.value)} MB (${limitNote(l)})`,
  },
  type_not_allowed: {
    limit: (l) => l.types,
    code: () => "upload_file_type_unsupported",
    item: (r) => fileWith(r, r.extension ? `.${r.extension}` : "no extension"),
    verb: ["has a type", "have types"],
    rest: (l) => `this tenant does not accept (${limitNote(l)})`,
  },
  archive_not_expanded: {
    limit: archiveLimit,
    code: disabledCode,
    item: (r) => r.file,
    verb: ["is a zip archive,", "are zip archives,"],
    rest: (l, limits) => `and this tenant ${formatsText(limits)} (${limitNote(l)})`,
  },
  not_a_zip: {
    limit: archiveLimit,
    code: () => "archive_magic_invalid",
    item: (r) => r.file,
    verb: ["is", "are"],
    rest: () => "not a zip archive, though named .zip",
  },
  archive_too_many_files: {
    limit: (l) => l.entries,
    code: () => "archive_entry_limit_exceeded",
    item: (r) => fileWith(r, `${r.archive?.files} files`),
    verb: ["holds", "hold"],
    rest: (l) => `more files than ${String(l.value)} (${limitNote(l)})`,
  },
  archive_too_large_unpacked: {
    limit: (l) => l.unpacked,
    code: () => "archive_uncompressed_size_exceeded",
    item: (r) => fileWith(r, `${mb(r.archive?.unpacked_bytes ?? 0)} MB unpacked`),
    verb: ["unpacks", "unpack"],
    rest: (l) => `to more than ${String(l.value)} MB (${limitNote(l)})`,
  },
  archive_ratio_too_high: {
    limit: (l) => l.ratio,
    code: () => "archive_compression_ratio_exceeded",
    item: (r) => fileWith(r, `${r.archive?.max_ratio_entry ?? "a file"} at ${r.archive?.max_ratio ?? "∞"}:1`),
    verb: ["compresses", "compress"],
    rest: (l) => `a file more than ${String(l.value)}:1 (${limitNote(l)})`,
  },
};

/** The published upload limits; a limit whose `binds_when` entry is off does not bind now, so it is left out. */
function uploadLimits(limits: PublishedLimits): UploadLimits {
  const binding = (key: string) => {
    const limit = limits.byKey.get(key);
    return limit && bindsNow(limit, limits) ? limit : undefined;
  };
  return {
    size: binding("kb_upload_max_file_size_mb"),
    types: binding("kb_upload_allowed_extensions"),
    enabled: binding("kb_upload_archive_enabled"),
    archives: binding("kb_upload_archive_formats"),
    entries: binding("kb_upload_archive_max_entries"),
    unpacked: binding("kb_upload_archive_max_total_uncompressed_mb"),
    ratio: binding("kb_upload_archive_max_compression_ratio"),
  };
}

const numeric = (limit: Limit | undefined): number | undefined => (typeof limit?.value === "number" ? limit.value : undefined);

/** Why a zip archive would be refused, checked as the instance checks it before expanding it. */
async function archiveRefusal(file: string, limits: UploadLimits, warn: (message: string) => void): Promise<Pick<Refusal, "reason" | "archive"> | undefined> {
  if (archivesOff(limits)) return { reason: "archive_not_expanded" };
  // With the switch on, the formats decide where the instance lists them.
  const formats = Array.isArray(limits.archives?.value) ? new Set(limits.archives.value.map((f) => f.toLowerCase().replace(/^\./, ""))) : undefined;
  if (formats && !formats.has("zip")) return { reason: "archive_not_expanded" };
  let summary: ZipSummary;
  try {
    summary = await readZipSummary(file);
  } catch (error) {
    if (error instanceof ZipError && error.notZip) return { reason: "not_a_zip" };
    warn(`Could not read the zip directory of ${path.basename(file)} (${error instanceof Error ? error.message : String(error)}); the instance checks it.`);
    return undefined;
  }
  const archive = {
    files: summary.files,
    unpacked_bytes: summary.uncompressedBytes,
    max_ratio: Number.isFinite(summary.maxRatio) ? Math.round(summary.maxRatio * 10) / 10 : null,
    max_ratio_entry: summary.maxRatioEntry,
  };
  const entries = numeric(limits.entries);
  const unpacked = numeric(limits.unpacked);
  const ratio = numeric(limits.ratio);
  if (entries !== undefined && summary.files > entries) return { reason: "archive_too_many_files", archive };
  if (unpacked !== undefined && summary.uncompressedBytes > unpacked * MB) return { reason: "archive_too_large_unpacked", archive };
  if (ratio !== undefined && summary.maxRatio > ratio) return { reason: "archive_ratio_too_high", archive };
  return undefined;
}

/**
 * The files the instance's published upload limits refuse, checked as the
 * instance checks them: size in mebibytes, the extension after the last dot,
 * and for a zip archive whether the tenant expands archives and the file
 * count, unpacked size and compression ratio its directory declares (the
 * instance checks each file inside against the types itself). A limit the
 * instance does not publish is not checked; an instance that publishes no
 * archive rules gets the archive and decides.
 */
async function uploadRefusals(files: string[], cwd: string, published: PublishedLimits, warn: (message: string) => void): Promise<{ refusals: Refusal[]; limits: UploadLimits }> {
  const limits = uploadLimits(published);
  const size = numeric(limits.size);
  const check = {
    maxBytes: size === undefined ? undefined : size * MB,
    allowed: Array.isArray(limits.types?.value) ? new Set(limits.types.value.map((e) => e.toLowerCase().replace(/^\./, ""))) : undefined,
  };
  const refusals: Refusal[] = [];
  for (const file of files) {
    const refused = await refusalFor(file, cwd, limits, check, warn);
    if (refused) refusals.push(refused);
  }
  return { refusals, limits };
}

async function refusalFor(
  file: string,
  cwd: string,
  limits: UploadLimits,
  check: { maxBytes?: number; allowed?: Set<string> },
  warn: (message: string) => void,
): Promise<Refusal | undefined> {
  const name = path.basename(file);
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  const bytes = (await fs.stat(file)).size;
  const base = { file: path.relative(cwd, file) || file, size_bytes: bytes, extension };
  if (check.maxBytes !== undefined && bytes > check.maxBytes) return { ...base, reason: "too_large" };
  if (extension === "zip") {
    const refused = limits.archives || limits.enabled ? await archiveRefusal(file, limits, warn) : undefined;
    return refused ? { ...base, ...refused } : undefined;
  }
  if (check.allowed && !check.allowed.has(extension)) return { ...base, reason: "type_not_allowed" };
  return undefined;
}

function clause(reason: Reason, list: Refusal[], limit: Limit, limits: UploadLimits): string {
  const { item, verb, rest } = REASONS[reason];
  const more = list.length > 5 ? ` and ${list.length - 5} more` : "";
  return `${list.slice(0, 5).map(item).join(", ")}${more} ${verb[list.length === 1 ? 0 : 1]} ${rest(limit, limits)}`;
}

function refusalError(found: { refusals: Refusal[]; limits: UploadLimits }, total: number) {
  const { refusals, limits } = found;
  const reasons = (Object.keys(REASONS) as Reason[]).filter((reason) => refusals.some((r) => r.reason === reason));
  const parts: string[] = [];
  const involved: Limit[] = [];
  for (const reason of reasons) {
    const limit = REASONS[reason].limit(limits)!;
    parts.push(clause(reason, refusals.filter((r) => r.reason === reason), limit, limits));
    if (!involved.includes(limit)) involved.push(limit);
  }
  return limitError({
    code: REASONS[reasons[0]!].code(limits),
    message: `${refusals.length} of ${total} files break this instance's upload limits, so nothing was sent: ${parts.join("; ")}.`,
    limits: involved,
    details: { refused: refusals },
    hint:
      "Leave those files out (--ext narrows the upload), or ask who can change the limit; a knowledge base may set lower limits of its own." +
      (reasons.includes("archive_not_expanded") && archivesOff(limits) && limits.enabled?.change
        ? ` A tenant admin turns archive uploads on with ${cavelonCommand("limits", "set", limits.enabled.key, "true")} (shows the change; --confirm sends it).`
        : ""),
  });
}

const BATCH_FILES = 20;
const BATCH_BYTES = 50 * 1024 * 1024;

export const kbUpload: CommandSpec = {
  name: "kb upload",
  summary: "Upload a folder's documents into a knowledge base; returns operation ids.",
  description:
    "Hidden files are skipped. Ingestion runs on the instance; `cavelon wait` follows it.\n" +
    "Files are checked against the instance's published upload limits first. A .zip goes only to a tenant that expands\n" +
    "archives, and only within its caps on file count, unpacked size and compression ratio.\n" +
    "A file named like an active document of the knowledge base is listed, with what happens to that document. An\n" +
    "instance that replaces same-named documents on upload does so (--keep-both keeps both); elsewhere the old one stays\n" +
    "active. --replace replaces it: through the instance's own replacement where its upload offers one, else the kit\n" +
    "deactivates the old document after the upload (after the wait with --wait), and then only with --confirm.",
  readOnly: false,
  mcpTool: "kb_upload",
  positionals: [{ name: "dir", description: "Folder (or single file) to upload.", required: true }],
  options: {
    kb: { type: "string", value: "<kb>", description: "Knowledge base name or id (required)." },
    recursive: { type: "boolean", short: "r", description: "Include subfolders." },
    ext: { type: "string", multiple: true, value: "<ext>", description: "Only these file extensions (pdf, md, …)." },
    replace: { type: "boolean", description: "Replace active documents with the same file name." },
    "keep-both": { type: "boolean", description: "Keep active documents with the same file name next to the new ones." },
    confirm: { type: "boolean", description: "With --replace, deactivate the old documents the instance does not replace itself; without it nothing is sent." },
    "dry-run": { type: "boolean", description: "List what would be uploaded and replaced, upload nothing." },
    wait: WAIT_OPTION,
    timeout: TIMEOUT_OPTION,
  },
  examples: [
    "cavelon kb upload ./docs --kb FAQ",
    "cavelon kb upload ./docs/bergbahn-faq.md --kb FAQ --replace --dry-run",
    "cavelon kb upload ./manuals --kb FAQ -r --ext pdf --wait --timeout 5m",
  ],
  async run(ctx, input) {
    const dirArg = positional(input, "dir")!;
    const dir = await confinedPath(ctx, dirArg, "The folder");
    const kbRef = stringOption(input, "kb");
    if (!kbRef) throw usageError("Which knowledge base?", "Pass --kb <name-or-id>.");
    const mode = boolOption(input, "replace") ? "replace" : boolOption(input, "keep-both") ? "keep-both" : "default";
    if (mode === "replace" && boolOption(input, "keep-both")) throw usageError("--replace and --keep-both exclude each other.");
    const extensions = listOption(input, "ext").flatMap((e) => e.split(",")).map((e) => e.replace(/^\./, "").toLowerCase()).filter(Boolean);
    let stat;
    try {
      stat = await fs.stat(dir);
    } catch {
      throw usageError(`${dir} does not exist.`);
    }
    const files = stat.isFile() ? [dir] : await collectFiles(dir, boolOption(input, "recursive"), extensions);
    if (files.length === 0) throw usageError(`No files to upload in ${dir}.`, extensions.length ? `Only ${extensions.join(", ")} files were considered.` : undefined);
    // Checked before anything is sent, against the limits the instance publishes for this tenant.
    const published = await limitsOrWarn(ctx);
    if (published?.published) {
      const found = await uploadRefusals(files, ctx.io.cwd, published, (message) => ctx.warn(message));
      if (found.refusals.length) throw refusalError(found, files.length);
    }
    const kb = await resolveKbId(ctx, kbRef);
    const { doc, op } = await workflowOperation(ctx, "POST", UPLOAD_ROUTE, "document upload");
    const support = replaceSupport(doc, op);
    const existing = await existingDocuments(ctx, kb.id);
    const matches = existing ? nameMatches(files, ctx.io.cwd, existing, mode, support) : [];
    const rel = files.map((f) => path.relative(ctx.io.cwd, f) || f);
    const planned = matches.map(({ outcome: _outcome, ...m }) => m);
    const hint = staysActiveHint(matches, mode);
    const deactivations = matches.filter((m) => m.plan === "deactivate");
    if (boolOption(input, "dry-run")) {
      return {
        data: { kb: kbRef, files: rel, count: rel.length, dry_run: true, existing: planned },
        text: [
          `Would upload ${rel.length} files:`,
          ...rel,
          ...matches.map(plannedLine),
          ...(hint ? [hint] : []),
          ...(deactivations.length ? [`The kit deactivates ${deactivations.length === 1 ? "that document" : "those documents"} only with --replace --confirm.`] : []),
        ].join("\n"),
      };
    }
    if (deactivations.length && !boolOption(input, "confirm")) {
      const confirm = cavelonCommand(
        "kb",
        "upload",
        dirArg,
        "--kb",
        kbRef,
        ...(boolOption(input, "recursive") ? ["-r"] : []),
        ...extensions.flatMap((e) => ["--ext", e]),
        "--replace",
        "--confirm",
      );
      return {
        data: { kb: { id: kb.id, name: kb.name ?? null }, files: rel, count: rel.length, uploaded: false, existing: planned, confirm },
        text: [
          `--replace uploads ${rel.length} files and then deactivates ${deactivations.length} document${deactivations.length === 1 ? "" : "s"} the instance's upload does not replace itself:`,
          ...matches.map(plannedLine),
          `Nothing was sent. Upload and deactivate with: ${confirm}`,
        ].join("\n"),
      };
    }
    // Batches keep each request bounded in size and time.
    const batches: string[][] = [];
    let current: string[] = [];
    let bytes = 0;
    for (const file of files) {
      const size = (await fs.stat(file)).size;
      if (current.length && (current.length >= BATCH_FILES || bytes + size > BATCH_BYTES)) {
        batches.push(current);
        current = [];
        bytes = 0;
      }
      current.push(file);
      bytes += size;
    }
    if (current.length) batches.push(current);
    const documents: UploadedDocument[] = [];
    const uploadedFiles = new Set<string>();
    let failure: { error: CavelonError; notUploaded: string[] } | undefined;
    for (const [index, batch] of batches.entries()) {
      const names = new Set(batch.map((f) => path.basename(f)));
      const replaceIds = Object.fromEntries(matches.filter((m) => m.plan === "replace_by_id" && names.has(m.filename)).map((m) => [m.filename, m.document_id]));
      const fields: Record<string, unknown> = {};
      if (Object.keys(replaceIds).length) fields.replace_doc_ids = JSON.stringify(replaceIds);
      if (mode === "keep-both" && support.byName) fields.replace_existing = false;
      try {
        const uploaded = await callStable<UploadedDocument[]>(ctx, "POST", UPLOAD_ROUTE, "document upload", {
          params: { kb_id: [kb.id] },
          body: Object.keys(fields).length ? fields : undefined,
          files: batch.map((f) => ({ field: "files", path: f })),
          timeoutMs: 300_000,
        });
        documents.push(...uploaded);
        for (const f of batch) uploadedFiles.add(path.relative(ctx.io.cwd, f) || f);
      } catch (error) {
        if (!(error instanceof CavelonError) || documents.length === 0) throw error;
        // Earlier batches are uploaded and ingesting: report them, and what is left.
        failure = { error, notUploaded: batches.slice(index).flat().map((f) => path.relative(ctx.io.cwd, f) || f) };
        break;
      }
    }
    settleMatches(matches, documents, uploadedFiles);
    const operationIds = documents.map((d) => d.operation_id).filter((id): id is string => Boolean(id));
    const summary = () => ({
      kb: { id: kb.id, name: kb.name ?? null },
      documents: documents.map((d) => ({
        id: d.id,
        filename: d.filename,
        status: d.status,
        operation_id: d.operation_id ?? null,
        ...(Array.isArray(d.replaced_document_ids) ? { replaced_document_ids: d.replaced_document_ids } : {}),
      })),
      operation_ids: operationIds,
      existing: matches,
    });
    const matchLines = () => {
      const note = staysActiveHint(matches, mode);
      return [...matches.map(outcomeLine), ...(note ? [note] : [])];
    };
    if (operationIds.length < documents.length) ctx.warn("The instance returned no operation id for some documents; it may be older than the operations API.");
    if (failure) {
      const refused = await deactivate(ctx, kb.id, matches);
      if (refused) ctx.warn(`The old documents stay active: ${refused.message}`);
      return {
        data: { ...summary(), error: failure.error.toJSON(), not_uploaded: failure.notUploaded },
        text: [
          `Uploaded ${documents.length} files, then: ${failure.error.message}`,
          `Not uploaded (${failure.notUploaded.length}): ${failure.notUploaded.join(", ")}`,
          ...matchLines(),
          ...(operationIds.length ? [`Wait for the uploaded ones with: cavelon wait ${operationIds.join(" ")}`] : []),
        ].join("\n"),
        exitCode: failure.error.exitCode,
      };
    }
    if (boolOption(input, "wait") && ctx.mode === "cli" && operationIds.length) {
      const waited = await waitAndReport(ctx, operationIds, timeoutMs(ctx, stringOption(input, "timeout")));
      // The old documents keep answering until the new ones are ingested; a failed ingestion keeps them.
      const refused = waited.exitCode === ExitCode.ok ? await deactivate(ctx, kb.id, matches) : undefined;
      if (waited.exitCode !== ExitCode.ok) for (const m of matches) if (m.outcome === undefined) m.outcome = "stays_active";
      if (refused) ctx.warn(`The old documents stay active: ${refused.message}`);
      return {
        data: { ...summary(), ...waited.data },
        text: [`Uploaded ${documents.length} files.`, ...matchLines(), waited.text].join("\n"),
        exitCode: refused && waited.exitCode === ExitCode.ok ? refused.exitCode : waited.exitCode,
      };
    }
    const refused = await deactivate(ctx, kb.id, matches);
    if (refused) ctx.warn(`The old documents stay active: ${refused.message}`);
    return {
      data: summary(),
      text: [
        `Uploaded ${documents.length} files to ${kb.name ?? kb.id}.`,
        ...matchLines(),
        ...(operationIds.length ? [`Operations: ${operationIds.length}`, `Wait with: cavelon wait ${operationIds.join(" ")}`] : []),
      ].join("\n"),
      exitCode: refused?.exitCode,
    };
  },
};

// ---------------------------------------------------------------------------
// test run
// ---------------------------------------------------------------------------

interface Suite {
  id: string;
  name: string;
  harness_id?: string | null;
  archived_at?: string | null;
}

interface TestRun {
  id: string;
  suite_id: string;
  suite_name?: string | null;
  status: string;
  summary?: Record<string, unknown>;
  operation_id?: string | null;
}

/** The counts of a test run's summary that it carries, and what kept it from passing. */
function summaryText(summary: Record<string, unknown>): string {
  const verdict = runVerdict(summary);
  const shown = ["passed", "failed", "errors"].filter((k) => k in summary).map((k) => k + " " + String(summary[k]));
  const others = Object.fromEntries(Object.entries(verdict.counts).filter(([k]) => !["failed", "errors"].includes(k)));
  if (Object.keys(others).length) shown.push(countsText(others));
  if ("pass_rate" in summary) shown.push(`pass_rate ${String(summary.pass_rate)}`);
  if (verdict.comparable === false) {
    shown.push(`not comparable${verdict.non_comparable_reasons.length ? ` (${verdict.non_comparable_reasons.join(", ")})` : ""}`);
  }
  return shown.join("  ");
}

/** `cavelon wait` for the runs still going, with the caller's timeout so each call fits the same shell limit. */
function resumeCommand(pending: string[], timeout: string | undefined): string {
  return cavelonCommand("wait", ...pending, ...(timeout ? ["--timeout", timeout] : []));
}

export const testRun: CommandSpec = {
  name: "test run",
  summary: "Start test-suite runs; returns operation ids.",
  description:
    "Without --suite, runs every suite of the solution (--harness, or cavelon.yaml's harness).\n" +
    "With --wait, exits 1 when a case failed or a run measured nothing comparable (cases not run, technical errors),\n" +
    "5 when answers wait for a manual verdict or a value a case needs.",
  readOnly: false,
  mcpTool: "test_run",
  options: {
    suite: { type: "string", multiple: true, value: "<suite>", description: "Suite name or id." },
    harness: { type: "string", value: "<harness>", description: "The solution to run against: its name, slug or id." },
    wait: WAIT_OPTION,
    timeout: TIMEOUT_OPTION,
    "idempotency-key": { type: "string", value: "<key>", description: "Send an Idempotency-Key with each start." },
  },
  examples: ["cavelon test run --suite smoke --wait --timeout 10m", "cavelon test run --harness support --json"],
  async run(ctx, input) {
    const session = await ctx.session();
    const harnessRef = stringOption(input, "harness") ?? session.project?.harness;
    const harnessId = harnessRef ? await resolveHarnessId(ctx, harnessRef) : undefined;
    const suites = await callStable<Suite[]>(ctx, "GET", "/api/v1/test-suites", "test suites", {
      query: { harness_id: harnessId },
    });
    const wanted = listOption(input, "suite");
    let chosen: Suite[];
    if (wanted.length) {
      chosen = wanted.map((ref) => {
        const hit = suites.find((s) => s.id === ref) ?? suites.filter((s) => s.name.toLowerCase() === ref.toLowerCase());
        if (Array.isArray(hit)) {
          if (hit.length === 1) return hit[0]!;
          throw new CavelonError(ExitCode.failure, {
            code: hit.length ? "suite_ambiguous" : "suite_not_found",
            message: hit.length ? `${hit.length} suites are named "${ref}"; pass its id.` : `No test suite "${ref}"${harnessRef ? ` for ${harnessRef}` : ""}.`,
            hint: "`cavelon api list_suites` lists the suites.",
          });
        }
        return hit;
      });
    } else {
      chosen = suites.filter((s) => !s.archived_at);
      if (chosen.length === 0) {
        throw new CavelonError(ExitCode.failure, {
          code: "no_suites",
          message: harnessRef ? `${harnessRef} has no test suites.` : "This tenant has no test suites.",
        });
      }
    }
    const key = stringOption(input, "idempotency-key");
    const runs: TestRun[] = [];
    for (const suite of chosen) {
      const body: Record<string, unknown> = {};
      if (harnessId) body.harness_id = harnessId;
      runs.push(
        await callStable<TestRun>(ctx, "POST", "/api/v1/test-suites/{suite_id}/runs", "test runs", {
          params: { suite_id: [suite.id] },
          body,
          headers: key ? { "Idempotency-Key": `${key}:${suite.id}` } : undefined,
        }),
      );
    }
    const operationIds = runs.map((r) => r.operation_id).filter((id): id is string => Boolean(id));
    const started = runs.map((r) => ({ run_id: r.id, suite: r.suite_name ?? r.suite_id, status: r.status, operation_id: r.operation_id ?? null }));
    if (boolOption(input, "wait") && ctx.mode === "cli" && operationIds.length) {
      const rawTimeout = stringOption(input, "timeout");
      const waited = await waitAndReport(ctx, operationIds, timeoutMs(ctx, rawTimeout));
      // The operation says the run finished; the run's summary says whether its cases passed (the wait names them).
      const results = [];
      let failedCases = 0;
      let verdictCode: ExitCodeValue = ExitCode.ok;
      for (const run of runs) {
        const latest = await callStable<TestRun>(ctx, "GET", "/api/v1/test-runs/{run_id}", "test runs", { params: { run_id: [run.id] } });
        const { failed, errors } = caseCounts(latest.summary);
        failedCases += failed + errors;
        // A run that is still going has no verdict yet; the wait's own exit code says so.
        if (!waited.pending.includes(run.operation_id ?? "")) {
          const code = runVerdict(latest.summary).exit_code;
          if (code === ExitCode.failure || (code === ExitCode.needsAction && verdictCode === ExitCode.ok)) verdictCode = code;
        }
        results.push({ run_id: latest.id, suite: latest.suite_name ?? latest.suite_id, status: latest.status, summary: latest.summary ?? {} });
      }
      let exitCode = waited.exitCode;
      if (exitCode === ExitCode.ok) exitCode = verdictCode;
      // The bounded wait ended first: the last line is the one command that picks the runs up again.
      const resume = waited.pending.length ? resumeCommand(waited.pending, rawTimeout) : undefined;
      const text = [
        waited.body,
        "",
        ...results.map((r) => `${r.suite}: ${r.status}  ${summaryText(r.summary)}`),
        ...(resume ? ["", `${waited.why} after the timeout; the runs go on. Resume: ${resume}`] : []),
      ].join("\n");
      return { data: { runs: results, failed_cases: failedCases, ...waited.data, ...(resume ? { resume } : {}) }, text, exitCode };
    }
    return {
      data: { runs: started, operation_ids: operationIds },
      text:
        table(started, ["suite", "run_id", "status", "operation_id"]) +
        (operationIds.length ? `\n\nWait with: cavelon wait ${operationIds.join(" ")}` : ""),
    };
  },
};

// ---------------------------------------------------------------------------
// trace
// ---------------------------------------------------------------------------

interface TraceSummary {
  id: string;
  conversation_id?: string | null;
  workflow_name?: string;
  status: string;
  duration_ms?: number | null;
  error_summary?: string | null;
  total_spans?: number;
  total_tool_calls?: number;
  total_llm_calls?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  created_at?: string;
}

interface Span {
  id: string;
  parent_span_id?: string | null;
  span_type?: string;
  name?: string;
  agent_slug?: string | null;
  tool_name?: string | null;
  model?: string | null;
  status?: string;
  sequence?: number;
  duration_ms?: number | null;
  input_json?: unknown;
  output_json?: unknown;
  attributes_json?: unknown;
  token_usage_json?: unknown;
  error_json?: unknown;
}

type TraceKind = "trigger" | "test" | "conversation";

/** The id each kind's route takes, as a person or agent finds it in a listing. */
const KIND_ID: Record<TraceKind, string> = {
  trigger: "a trigger run id (a test case's run_id)",
  test: "a test run id (from `cavelon test run`)",
  conversation: "a conversation id (a test case's conversation_id, or a trace's)",
};

/**
 * The command that opens a test case's traces, with the id its route needs: a
 * case answered in a conversation has its traces there, a trigger case under
 * the run it started. Undefined when the instance recorded neither.
 */
function caseTraceCommand(r: TestResultState): { label: string; command: string } | undefined {
  if (r.conversation_id) return { label: "by its conversation id", command: cavelonCommand("trace", r.conversation_id, "--kind", "conversation") };
  if (r.agent_run_id) return { label: "by its trigger run id", command: cavelonCommand("trace", r.agent_run_id, "--kind", "trigger") };
  return undefined;
}

/** The command that shows one trace's spans: the route takes the id the list was read for, and the trace id. */
function spansCommand(owner: string, kind: TraceKind, traceId: string): string {
  return cavelonCommand("trace", owner, "--kind", kind, "--trace", traceId);
}

/** A detail route's 404: say which ids `--trace` needs, so a wrong one is not retried. */
function traceNotFound(id: string, kind: TraceKind | undefined, traceId: string, error: CavelonError): CavelonError {
  const tried = kind ? `${kind === "trigger" ? "trigger run" : "conversation"} ${id}` : `trigger run or conversation ${id}`;
  return new CavelonError(ExitCode.failure, {
    code: "trace_not_found",
    message: `No trace ${traceId} under ${tried} (${error.message}).`,
    hint:
      "<run> must be the id the trace was listed under: a trigger run id with --kind trigger, or a conversation id with --kind conversation " +
      "(a test case's traces are under its conversation_id; a test run id or an agent's run id does not work here). " +
      `--trace takes a trace_id from that list. List them with: ${cavelonCommand("trace", id)}`,
  });
}

function summarizeTrace(t: TraceSummary) {
  return {
    trace_id: t.id,
    workflow: t.workflow_name ?? null,
    status: t.status,
    duration_ms: t.duration_ms ?? null,
    spans: t.total_spans ?? null,
    llm_calls: t.total_llm_calls ?? null,
    tool_calls: t.total_tool_calls ?? null,
    tokens: (t.total_input_tokens ?? 0) + (t.total_output_tokens ?? 0),
    error: t.error_summary ?? null,
    conversation_id: t.conversation_id ?? null,
  };
}

function summarizeSpan(s: Span) {
  const error = s.error_json ? clip(typeof s.error_json === "string" ? s.error_json : JSON.stringify(s.error_json), 200) : null;
  return {
    span_id: s.id,
    seq: s.sequence ?? null,
    type: s.span_type ?? null,
    name: s.tool_name ?? s.name ?? null,
    agent: s.agent_slug ?? null,
    status: s.status ?? null,
    duration_ms: s.duration_ms ?? null,
    error,
  };
}

function detailOf(value: unknown, full: boolean): unknown {
  if (full || value === null || value === undefined) return value ?? null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 2000 ? clip(text, 2000) : value;
}

async function tryTraces(ctx: Context, kind: TraceKind, id: string): Promise<TraceSummary[] | undefined> {
  const template = kind === "trigger" ? "/api/v1/triggers/runs/{run_id}/traces" : "/api/v1/conversations/{conversation_id}/traces";
  const param = kind === "trigger" ? "run_id" : "conversation_id";
  try {
    return await callStable<TraceSummary[]>(ctx, "GET", template, "traces", { params: { [param]: [id] } });
  } catch (error) {
    if (error instanceof CavelonError && (error.status === 404 || error.status === 422)) return undefined;
    throw error;
  }
}

/** Run statuses before a run starts, when it has no traces yet. */
const NOT_STARTED = new Set(["queued", "pending"]);

/**
 * A trigger run without traces, as the run says it: one not started yet, one
 * refused for capacity, or one that ended without a trace (a loop's iteration
 * child), with its error and the stages that
 * recorded one. Undefined when the id is no trigger run.
 */
async function untracedRun(ctx: Context, id: string): Promise<{ run: RunState; note?: CapacityNote; stages: StageError[] } | undefined> {
  if (!isUuid(id)) return undefined;
  let run: RunState;
  try {
    run = await callStable<RunState>(ctx, "GET", "/api/v1/triggers/runs/{run_id}", "trigger runs", { params: { run_id: [id] } });
  } catch (error) {
    if (error instanceof CavelonError && (error.status === 404 || error.status === 422)) return undefined;
    throw error;
  }
  const note = await runCapacityNote(ctx, run);
  const stages = NOT_STARTED.has(run.status) ? [] : await stageErrors(ctx, id);
  return { run, note, stages };
}

function untracedText(id: string, untraced: { run: RunState; note?: CapacityNote; stages: StageError[] }): string {
  const { run, note, stages } = untraced;
  const why = [run.error_summary, ...stages.map(stageErrorText)].filter(Boolean).map((line) => `\n  ${line}`);
  return `Run ${id} is ${run.status} and has no traces${NOT_STARTED.has(run.status) || run.status === "running" ? " yet" : ""}.${noteLines(note)}${why.join("")}`;
}

/** The hint for a capacity refusal any of these errors names, as a line after the table. */
async function capacityFooter(ctx: Context, errors: Array<string | null | undefined>): Promise<string> {
  const code = capacityCodeIn(...errors);
  if (!code) return "";
  return `\n\n${code}: ${capacityHint(code, await readLimits(ctx).catch(() => undefined))}`;
}

/** What the instance recorded for a case that did not pass: its error and the judge's reasoning, whole with --full. */
function notPassedLines(r: TestResultState, max: number): string[] {
  const c = failedCase(r, max);
  const lines = [`  ${caseLabel(c)}  ${c.status}`];
  if (c.reason) lines.push(`    ${c.reason}`);
  if (r.llm_judge_reasoning && r.llm_judge_reasoning !== r.error_message) lines.push(`    Judge: ${clip(r.llm_judge_reasoning, max)}`);
  const open = caseTraceCommand(r);
  if (open) lines.push(`    Its traces (${open.label}): ${open.command}`);
  return lines;
}

/** A case that did not fail, as the judge saw it: a low-scoring pass is read, not only counted. */
function judgedLines(r: TestResultState, max: number): string[] {
  const score = r.llm_judge_score === null || r.llm_judge_score === undefined ? "" : `  score ${r.llm_judge_score}`;
  return [`  ${caseLabel(failedCase(r))}  ${r.status}${score}`, `    Judge: ${clip(r.llm_judge_reasoning!, max)}`];
}

/** A test run's results: one line per case, then each case that did not pass with the reasons the instance recorded. */
async function testRunView(ctx: Context, id: string, results: TestResultState[], options: { limit: number; cursor?: string; full: boolean }) {
  const max = options.full ? Number.MAX_SAFE_INTEGER : 1000;
  const page = pageOf(results, options.limit, options.cursor);
  const items = page.items.map((r) => ({
    case: r.test_case_name ?? r.id,
    step: r.step_order ?? null,
    status: r.status,
    score: r.llm_judge_score ?? null,
    conversation_id: r.conversation_id ?? null,
    run_id: r.agent_run_id ?? null,
    error: r.error_message ? clip(r.error_message, 200) : null,
    judge_reasoning: r.llm_judge_reasoning ? clip(r.llm_judge_reasoning, max) : null,
    trace_command: caseTraceCommand(r)?.command ?? null,
    // judge_breakdown is an open object in the OpenAPI; it is passed on as the instance sends it.
    ...(NOT_PASSED.has(r.status) ? { reason: failedCase(r, max).reason, judge_breakdown: detailOf(r.judge_breakdown, options.full) } : {}),
  }));
  const notPassed = page.items.filter((r) => NOT_PASSED.has(r.status));
  // An older instance, or one that keeps the reasoning of failures only, sends none for a pass.
  const judged = page.items.filter((r) => !NOT_PASSED.has(r.status) && r.llm_judge_reasoning);
  const byConversation = page.items.find((r) => r.conversation_id);
  const byRun = page.items.find((r) => !r.conversation_id && r.agent_run_id);
  const where = [
    byConversation ? `A case's traces, by the conversation_id in its row: ${caseTraceCommand(byConversation)!.command}` : "",
    byRun ? `A trigger case's traces, by the run_id in its row: ${caseTraceCommand(byRun)!.command}` : "",
  ].filter(Boolean);
  return {
    data: { kind: "test", run_id: id, results: { ...page, items } },
    text:
      table(items, ["case", "step", "status", "score", ...(items.some((r) => r.run_id) ? ["run_id"] : []), "conversation_id"]) +
      moreHint(page.next_cursor, cavelonCommand("trace", id, "--kind", "test")) +
      (notPassed.length ? `\n\nDid not pass:\n${notPassed.flatMap((r) => notPassedLines(r, max)).join("\n")}` : "") +
      (judged.length ? `\n\nJudge's reasoning:\n${judged.flatMap((r) => judgedLines(r, options.full ? max : 300)).join("\n")}` : "") +
      `\n\n${where.length ? where.join("\n") : "The instance recorded no conversation or run for these results, so they have no trace to open."}` +
      (await capacityFooter(ctx, items.map((r) => r.error))),
  };
}

export const trace: CommandSpec = {
  name: "trace",
  summary: "Summarise the traces of a run, with a command for each span's detail.",
  description:
    "<run> is a trigger run id, a test run id, a conversation id or an operation id (op_…).\n" +
    "Without --trace: one line per trace (or per test result). With --trace: its spans. With --span: one span in full.",
  readOnly: true,
  idempotent: true,
  mcpTool: "trace",
  positionals: [{ name: "run", description: "Run, conversation or operation id.", required: true }],
  options: {
    kind: { type: "string", value: "<kind>", description: "trigger, test or conversation (default: found out)." },
    trace: { type: "string", value: "<trace_id>", description: "Show this trace's spans." },
    span: { type: "string", value: "<span_id>", description: "Show one span's input, output and error (needs --trace)." },
    full: { type: "boolean", description: "Do not shorten span input and output." },
    limit: LIMIT_OPTION,
    cursor: CURSOR_OPTION,
  },
  examples: ["cavelon trace op_test_run_…", "cavelon trace <run> --trace <trace_id>", "cavelon trace <run> --trace <trace_id> --span <span_id>"],
  async run(ctx, input) {
    let id = positional(input, "run")!;
    let kind = stringOption(input, "kind") as TraceKind | undefined;
    if (kind && !["trigger", "test", "conversation"].includes(kind)) throw usageError("--kind must be trigger, test or conversation.");
    const limit = intOption(input, "limit", { min: 1, max: 500, fallback: 20 })!;
    const cursor = stringOption(input, "cursor");
    if (id.startsWith("op_")) {
      const op = await getOperation(await ctx.client(), id);
      const ref = op.result_ref;
      if (!ref) throw new CavelonError(ExitCode.failure, { code: "no_result", message: `${id} has no result yet (${op.status}).` });
      // A trigger run (what `loop start` starts) has traces of its own; a test run, its results'.
      const triggerRun = ref.type === "agent_run" || Boolean(ref.href?.startsWith("/api/v1/triggers/runs/"));
      if (ref.type !== "test_run" && !triggerRun) {
        throw new CavelonError(ExitCode.failure, {
          code: "no_trace",
          message: `${id} is a ${op.kind}; its result is a ${ref.type}, which has no trace.`,
        });
      }
      id = ref.id;
      kind = triggerRun ? "trigger" : "test";
    }
    const traceId = stringOption(input, "trace");
    const spanId = stringOption(input, "span");
    if (spanId && !traceId) throw usageError("--span needs --trace <trace_id>.");

    if (traceId) {
      const detailKind = kind ?? "trigger";
      if (detailKind === "test") throw usageError("A test run's traces belong to its conversations: pass --kind conversation <conversation_id>.");
      const template =
        detailKind === "trigger" ? "/api/v1/triggers/runs/{run_id}/traces/{trace_id}" : "/api/v1/conversations/{conversation_id}/traces/{trace_id}";
      const owner = detailKind === "trigger" ? "run_id" : "conversation_id";
      const notFound = (error: unknown): error is CavelonError => error instanceof CavelonError && (error.status === 404 || error.status === 422);
      let detail: TraceSummary & { spans?: Span[] };
      try {
        detail = await callStable(ctx, "GET", template, "traces", { params: { [owner]: [id], trace_id: [traceId] } });
      } catch (error) {
        if (!notFound(error)) throw error;
        if (kind) throw traceNotFound(id, kind, traceId, error);
        try {
          detail = await callStable(ctx, "GET", "/api/v1/conversations/{conversation_id}/traces/{trace_id}", "traces", {
            params: { conversation_id: [id], trace_id: [traceId] },
          });
        } catch (second) {
          throw notFound(second) ? traceNotFound(id, undefined, traceId, second) : second;
        }
      }
      const spans = (detail.spans ?? []).slice().sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
      if (spanId) {
        const span = spans.find((s) => s.id === spanId);
        if (!span) throw new CavelonError(ExitCode.failure, { code: "span_not_found", message: `No span ${spanId} in trace ${traceId}.` });
        const full = boolOption(input, "full");
        const data = {
          ...summarizeSpan(span),
          model: span.model ?? null,
          parent_span_id: span.parent_span_id ?? null,
          input: detailOf(span.input_json, full),
          output: detailOf(span.output_json, full),
          attributes: detailOf(span.attributes_json, full),
          tokens: span.token_usage_json ?? null,
          error: span.error_json ?? null,
        };
        return { data, text: JSON.stringify(data, null, 2) };
      }
      const page = pageOf(spans.map(summarizeSpan), limit, cursor);
      const base = cavelonCommand("trace", id, ...(kind ? ["--kind", kind] : []), "--trace", traceId);
      return {
        data: { trace: summarizeTrace(detail), spans: page },
        text:
          `${keyValues(Object.entries(summarizeTrace(detail)))}\n\n` +
          table(page.items, ["seq", "type", "name", "status", "duration_ms", "span_id"]) +
          moreHint(page.next_cursor, base) +
          (page.items.length ? `\n\nOne span in full, by the span_id in its row: ${base} --span ${shellWord(page.items[0]!.span_id)}` : ""),
      };
    }

    // A run: try what the id can be, unless --kind says. Some routes answer an
    // unknown id with an empty list, so when guessing, an empty answer means "not this".
    const order: TraceKind[] = kind ? [kind] : ["trigger", "test", "conversation"];
    for (const candidate of order) {
      if (candidate === "test") {
        let results: TestResultState[] | undefined;
        try {
          results = await callStable<TestResultState[]>(ctx, "GET", "/api/v1/test-runs/{run_id}/results", "test results", { params: { run_id: [id] } });
        } catch (error) {
          if (!(error instanceof CavelonError && (error.status === 404 || error.status === 422))) throw error;
        }
        if (!results || (!kind && results.length === 0)) continue;
        return testRunView(ctx, id, results, { limit, cursor, full: boolOption(input, "full") });
      }
      const traces = await tryTraces(ctx, candidate, id);
      if (candidate === "trigger" && !traces?.length) {
        // A run waiting for run capacity, or refused for it, has no traces yet;
        // a loop's iteration child is a trigger run too, found without --kind.
        const untraced = await untracedRun(ctx, id);
        if (untraced) {
          const { run, note, stages } = untraced;
          return {
            data: {
              kind: "trigger",
              id,
              run: { status: run.status, error: run.error_summary ?? null, ...note, ...(stages.length ? { stage_errors: stages } : {}) },
              traces: { items: [], next_cursor: null },
            },
            text: untracedText(id, untraced),
          };
        }
      }
      if (!traces || (!kind && traces.length === 0)) continue;
      const page = pageOf(
        traces.map((t) => ({ ...summarizeTrace(t), spans_command: spansCommand(id, candidate, t.id) })),
        limit,
        cursor,
      );
      return {
        data: { kind: candidate, id, traces: page },
        text:
          (table(page.items, ["trace_id", "workflow", "status", "duration_ms", "spans", "error"]) || "No traces recorded.") +
          moreHint(page.next_cursor, cavelonCommand("trace", id, "--kind", candidate)) +
          (page.items.length
            ? `\n\nSpans of a trace, by the ${candidate === "trigger" ? "trigger run" : "conversation"} id and the trace_id in its row: ${page.items[0]!.spans_command}`
            : "") +
          (await capacityFooter(ctx, page.items.map((t) => t.error))),
      };
    }
    if (kind) {
      throw new CavelonError(ExitCode.failure, {
        code: "run_not_found",
        message: `No ${kind === "trigger" ? "trigger run" : kind === "test" ? "test run" : "conversation"} ${id} in this tenant.`,
        hint: `--kind ${kind} takes ${KIND_ID[kind]}. Without --kind, \`${cavelonCommand("trace", id)}\` finds out what the id is.`,
      });
    }
    throw new CavelonError(ExitCode.failure, {
      code: "run_not_found",
      message: `No trigger run, test run or conversation ${id} with results or traces in this tenant.`,
      hint:
        `<run> takes ${KIND_ID.trigger}, ${KIND_ID.test} or ${KIND_ID.conversation}; a trace id goes after --trace. ` +
        "Name the kind with --kind trigger|test|conversation to see an empty one.",
    });
  },
};
