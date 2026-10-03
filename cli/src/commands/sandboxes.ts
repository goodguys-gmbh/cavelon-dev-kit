import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  boolOption,
  CURSOR_OPTION,
  intOption,
  LIMIT_OPTION,
  listOption,
  positional,
  stringOption,
  type CommandSpec,
  type Context,
  type Input,
} from "../command.js";
import type { OpenApiDoc } from "../contracts.js";
import { CavelonError, ExitCode, usageError } from "../errors.js";
import { idempotencyKey, instanceModes, requireFeature, stableKey, UUID_KEY_OPTION } from "../features.js";
import { clip, keyValues, moreHint, table } from "../format.js";
import { buildRequest, callStable, workflowOperation } from "../invoke.js";
import { isUuid } from "../session.js";
import { cavelonCommand } from "../shell.js";
import { archiveFrom } from "../tar.js";
import { TIMEOUT_OPTION, timeoutMs, waitAndReport } from "./async.js";
import { resolveHarnessId } from "./tenants.js";

/**
 * Sandboxes: inspect them, seed them, take results out. Each Sandbox runs in
 * one execution mode, and the modes offer different things (plan 05):
 * archive import and export and a trusted validation receipt only on an
 * isolated container, a workspace refresh only on a customer VM. A command
 * the mode does not offer is refused before anything is sent, naming the
 * mode; the instance refuses it anyway.
 */

type Offer = "archive" | "receipt" | "refresh";

const MODES: Record<string, { offers: Offer[]; commands: string[] }> = {
  isolated_container: {
    offers: ["archive", "receipt"],
    commands: ["validate", "files", "cat", "activity", "logs", "receipt", "seed", "artifacts export"],
  },
  customer_vm: {
    offers: ["refresh"],
    commands: ["validate", "files", "cat", "activity", "logs", "refresh"],
  },
};

const WAIT_OPTION = { type: "boolean" as const, description: "Wait for the job to finish (see `cavelon wait`).", cliOnly: true };
const HARNESS_OPTION = {
  type: "string" as const,
  value: "<harness>",
  description: "The solution the Sandbox is read for (default: cavelon.yaml's, or the Sandbox's only allowed one).",
};
const REVISION_OPTION = {
  type: "string" as const,
  value: "<revision>",
  description: "The workspace revision the job expects (default: the current one).",
};

interface Sandbox {
  id: string;
  name: string;
  execution_mode: string;
  lifecycle_state: string;
  config_version: number;
  observed_revision: string | null;
  readiness: { passed?: boolean; checks?: Array<{ name: string; passed: boolean; reason?: string | null }>; checked_at?: string } | null;
  allowed_harness_ids: string[];
  writer_owner_run_id: string | null;
  connection?: { state: string; last_contact_at: string | null } | null;
}

interface ArchiveJob {
  id: string;
  sandbox_id: string;
  direction: "import" | "export";
  expected_workspace_revision: string;
  status: "active" | "cancelling" | "succeeded" | "failed" | "cancelled";
  phase: string;
  artifact_id: string | null;
  error_code: string | null;
  upload_deadline: string;
  operation_id: string;
}

// ---------------------------------------------------------------------------
// Lookups and the mode rules
// ---------------------------------------------------------------------------

const SANDBOX_PAGE = 100;
const MAX_SANDBOX_PAGES = 10;

async function sandboxesOn(ctx: Context): Promise<void> {
  await requireFeature(ctx, "sandbox_feature_enabled", "sandbox_feature_disabled", "Sandboxes");
}

export async function resolveSandbox(ctx: Context, ref: string): Promise<Sandbox> {
  await sandboxesOn(ctx);
  if (isUuid(ref)) return callStable<Sandbox>(ctx, "GET", "/api/v1/sandboxes/{sandbox_id}", "Sandboxes", { params: { sandbox_id: [ref] } });
  const all: Sandbox[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_SANDBOX_PAGES; page++) {
    const items = await callStable<Sandbox[]>(ctx, "GET", "/api/v1/sandboxes", "Sandboxes", { query: { limit: SANDBOX_PAGE, after } });
    all.push(...items);
    if (items.length < SANDBOX_PAGE) break;
    after = items.at(-1)!.id;
  }
  let hits = all.filter((s) => s.name === ref);
  if (hits.length === 0) hits = all.filter((s) => s.name.toLowerCase() === ref.toLowerCase());
  if (hits.length === 1) return hits[0]!;
  throw new CavelonError(ExitCode.failure, {
    code: hits.length ? "sandbox_ambiguous" : "sandbox_not_found",
    message: hits.length ? `${hits.length} Sandboxes are named "${ref}"; pass its id.` : `No Sandbox "${ref}" in this tenant.`,
    hint: "`cavelon sandbox list` lists them.",
  });
}

