import { noteLines, runCapacityNote, type CapacityNote } from "../capacity.js";
import {
  boolOption,
  CURSOR_OPTION,
  intOption,
  LIMIT_OPTION,
  positional,
  stringOption,
  type CommandSpec,
  type Context,
} from "../command.js";
import { CavelonError, ExitCode, usageError, type ExitCodeValue } from "../errors.js";
import { confirmation, confirmTokenRequired, PERSON_CONFIRMS_HELP } from "../confirm-token.js";
import { idempotencyKey, requireFeature, UUID_KEY_OPTION, withRetryKey } from "../features.js";
import { clip, keyValues, moreHint, table } from "../format.js";
import type { ErrorCatalog } from "../contracts.js";
import { callStable } from "../invoke.js";
import { catalogEntry } from "../package-check.js";
import { readPrincipal } from "../principal.js";
import { isUuid } from "../session.js";
import { cavelonCommand, fill, type Word } from "../printed.js";
import { readBody } from "./api.js";
import { TIMEOUT_OPTION, timeoutMs, waitAndReport } from "./async.js";
import { catalogFor } from "./solution.js";

/**
 * Masterloop loops and the triggers that start them. A loop starts only
 * through its trigger and stops with the trigger run, so `loop start` and
 * `loop cancel` act on the run; the other commands act on one loop of it.
 */

const WAIT_OPTION = { type: "boolean" as const, description: "Wait for the run to finish (see `cavelon wait`).", cliOnly: true };
const LOOP_OPTION = { type: "string" as const, value: "<loop_id>", description: "The loop, when the run has more than one." };

// ---------------------------------------------------------------------------
// Shapes, as the instance's OpenAPI publishes them
// ---------------------------------------------------------------------------

interface Trigger {
  id: string;
  slug: string;
  name: string;
  harness_id?: string | null;
  trigger_type: string;
  is_active: boolean;
}

interface AgentRun {
  id: string;
  trigger_definition_id?: string | null;
  workflow_name: string;
  status: string;
  error_summary?: string | null;
  acting_as?: { kind: string; name?: string | null; key_prefix?: string | null } | null;
  started_at?: string | null;
  ended_at?: string | null;
  created_at?: string | null;
  operation_id?: string | null;
  /** True while every run slot is taken; absent on an older instance. */
  waiting_for_capacity?: boolean | null;
}

interface Usage {
  model_requests: number;
  input_tokens: number;
  output_tokens: number;
}

interface Loop {
  id: string;
  owner_run_id: string;
  node_ref: string;
  node_name?: string | null;
  harness_id: string;
  sandbox_id: string | null;
  state: string;
  reason: string | null;
  version: number;
  iteration_number: number;
  pause_requested: boolean;
  cancel_requested: boolean;
  deadline_at: string;
  limits: Record<string, number | null>;
  charged_usage: Usage;
  content_visible: boolean;
  goal?: string | null;
  progress_summary?: string | null;
  blocked_reason?: string | null;
  cleanup_pending?: boolean;
  parent_completion_consumed_at?: string | null;
  /** LoopDetail only: what the loop ended with. */
  terminal_result?: Record<string, unknown> | null;
  /** LoopDetail only: false while the instance has Masterloop or Sandboxes switched off. */
  resume_enabled?: boolean;
  /** LoopDetail only: the loop's Sandbox operations by status; an `unknown` one holds a resume back. */
  operation_counts?: Record<string, number>;
  /** LoopDetail only, once the instance publishes it: how a pause goes on. */
  resume?: unknown;
  operation_id: string;
}

interface Iteration {
  id: string;
  iteration_number: number;
  child_run_id: string;
  child_status: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  accepted_at: string | null;
  reserved_usage: Usage;
  actual_usage: Usage | null;
  accepted_result: Record<string, unknown> | null;
}

interface IterationPage {
  items: Iteration[];
  next_cursor: number | null;
  content_visible: boolean;
}

const MAX_ITERATION_CURSOR = 100;
const LOOP_TERMINAL = new Set(["completed", "failed", "cancelled", "stopped"]);
/** A loop in these states decides nothing more on its own: every ended iteration is accepted or not. */
const LOOP_SETTLED = new Set([...LOOP_TERMINAL, "paused"]);
const RUN_TERMINAL = new Set(["completed", "failed", "blocked", "rejected", "skipped_budget", "expired", "cancelled", "debug_stopped"]);

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** The solution a trigger starts runs of, for a preview: null when the trigger names none or it cannot be read. */
async function triggerSolution(ctx: Context, trigger: Trigger): Promise<{ id: string; slug: string | null; name: string | null; status: string | null } | null> {
  if (!trigger.harness_id) return null;
  const harness = await callStable<{ id: string; slug?: string; name?: string; status?: string }>(ctx, "GET", "/api/v1/harnesses/{harness_id}", "reading solutions", {
    params: { harness_id: [trigger.harness_id] },
  }).catch(() => undefined);
  return { id: trigger.harness_id, slug: harness?.slug ?? null, name: harness?.name ?? null, status: harness?.status ?? null };
}

export async function resolveTrigger(ctx: Context, ref: string): Promise<Trigger> {
  if (isUuid(ref)) {
    return callStable<Trigger>(ctx, "GET", "/api/v1/triggers/{trigger_id}", "triggers", { params: { trigger_id: [ref] } });
  }
  const triggers = await callStable<Trigger[]>(ctx, "GET", "/api/v1/triggers", "triggers");
  let hits = triggers.filter((t) => t.slug === ref);
  if (hits.length === 0) hits = triggers.filter((t) => t.name.toLowerCase() === ref.toLowerCase());
  if (hits.length === 1) return hits[0]!;
  throw new CavelonError(ExitCode.failure, {
    code: hits.length ? "trigger_ambiguous" : "trigger_not_found",
    message: hits.length ? `${hits.length} triggers are named "${ref}"; pass its id.` : `No trigger "${ref}" in this tenant.`,
    hint: `\`${cavelonCommand("api", "list_triggers")}\` lists them with their ids and slugs.`,
  });
}

async function getRun(ctx: Context, runId: string): Promise<AgentRun> {
  if (!isUuid(runId)) throw usageError(`"${runId}" is not a run id.`, `\`${cavelonCommand("loop", "start")}\` prints the run id.`);
  return callStable<AgentRun>(ctx, "GET", "/api/v1/triggers/runs/{run_id}", "trigger runs", { params: { run_id: [runId] } });
}

const MAX_LOOP_PAGES = 5;

async function loopsOf(ctx: Context, runId: string): Promise<Loop[]> {
  const loops: Loop[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LOOP_PAGES; page++) {
    const result = await callStable<{ items: Loop[]; next_cursor: string | null }>(ctx, "GET", "/api/v1/triggers/runs/{run_id}/loops", "loops", {
      params: { run_id: [runId] },
      query: { limit: 20, cursor },
    });
    loops.push(...result.items);
    if (!result.next_cursor) break;
    cursor = result.next_cursor;
  }
  return loops;
}

