import { accessFor, operationAccess, whoInstead } from "../access.js";
import { positional, stringOption, type CommandSpec, type Context, type Input } from "../command.js";
import { confirmation, confirmTokenRequired, PERSON_CONFIRMS_HELP, type Confirmation } from "../confirm-token.js";
import { CavelonError, ExitCode, usageError } from "../errors.js";
import { clip, keyValues, table } from "../format.js";
import { harnessNotFoundError, lookupHarness, type HarnessSummary } from "../harness-ref.js";
import { callOperation, workflowOperation } from "../invoke.js";
import { canonical } from "../package-files.js";
import { cavelonCommand } from "../printed.js";

const BASE = "/api/v1/harnesses/{harness_id}";
const READ = `${BASE}/publication`;
interface Publication {
  published_version: number;
  draft_revision: number;
  has_draft: boolean;
  draft_change_count: number;
  changes: Array<{ entity: string; id: string; name: string; action: string }>;
  readiness: { ready_to_activate?: boolean | null; blockers: unknown[]; warnings?: unknown[]; checks?: unknown[] };
  review_run_ids: string[];
  waiting_runs_affected: number;
  waiting_runs: Array<{ id: string; node_ref: { kind: string; id: string }; node_name: string }>;
  published_snapshots: Array<{ id: string; version: number; label: string; created_at: string }>;
  activation_override: unknown;
  can_rollback: boolean;
}
const harnessOption = { type: "string" as const, value: "<harness>", description: "Solution name, slug or id; default: selected environment or cavelon.yaml." };
const envOption = { type: "string" as const, value: "<name>", description: "Use env/<name>.yaml's tenant and solution." };
const confirmOption = { type: "boolean" as const, mcpToken: true, description: "After review, ask the person to confirm exactly this change." };

async function target(ctx: Context, input: Input) {
  const session = await ctx.session();
  const ref = stringOption(input, "harness") ?? positional(input, "solution") ?? session.envFile?.harness ?? session.project?.harness;
  if (!ref) throw usageError("Which solution?", "Pass --harness <name-or-id>, or select one in cavelon.yaml or the environment.");
  const { harness, candidates } = await lookupHarness(ctx, ref);
  if (!harness) throw harnessNotFoundError(ref, candidates);
  return harness;
}

/** New lifecycle routes require a published contract; older instances keep their existing behavior. */
async function operation(ctx: Context, route: string, method = "GET") {
  const result = await workflowOperation(ctx, method, route, "solution publication");
  if (!result.doc) throw new CavelonError(ExitCode.failure, { code: "operation_unavailable", message: "This instance does not publish a solution-publication contract." });
  return result;
}
async function read(ctx: Context, id: string, snapshot?: string): Promise<Publication> {
  const { doc, op } = await operation(ctx, READ);
  const result = await callOperation(ctx, await ctx.client(), doc, op, { params: { harness_id: [id], ...(snapshot ? { snapshot_id: [snapshot] } : {}) } });
  const p = result.data as Publication | null;
  if (!p || !Number.isSafeInteger(p.published_version) || p.published_version < 0 || !Number.isSafeInteger(p.draft_revision) || p.draft_revision < 0 || typeof p.has_draft !== "boolean" || !Array.isArray(p.changes) || !Array.isArray(p.readiness?.blockers) || [p.readiness.warnings, p.readiness.checks].some(value => value !== undefined && !Array.isArray(value)) || !Number.isSafeInteger(p.waiting_runs_affected) || p.waiting_runs_affected < 0 || !Array.isArray(p.review_run_ids) || p.review_run_ids.some(id => typeof id !== "string") || !Array.isArray(p.waiting_runs) || !Array.isArray(p.published_snapshots) || typeof p.can_rollback !== "boolean") {
    throw new CavelonError(ExitCode.failure, { code: "publication_state_unknown", message: "The instance did not describe a complete publication state; nothing was changed.", hint: "Read the solution's publication state in the Admin or update the instance." });
  }
  return p;
}
function findingsText(label: string, findings: unknown[] | undefined): string {
  if (!findings?.length) return "";
  const lines = findings.slice(0, 20).map(finding => {
    if (finding && typeof finding === "object") {
      const f = finding as Record<string, unknown>;
      if (typeof f.label === "string" && typeof f.state === "string" && typeof f.detail === "string") {
        return clip(`${f.label} (${f.state}): ${f.detail}${Array.isArray(f.items) && f.items.length ? ` ${JSON.stringify(f.items)}` : ""}`, 500);
      }
    }
    return clip(JSON.stringify(finding), 500);
  });
  if (findings.length > 20) lines.push(`${findings.length - 20} more findings; read --json for the full review before approving.`);
  return `\n\n${label}:\n${lines.join("\n")}`;
}
function stateText(p: Publication): string {
  return keyValues([
    ["published", `v${p.published_version}`],
    ["draft", p.has_draft ? `${p.draft_change_count} unpublished changes (revision ${p.draft_revision})` : "none"],
    ["readiness blockers", p.readiness.blockers.length],
    ["readiness warnings", p.readiness.warnings?.length ?? "not reported"],
    ["waiting runs affected", p.waiting_runs_affected],
  ]) + findingsText("Blockers", p.readiness.blockers) + findingsText("Warnings", p.readiness.warnings) + findingsText("Readiness checks", p.readiness.checks) + (p.waiting_runs.length ? `\n\nWaiting runs:\n${table(p.waiting_runs.slice(0, 20), ["id", "node_name"])}` : "") + (p.changes.length ? `\n\n${table(p.changes.slice(0, 50), ["entity", "name", "action", "id"])}` : "") + (p.changes.length > 50 ? `\n${p.changes.length - 50} more changes; --json includes all.` : "");
}