const REFUSALS: Record<Offer, { code: string; what: string; elsewhere: (s: Sandbox) => string }> = {
  archive: {
    code: "sandbox_capability_unavailable",
    what: "archive import and export",
    elsewhere: (s) =>
      `On a customer VM, put the files into its directory on the VM, then run \`${cavelonCommand("sandbox", "refresh", s.name)}\`; ` +
      `read results with \`${cavelonCommand("sandbox", "files", s.name)}\` and \`${cavelonCommand("sandbox", "cat", s.name)} <path>\`.`,
  },
  receipt: {
    code: "sandbox_validation_receipt_unavailable",
    what: "a runner validation receipt (it reports agent_reported completion only)",
    elsewhere: (s) => `The evidence is the files: \`${cavelonCommand("sandbox", "files", s.name)}\` and \`${cavelonCommand("sandbox", "cat", s.name)} <path>\`.`,
  },
  refresh: {
    code: "sandbox_workspace_refresh_unavailable",
    what: "a workspace refresh (nothing edits it outside Cavelon)",
    elsewhere: (s) => `Seed an isolated container with \`${cavelonCommand("sandbox", "seed", s.name)} <folder>\`.`,
  },
};

/** Refuse what the Sandbox's mode does not offer, naming the mode. */
function requireOffer(ctx: Context, sandbox: Sandbox, offer: Offer, command: string): void {
  const mode = MODES[sandbox.execution_mode];
  if (!mode) {
    ctx.warn(`Sandbox "${sandbox.name}" runs in mode ${sandbox.execution_mode}, which this cavelon does not know; the instance decides.`);
    return;
  }
  if (mode.offers.includes(offer)) return;
  const refusal = REFUSALS[offer];
  const offering = Object.entries(MODES).filter(([, m]) => m.offers.includes(offer)).map(([name]) => name);
  throw new CavelonError(ExitCode.validation, {
    code: refusal.code,
    message: `Sandbox "${sandbox.name}" runs in ${sandbox.execution_mode} mode, which offers no ${refusal.what}; \`cavelon ${command}\` needs ${offering.map((m) => "an " + m).join(" or ")} Sandbox.`,
    hint: refusal.elsewhere(sandbox),
  });
}

/** The solution the Sandbox is used for: named, the folder's, or its only allowed one. */
async function harnessFor(ctx: Context, input: Input, sandbox: Sandbox): Promise<string> {
  const ref = stringOption(input, "harness") ?? (await ctx.session()).project?.harness;
  const allowed = sandbox.allowed_harness_ids ?? [];
  if (allowed.length === 0) {
    throw new CavelonError(ExitCode.unauthorized, {
      code: "sandbox_harness_not_allowed",
      message: `No solution may use Sandbox "${sandbox.name}" yet.`,
      hint: "A person grants Sandbox Access (the allowed solutions) in the Admin.",
    });
  }
  if (!ref) {
    if (allowed.length === 1) return allowed[0]!;
    throw usageError(`Sandbox "${sandbox.name}" allows ${allowed.length} solutions; name one with --harness.`, `Allowed: ${allowed.join(", ")}`);
  }
  const id = await resolveHarnessId(ctx, ref);
  if (!allowed.includes(id)) {
    throw new CavelonError(ExitCode.unauthorized, {
      code: "sandbox_harness_not_allowed",
      message: `Solution ${ref} may not use Sandbox "${sandbox.name}".`,
      hint: "A person grants Sandbox Access (the allowed solutions) in the Admin; --harness names another solution.",
    });
  }
  return id;
}

function sandboxView(s: Sandbox) {
  return {
    name: s.name,
    id: s.id,
    mode: s.execution_mode,
    state: s.lifecycle_state,
    ready: s.readiness?.passed ?? null,
    revision: s.observed_revision,
    connection: s.connection?.state ?? null,
    writer_run_id: s.writer_owner_run_id,
    offers: MODES[s.execution_mode]?.commands ?? null,
  };
}

// ---------------------------------------------------------------------------
// Inspect
// ---------------------------------------------------------------------------

export const sandboxList: CommandSpec = {
  name: "sandbox list",
  summary: "The tenant's Sandboxes: mode, state, revision, and what each mode offers.",
  readOnly: true,
  idempotent: true,
  mcpTool: "sandbox_list",
  options: { limit: { ...LIMIT_OPTION, description: "Return at most n Sandboxes (at most 100)." }, cursor: CURSOR_OPTION },
  examples: ["cavelon sandbox list", "cavelon sandbox list --json"],
  async run(ctx, input) {
    await sandboxesOn(ctx);
    const limit = intOption(input, "limit", { min: 1, max: 100, fallback: 50 })!;
    const after = stringOption(input, "cursor");
    if (after !== undefined && !isUuid(after)) throw usageError(`--cursor "${after}" is not a cursor from a previous page.`);
    const items = (await callStable<Sandbox[]>(ctx, "GET", "/api/v1/sandboxes", "Sandboxes", { query: { limit, after } })).map(sandboxView);
    const next = items.length === limit ? items.at(-1)!.id : null;
    const modes = await instanceModes(ctx);
    return {
      data: { items, next_cursor: next, instance_modes: modes ?? null },
      text:
        (table(items, ["name", "mode", "state", "ready", "revision", "connection", "id"]) || "No Sandboxes.") +
        moreHint(next, "cavelon sandbox list") +
        (modes ? `\n\nNew Sandboxes on this instance: ${modes.join(", ") || "none (switched off)"}.` : ""),
    };
  },
};