async function getLoop(ctx: Context, runId: string, loopId: string): Promise<Loop> {
  return callStable<Loop>(ctx, "GET", "/api/v1/triggers/runs/{run_id}/loops/{loop_id}", "loops", {
    params: { run_id: [runId], loop_id: [loopId] },
  });
}

/** The newest loop that has not ended, else the last one. */
function currentLoop(loops: Loop[]): Loop | undefined {
  return [...loops].reverse().find((l) => !LOOP_TERMINAL.has(l.state)) ?? loops.at(-1);
}

/** The loop a command means: the one named, or the only one that fits. */
async function pickLoop(ctx: Context, runId: string, loopId: string | undefined, fits: (loop: Loop) => boolean, what: string): Promise<Loop> {
  if (loopId) return getLoop(ctx, runId, loopId);
  const loops = await loopsOf(ctx, runId);
  if (loops.length === 0) {
    throw new CavelonError(ExitCode.failure, {
      code: "loop_not_found",
      message: `Run ${runId} has no loop (yet).`,
      hint: `A loop starts when the run reaches its Masterloop node; \`${cavelonCommand("loop", "watch", runId)}\` waits for it.`,
    });
  }
  const candidates = loops.filter(fits);
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    throw new CavelonError(ExitCode.conflict, {
      code: "loop_state_conflict",
      message: `No loop of run ${runId} ${what}: ${loops.map((l) => l.id + " is " + l.state).join(", ")}.`,
    });
  }
  throw usageError(`Run ${runId} has ${candidates.length} loops that ${what}; name one with --loop.`, `Loops: ${candidates.map((l) => l.id).join(", ")}`);
}

function loopSummary(loop: Loop) {
  return {
    loop_id: loop.id,
    run_id: loop.owner_run_id,
    node: loop.node_name ?? loop.node_ref,
    state: loop.state,
    reason: loop.reason ?? loop.blocked_reason ?? null,
    iteration: loop.iteration_number,
    max_iterations: loop.limits.max_iterations ?? null,
    usage: loop.charged_usage,
    deadline_at: loop.deadline_at,
    sandbox_id: loop.sandbox_id,
    pause_requested: loop.pause_requested,
    progress: loop.progress_summary ?? null,
    operation_id: loop.operation_id,
  };
}

function runSummary(run: AgentRun, note?: CapacityNote) {
  return {
    run_id: run.id,
    workflow: run.workflow_name,
    status: run.status,
    error: run.error_summary ?? null,
    acting_as: run.acting_as ? (run.acting_as.name ?? run.acting_as.key_prefix ?? run.acting_as.kind) : null,
    operation_id: run.operation_id ?? null,
    ...note,
  };
}

/**
 * What became of an iteration. The controller accepts an iteration's result
 * at its next tick after the child ended, so an ended iteration is "ended"
 * until it is accepted, a later one starts, or the loop pauses or ends
 * without accepting it ("rejected", or "failed" when the child failed).
 */
type Verdict = "accepted" | "rejected" | "failed" | "ended" | "running";

function verdictOf(it: Iteration, decided: boolean): Verdict {
  if (it.accepted_at !== null) return "accepted";
  if (it.ended_at === null) return "running";
  if (!decided) return "ended";
  return it.child_status === "completed" ? "rejected" : "failed";
}

/**
 * One iteration as an envelope: its verdict, the outcome of the accepted
 * `loop.continuation.v1` result, and what it used. Until the instance reports
 * the actual usage, the budget the iteration reserved is shown as reserved.
 * `context` is the loop when the iteration is the last one it decided on, so
 * an iteration it did not accept carries the loop's reason.
 */
function iterationEnvelope(it: Iteration, decided: boolean, context?: Loop) {
  const result = it.accepted_result;
  let shown: unknown = result;
  if (result) {
    const text = JSON.stringify(result);
    if (text.length > 2000) shown = clip(text, 2000);
  }
  const verdict = verdictOf(it, decided);
  const notAccepted = verdict === "rejected" || verdict === "failed";
  return {
    iteration: it.iteration_number,
    child_run_id: it.child_run_id,
    child_status: it.child_status,
    verdict,
    accepted: it.accepted_at !== null,
    outcome: result && typeof result.outcome === "string" ? result.outcome : null,
    reason: notAccepted && context ? [context.reason, context.blocked_reason].filter(Boolean).join(": ") || null : null,
    duration_ms: it.duration_ms,
    usage: it.actual_usage,
    reserved_usage: it.reserved_usage,
    result: shown,
  };
}

type IterationEnvelope = ReturnType<typeof iterationEnvelope>;

const tokens = (usage: Usage) => usage.input_tokens + usage.output_tokens;

function iterationLine(env: IterationEnvelope): string {
  const child = env.child_status === "completed" ? "" : ` (child ${env.child_status})`;
  const usage = env.usage
    ? `requests ${env.usage.model_requests}  tokens ${tokens(env.usage)}`
    : `usage not reported yet; reserved requests ${env.reserved_usage.model_requests}, tokens ${tokens(env.reserved_usage)}`;
  const outcome = env.outcome ? "  → " + env.outcome : "";
  const reason = env.reason ? "  (" + env.reason + ")" : "";
  return `iteration ${env.iteration}  ${env.verdict}${child}${outcome}  ${env.duration_ms ?? "-"} ms  ${usage}${reason}`;
}

function usageText(usage: Usage): string {
  return `requests ${usage.model_requests}, tokens in ${usage.input_tokens}, out ${usage.output_tokens}`;
}

function loopExitCode(state: string): ExitCodeValue {
  if (state === "completed") return ExitCode.ok;
  if (state === "failed" || state === "cancelled" || state === "stopped") return ExitCode.failure;
  if (state === "paused") return ExitCode.needsAction;
  return ExitCode.timeout;
}

// ---------------------------------------------------------------------------
// loop start / cancel
// ---------------------------------------------------------------------------