/** Readiness can change without a graph edit, for example when a new test finishes. */
function readinessReview(p: Publication) {
  const sorted = (values: unknown[] | undefined) => values ? [...values].sort((a, b) => canonical(a).localeCompare(canonical(b))) : null;
  return { ready_to_activate: p.readiness.ready_to_activate ?? null, blockers: sorted(p.readiness.blockers), warnings: sorted(p.readiness.warnings), checks: sorted(p.readiness.checks) };
}

function publishRisks(p: Publication): string {
  return [
    "Publishing risks:",
    "New live requests will use the reviewed draft; this is not a test run.",
    ...(p.waiting_runs_affected ? [`The instance reports ${p.waiting_runs_affected} affected waiting runs; review the listed runs.`] : []),
    ...(p.readiness.warnings?.length ? ["Readiness warnings remain. Publish only if you accept the warnings shown above."] : []),
  ].join("\n");
}

export const publication: CommandSpec = {
  name: "harness publication",
  summary: "Read published version, pending draft, readiness, waiting runs and rollback snapshots.",
  readOnly: true, idempotent: true, mcpTool: "harness_publication", operations: [`GET ${READ}`],
  positionals: [{ name: "solution", description: "Solution name, slug or id; default: environment or cavelon.yaml." }],
  options: { env: envOption },
  async run(ctx, input) {
    const harness = await target(ctx, input); const p = await read(ctx, harness.id);
    return { data: { harness, ...p }, text: `${harness.name} (${harness.slug})\n${stateText(p)}` };
  },
};

type Action = "publish" | "discard-draft" | "rollback";
type Snapshot = Publication["published_snapshots"][number];
const ACTIONS = {
  publish: { words: ["publish"], tool: "solution_publish", summary: "Review and publish a solution's draft through its readiness gate." },
  "discard-draft": { words: ["harness", "discard-draft"], tool: "harness_discard_draft", summary: "Review and discard a solution's unpublished draft." },
  rollback: { words: ["harness", "rollback"], tool: "harness_rollback", summary: "Review and restore a pinned published version as a new publication." },
};

function earlierSnapshot(p: Publication, requested: string | undefined, harness: HarnessSummary): Snapshot {
  const snapshots = p.published_snapshots.filter(s => typeof s.id === "string" && s.id.length > 0 && Number.isSafeInteger(s.version) && s.version < p.published_version).sort((a, b) => b.version - a.version);
  const snapshot = requested ? snapshots.find(s => s.id === requested) : snapshots[0];
  if (!p.can_rollback || !snapshot) throw usageError("No earlier pinned published snapshot matches this rollback.", `Choose a snapshot id from ${cavelonCommand("harness", "publication", harness.slug, "--json")}.`);
  return snapshot;
}