export const sandboxValidate: CommandSpec = {
  name: "sandbox validate",
  summary: "Run the Sandbox's readiness checks on its runner; exit 3 when one fails.",
  description: "Needs sandboxes.manage. A Sandbox that is not ready refuses loops and seeds.",
  readOnly: false,
  idempotent: true,
  mcpTool: "sandbox_validate",
  positionals: [{ name: "sandbox", description: "Sandbox name or id.", required: true }],
  examples: ["cavelon sandbox validate orders-test"],
  async run(ctx, input) {
    const sandbox = await resolveSandbox(ctx, positional(input, "sandbox")!);
    const result = await callStable<Sandbox>(ctx, "POST", "/api/v1/sandboxes/{sandbox_id}/validate", "validating Sandboxes", {
      params: { sandbox_id: [sandbox.id], "if-match": [`"${sandbox.config_version}"`] },
      timeoutMs: 90_000,
    });
    const checks = result.readiness?.checks ?? [];
    const passed = result.readiness?.passed === true;
    const failed = checks.filter((c) => !c.passed);
    return {
      data: { ...sandboxView(result), checks },
      text:
        `Sandbox "${result.name}" (${result.execution_mode}): ${passed ? "ready" : "not ready (" + result.lifecycle_state + ")"}` +
        (failed.length ? `\n${table(failed.map((c) => ({ check: c.name, reason: c.reason ?? "" })), ["check", "reason"])}` : ""),
      exitCode: passed ? ExitCode.ok : ExitCode.validation,
    };
  },
};

interface FilesPage {
  entries: Array<{ path: string; kind: string; size: number }>;
  next_cursor: string | null;
  workspace_revision: string;
}

export const sandboxFiles: CommandSpec = {
  name: "sandbox files",
  summary: "List a folder of the Sandbox's workspace.",
  readOnly: true,
  idempotent: true,
  mcpTool: "sandbox_files",
  positionals: [
    { name: "sandbox", description: "Sandbox name or id.", required: true },
    { name: "path", description: "Folder in the workspace (default: its root)." },
  ],
  options: { harness: HARNESS_OPTION, limit: { ...LIMIT_OPTION, description: "Return at most n entries (at most 100)." }, cursor: CURSOR_OPTION },
  examples: ["cavelon sandbox files orders-test", "cavelon sandbox files orders-test output --json"],
  async run(ctx, input) {
    const sandbox = await resolveSandbox(ctx, positional(input, "sandbox")!);
    const harness = await harnessFor(ctx, input, sandbox);
    const folder = positional(input, "path") ?? ".";
    const limit = intOption(input, "limit", { min: 1, max: 100, fallback: 50 })!;
    const page = await callStable<FilesPage>(ctx, "GET", "/api/v1/sandboxes/{sandbox_id}/files", "Sandbox files", {
      params: { sandbox_id: [sandbox.id] },
      query: { harness_id: harness, path: folder, limit, cursor: stringOption(input, "cursor") },
    });
    return {
      data: { sandbox: sandbox.name, path: folder, workspace_revision: page.workspace_revision, entries: page.entries, next_cursor: page.next_cursor },
      text:
        `${sandbox.name}:${folder}  (${page.workspace_revision})\n` +
        (table(page.entries, ["kind", "size", "path"], 120) || "Empty.") +
        moreHint(page.next_cursor, cavelonCommand("sandbox", "files", sandbox.name, folder)),
    };
  },
};

interface ContentPage {
  content: string;
  encoding: "base64" | "utf-8";
  offset: number;
  next_offset: number | null;
  size: number;
  digest: string | null;
  workspace_revision: string;
}

export const sandboxCat: CommandSpec = {
  name: "sandbox cat",
  summary: "Print a file of the Sandbox's workspace, a page at a time.",
  description: "At most 32 KiB per call; --offset reads on. --base64 for a binary file.",
  readOnly: true,
  idempotent: true,
  mcpTool: "sandbox_cat",
  positionals: [
    { name: "sandbox", description: "Sandbox name or id.", required: true },
    { name: "path", description: "File in the workspace.", required: true },
  ],
  options: {
    harness: HARNESS_OPTION,
    offset: { type: "string", value: "<bytes>", description: "Start at this byte." },
    length: { type: "string", value: "<bytes>", description: "Read at most this many bytes (at most 32768)." },
    base64: { type: "boolean", description: "Return the bytes as base64." },
  },
  examples: ["cavelon sandbox cat orders-test output/summary.json", "cavelon sandbox cat orders-test data.bin --base64 --json"],
  async run(ctx, input) {
    const sandbox = await resolveSandbox(ctx, positional(input, "sandbox")!);
    const harness = await harnessFor(ctx, input, sandbox);
    const file = positional(input, "path")!;
    const page = await callStable<ContentPage>(ctx, "GET", "/api/v1/sandboxes/{sandbox_id}/files/content", "Sandbox file content", {
      params: { sandbox_id: [sandbox.id] },
      query: {
        harness_id: harness,
        path: file,
        offset: intOption(input, "offset", { min: 0 }),
        length: intOption(input, "length", { min: 1, max: 32768 }),
        encoding: boolOption(input, "base64") ? "base64" : "utf-8",
      },
    });
    if (page.next_offset !== null && !ctx.json && ctx.mode === "cli") {
      ctx.io.stderr.write(`Bytes ${page.offset}–${page.next_offset} of ${page.size}. Read on: ${cavelonCommand("sandbox", "cat", sandbox.name, file, "--offset", String(page.next_offset))}\n`);
    }
    return {
      data: { sandbox: sandbox.name, path: file, ...page },
      text: page.content,
    };
  },
};