export const loopStart: CommandSpec = {
  name: "loop start",
  summary: "Start a loop through its trigger, as you; previews first, --confirm starts it and returns the run and operation ids.",
  description:
    "Calls the trigger's run-now route. The run (and its loop) acts as the caller: with a personal access token, the person.\n" +
    "It runs on its own and spends the tenant's model budget, so without --confirm nothing starts: the preview names the\n" +
    "trigger, its solution and the payload. Show it to a person and confirm only with their yes. For a trigger of a draft\n" +
    "solution an agent confirms with the preview's token (--confirm <token>, or confirm over MCP); for any other,\n" +
    "a coding agent cannot confirm it: over MCP the client asks the person, and from an agent's shell the person runs the\n" +
    "confirm in their own terminal. Follow the run with `loop watch <run>`, or `wait <operation>`; `loop cancel <run>` stops it.",
  readOnly: false,
  mcpTool: "loop_start",
  operations: ["POST /api/v1/triggers/{trigger_id}/run"],
  positionals: [{ name: "trigger", description: "Trigger slug, name or id.", required: true }],
  options: {
    input: { type: "string", value: "<json|@file|->", description: "The run's payload: JSON, @file.json or - for stdin." },
    wait: WAIT_OPTION,
    timeout: TIMEOUT_OPTION,
    "idempotency-key": UUID_KEY_OPTION,
    confirm: { type: "boolean", mcpToken: true, description: "Start the run (after a person saw the preview)." },
  },
  examples: [
    "cavelon loop start counter",
    "cavelon loop start counter --confirm",
    "cavelon loop start counter --confirm <token>",
    "cavelon loop start orders --input @orders-request.json --confirm --json",
  ],
  async run(ctx, input) {
    // Refused before anything is read, as every confirming tool refuses true.
    if (ctx.mode === "mcp" && input.options.confirm === true) throw confirmTokenRequired("loop_start");
    await requireFeature(ctx, "masterloop_enabled", "masterloop_feature_disabled", "Masterloop");
    const trigger = await resolveTrigger(ctx, positional(input, "trigger")!);
    const raw = stringOption(input, "input");
    const payload = raw === undefined ? {} : await readBody(ctx, raw);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw usageError("--input must be a JSON object.");
    const solution = await triggerSolution(ctx, trigger);
    const given = stringOption(input, "idempotency-key");
    const words = ["loop", "start", trigger.slug, ...(raw !== undefined ? ["--input", raw] : []), ...(given ? ["--idempotency-key", given] : [])];
    // A trigger of a draft solution is the fast loop an agent confirms on its own; any other run acts as the person on their budget.
    const gate = await confirmation(ctx, input, "loop_start", { trigger: trigger.id, payload }, {
      ...(solution?.status === "draft"
        ? {}
        : { person: { what: `Start a run of the trigger ${trigger.slug}, which acts as the person and spends the tenant's model budget.`, words: [...words, "--confirm"] } }),
    });
    if (!gate.confirmed) {
      const confirm = gate.confirm(cavelonCommand(...words, "--confirm"));
      const payloadText = clip(JSON.stringify(payload), 500);
      return {
        data: {
          started: false,
          would: "start_run",
          trigger: { id: trigger.id, slug: trigger.slug, name: trigger.name, type: trigger.trigger_type, is_active: trigger.is_active },
          solution,
          payload,
          confirm,
          ...gate.fields,
        },
        text: [
          `Starting ${trigger.slug} (${trigger.trigger_type}) starts a run that acts as you, runs on its own and spends the tenant's model budget until it ends or is cancelled.`,
          !solution
            ? "Solution: none named by the trigger."
            : solution.status
              ? `Solution: ${solution.name ?? solution.id}${solution.slug ? ` (${solution.slug})` : ""}, ${solution.status}.`
              : `Solution: ${solution.id} (not readable).`,
          `Payload: ${payloadText}`,
          gate.where, ...(gate.mismatch ? [gate.mismatch] : []),
          `Nothing was started. Show this to a person; with their yes: ${confirm}`,
        ].join("\n"),
        ...(gate.exitCode ? { exitCode: gate.exitCode } : {}),
      };
    }
    // Always keyed: a start that timed out may have started the run, and a retry with the same key does not start another.
    const key = idempotencyKey(input);
    const run = await callStable<AgentRun>(ctx, "POST", "/api/v1/triggers/{trigger_id}/run", "starting triggers", {
      params: { trigger_id: [trigger.id] },
      headers: { "Idempotency-Key": key },
      body: { payload },
    }).catch((error: unknown) => {
      throw withRetryKey(error, key);
    });
    if (!trigger.is_active) ctx.warn(`Trigger "${trigger.slug}" is not active: its schedule and webhook start no runs, though this manual start did.`);
    const started = { trigger: { id: trigger.id, slug: trigger.slug }, ...runSummary(run), idempotency_key: key };
    if (boolOption(input, "wait") && ctx.mode === "cli" && run.operation_id) {
      const waited = await waitAndReport(ctx, [run.operation_id], timeoutMs(ctx, stringOption(input, "timeout")));
      const text = `Started run ${run.id} of ${trigger.slug}.\n${waited.text}`;
      // A run that ended without starting a loop says why: a blueprint may complete through its failure output.
      const missing = await endedWithoutLoop(ctx, run.id);
      if (missing) {
        return {
          data: { ...started, ...waited.data, without_loop: missing },
          text: `${text}\nThe run ended (${missing.status}) without a loop.${missing.why ? " " + missing.why : ""}\nLook closer: ${cavelonCommand("trace", run.id)}`,
          exitCode: waited.exitCode === ExitCode.ok ? ExitCode.failure : waited.exitCode,
        };
      }
      return { data: { ...started, ...waited.data }, text, exitCode: waited.exitCode };
    }
    return {
      data: started,
      text:
        `Started run ${run.id} of ${trigger.slug} (${run.status}).\n` +
        `Follow:  ${cavelonCommand("loop", "watch", run.id)}\n` +
        (run.operation_id ? `Wait:    ${cavelonCommand("wait", run.operation_id)}\n` : "") +
        `Stop:    ${cavelonCommand("loop", "cancel", run.id, "--confirm")}`,
    };
  },
};

export const loopCancel: CommandSpec = {
  name: "loop cancel",
  summary: "Stop a trigger run and its loops (needs --confirm).",
  description: "Without --confirm, shows what would stop and stops nothing. Stopping the run stops every loop of it.",
  readOnly: false,
  destructive: true,
  idempotent: true,
  mcpTool: "loop_cancel",
  operations: ["POST /api/v1/triggers/runs/{run_id}/cancel"],
  positionals: [{ name: "run", description: "The trigger run id (from `loop start`).", required: true }],
  options: {
    confirm: { type: "boolean", mcpToken: true, description: "Stop the run; without it nothing is stopped." },
  },
  examples: ["cavelon loop cancel <run>", "cavelon loop cancel <run> --confirm", "cavelon loop cancel <run> --confirm <token>"],
  async run(ctx, input) {
    const runId = positional(input, "run")!;
    const run = await getRun(ctx, runId);
    const note = await runCapacityNote(ctx, run);
    if (RUN_TERMINAL.has(run.status)) {
      return { data: { cancelled: false, run: runSummary(run, note) }, text: `Run ${run.id} is already ${run.status}; nothing to stop.${noteLines(note)}` };
    }
    const loops = (await loopsOf(ctx, run.id)).map(loopSummary);
    const gate = await confirmation(ctx, input, "loop_cancel", { run: run.id });
    if (!gate.confirmed) {
      const confirm = gate.confirm(cavelonCommand("loop", "cancel", run.id, "--confirm"));
      return {
        data: { cancelled: false, run: runSummary(run, note), loops, confirm, ...gate.fields },
        text:
          `Run ${run.id} (${run.workflow_name}) is ${run.status}` +
          (loops.length ? `, with loops:\n${table(loops, ["loop_id", "node", "state", "iteration"])}\n` : ".\n") +
          (note ? `${noteLines(note).slice(1)}\n` : "") +
          `${gate.where}\n` +
          (gate.mismatch ? `${gate.mismatch}\n` : "") +
          `Nothing was stopped. Stop it with: ${confirm}`,
        ...(gate.exitCode ? { exitCode: gate.exitCode } : {}),
      };
    }
    const cancelled = await callStable<AgentRun>(ctx, "POST", "/api/v1/triggers/runs/{run_id}/cancel", "cancelling runs", { params: { run_id: [run.id] } });
    return {
      data: { cancelled: true, run: runSummary(cancelled), loops },
      text: `Run ${cancelled.id} is ${cancelled.status}; its loops stop at their next safe point.` + (cancelled.operation_id ? `\nWait: ${cavelonCommand("wait", cancelled.operation_id)}` : ""),
    };
  },
};

