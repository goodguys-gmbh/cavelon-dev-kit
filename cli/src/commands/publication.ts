import { accessFor, operationAccess, whoInstead } from "../access.js";
import { positional, stringOption, type CommandSpec, type Context, type Input } from "../command.js";
import { confirmation, confirmTokenRequired, PERSON_CONFIRMS_HELP } from "../confirm-token.js";
import { CavelonError, ExitCode, usageError } from "../errors.js";
import { clip, keyValues, table } from "../format.js";
import { harnessNotFoundError, lookupHarness } from "../harness-ref.js";
import { callOperation, workflowOperation } from "../invoke.js";
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
  if (!p || !Number.isSafeInteger(p.published_version) || p.published_version < 0 || !Number.isSafeInteger(p.draft_revision) || p.draft_revision < 0 || typeof p.has_draft !== "boolean" || !Array.isArray(p.changes) || !Array.isArray(p.readiness?.blockers) || !Number.isSafeInteger(p.waiting_runs_affected) || p.waiting_runs_affected < 0 || !Array.isArray(p.review_run_ids) || p.review_run_ids.some(id => typeof id !== "string") || !Array.isArray(p.waiting_runs) || !Array.isArray(p.published_snapshots) || typeof p.can_rollback !== "boolean") {
    throw new CavelonError(ExitCode.failure, { code: "publication_state_unknown", message: "The instance did not describe a complete publication state; nothing was changed.", hint: "Read the solution's publication state in the Admin or update the instance." });
  }
  return p;
}
function stateText(p: Publication): string {
  return keyValues([
    ["published", `v${p.published_version}`],
    ["draft", p.has_draft ? `${p.draft_change_count} unpublished changes (revision ${p.draft_revision})` : "none"],
    ["readiness blockers", p.readiness.blockers.length],
    ["waiting runs affected", p.waiting_runs_affected],
  ]) + (p.waiting_runs.length ? `\n\nWaiting runs:\n${table(p.waiting_runs.slice(0, 20), ["id", "node_name"])}` : "") + (p.readiness.blockers.length ? `\n\nBlockers:\n${p.readiness.blockers.slice(0, 20).map(b => clip(JSON.stringify(b), 500)).join("\n")}` : "") + (p.changes.length ? `\n\n${table(p.changes.slice(0, 50), ["entity", "name", "action", "id"])}` : "") + (p.changes.length > 50 ? `\n${p.changes.length - 50} more changes; --json includes all.` : "");
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
function changeCommand(action: Action): CommandSpec {
  const words = action === "publish" ? ["publish"] : ["harness", action];
  const tool = action === "publish" ? "solution_publish" : `harness_${action.replaceAll("-", "_")}`;
  return {
    name: words.join(" "),
    summary: action === "publish" ? "Review and publish a solution's draft through its readiness gate." : action === "rollback" ? "Review and restore a pinned published version as a new publication." : "Review and discard a solution's unpublished draft.",
    description: "Previews first. Publishing and rollback change live traffic; discarding removes unpublished work. Each needs a person's fresh confirmation, including in YOLO mode. No force option is offered.\n" + PERSON_CONFIRMS_HELP,
    readOnly: false, destructive: action === "discard-draft", mcpTool: tool, operations: [`GET ${READ}`, `POST ${BASE}/${action}`],
    options: { harness: harnessOption, env: envOption, confirm: confirmOption, ...(action === "rollback" ? { snapshot: { type: "string" as const, value: "<id>", description: "Pinned published snapshot id; default: the previous published version." } } : {}) },
    async run(ctx, input) {
      if (ctx.mode === "mcp" && input.options.confirm === true) throw confirmTokenRequired(tool);
      const harness = await target(ctx, input);
      let p = await read(ctx, harness.id);
      if (action !== "rollback" && !p.has_draft) return { data: { changed: false, harness, publication: p }, text: "No unpublished draft; nothing was changed." };
      if (action === "publish" && p.readiness.blockers.length) return { data: { changed: false, harness, publication: p, blockers: p.readiness.blockers }, text: `${stateText(p)}\n\nPublication is blocked. Fix the instance's readiness/Graph Check findings and review again.`, exitCode: ExitCode.validation };
      const requested = stringOption(input, "snapshot");
      const snapshots = p.published_snapshots.filter(s => typeof s.id === "string" && s.id.length > 0 && Number.isSafeInteger(s.version) && s.version < p.published_version).sort((a, b) => b.version - a.version);
      const snapshot = action === "rollback" ? requested ? snapshots.find(s => s.id === requested) : snapshots[0] : undefined;
      if (action === "rollback" && (!p.can_rollback || !snapshot)) throw usageError("No earlier pinned published snapshot matches this rollback.", `Choose a snapshot id from ${cavelonCommand("harness", "publication", harness.slug, "--json")}.`);
      if (snapshot) p = await read(ctx, harness.id, snapshot.id);
      const { doc, op } = await operation(ctx, `${BASE}/${action}`, "POST");
      const access = await accessFor(await ctx.client());
      if (action !== "discard-draft" && access?.principal.token?.may_activate === false) {
        throw new CavelonError(ExitCode.unauthorized, { code: "token_activation_refused", message: "This personal access token does not allow activation, publication or rollback.", hint: "A person performs it in the Admin or creates an appropriately scoped token with May activate." });
      }
      const permission = operationAccess(access, `POST ${BASE}/${action}`);
      if (permission.allowed === false) throw new CavelonError(ExitCode.unauthorized, { code: "permission_missing", message: "This credential cannot perform the publication change; nothing was changed.", hint: whoInstead(access, permission) });
      const body = { expected_version: p.published_version, expected_draft_revision: p.draft_revision, ...(snapshot ? { snapshot_id: snapshot.id } : {}), ...(action !== "discard-draft" ? { confirm_affected_runs: p.waiting_runs_affected > 0, expected_waiting_run_ids: [...p.review_run_ids].sort() } : {}) };
      const commandWords = [...words, "--harness", harness.slug, ...(stringOption(input, "env") ? ["--env", stringOption(input, "env")!] : []), ...(snapshot ? ["--snapshot", snapshot.id] : []), "--confirm"];
      const consequence = action === "publish" ? `Publish ${harness.name}'s reviewed draft to live traffic.` : action === "rollback" ? `Restore published v${snapshot!.version} for ${harness.name} as a new live publication.${p.has_draft ? " Unpublished edits will be saved in a pinned recovery snapshot and the working draft cleared." : ""}` : `Discard ${harness.name}'s unpublished edits; the published graph stays in service.`;
      const gate = await confirmation(ctx, input, tool, { harness: harness.id, body, changes: [...p.changes].sort((a, b) => `${a.entity}:${a.id}` < `${b.entity}:${b.id}` ? -1 : `${a.entity}:${a.id}` > `${b.entity}:${b.id}` ? 1 : 0), waiting_runs: [...p.waiting_runs].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), has_draft: p.has_draft }, { person: { what: `${consequence}\n${stateText(p)}`, words: commandWords } });
      if (!gate.confirmed) {
        const confirm = gate.confirm(cavelonCommand(...commandWords));
        return { data: { changed: false, harness, publication: p, ...(snapshot ? { rollback_snapshot: snapshot } : {}), confirm, ...gate.fields }, text: [consequence, stateText(p), gate.where, ...(gate.mismatch ? [gate.mismatch] : []), `Show this to a person; with their yes: ${confirm}`].join("\n"), ...(gate.exitCode ? { exitCode: gate.exitCode } : {}) };
      }
      const result = await callOperation(ctx, await ctx.client(), doc, op, { params: { harness_id: [harness.id] }, body });
      const data = result.data as Record<string, unknown>;
      const warnings = Array.isArray(data.warnings) ? data.warnings.map(w => clip(String(w), 500)) : [];
      return { data: { changed: true, harness, result: data }, text: `${action} completed for ${harness.name}.${warnings.length ? `\n${warnings.join("\n")}` : ""}` };
    },
  };
}
export const publish = changeCommand("publish");
export const discardDraft = changeCommand("discard-draft");
export const rollback = changeCommand("rollback");

/** Do not infer isolation from an active status alone; only the instance's explicit report establishes it. */
export function publicationNotice(value: unknown): string | undefined {
  const p = value as { target?: unknown; published_version?: unknown } | null;
  if (p?.target === "draft") return `Unpublished draft; live traffic stays on published v${typeof p.published_version === "number" ? p.published_version : "?"}. Review ${cavelonCommand("publish")} before putting these edits live. Tenant-wide resources retain their existing behavior.`;
  if (p?.target === "published") return "Editable solution configuration; activation/publication follows the instance's lifecycle.";
  return undefined;
}