interface ActivityEntry {
  id: string;
  owner_run_id: string;
  child_run_id: string | null;
  action: string;
  kind: string;
  status: string;
  workspace_revision: string | null;
  can_cancel: boolean;
  artifact?: { artifact_id: string; status: string } | null;
  created_at: string;
  operation_id: string;
}

export const sandboxActivity: CommandSpec = {
  name: "sandbox activity",
  summary: "What ran in the Sandbox for a solution: commands, transfers, validations; or one of them.",
  readOnly: true,
  idempotent: true,
  mcpTool: "sandbox_activity",
  positionals: [
    { name: "sandbox", description: "Sandbox name or id.", required: true },
    { name: "activity", description: "One activity's id, for its detail." },
  ],
  options: { harness: HARNESS_OPTION, limit: { ...LIMIT_OPTION, description: "Return at most n entries (at most 100)." }, cursor: CURSOR_OPTION },
  examples: ["cavelon sandbox activity orders-test", "cavelon sandbox activity orders-test <activity_id> --json"],
  async run(ctx, input) {
    const sandbox = await resolveSandbox(ctx, positional(input, "sandbox")!);
    const harness = await harnessFor(ctx, input, sandbox);
    const one = positional(input, "activity");
    const view = (e: ActivityEntry) => ({
      activity_id: e.id,
      action: e.action,
      kind: e.kind,
      status: e.status,
      revision: e.workspace_revision,
      run_id: e.child_run_id ?? e.owner_run_id,
      artifact: e.artifact?.artifact_id ?? null,
      created_at: e.created_at,
      operation_id: e.operation_id,
    });
    if (one) {
      const detail = await callStable<{ operation: ActivityEntry }>(ctx, "GET", "/api/v1/sandboxes/{sandbox_id}/activity/{operation_link_id}", "Sandbox activity", {
        params: { sandbox_id: [sandbox.id], operation_link_id: [one] },
        query: { harness_id: harness },
      });
      const entry = view(detail.operation);
      const more = [`Logs: ${cavelonCommand("sandbox", "logs", sandbox.name, one)}`];
      if (MODES[sandbox.execution_mode]?.offers.includes("receipt")) more.push(`Receipt: ${cavelonCommand("sandbox", "receipt", sandbox.name, one)}`);
      return { data: entry, text: `${keyValues(Object.entries(entry))}\n\n${more.join("\n")}` };
    }
    const after = stringOption(input, "cursor");
    const page = await callStable<{ entries: ActivityEntry[]; next_cursor: string | null }>(ctx, "GET", "/api/v1/sandboxes/{sandbox_id}/activity", "Sandbox activity", {
      params: { sandbox_id: [sandbox.id] },
      query: { harness_id: harness, limit: intOption(input, "limit", { min: 1, max: 100, fallback: 50 }), after },
    });
    const items = page.entries.map(view);
    return {
      data: { sandbox: sandbox.name, items, next_cursor: page.next_cursor },
      text: (table(items, ["activity_id", "action", "status", "created_at"]) || "No activity.") + moreHint(page.next_cursor, cavelonCommand("sandbox", "activity", sandbox.name)),
    };
  },
};

interface LogsPage {
  content_base64: string;
  snapshot_digest: string;
  offset: number;
  next_offset: number | null;
  size_bytes: number;
  page_truncated: boolean;
}