// ---------------------------------------------------------------------------
// loop iterations / watch
// ---------------------------------------------------------------------------

export const loopIterations: CommandSpec = {
  name: "loop iterations",
  summary: "A loop's state, budget and iterations, a page at a time.",
  description:
    "Each iteration's verdict: accepted, rejected or failed (the child failed), ended (not yet accepted) or running;\n" +
    "the outcome of its accepted result (continue, wait, done, blocked), and its usage once the instance reports it.",
  readOnly: true,
  idempotent: true,
  mcpTool: "loop_iterations",
  positionals: [{ name: "run", description: "The trigger run id.", required: true }],
  options: {
    loop: LOOP_OPTION,
    limit: { ...LIMIT_OPTION, description: "Return at most n iterations (at most 20)." },
    cursor: CURSOR_OPTION,
  },
  examples: ["cavelon loop iterations <run>", "cavelon loop iterations <run> --cursor 20 --json"],
  async run(ctx, input) {
    const runId = positional(input, "run")!;
    const limit = intOption(input, "limit", { min: 1, max: 20, fallback: 20 })!;
    const cursor = intOption(input, "cursor", { min: 0 });
    const loopId = stringOption(input, "loop");
    const loop = loopId ? await getLoop(ctx, runId, loopId) : currentLoop(await loopsOf(ctx, runId));
    if (!loop) throw new CavelonError(ExitCode.failure, { code: "loop_not_found", message: `Run ${runId} has no loop (yet).` });
    const page = await iterationPage(ctx, loop, limit, cursor ?? 0);
    const newest = newestIteration(loop, page.items);
    const items = page.items.map((it) => envelopeIn(it, loop, newest));
    const next = page.next_cursor === null ? null : String(page.next_cursor);
    const summary = loopSummary(loop);
    return {
      data: { loop: summary, iterations: { items, next_cursor: next }, content_visible: page.content_visible },
      text:
        `${keyValues(Object.entries({ ...summary, usage: usageText(summary.usage) }))}\n\n` +
        (table(items, ["iteration", "child_status", "verdict", "outcome", "duration_ms", "child_run_id"]) || "No iterations yet.") +
        moreHint(next, cavelonCommand("loop", "iterations", loop.owner_run_id, "--loop", loop.id)) +
        (page.content_visible ? "" : "\nIteration results are hidden from this credential.") +
        (items.length ? `\nOne iteration's run: ${cavelonCommand("trace", fill("child_run_id"))}` : ""),
    };
  },
};

function iterationPage(ctx: Context, loop: Loop, limit: number, cursor: number): Promise<IterationPage> {
  return callStable<IterationPage>(ctx, "GET", "/api/v1/triggers/runs/{run_id}/loops/{loop_id}/iterations", "loop iterations", {
    params: { run_id: [loop.owner_run_id], loop_id: [loop.id] },
    query: { limit, cursor },
  });
}

function newestIteration(loop: Loop, items: Iteration[]): number {
  return Math.max(loop.iteration_number, ...items.map((i) => i.iteration_number));
}

/** An iteration is decided once a later one started or the loop settled; the last one carries the loop's reason. */
function envelopeIn(it: Iteration, loop: Loop, newest: number): IterationEnvelope {
  const settled = LOOP_SETTLED.has(loop.state);
  const later = newest > it.iteration_number;
  return iterationEnvelope(it, later || settled, settled && !later ? loop : undefined);
}

export const loopWatch: CommandSpec = {
  name: "loop watch",
  mcpInstead: "loop iterations",
  summary: "Follow a loop: one line per decided iteration and per state change, then the loop's outcome.",
  description:
    "Prints each iteration once the loop accepted it, rejected it or its child failed, with its outcome and usage\n" +
    "(one JSON object per line with --json), and the loop's outcome when it ends or pauses. Exit 0 when the loop\n" +
    "completed, 1 when it failed or was cancelled, 5 at once when it pauses (a person reviews and resumes it),\n" +
    "6 when the timeout passed first.",
  readOnly: true,
  idempotent: true,
  mcpTool: false,
  positionals: [{ name: "run", description: "The trigger run id.", required: true }],
  options: {
    loop: LOOP_OPTION,
    timeout: { ...TIMEOUT_OPTION, description: "Stop watching after this long (default 10m)." },
  },
  examples: ["cavelon loop watch <run>", "cavelon loop watch <run> --json --timeout 5m"],
  async run(ctx, input) {
    const runId = positional(input, "run")!;
    const loopId = stringOption(input, "loop");
    const deadline = Date.now() + timeoutMs(ctx, stringOption(input, "timeout"), "10m");
    const fromEnv = Number(ctx.io.env.CAVELON_POLL_INTERVAL_MS);
    const interval = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 2000;
    const emit = (line: Record<string, unknown>, text: string) => ctx.io.stdout.write(ctx.json ? `${JSON.stringify(line)}\n` : `${text}\n`);
    const watched: Watched = { shown: new Set(), offset: 0, lastState: "", lastOutcome: null };
    let waiting: CapacityNote["capacity_wait"];
    for (;;) {
      const next = loopId ? await getLoop(ctx, runId, loopId) : currentLoop(await loopsOf(ctx, runId));
      if (next && next.id !== watched.loop?.id) {
        watched.offset = 0;
        watched.lastOutcome = null;
      }
      watched.loop = next;
      if (next) {
        // The iterations decided since the last look, then the loop's state.
        for (const envelope of await decidedIterations(ctx, next, watched)) {
          if (envelope.outcome) watched.lastOutcome = envelope.outcome;
          emit({ type: "iteration", loop_id: next.id, ...envelope }, iterationLine(envelope));
        }
        const state = `${next.id}:${next.state}:${next.pause_requested}`;
        if (state !== watched.lastState) {
          emit({ type: "loop", loop: loopSummary(next) }, stateLine(next));
          watched.lastState = state;
        }
        // A paused loop waits for a person, so the watch ends with it as with an ended one.
        if (LOOP_SETTLED.has(next.state)) {
          const outcome = await loopOutcome(ctx, next, watched.lastOutcome);
          emit({ type: "outcome", ...outcome }, outcomeText(outcome));
          return { data: undefined, text: "", exitCode: loopExitCode(next.state) };
        }
      } else {
        // No loop yet: a run queued past a normal start waits for run capacity; say so once.
        const { run, note } = await requireRunGoesOn(ctx, runId);
        if (note?.capacity_wait && !waiting) emit({ type: "run", run: runSummary(run, note) }, `run ${run.id}  ${run.status}  ${note.capacity_wait.note}`);
        waiting = note?.capacity_wait;
      }
      const left = deadline - Date.now();
      if (left <= 0) break;
      await ctx.io.sleep(Math.min(interval, left));
    }
    const state = watched.loop?.state ?? (waiting ? "not started: its run is waiting for run capacity" : "not started");
    const resume = cavelonCommand("loop", "watch", runId, ...(loopId ? ["--loop", loopId] : []));
    ctx.io.stderr.write(`Stopped watching; the loop is still ${state}. Resume: ${resume}\n`);
    return { data: undefined, text: "", exitCode: ExitCode.timeout };
  },
};