function mutationBody(action: Action, p: Publication, snapshot?: Snapshot): Record<string, unknown> {
  const body: Record<string, unknown> = { expected_version: p.published_version, expected_draft_revision: p.draft_revision };
  if (snapshot) body.snapshot_id = snapshot.id;
  if (action !== "discard-draft") {
    body.confirm_affected_runs = p.waiting_runs_affected > 0;
    body.expected_waiting_run_ids = [...p.review_run_ids].sort((a, b) => a.localeCompare(b));
  }
  return body;
}

function reviewedChange(harnessId: string, action: Action, p: Publication, snapshot?: Snapshot) {
  const changes = [...p.changes].sort((a, b) => (a.entity + ":" + a.id).localeCompare(b.entity + ":" + b.id));
  const waiting = [...p.waiting_runs].sort((a, b) => a.id.localeCompare(b.id));
  return { harness: harnessId, body: mutationBody(action, p, snapshot), changes, waiting_runs: waiting, has_draft: p.has_draft, ...(action !== "discard-draft" ? { readiness: readinessReview(p), waiting_runs_affected: p.waiting_runs_affected } : {}) };
}

function commandWords(action: Action, input: Input, harness: HarnessSummary, snapshot?: Snapshot): string[] {
  const words = [...ACTIONS[action].words, "--harness", harness.slug];
  const env = stringOption(input, "env");
  if (env) words.push("--env", env);
  if (snapshot) words.push("--snapshot", snapshot.id);
  words.push("--confirm");
  return words;
}

function consequenceOf(action: Action, harness: HarnessSummary, p: Publication, snapshot?: Snapshot): string {
  if (action === "publish") return `Publish ${harness.name}'s reviewed draft to live traffic.`;
  if (action === "discard-draft") return `Discard ${harness.name}'s unpublished edits; the published graph stays in service.`;
  let message = `Restore published v${snapshot!.version} for ${harness.name} as a new live publication.`;
  if (p.has_draft) message += " Unpublished edits will be saved in a pinned recovery snapshot and the working draft cleared.";
  return message;
}

async function checkMutationAccess(ctx: Context, action: Action) {
  const access = await accessFor(await ctx.client());
  if (action !== "discard-draft" && access?.principal.token?.may_activate === false) {
    throw new CavelonError(ExitCode.unauthorized, { code: "token_activation_refused", message: "This personal access token does not allow activation, publication or rollback.", hint: "A person performs it in the Admin or creates an appropriately scoped token with May activate." });
  }
  const permission = operationAccess(access, `POST ${BASE}/${action}`);
  if (permission.allowed === false) throw new CavelonError(ExitCode.unauthorized, { code: "permission_missing", message: "This credential cannot perform the publication change; nothing was changed.", hint: whoInstead(access, permission) });
}

function previewResult(harness: HarnessSummary, p: Publication, gate: Confirmation, review: string, words: string[], snapshot?: Snapshot) {
  const confirm = gate.confirm(cavelonCommand(...words));
  return {
    data: { changed: false, harness, publication: p, ...(snapshot ? { rollback_snapshot: snapshot } : {}), confirm, ...gate.fields },
    text: [review, gate.where, ...(gate.mismatch ? [gate.mismatch] : []), `Show this to a person; with their yes: ${confirm}`].join("\n"),
    ...(gate.exitCode ? { exitCode: gate.exitCode } : {}),
  };
}