export const sandboxLogs: CommandSpec = {
  name: "sandbox logs",
  summary: "One activity's log output, a page at a time.",
  description: "The runner keeps a bounded tail; the next page needs the same --snapshot, which each page prints.",
  readOnly: true,
  idempotent: true,
  mcpTool: "sandbox_logs",
  positionals: [
    { name: "sandbox", description: "Sandbox name or id.", required: true },
    { name: "activity", description: "The activity id (from `sandbox activity`).", required: true },
  ],
  options: {
    harness: HARNESS_OPTION,
    offset: { type: "string", value: "<bytes>", description: "Start at this byte." },
    length: { type: "string", value: "<bytes>", description: "Read at most this many bytes (at most 32768)." },
    snapshot: { type: "string", value: "<digest>", description: "The snapshot digest of the first page, to read on." },
  },
  examples: ["cavelon sandbox logs orders-test <activity_id>"],
  async run(ctx, input) {
    const sandbox = await resolveSandbox(ctx, positional(input, "sandbox")!);
    const harness = await harnessFor(ctx, input, sandbox);
    const activity = positional(input, "activity")!;
    const page = await callStable<LogsPage>(ctx, "GET", "/api/v1/sandboxes/{sandbox_id}/activity/{operation_link_id}/logs", "Sandbox logs", {
      params: { sandbox_id: [sandbox.id], operation_link_id: [activity] },
      query: {
        harness_id: harness,
        offset: intOption(input, "offset", { min: 0 }),
        length: intOption(input, "length", { min: 1, max: 32768 }),
        snapshot_digest: stringOption(input, "snapshot"),
      },
    });
    const text = Buffer.from(page.content_base64, "base64").toString("utf8");
    const next =
      page.next_offset === null
        ? null
        : cavelonCommand("sandbox", "logs", sandbox.name, activity, "--offset", String(page.next_offset), "--snapshot", page.snapshot_digest);
    if (next && !ctx.json && ctx.mode === "cli") ctx.io.stderr.write(`Bytes ${page.offset}–${page.next_offset} of ${page.size_bytes}. Read on: ${next}\n`);
    return {
      data: { sandbox: sandbox.name, activity_id: activity, text, offset: page.offset, next_offset: page.next_offset, size_bytes: page.size_bytes, snapshot_digest: page.snapshot_digest, next },
      text,
    };
  },
};

export const sandboxReceipt: CommandSpec = {
  name: "sandbox receipt",
  summary: "The runner's validation receipt of one activity (isolated container only).",
  description: "A trusted receipt exists only on an isolated container; a customer VM reports agent_reported completion.",
  readOnly: true,
  idempotent: true,
  mcpTool: "sandbox_receipt",
  positionals: [
    { name: "sandbox", description: "Sandbox name or id.", required: true },
    { name: "activity", description: "The activity id (from `sandbox activity`).", required: true },
  ],
  options: { harness: HARNESS_OPTION },
  examples: ["cavelon sandbox receipt orders-test <activity_id> --json"],
  async run(ctx, input) {
    const sandbox = await resolveSandbox(ctx, positional(input, "sandbox")!);
    requireOffer(ctx, sandbox, "receipt", "sandbox receipt");
    const harness = await harnessFor(ctx, input, sandbox);
    const activity = positional(input, "activity")!;
    const result = await callStable<{ receipt: Record<string, unknown> }>(ctx, "GET", "/api/v1/sandboxes/{sandbox_id}/activity/{operation_link_id}/receipt", "Sandbox receipts", {
      params: { sandbox_id: [sandbox.id], operation_link_id: [activity] },
      query: { harness_id: harness },
    });
    const text = JSON.stringify(result.receipt, null, 2);
    return { data: { sandbox: sandbox.name, activity_id: activity, receipt: result.receipt }, text: clip(text, 20_000) };
  },
};

// ---------------------------------------------------------------------------
// Change: refresh, seed, export
// ---------------------------------------------------------------------------

export const sandboxRefresh: CommandSpec = {
  name: "sandbox refresh",
  summary: "Accept a customer VM's workspace as it is now, after files were put on the VM (customer VM only).",
  description: "Edits on the VM outside Cavelon are legitimate; refresh makes the current files the new baseline revision.",
  readOnly: false,
  idempotent: true,
  mcpTool: "sandbox_refresh",
  positionals: [{ name: "sandbox", description: "Sandbox name or id.", required: true }],
  options: { "idempotency-key": UUID_KEY_OPTION },
  examples: ["cavelon sandbox refresh spec-vm"],
  async run(ctx, input) {
    const sandbox = await resolveSandbox(ctx, positional(input, "sandbox")!);
    requireOffer(ctx, sandbox, "refresh", "sandbox refresh");
    const result = await callStable<Sandbox>(ctx, "POST", "/api/v1/sandboxes/{sandbox_id}/refresh-workspace", "refreshing Sandboxes", {
      params: { sandbox_id: [sandbox.id], "idempotency-key": [idempotencyKey(input)], "if-match": [`"${sandbox.config_version}"`] },
      timeoutMs: 90_000,
    });
    return {
      data: { ...sandboxView(result), previous_revision: sandbox.observed_revision },
      text: `Sandbox "${result.name}": baseline ${sandbox.observed_revision ?? "none"} → ${result.observed_revision ?? "none"} (${result.lifecycle_state}).`,
    };
  },
};