interface Watched {
  loop?: Loop;
  /** Iterations already printed. */
  shown: Set<string>;
  /** Where the first iteration not yet printed is. */
  offset: number;
  lastState: string;
  /** The outcome of the last accepted iteration printed. */
  lastOutcome: string | null;
}

/** The iterations of the loop decided since the last look, in order; an ended one waits for its verdict. */
async function decidedIterations(ctx: Context, loop: Loop, watched: Watched): Promise<IterationEnvelope[]> {
  const found: IterationEnvelope[] = [];
  // The route reads at most from offset 100; what was shown is skipped by id.
  let cursor: number | null = Math.min(watched.offset, MAX_ITERATION_CURSOR);
  while (cursor !== null) {
    const page = await iterationPage(ctx, loop, 20, cursor);
    const newest = newestIteration(loop, page.items);
    for (const it of page.items.filter((i) => !watched.shown.has(i.id))) {
      const envelope = envelopeIn(it, loop, newest);
      if (envelope.verdict === "ended" || envelope.verdict === "running") continue;
      watched.shown.add(it.id);
      found.push(envelope);
    }
    const prefix = page.items.findIndex((i) => !watched.shown.has(i.id));
    if (prefix === -1 && page.next_cursor !== null) cursor = page.next_cursor;
    else {
      watched.offset = cursor + (prefix === -1 ? page.items.length : prefix);
      cursor = null;
    }
  }
  return found;
}

function stateLine(loop: Loop): string {
  const reason = loop.reason ?? loop.blocked_reason;
  const because = reason ? "  (" + reason + ")" : "";
  const requested = loop.pause_requested && loop.state !== "paused" ? "  pause requested" : "";
  return `loop ${loop.id}  ${loop.state}${because}${requested}`;
}

/** How a loop ended or why it paused: its reason, what it charged, and for a pause how it can go on. */
async function loopOutcome(ctx: Context, loop: Loop, lastOutcome: string | null) {
  // The loop's detail adds the blocked reason, the terminal result and what a resume needs; without it, the summary is enough.
  let detail: Loop = loop;
  try {
    detail = await getLoop(ctx, loop.owner_run_id, loop.id);
  } catch (error) {
    if (!(error instanceof CavelonError)) throw error;
  }
  const terminal = detail.terminal_result ? JSON.stringify(detail.terminal_result) : null;
  return {
    loop_id: loop.id,
    run_id: loop.owner_run_id,
    state: loop.state,
    reason: detail.reason ?? loop.reason ?? null,
    blocked_reason: detail.blocked_reason ?? null,
    iterations: detail.iteration_number,
    last_outcome: lastOutcome,
    charged_usage: detail.charged_usage,
    progress: detail.progress_summary ? clip(detail.progress_summary, 500) : null,
    terminal_result: terminal && terminal.length > 2000 ? clip(terminal, 2000) : (detail.terminal_result ?? null),
    ...(loop.state === "paused" ? { go_on: await howToGoOn(ctx, detail) } : {}),
  };
}

function outcomeText(outcome: Awaited<ReturnType<typeof loopOutcome>>): string {
  const because = [outcome.reason, outcome.blocked_reason].filter(Boolean).join(": ");
  const counted = `after ${outcome.iterations} iteration${outcome.iterations === 1 ? "" : "s"}`;
  const last = outcome.last_outcome ? ` (last outcome: ${outcome.last_outcome})` : "";
  const state = outcome.state === "paused" ? "is paused" : outcome.state;
  const why = because ? " (" + because + ")" : "";
  const lines = [`Loop ${outcome.loop_id} ${state} ${counted}${why}${last}.`, `Charged: ${usageText(outcome.charged_usage)}.`];
  if (outcome.progress) lines.push(`Progress: ${outcome.progress}`);
  if (outcome.go_on) lines.push(goOnText(outcome.go_on));
  return lines.join("\n");
}

/** A run with no loop yet: fine while it runs or waits for run capacity, an error once it ended. */
async function requireRunGoesOn(ctx: Context, runId: string): Promise<{ run: AgentRun; note?: CapacityNote }> {
  const run = await getRun(ctx, runId);
  const note = await runCapacityNote(ctx, run);
  if (RUN_TERMINAL.has(run.status)) {
    const why = await whyNoLoop(ctx, run);
    throw new CavelonError(ExitCode.failure, {
      code: "loop_not_found",
      message: `Run ${runId} ended (${run.status}) without a loop.${why.text ? " " + why.text : ""}`,
      hint: note?.capacity_refusal ? `${note.capacity_refusal.code}: ${note.capacity_refusal.hint}` : `\`${cavelonCommand("trace", run.id)}\` shows its traces.`,
      details:
        note?.capacity_refusal || why.stage_errors.length
          ? { ...(note?.capacity_refusal ? { capacity_refusal: note.capacity_refusal } : {}), ...(why.stage_errors.length ? { stage_errors: why.stage_errors } : {}) }
          : undefined,
    });
  }
  return { run, note };
}

/** The stage a run's orchestration state records an error for, with its message. */
export interface StageError {
  stage: string;
  index: number | null;
  status: string | null;
  message: string;
}

interface OrchestrationStage {
  key: string;
  stage_index?: number | null;
  status?: string | null;
  error?: Record<string, unknown> | null;
}

const MAX_STAGE_ERRORS = 5;

/**
 * The stages of a run that recorded an error. A blueprint may route a
 * stage's error to its failure output, so a run can complete although the
 * stage that starts the loop failed. The error is an open object in the
 * OpenAPI: its `message` is shown when it is text, else the object.
 */
export async function stageErrors(ctx: Context, runId: string): Promise<StageError[]> {
  let state: { stages?: OrchestrationStage[] };
  try {
    state = await callStable(ctx, "GET", "/api/v1/triggers/runs/{run_id}/orchestration-state", "run stages", { params: { run_id: [runId] } });
  } catch (error) {
    // A run without orchestration state, or an instance or credential that does not show it: no stage to name.
    if (error instanceof CavelonError) return [];
    throw error;
  }
  return (state.stages ?? [])
    .filter((stage) => stage.error && Object.keys(stage.error).length > 0)
    .slice(0, MAX_STAGE_ERRORS)
    .map((stage) => ({
      stage: stage.key,
      index: stage.stage_index ?? null,
      status: stage.status ?? null,
      message: clip(typeof stage.error!.message === "string" ? stage.error!.message : JSON.stringify(stage.error), 500),
    }));
}

export function stageErrorText(stage: StageError): string {
  return `Stage ${stage.index ?? "?"} (${stage.stage}) ${stage.status ?? "errored"}: ${stage.message}`;
}

