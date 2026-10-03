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
import { CavelonError, ExitCode, usageError } from "../errors.js";
import { clip, keyValues, moreHint, table } from "../format.js";
import { callStable } from "../invoke.js";
import { bindsNow, changedBy, limitError, limitsOrWarn, readLimits, type Limit, type PublishedLimits } from "../limits.js";
import { getOperation } from "../operations.js";
import { caseCounts, caseLabel, failedCase, NOT_PASSED, type TestResultState } from "../results.js";
import { isUuid } from "../session.js";
import { cavelonCommand } from "../shell.js";
import { readZipSummary, ZipError, type ZipSummary } from "../zip.js";
import { TIMEOUT_OPTION, timeoutMs, waitAndReport } from "./async.js";
import { stageErrors, stageErrorText, type StageError } from "./loops.js";
import { resolveHarnessId } from "./tenants.js";

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
    "archives, and only within its caps on file count, unpacked size and compression ratio.",
  readOnly: false,
  mcpTool: "kb_upload",
  positionals: [{ name: "dir", description: "Folder (or single file) to upload.", required: true }],
  options: {
    kb: { type: "string", value: "<kb>", description: "Knowledge base name or id (required)." },
    recursive: { type: "boolean", short: "r", description: "Include subfolders." },
    ext: { type: "string", multiple: true, value: "<ext>", description: "Only these file extensions (pdf, md, …)." },
    "dry-run": { type: "boolean", description: "List what would be uploaded, upload nothing." },
    wait: WAIT_OPTION,
    timeout: TIMEOUT_OPTION,
  },
  examples: ["cavelon kb upload ./docs --kb FAQ", "cavelon kb upload ./manuals --kb FAQ -r --ext pdf --wait --timeout 5m"],
  async run(ctx, input) {
    const dir = path.resolve(ctx.io.cwd, positional(input, "dir")!);
    const kbRef = stringOption(input, "kb");
    if (!kbRef) throw usageError("Which knowledge base?", "Pass --kb <name-or-id>.");
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
    if (boolOption(input, "dry-run")) {
      const rel = files.map((f) => path.relative(ctx.io.cwd, f) || f);
      return { data: { kb: kbRef, files: rel, count: rel.length, dry_run: true }, text: `Would upload ${rel.length} files:\n${rel.join("\n")}` };
    }
    const kb = await resolveKbId(ctx, kbRef);
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
    let failure: { error: CavelonError; notUploaded: string[] } | undefined;
    for (const [index, batch] of batches.entries()) {
      try {
        const uploaded = await callStable<UploadedDocument[]>(ctx, "POST", "/api/v1/knowledge-bases/{kb_id}/documents/upload", "document upload", {
          params: { kb_id: [kb.id] },
          files: batch.map((f) => ({ field: "files", path: f })),
          timeoutMs: 300_000,
        });
        documents.push(...uploaded);
      } catch (error) {
        if (!(error instanceof CavelonError) || documents.length === 0) throw error;
        // Earlier batches are uploaded and ingesting: report them, and what is left.
        failure = { error, notUploaded: batches.slice(index).flat().map((f) => path.relative(ctx.io.cwd, f) || f) };
        break;
      }
    }
    const operationIds = documents.map((d) => d.operation_id).filter((id): id is string => Boolean(id));
    const summary = {
      kb: { id: kb.id, name: kb.name ?? null },
      documents: documents.map((d) => ({ id: d.id, filename: d.filename, status: d.status, operation_id: d.operation_id ?? null })),
      operation_ids: operationIds,
    };
    if (operationIds.length < documents.length) ctx.warn("The instance returned no operation id for some documents; it may be older than the operations API.");
    if (failure) {
      return {
        data: { ...summary, error: failure.error.toJSON(), not_uploaded: failure.notUploaded },
        text:
          `Uploaded ${documents.length} files, then: ${failure.error.message}\n` +
          `Not uploaded (${failure.notUploaded.length}): ${failure.notUploaded.join(", ")}\n` +
          (operationIds.length ? `Wait for the uploaded ones with: cavelon wait ${operationIds.join(" ")}` : ""),
        exitCode: failure.error.exitCode,
      };
    }
    if (boolOption(input, "wait") && ctx.mode === "cli" && operationIds.length) {
      const waited = await waitAndReport(ctx, operationIds, timeoutMs(ctx, stringOption(input, "timeout")));
      return { data: { ...summary, ...waited.data }, text: `Uploaded ${documents.length} files.\n${waited.text}`, exitCode: waited.exitCode };
    }
    return {
      data: summary,
      text:
        `Uploaded ${documents.length} files to ${kb.name ?? kb.id}.` +
        (operationIds.length ? `\nOperations: ${operationIds.length}\nWait with: cavelon wait ${operationIds.join(" ")}` : ""),
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

/** The counts of a test run's summary that it carries. */
function summaryText(summary: Record<string, unknown>): string {
  return ["passed", "failed", "errors", "pass_rate"]
    .filter((k) => k in summary)
    .map((k) => k + " " + String(summary[k]))
    .join("  ");
}

export const testRun: CommandSpec = {
  name: "test run",
  summary: "Start test-suite runs; returns operation ids.",
  description:
    "Without --suite, runs every suite of the solution (--harness, or cavelon.yaml's harness).\n" +
    "With --wait, exits 1 when a case failed, 5 when answers wait for a manual verdict.",
  readOnly: false,
  mcpTool: "test_run",
  options: {
    suite: { type: "string", multiple: true, value: "<suite>", description: "Suite name or id." },
    harness: { type: "string", value: "<harness>", description: "Solution slug or id to run against." },
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
      const waited = await waitAndReport(ctx, operationIds, timeoutMs(ctx, stringOption(input, "timeout")));
      // The operation says the run finished; the run's summary says whether its cases passed (the wait names them).
      const results = [];
      let failedCases = 0;
      for (const run of runs) {
        const latest = await callStable<TestRun>(ctx, "GET", "/api/v1/test-runs/{run_id}", "test runs", { params: { run_id: [run.id] } });
        const { failed, errors } = caseCounts(latest.summary);
        failedCases += failed + errors;
        results.push({ run_id: latest.id, suite: latest.suite_name ?? latest.suite_id, status: latest.status, summary: latest.summary ?? {} });
      }
      let exitCode = waited.exitCode;
      if (exitCode === ExitCode.ok && failedCases > 0) exitCode = ExitCode.failure;
      const text = [
        waited.text,
        "",
        ...results.map((r) => `${r.suite}: ${r.status}  ${summaryText(r.summary)}`),
      ].join("\n");
      return { data: { runs: results, failed_cases: failedCases, ...waited.data }, text, exitCode };
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
  if (c.run_id) lines.push(`    Its run: ${cavelonCommand("trace", c.run_id)}`);
  return lines;
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
    // judge_breakdown is an open object in the OpenAPI; it is passed on as the instance sends it.
    ...(NOT_PASSED.has(r.status)
      ? { reason: failedCase(r, max).reason, judge_reasoning: r.llm_judge_reasoning ? clip(r.llm_judge_reasoning, max) : null, judge_breakdown: detailOf(r.judge_breakdown, options.full) }
      : {}),
  }));
  const notPassed = page.items.filter((r) => NOT_PASSED.has(r.status));
  const where = [
    items.some((r) => r.conversation_id) ? `A case's trace: ${cavelonCommand("trace")} <conversation_id> --kind conversation` : "",
    items.some((r) => r.run_id) ? `A trigger case's run: ${cavelonCommand("trace")} <run_id>` : "",
  ].filter(Boolean);
  return {
    data: { kind: "test", run_id: id, results: { ...page, items } },
    text:
      table(items, ["case", "step", "status", "score", ...(items.some((r) => r.run_id) ? ["run_id"] : []), "conversation_id"]) +
      moreHint(page.next_cursor, cavelonCommand("trace", id, "--kind", "test")) +
      (notPassed.length ? `\n\nDid not pass:\n${notPassed.flatMap((r) => notPassedLines(r, max)).join("\n")}` : "") +
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
      if (!op.result_ref) throw new CavelonError(ExitCode.failure, { code: "no_result", message: `${id} has no result yet (${op.status}).` });
      if (op.result_ref.type !== "test_run") {
        throw new CavelonError(ExitCode.failure, {
          code: "no_trace",
          message: `${id} is a ${op.kind}; its result is a ${op.result_ref.type}, which has no trace.`,
        });
      }
      id = op.result_ref.id;
      kind = "test";
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
      let detail: TraceSummary & { spans?: Span[] };
      try {
        detail = await callStable(ctx, "GET", template, "traces", { params: { [owner]: [id], trace_id: [traceId] } });
      } catch (error) {
        if (!kind && error instanceof CavelonError && error.status === 404) {
          detail = await callStable(ctx, "GET", "/api/v1/conversations/{conversation_id}/traces/{trace_id}", "traces", {
            params: { conversation_id: [id], trace_id: [traceId] },
          });
        } else throw error;
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
      const base = `cavelon trace ${id}${kind ? ` --kind ${kind}` : ""} --trace ${traceId}`;
      return {
        data: { trace: summarizeTrace(detail), spans: page },
        text:
          `${keyValues(Object.entries(summarizeTrace(detail)))}\n\n` +
          table(page.items, ["seq", "type", "name", "status", "duration_ms", "span_id"]) +
          moreHint(page.next_cursor, base) +
          `\n\nOne span in full: ${base} --span <span_id>`,
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
      const page = pageOf(traces.map(summarizeTrace), limit, cursor);
      return {
        data: { kind: candidate, id, traces: page },
        text:
          (table(page.items, ["trace_id", "workflow", "status", "duration_ms", "spans", "error"]) || "No traces recorded.") +
          moreHint(page.next_cursor, `cavelon trace ${id} --kind ${candidate}`) +
          (page.items.length ? `\n\nSpans of one: cavelon trace ${id} --kind ${candidate} --trace <trace_id>` : "") +
          (await capacityFooter(ctx, page.items.map((t) => t.error))),
      };
    }
    throw new CavelonError(ExitCode.failure, {
      code: "run_not_found",
      message: `No trigger run, test run or conversation ${id} with results or traces in this tenant.`,
      hint: "Name the kind with --kind trigger|test|conversation to see an empty one.",
    });
  },
};