async function runChange(ctx: Context, input: Input, action: Action) {
  const tool = ACTIONS[action].tool;
  if (ctx.mode === "mcp" && input.options.confirm === true) throw confirmTokenRequired(tool);
  const harness = await target(ctx, input);
  let p = await read(ctx, harness.id);
  if (action !== "rollback" && !p.has_draft) return { data: { changed: false, harness, publication: p }, text: "No unpublished draft; nothing was changed." };
  if (action === "publish" && p.readiness.blockers.length) return { data: { changed: false, harness, publication: p, blockers: p.readiness.blockers }, text: `${stateText(p)}\n\nPublication is blocked. Fix the instance's readiness/Graph Check findings and review again.`, exitCode: ExitCode.validation };
  let snapshot: Snapshot | undefined;
  if (action === "rollback") {
    snapshot = earlierSnapshot(p, stringOption(input, "snapshot"), harness);
    p = await read(ctx, harness.id, snapshot.id);
  }
  const { doc, op } = await operation(ctx, `${BASE}/${action}`, "POST");
  await checkMutationAccess(ctx, action);
  const body = mutationBody(action, p, snapshot);
  const words = commandWords(action, input, harness, snapshot);
  const consequence = consequenceOf(action, harness, p, snapshot);
  const review = `${consequence}\n${stateText(p)}${action === "publish" ? `\n\n${publishRisks(p)}` : ""}`;
  const change = reviewedChange(harness.id, action, p, snapshot);
  const gate = await confirmation(ctx, input, tool, change, { person: { what: review, words, ...(action === "publish" ? { approval: { title: "Publish this solution", description: "I reviewed this draft, accept any remaining warnings and the effects on live traffic and affected waiting runs, and approve this publication." } } : {}) } });
  if (!gate.confirmed) return previewResult(harness, p, gate, review, words, snapshot);
  if (action === "publish" && ctx.mode === "mcp") {
    // A test or another editor can change the review while the person reads the form.
    const current = await read(ctx, harness.id);
    if (canonical(change) !== canonical(reviewedChange(harness.id, action, current))) {
      throw new CavelonError(ExitCode.conflict, { code: "publication_review_changed", message: "The publication review changed while awaiting approval; nothing was published.", hint: "Read the updated publication findings and request a fresh preview and personal approval." });
    }
  }
  const result = await callOperation(ctx, await ctx.client(), doc, op, { params: { harness_id: [harness.id] }, body });
  const data = result.data as Record<string, unknown>;
  const warnings = Array.isArray(data.warnings) ? data.warnings.map(w => clip(String(w), 500)) : [];
  return { data: { changed: true, harness, result: data }, text: [`${action} completed for ${harness.name}.`, ...warnings].join("\n") };
}

function changeCommand(action: Action): CommandSpec {
  const config = ACTIONS[action];
  return {
    name: config.words.join(" "), summary: config.summary,
    description: "Previews first. Publishing and rollback change live traffic; discarding removes unpublished work. Each needs a person's fresh confirmation, including in YOLO mode. No force option is offered.\n" + PERSON_CONFIRMS_HELP,
    readOnly: false, destructive: action === "discard-draft", mcpTool: config.tool,
    operations: [`GET ${READ}`, `POST ${BASE}/${action}`],
    options: { harness: harnessOption, env: envOption, confirm: confirmOption, ...(action === "rollback" ? { snapshot: { type: "string" as const, value: "<id>", description: "Pinned published snapshot id; default: the previous published version." } } : {}) },
    run: (ctx, input) => runChange(ctx, input, action),
  };
}
export const publish = changeCommand("publish");
export const discardDraft = changeCommand("discard-draft");
export const rollback = changeCommand("rollback");

/** Do not infer isolation from an active status alone; only the instance's explicit report establishes it. */
export function publicationNotice(value: unknown, live: string[] = []): string | undefined {
  const p = value as { target?: unknown; published_version?: unknown } | null;
  // Persona widget fields do not wait for a publication: saying live traffic stays on the published version would be wrong for them.
  const except = live.length ? ` Except ${live.join(", ")}: persona widget fields reach visitors at once, without a publication.` : "";
  if (p?.target === "draft") return `Unpublished draft; live traffic stays on published v${typeof p.published_version === "number" ? p.published_version : "?"}.${except} Review ${cavelonCommand("publish")} before putting ${live.length ? "the other" : "these"} edits live. Tenant-wide resources retain their existing behavior.`;
  if (p?.target === "published") return "Editable solution configuration; activation/publication follows the instance's lifecycle.";
  return undefined;
}