/** The workspace's current revision: as the caller says, as a listing reads it, or as the instance last saw it. */
async function currentRevision(ctx: Context, input: Input, sandbox: Sandbox, harness: string): Promise<string> {
  const given = stringOption(input, "revision");
  if (given !== undefined) {
    if (!/^revision-\d{1,16}$/.test(given)) throw usageError(`--revision must look like revision-12, got "${given}".`);
    return given;
  }
  try {
    const page = await callStable<FilesPage>(ctx, "GET", "/api/v1/sandboxes/{sandbox_id}/files", "Sandbox files", {
      params: { sandbox_id: [sandbox.id] },
      query: { harness_id: harness, path: ".", limit: 1 },
    });
    return page.workspace_revision;
  } catch (error) {
    if (!(error instanceof CavelonError) || error.status === undefined || error.status >= 500 || !sandbox.observed_revision) throw error;
    ctx.warn(`Could not read the workspace (${error.code}); using the revision the instance last saw, ${sandbox.observed_revision}.`);
    return sandbox.observed_revision;
  }
}

/** The largest archive the instance's OpenAPI accepts, or 64 MiB when it does not say. */
async function maxArchiveBytes(ctx: Context): Promise<number> {
  const fallback = 64 * 1024 * 1024;
  try {
    const doc: OpenApiDoc = await (await ctx.contracts()).openapi();
    const schema = (doc.components?.schemas as Record<string, { properties?: Record<string, { anyOf?: Array<{ maximum?: number }> ; maximum?: number }> }> | undefined)?.SandboxArtifactJobCreate;
    const size = schema?.properties?.size_bytes;
    const max = size?.maximum ?? size?.anyOf?.find((s) => typeof s.maximum === "number")?.maximum;
    return typeof max === "number" ? max : fallback;
  } catch {
    return fallback;
  }
}

const JOB_ROUTE = "/api/v1/sandboxes/{sandbox_id}/artifact-jobs/{job_id}";

async function getJob(ctx: Context, sandboxId: string, jobId: string): Promise<ArchiveJob> {
  return callStable<ArchiveJob>(ctx, "GET", JOB_ROUTE, "archive jobs", { params: { sandbox_id: [sandboxId], job_id: [jobId] } });
}

function jobFailed(job: ArchiveJob): CavelonError {
  return new CavelonError(ExitCode.failure, {
    code: job.error_code ?? "sandbox_artifact_job_failed",
    message: `Archive job ${job.id} ${job.status}${job.error_code ? ": " + job.error_code : ""}.`,
    hint: job.error_code ? `\`cavelon explain ${job.error_code}\` says what it means.` : undefined,
  });
}

const UPLOAD_READY_MS = 30_000;

/** The same seed with --confirm: the Sandbox, the source and the solution it named. */
function seedCommand(sandbox: Sandbox, input: Input): string {
  const harness = stringOption(input, "harness");
  return cavelonCommand("sandbox", "seed", sandbox.name, positional(input, "source")!, ...(harness ? ["--harness", harness] : []), "--confirm");
}