/** A run that ended and has no loop, with why; undefined while it runs or once it has a loop. */
async function endedWithoutLoop(ctx: Context, runId: string): Promise<{ status: string; why: string; stage_errors: StageError[] } | undefined> {
  const run = await getRun(ctx, runId);
  if (!RUN_TERMINAL.has(run.status) || (await loopsOf(ctx, runId)).length > 0) return undefined;
  const why = await whyNoLoop(ctx, run);
  return { status: run.status, why: why.text, stage_errors: why.stage_errors };
}

/** Why a run that ended did not start a loop: its error summary and the stages that recorded an error. */
async function whyNoLoop(ctx: Context, run: AgentRun): Promise<{ text: string; stage_errors: StageError[] }> {
  const stages = await stageErrors(ctx, run.id);
  const text = [run.error_summary, ...stages.map(stageErrorText)].filter(Boolean).join(" ");
  return { text, stage_errors: stages };
}

// ---------------------------------------------------------------------------
// How a paused loop goes on
// ---------------------------------------------------------------------------

/**
 * How the instance lets a pause go on: `plain` resumes as it is,
 * `review_required` resumes with the pause reason as the reviewed reason (a
 * verdict on the task), `none` cannot be resumed. The instance publishes it as
 * the loop's `resume`; until it does, the kit
 * reads only what the loop's published state rules out, and lets the
 * instance's answer to the resume tell a review apart.
 */
type ResumeKind = "plain" | "review_required" | "none";
const RESUME_KINDS: ReadonlySet<string> = new Set<ResumeKind>(["plain", "review_required", "none"]);

interface GoOn {
  /** null: the instance does not say whether the pause needs a review. */
  resume: ResumeKind | null;
  /** Who decided `resume`: the instance's own field, or the kit from the loop's published state. */
  decided_by: "instance" | "loop_state";
  /** What the pause reason means and what to do, from the instance's error catalog when it lists the reason. */
  reason_text: string | null;
  /** Why the loop cannot be resumed, or not yet. */
  why_not: string | null;
  /** The commands to run, in order. */
  commands: string[];
  /** Only while the instance does not say: the resume after a review, should the instance ask for one. */
  if_review_required: string | null;
}

/** The catalog only adds words; without it the loop's own fields still say how it goes on. */
async function catalogOrNone(ctx: Context): Promise<ErrorCatalog | null> {
  return catalogFor(ctx, false).catch(() => null);
}

function publishedResume(loop: Loop): ResumeKind | undefined {
  return typeof loop.resume === "string" && RESUME_KINDS.has(loop.resume) ? (loop.resume as ResumeKind) : undefined;
}

/** What the loop's published state says against a resume; `final` when only a new run goes on. */
function resumeBlocker(loop: Loop, now: number): { why: string; final: boolean } | undefined {
  if (loop.cancel_requested || loop.cleanup_pending || loop.parent_completion_consumed_at) return { why: "its run is being stopped", final: true };
  if (Date.parse(loop.deadline_at) <= now) return { why: `its deadline passed (${loop.deadline_at})`, final: true };
  if (loop.resume_enabled === false) return { why: "Masterloop or Sandboxes are switched off on this instance", final: true };
  const unknown = loop.operation_counts?.unknown ?? 0;
  if (unknown > 0) {
    const what = unknown === 1 ? "one of its Sandbox operations has" : `${unknown} of its Sandbox operations have`;
    return { why: `the instance refuses a resume while ${what} an unknown outcome; wait until the Sandbox reconciles it`, final: false };
  }
  return undefined;
}

function resumeCommand(loop: Loop, reason?: Word): string {
  return cavelonCommand("loop", "resume", loop.owner_run_id, "--loop", loop.id, ...(reason ? ["--reason", reason] : []));
}

/** Stop the run and start a new one of its trigger. */
async function startAgain(ctx: Context, loop: Loop): Promise<string[]> {
  let start = cavelonCommand("loop", "start", fill("trigger"));
  try {
    const run = await getRun(ctx, loop.owner_run_id);
    if (run.trigger_definition_id) start = cavelonCommand("loop", "start", (await resolveTrigger(ctx, run.trigger_definition_id)).slug);
  } catch (error) {
    if (!(error instanceof CavelonError)) throw error;
  }
  return [...(loop.cancel_requested ? [] : [cavelonCommand("loop", "cancel", loop.owner_run_id, "--confirm")]), start];
}

async function howToGoOn(ctx: Context, loop: Loop): Promise<GoOn> {
  const entry = loop.reason ? catalogEntry(await catalogOrNone(ctx), loop.reason) : undefined;
  const published = publishedResume(loop);
  const blocker = published ? undefined : resumeBlocker(loop, Date.now());
  const resume = published ?? (blocker?.final ? "none" : null);
  const base = {
    resume,
    decided_by: published ? ("instance" as const) : ("loop_state" as const),
    reason_text: entry ? [entry.message, entry.hint].filter(Boolean).join(" ") : null,
    why_not: blocker?.why ?? null,
    if_review_required: null,
  };
  if (resume === "none") return { ...base, commands: await startAgain(ctx, loop) };
  if (resume === "review_required" && loop.reason) return { ...base, commands: [resumeCommand(loop, loop.reason)] };
  if (resume === "plain") return { ...base, commands: [resumeCommand(loop)] };
  return { ...base, commands: [resumeCommand(loop)], if_review_required: loop.reason ? resumeCommand(loop, loop.reason) : null };
}