export const sandboxSeed: CommandSpec = {
  name: "sandbox seed",
  summary: "Replace an isolated container's workspace with a folder or tar archive (needs --confirm).",
  description:
    "Isolated container only; on a customer VM, put the files on the VM and run `sandbox refresh`. The folder is sent as an\n" +
    "uncompressed tar (files and folders only); a .tar is sent as it is; any other file lands under its own name. The archive\n" +
    "becomes the workspace. Without --confirm, shows what would be sent. Running the same seed again resumes it.",
  readOnly: false,
  destructive: true,
  idempotent: true,
  mcpTool: "sandbox_seed",
  positionals: [
    { name: "sandbox", description: "Sandbox name or id.", required: true },
    { name: "source", description: "A folder, an uncompressed .tar, or one file.", required: true },
  ],
  options: {
    harness: HARNESS_OPTION,
    revision: REVISION_OPTION,
    confirm: { type: "boolean", description: "Send it; without it nothing changes." },
    wait: WAIT_OPTION,
    timeout: TIMEOUT_OPTION,
    "idempotency-key": UUID_KEY_OPTION,
  },
  examples: ["cavelon sandbox seed orders-test seeds/orders", "cavelon sandbox seed orders-test seeds/orders --confirm --wait"],
  async run(ctx, input) {
    const sandbox = await resolveSandbox(ctx, positional(input, "sandbox")!);
    requireOffer(ctx, sandbox, "archive", "sandbox seed");
    const source = path.resolve(ctx.io.cwd, positional(input, "source")!);
    const archive = await archiveFrom(source, await maxArchiveBytes(ctx));
    const harness = await harnessFor(ctx, input, sandbox);
    const revision = await currentRevision(ctx, input, sandbox, harness);
    const summary = {
      sandbox: sandbox.name,
      sandbox_id: sandbox.id,
      mode: sandbox.execution_mode,
      harness_id: harness,
      revision,
      archive: { from: archive.from, sha256: archive.sha256, size_bytes: archive.bytes.length, ...(archive.files >= 0 ? { files: archive.files, folders: archive.directories } : {}) },
    };
    if (sandbox.lifecycle_state !== "ready") ctx.warn(`Sandbox "${sandbox.name}" is ${sandbox.lifecycle_state}; the instance accepts a seed only when it is ready (\`cavelon sandbox validate\`).`);
    if (sandbox.writer_owner_run_id) ctx.warn(`Run ${sandbox.writer_owner_run_id} holds the Sandbox's writer; the instance refuses a seed until it ends.`);
    const what = archive.files >= 0 ? `${archive.files} files in ${archive.directories} folders` : "the tar archive";
    if (!boolOption(input, "confirm")) {
      const confirm = seedCommand(sandbox, input);
      return {
        data: { ...summary, seeded: false, confirm },
        text:
          `Would replace the workspace of "${sandbox.name}" (${revision}) with ${what}, ${archive.bytes.length} bytes, sha256 ${archive.sha256}.\n` +
          `Nothing was sent. Seed it with: ${confirm}`,
      };
    }
    const key = stringOption(input, "idempotency-key") !== undefined ? idempotencyKey(input) : stableKey(`seed:${sandbox.id}:${revision}:${archive.sha256}`);
    let job = await callStable<ArchiveJob>(ctx, "POST", "/api/v1/sandboxes/{sandbox_id}/artifact-jobs", "archive jobs", {
      params: { sandbox_id: [sandbox.id], "idempotency-key": [key] },
      body: { harness_id: harness, direction: "import", expected_workspace_revision: revision, sha256: archive.sha256, size_bytes: archive.bytes.length },
    });
    // The job takes the workspace first; the bytes go up once it waits for them.
    const until = Date.now() + UPLOAD_READY_MS;
    while (job.status === "active" && job.phase !== "awaiting_upload" && ["acquire", "operation"].includes(job.phase) && Date.now() < until) {
      await ctx.io.sleep(Math.min(1000, Math.max(0, until - Date.now())));
      job = await getJob(ctx, sandbox.id, job.id);
    }
    if (job.status === "failed" || job.status === "cancelled") throw jobFailed(job);
    const resume = seedCommand(sandbox, input);
    if (job.status === "active" && job.phase === "awaiting_upload") {
      job = await upload(ctx, sandbox.id, job.id, archive.bytes);
    } else if (job.status === "active" && ["acquire", "operation"].includes(job.phase)) {
      return {
        data: { ...summary, seeded: false, job_id: job.id, phase: job.phase, operation_id: job.operation_id, resume },
        text: `Job ${job.id} is still taking the workspace (${job.phase}). Run the same seed again to send the archive: ${resume}`,
        exitCode: ExitCode.timeout,
      };
    }
    const result = { ...summary, seeded: true, job_id: job.id, phase: job.phase, operation_id: job.operation_id };
    if (boolOption(input, "wait") && ctx.mode === "cli") {
      const waited = await waitAndReport(ctx, [job.operation_id], timeoutMs(ctx, stringOption(input, "timeout")));
      return { data: { ...result, ...waited.data }, text: `Sent ${what} to "${sandbox.name}".\n${waited.text}`, exitCode: waited.exitCode };
    }
    return {
      data: result,
      text: `Sent ${what} to "${sandbox.name}"; the import runs on the instance.\nWait with: cavelon wait ${job.operation_id}`,
    };
  },
};

/** PUT the exact bytes the job declared, raw (`application/octet-stream`), not JSON. */
async function upload(ctx: Context, sandboxId: string, jobId: string, bytes: Uint8Array): Promise<ArchiveJob> {
  const client = await ctx.client();
  const { op } = await workflowOperation(ctx, "PUT", `${JOB_ROUTE}/content`, "archive uploads");
  const { path: target } = buildRequest(op, { params: { sandbox_id: [sandboxId], job_id: [jobId] }, bytes });
  const response = await client.fetchRaw("PUT", target, {
    bytes,
    headers: { "Content-Type": "application/octet-stream" },
    signal: AbortSignal.timeout(Number(ctx.io.env.CAVELON_HTTP_TIMEOUT_MS) || 120_000),
  });
  const text = await response.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON; the refusal takes the text
  }
  if (!response.ok) throw await client.refusal(response.status, data, `PUT ${target}`, response.headers);
  return data as ArchiveJob;
}

/** The export's tar into a file of the caller's choosing, or sandbox-<job>.tar; never over an existing file. */
async function download(ctx: Context, sandbox: Sandbox, job: ArchiveJob, out: string | undefined) {
  if (!isUuid(job.id)) throw new CavelonError(ExitCode.failure, { code: "invalid_job_id", message: `The instance returned an unexpected job id.` });
  const file = path.resolve(ctx.io.cwd, out ?? `sandbox-${job.id}.tar`);
  const client = await ctx.client();
  const { op } = await workflowOperation(ctx, "GET", `${JOB_ROUTE}/content`, "archive downloads");
  const { path: target } = buildRequest(op, { params: { sandbox_id: [sandbox.id], job_id: [job.id] } });
  const response = await client.fetchRaw("GET", target, {
    accept: "application/x-tar",
    signal: AbortSignal.timeout(Number(ctx.io.env.CAVELON_HTTP_TIMEOUT_MS) || 120_000),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    const text = new TextDecoder().decode(bytes);
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // not JSON
    }
    throw await client.refusal(response.status, data, `GET ${target}`, response.headers);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const declared = response.headers.get("x-content-sha256");
  if (declared && declared.toLowerCase() !== sha256) {
    throw new CavelonError(ExitCode.server, {
      code: "sandbox_artifact_digest_mismatch",
      message: `The export arrived with sha256 ${sha256}, but the instance declared ${declared}; nothing was written.`,
      hint: "Download it again.",
    });
  }
  try {
    await fs.writeFile(file, bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CavelonError(ExitCode.conflict, {
        code: "file_exists",
        message: `${file} exists; cavelon does not overwrite it.`,
        hint: `Choose another file with --out, then: ${cavelonCommand("artifacts", "export", sandbox.name, "--job", job.id, "--out")} <file>`,
      });
    }
    throw error;
  }
  return { file: path.relative(ctx.io.cwd, file) || file, size_bytes: bytes.length, sha256 };
}

export const artifactsExport: CommandSpec = {
  name: "artifacts export",
  summary: "Take files out of an isolated container as a tar archive (isolated container only).",
  description:
    "Starts an export job and returns its operation id; with --wait (or later with --job <id>) the tar is written to --out\n" +
    "(default sandbox-<job>.tar), never over an existing file. On a customer VM, read results with `sandbox cat`.",
  readOnly: false,
  mcpTool: "artifacts_export",
  positionals: [{ name: "sandbox", description: "Sandbox name or id.", required: true }],
  options: {
    path: { type: "string", multiple: true, value: "<path>", description: "Export only these workspace paths (repeatable; default: all)." },
    out: { type: "string", value: "<file>", description: "Where to write the tar (default: sandbox-<job>.tar)." },
    job: { type: "string", value: "<job_id>", description: "Download a job started earlier, instead of starting one." },
    harness: HARNESS_OPTION,
    revision: REVISION_OPTION,
    wait: WAIT_OPTION,
    timeout: TIMEOUT_OPTION,
    "idempotency-key": UUID_KEY_OPTION,
  },
  examples: ["cavelon artifacts export orders-test --path output --wait", "cavelon artifacts export orders-test --job <job_id> --out results.tar"],
  async run(ctx, input) {
    const sandbox = await resolveSandbox(ctx, positional(input, "sandbox")!);
    requireOffer(ctx, sandbox, "archive", "artifacts export");
    const out = stringOption(input, "out");
    const jobRef = stringOption(input, "job");
    let job: ArchiveJob;
    if (jobRef) {
      if (!isUuid(jobRef)) throw usageError(`--job "${jobRef}" is not a job id.`);
      job = await getJob(ctx, sandbox.id, jobRef);
      if (job.direction !== "export") throw usageError(`Job ${job.id} is an ${job.direction}, not an export.`);
    } else {
      const harness = await harnessFor(ctx, input, sandbox);
      const revision = await currentRevision(ctx, input, sandbox, harness);
      const paths = listOption(input, "path");
      job = await callStable<ArchiveJob>(ctx, "POST", "/api/v1/sandboxes/{sandbox_id}/artifact-jobs", "archive jobs", {
        params: { sandbox_id: [sandbox.id], "idempotency-key": [idempotencyKey(input)] },
        body: { harness_id: harness, direction: "export", expected_workspace_revision: revision, ...(paths.length ? { paths } : {}) },
      });
    }
    const later = cavelonCommand("artifacts", "export", sandbox.name, "--job", job.id, ...(out ? ["--out", out] : []));
    const base = { sandbox: sandbox.name, job_id: job.id, operation_id: job.operation_id };
    if (job.status === "active" || job.status === "cancelling") {
      if (!(boolOption(input, "wait") && ctx.mode === "cli")) {
        return {
          data: { ...base, status: job.status, phase: job.phase, download: later },
          text: `Export job ${job.id} is ${job.phase}.\nWait with: cavelon wait ${job.operation_id}\nThen download: ${later}`,
          exitCode: jobRef ? ExitCode.timeout : ExitCode.ok,
        };
      }
      const waited = await waitAndReport(ctx, [job.operation_id], timeoutMs(ctx, stringOption(input, "timeout")));
      job = await getJob(ctx, sandbox.id, job.id);
      if (job.status !== "succeeded") {
        if (job.status === "failed" || job.status === "cancelled") throw jobFailed(job);
        return { data: { ...base, ...waited.data, download: later }, text: `${waited.text}\nThen download: ${later}`, exitCode: waited.exitCode };
      }
    }
    if (job.status !== "succeeded") throw jobFailed(job);
    const written = await download(ctx, sandbox, job, out);
    return {
      data: { ...base, status: job.status, ...written },
      text: `Wrote ${written.file} (${written.size_bytes} bytes, sha256 ${written.sha256}).`,
    };
  },
};