function goOnText(go: GoOn): string {
  const commands = go.commands.map((c) => "  " + c);
  const lines = go.reason_text ? [go.reason_text] : [];
  if (go.resume === "none") {
    const why = go.why_not ? `: ${go.why_not}` : "";
    lines.push(`It cannot be resumed${why}. Instead, stop the run, fix the cause and start a new run:`, ...commands);
  } else if (go.resume === "review_required") {
    lines.push("It waits for a person. The pause is a verdict on the task: check the cause and fix it, then resume and name the pause reason as reviewed:", ...commands);
  } else {
    lines.push("It waits for a person: fix the cause, then resume it:", ...commands);
    if (go.why_not) lines.push(`Not yet: ${go.why_not}.`);
    if (go.if_review_required) {
      lines.push("If the instance answers loop_resume_review_required, the pause is a verdict on the task; after your review:", `  ${go.if_review_required}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// loop pause / resume
// ---------------------------------------------------------------------------

interface ControlReceipt {
  loop_id: string;
  action: "pause" | "resume";
  state: string;
  reason: string | null;
  version: number;
  pause_requested: boolean;
  accepted_at: string;
}

function controlCommand(action: "pause" | "resume"): CommandSpec {
  const pausing = action === "pause";
  return {
    name: `loop ${action}`,
    summary: pausing ? "Ask a loop to pause at its next safe point." : "Resume a paused loop.",
    description: pausing
      ? "The current iteration finishes first. A paused loop waits for `loop resume`; `wait` on its run exits 5 meanwhile."
      : "The instance checks the loop's budget, deadline and Sandbox again before it goes on. A pause that is a verdict on\n" +
        "the task needs --reason with the pause reason a person reviewed, exactly as the loop names it (`loop watch` prints\n" +
        "the command); any other pause resumes without it. A pause that cannot be resumed is refused with what to do instead.",
    readOnly: false,
    mcpTool: `loop_${action}`,
    operations: [`POST /api/v1/triggers/runs/{run_id}/loops/{loop_id}/${action}`],
    positionals: [{ name: "run", description: "The trigger run id.", required: true }],
    options: {
      loop: LOOP_OPTION,
      ...(pausing ? {} : { reason: REVIEWED_REASON_OPTION }),
      "idempotency-key": UUID_KEY_OPTION,
    },
    examples: pausing
      ? ["cavelon loop pause <run>", "cavelon loop pause <run> --loop <loop_id>"]
      : ["cavelon loop resume <run>", "cavelon loop resume <run> --loop <loop_id> --reason task_blocked"],
    async run(ctx, input) {
      const runId = positional(input, "run")!;
      const key = idempotencyKey(input);
      let loop = await pickLoop(
        ctx,
        runId,
        stringOption(input, "loop"),
        pausing ? (l) => !LOOP_TERMINAL.has(l.state) && l.state !== "paused" : (l) => l.state === "paused",
        pausing ? "is running" : "is paused",
      );
      const reason = pausing ? undefined : stringOption(input, "reason");
      if (!pausing) {
        // The detail says what a resume needs; its version is the newest.
        loop = await getLoop(ctx, loop.owner_run_id, loop.id);
        await checkResume(ctx, loop, reason);
      }
      let receipt: ControlReceipt;
      try {
        receipt = await callStable<ControlReceipt>(ctx, "POST", `/api/v1/triggers/runs/{run_id}/loops/{loop_id}/${action}`, `${action} loops`, {
          params: { run_id: [loop.owner_run_id], loop_id: [loop.id] },
          // A header, not a parameter: without a served OpenAPI the kit knows only the path's parameters.
          headers: { "Idempotency-Key": key },
          body: { expected_version: loop.version, ...(reason ? { reviewed_reason: reason } : {}) },
        });
      } catch (error) {
        if (pausing || !(error instanceof CavelonError) || error.exitCode === ExitCode.server) throw withRetryKey(error, key);
        throw await resumeRefused(ctx, error, loop, reason);
      }
      const text = pausing
        ? `Pause requested for loop ${receipt.loop_id} (${receipt.state}); it pauses after the current iteration.`
        : `Loop ${receipt.loop_id} resumes (${receipt.state}).`;
      return { data: { ...receipt, run_id: loop.owner_run_id, operation_id: loop.operation_id }, text: `${text}\nFollow: ${cavelonCommand("loop", "watch", loop.owner_run_id)}` };
    },
  };
}

const REVIEWED_REASON_OPTION = {
  type: "string" as const,
  value: "<pause_reason>",
  description: "The pause reason a person reviewed, exactly as the loop names it (task_blocked, not free text); only a verdict on the task needs it.",
};

/** A pause that is a verdict on the task, resumed without a review: exit 5, a person reviews it first. */
function reviewRequired(loop: Loop, message: string, hint?: string): CavelonError {
  const check = `${cavelonCommand("loop", "iterations", loop.owner_run_id, "--loop", loop.id)} and ${cavelonCommand("trace", fill("child_run_id"))}`;
  return new CavelonError(ExitCode.needsAction, {
    code: "loop_resume_review_required",
    message,
    hint: [hint, `A person checks the cause (${check}) and fixes it, then: ${resumeCommand(loop, loop.reason ?? fill("pause_reason"))}`].filter(Boolean).join(" "),
  });
}

/** Refuses before sending what the instance would refuse, from what the loop publishes. */
async function checkResume(ctx: Context, loop: Loop, reason: string | undefined): Promise<void> {
  if (reason !== undefined && reason !== loop.reason) {
    throw usageError(
      `--reason names the pause reason you reviewed, exactly as the loop names it: loop ${loop.id} is paused for ${loop.reason ?? "no reason"}, not "${reason}".`,
      loop.reason ? `After a review of ${loop.reason}: ${resumeCommand(loop, loop.reason)}` : `Resume it without --reason: ${resumeCommand(loop)}`,
    );
  }
  const published = publishedResume(loop);
  if (published === "none") {
    const go = await howToGoOn(ctx, loop);
    throw new CavelonError(ExitCode.conflict, {
      code: "loop_not_resumable",
      message: `Loop ${loop.id} (paused for ${loop.reason ?? "no reason"}) cannot be resumed.${go.reason_text ? " " + go.reason_text : ""}`,
      hint: `Instead, stop the run, fix the cause and start a new run: ${go.commands.join(", then ")}`,
    });
  }
  if (published === "review_required" && reason === undefined) {
    throw reviewRequired(loop, `The pause (${loop.reason}) is a verdict on the task: a resume names it as reviewed.`);
  }
}

/** The instance's refusal of a resume, with what to do about it: the catalog's hint when it lists the code, and the command. */
async function resumeRefused(ctx: Context, error: CavelonError, loop: Loop, reason: string | undefined): Promise<CavelonError> {
  const entry = catalogEntry(await catalogOrNone(ctx), error.code);
  const said = [error.hint, entry?.hint].filter((h, i, all): h is string => Boolean(h) && all.indexOf(h) === i).join(" ") || undefined;
  if (error.code === "loop_resume_review_required" && loop.reason) return reviewRequired(loop, error.message, said);
  let next: string | undefined;
  if (error.code === "loop_control_invalid" && reason !== undefined) next = `This pause (${loop.reason}) takes no review; resume it without --reason: ${resumeCommand(loop)}`;
  if (error.code === "loop_review_reason_mismatch") next = `The loop's pause reason changed since it was read; ${cavelonCommand("loop", "watch", loop.owner_run_id, "--loop", loop.id)} shows it.`;
  if (error.code === "loop_operation_unknown") next = "A Sandbox operation of the loop has an unknown outcome; resume it once the Sandbox has reconciled the operation.";
  if (error.code === "loop_control_unavailable") next = `The loop cannot go on. Instead, stop the run, fix the cause and start a new run: ${(await startAgain(ctx, loop)).join(", then ")}`;
  if (!next && !entry) return error;
  return new CavelonError(error.exitCode, {
    code: error.code,
    message: error.message,
    hint: [said, next].filter(Boolean).join(" "),
    docs: error.docs ?? entry?.docs,
    status: error.status,
    details: error.details,
    blockers: error.blockers,
  });
}

export const loopPause = controlCommand("pause");
export const loopResume = controlCommand("resume");

// ---------------------------------------------------------------------------
// trigger identity
// ---------------------------------------------------------------------------

interface IdentityResource {
  id: string;
  name: string;
}

interface ExecutionIdentity {
  trigger_id: string;
  api_key_id: string | null;
  version: number;
  required_solutions?: IdentityResource[];
  sandboxes_missing_key?: IdentityResource[];
  selected_key?: { id: string; name?: string | null; key_prefix?: string | null; problem?: string | null; uncovered_solutions?: IdentityResource[] } | null;
}

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  is_active: boolean;
}

/** Key and token values start like this; they never go into an argument. */
const SECRET_PREFIXES = ["cbp_", "cvpat_"];

async function resolveApiKey(ctx: Context, ref: string): Promise<ApiKey | { id: string }> {
  if (SECRET_PREFIXES.some((p) => ref.startsWith(p))) {
    throw usageError(
      "That looks like a key or token value. Name the API key by its name or id; a secret never goes into an argument.",
      "A personal access token is never an execution identity; scheduled and webhook runs act as an API key.",
    );
  }
  if (isUuid(ref)) return { id: ref };
  const client = await ctx.client();
  const tenantId = client.target.tenantId ?? (await readPrincipal(client))?.tenant_id ?? undefined;
  if (!tenantId) throw usageError("Which tenant's API keys? Choose one with `cavelon use` (it lists your tenants) or --tenant, or pass the key's id.");
  const keys: ApiKey[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await callStable<{ items: ApiKey[]; total: number }>(ctx, "GET", "/api/v1/tenants/{tenant_id}/api-keys", "API keys", {
      params: { tenant_id: [tenantId] },
      query: { limit: 100, offset },
    });
    keys.push(...page.items);
    if (keys.length >= page.total || page.items.length === 0) break;
  }
  const hits = keys.filter((k) => k.name === ref || k.name.toLowerCase() === ref.toLowerCase());
  if (hits.length === 1) {
    if (!hits[0]!.is_active) throw new CavelonError(ExitCode.failure, { code: "api_key_inactive", message: `API key "${hits[0]!.name}" is revoked or inactive.` });
    return hits[0]!;
  }
  throw new CavelonError(ExitCode.failure, {
    code: hits.length ? "api_key_ambiguous" : "api_key_not_found",
    message: hits.length ? `${hits.length} API keys are named "${ref}"; pass its id.` : `No API key "${ref}" in this tenant.`,
    hint: "A person creates API keys in Settings → API keys; the kit only binds one.",
  });
}

function identityView(identity: ExecutionIdentity) {
  const key = identity.selected_key;
  return {
    trigger_id: identity.trigger_id,
    api_key_id: identity.api_key_id,
    key: key ? (key.name ?? key.key_prefix ?? key.id) : null,
    version: identity.version,
    problem: key?.problem ?? null,
    required_solutions: (identity.required_solutions ?? []).map((s) => s.name),
    uncovered_solutions: (key?.uncovered_solutions ?? []).map((s) => s.name),
    sandboxes_missing_key: (identity.sandboxes_missing_key ?? []).map((s) => s.name),
  };
}

function identityText(trigger: Trigger, view: ReturnType<typeof identityView>): string {
  const who = view.key ? `runs as API key "${view.key}"` : "no execution identity (scheduled and webhook runs cannot start)";
  const lines = [`Trigger ${trigger.slug}: ${who}`];
  if (view.required_solutions.length) lines.push(`The key must reach: ${view.required_solutions.join(", ")}`);
  if (view.problem) lines.push(`Problem: ${view.problem}`);
  if (view.uncovered_solutions.length) lines.push(`Not covered by the key: ${view.uncovered_solutions.join(", ")}`);
  if (view.sandboxes_missing_key.length) lines.push(`Sandboxes whose Access does not list the key: ${view.sandboxes_missing_key.join(", ")} (a person adds it in the Admin)`);
  return lines.join("\n");
}

export const triggerIdentity: CommandSpec = {
  name: "trigger identity",
  summary: "Show, bind or clear the API key a trigger's unattended runs act as (binding needs --confirm).",
  description:
    "Without <key> or --clear, shows the binding. Binding gives the trigger standing authority, so it is never part of\n" +
    "`apply`: show the person, then run it with --confirm. It needs settings.manage and triggers.manage. Creating keys\n" +
    "and Sandbox Access stay in the Admin. A personal access token is never an execution identity.\n" +
    PERSON_CONFIRMS_HELP,
  readOnly: false,
  destructive: true,
  idempotent: true,
  mcpTool: "trigger_identity",
  operations: ["PUT /api/v1/triggers/{trigger_id}/execution-identity"],
  positionals: [
    { name: "trigger", description: "Trigger slug, name or id.", required: true },
    { name: "key", description: "The API key's name or id (never its value)." },
  ],
  options: {
    clear: { type: "boolean", description: "Remove the binding; scheduled and webhook runs then cannot start." },
    confirm: { type: "boolean", mcpToken: true, description: "Make the change; without it nothing changes." },
  },
  examples: [
    "cavelon trigger identity orders",
    "cavelon trigger identity orders loop-runner --confirm",
    "cavelon trigger identity orders --clear --confirm",
  ],
  async run(ctx, input) {
    const keyRef = positional(input, "key");
    const clear = boolOption(input, "clear");
    if (keyRef && clear) throw usageError("Pass a key or --clear, not both.");
    const trigger = await resolveTrigger(ctx, positional(input, "trigger")!);
    const route = "/api/v1/triggers/{trigger_id}/execution-identity";
    const current = await callStable<ExecutionIdentity>(ctx, "GET", route, "execution identities", { params: { trigger_id: [trigger.id] } });
    const view = identityView(current);
    if (!keyRef && !clear) return { data: { trigger: trigger.slug, ...view }, text: identityText(trigger, view) };

    const key = keyRef ? await resolveApiKey(ctx, keyRef) : undefined;
    const wanted = key?.id ?? null;
    if (wanted === current.api_key_id) {
      return { data: { trigger: trigger.slug, changed: false, ...view }, text: `Nothing to change.\n${identityText(trigger, view)}` };
    }
    const keyName = key && "name" in key ? key.name : wanted;
    const change = wanted ? `bind API key "${keyName}"` : "clear the binding";
    const words = ["trigger", "identity", trigger.slug, keyRef ?? "--clear", "--confirm"];
    const gate = await confirmation(ctx, input, "trigger_identity", { trigger: trigger.id, from: current.api_key_id ?? null, to: wanted }, {
      person: { what: `Trigger ${trigger.slug}: ${change}, which its runs act as.`, words },
    });
    if (!gate.confirmed) {
      const confirm = gate.confirm(cavelonCommand(...words));
      return {
        data: { trigger: trigger.slug, changed: false, would: change, current: view, confirm, ...gate.fields },
        text: `${identityText(trigger, view)}\n\n${gate.where}\n${gate.mismatch ? `${gate.mismatch}\n` : ""}Nothing changed. To ${change}: ${confirm}`,
        ...(gate.exitCode ? { exitCode: gate.exitCode } : {}),
      };
    }
    const updated = await callStable<ExecutionIdentity>(ctx, "PUT", route, "execution identities", {
      params: { trigger_id: [trigger.id] },
      body: { api_key_id: wanted, expected_version: current.version },
    });
    const after = identityView(updated);
    if (after.problem) ctx.warn(`The key cannot start this trigger's runs yet: ${after.problem}`);
    if (after.sandboxes_missing_key.length) ctx.warn(`Sandbox Access does not list the key for: ${after.sandboxes_missing_key.join(", ")}. A person adds it in the Admin.`);
    return { data: { trigger: trigger.slug, changed: true, ...after }, text: `Done: ${change}.\n${identityText(trigger, after)}` };
  },
};
