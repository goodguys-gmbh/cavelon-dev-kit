import { createHash, randomUUID } from "node:crypto";

/**
 * The fake instance's triggers, trigger runs, Masterloop loops, Sandboxes,
 * archive jobs and execution identities. Each route is one the OpenAPI
 * snapshot declares and answers in its shapes (checked in contract.test.ts).
 * A loop moves one iteration forward each time something reads it, so a
 * test sees it run, pause, resume and finish without timers.
 */

export interface LoopPlan {
  /** Iterations until the loop's check passes. */
  iterations: number;
  sandboxId?: string | null;
  /** Files the loop leaves in its Sandbox when it completes. */
  output?: Record<string, string>;
  /** The loop fails at this iteration instead. */
  failAt?: number;
  /** This iteration's child fails: the loop does not accept it and pauses (task_blocked, or `pauseReason`). */
  blockAt?: number;
  /** The reason the loop pauses at `blockAt`. */
  pauseReason?: string;
  /**
   * How the instance lets the pause go on, and answers a resume as controls.py does: `plain`
   * refuses a reviewed reason (422 loop_control_invalid), `review_required` needs the pause
   * reason as the reviewed reason, `none` refuses (409 loop_control_unavailable). Left out: a
   * task verdict needs a review, any other pause resumes plain.
   */
  resume?: "plain" | "review_required" | "none";
  /**
   * The loop's detail publishes `resume` and `resume_refusal`, as the
   * snapshot does; false is an older instance, where a client reads the other fields.
   */
  publishResume?: boolean;
  /** Fields of the paused loop's detail, as the instance publishes them (resume_enabled, operation_counts, deadline_at). */
  pausedDetail?: Record<string, unknown>;
  /** An iteration is accepted one look after it ended, as the controller's next tick accepts it. */
  acceptLater?: boolean;
  /** What each iteration reserves, and what it reports using once accepted. */
  reserve?: Usage;
  use?: Usage;
}

interface Usage {
  model_requests: number;
  input_tokens: number;
  output_tokens: number;
}

export interface FakeTrigger {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  harness_id: string;
  trigger_type: string;
  is_active: boolean;
  identity: { api_key_id: string | null; version: number };
  /** What the identity editor says the key must reach. */
  required_solutions: Array<{ id: string; name: string }>;
  loop?: LoopPlan;
  /** The run completes without a loop: this stage's error went to the blueprint's failure output. */
  stageError?: { key: string; index: number; type: string; message: string };
}

export interface FakeRun {
  id: string;
  tenant_id: string;
  trigger: FakeTrigger;
  status: string;
  payload: Record<string, unknown>;
  acting_as: { kind: "user" | "key"; name: string | null };
  created_at: string;
  ended_at: string | null;
  /** Why it failed, as the instance summarises it; a failed run without one reads "The loop failed." */
  error_summary?: string | null;
  /** The loop run that started this one as an iteration. */
  parent?: FakeRun;
  /** The orchestration state's stages; a run without them has no orchestration state. */
  stages?: Array<Record<string, unknown>>;
  /** True while the worker holds the run back because every run slot is taken. */
  waiting_for_capacity?: boolean;
  /** As an older instance answers: the run has no waiting_for_capacity. */
  olderInstance?: boolean;
}

export interface FakeIteration {
  id: string;
  number: number;
  child_run_id: string;
  started_at: string;
  ended_at: string;
  outcome: "continue" | "done" | "blocked";
  /** The child's status; a failed child leaves no result to accept. */
  child_status: "completed" | "failed";
  accepted: boolean;
}

export interface FakeLoop {
  id: string;
  tenant_id: string;
  run: FakeRun;
  plan: LoopPlan;
  state: string;
  reason: string | null;
  version: number;
  pause_requested: boolean;
  iterations: FakeIteration[];
  created_at: string;
  updated_at: string;
  controls: Map<string, unknown>;
}

export interface FakeSandbox {
  id: string;
  tenant_id: string;
  name: string;
  execution_mode: "isolated_container" | "customer_vm";
  lifecycle_state: string;
  config_version: number;
  revision: number;
  allowed_harness_ids: string[];
  machine_api_key_ids: string[];
  files: Map<string, Buffer>;
  writer_owner_run_id: string | null;
  /** Whether validate passes. */
  healthy: boolean;
  readiness: Record<string, unknown> | null;
  activity: FakeActivity[];
  refreshKeys: Map<string, number>;
}

export interface FakeActivity {
  id: string;
  owner_run_id: string;
  harness_id: string;
  action: string;
  log: string;
  created_at: string;
}

export interface FakeJob {
  id: string;
  tenant_id: string;
  sandbox: FakeSandbox;
  run_id: string;
  direction: "import" | "export";
  revision: string;
  status: "active" | "cancelling" | "succeeded" | "failed" | "cancelled";
  phase: string;
  sha256: string | null;
  size: number | null;
  paths: string[] | null;
  operation_link_id: string | null;
  artifact_id: string | null;
  error_code: string | null;
  uploaded: Buffer | null;
  export: Buffer | null;
  created_at: string;
  spec: string;
}

export interface LongRunningState {
  triggers: FakeTrigger[];
  runs: FakeRun[];
  loops: FakeLoop[];
  sandboxes: FakeSandbox[];
  jobs: Map<string, FakeJob>;
  apiKeys: Array<{ id: string; tenant_id: string; name: string; key_prefix: string; is_active: boolean }>;
}

export function longRunningState(): LongRunningState {
  return { triggers: [], runs: [], loops: [], sandboxes: [], jobs: new Map(), apiKeys: [] };
}

export interface RouteContext {
  method: string;
  path: string;
  url: URL;
  headers: Record<string, string | string[] | undefined>;
  raw: Buffer;
  json: unknown;
  tenantId: string;
  actor: { kind: "user" | "key"; name: string };
  send(status: number, body: unknown): void;
  sendBytes(status: number, bytes: Buffer, headers: Record<string, string>): void;
  /** Registers an operation whose state comes from the record. */
  liveOperation(kind: string, recordId: string, tenantId: string, view: (advance: boolean) => LiveView): string;
}

export interface LiveView {
  status: "queued" | "running" | "needs_action" | "succeeded" | "failed" | "cancelled";
  phase: string;
  error?: { code: string; message: string } | null;
  action?: { reason: string; admin_url: string } | null;
  result_ref?: { type: string; id: string; href: string } | null;
}

const now = () => new Date().toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const opIdOf = (kind: string, id: string) => `op_${kind}_${id.replaceAll("-", "")}`;

const LIMITS = {
  max_iterations: 12,
  deadline_seconds: 300,
  max_iteration_seconds: 30,
  max_model_requests: 0,
  max_input_tokens: 0,
  max_output_tokens: 0,
  max_command_seconds: 300,
  max_no_progress_iterations: 3,
  max_iteration_turns: null,
};
const ZERO = { model_requests: 0, input_tokens: 0, output_tokens: 0 };
const LOOP_DONE = new Set(["completed", "failed", "cancelled"]);
const RUN_DONE = new Set(["completed", "failed", "cancelled"]);

// ---------------------------------------------------------------------------
// Views in the published shapes
// ---------------------------------------------------------------------------

export function triggerView(t: FakeTrigger) {
  return {
    id: t.id,
    tenant_id: t.tenant_id,
    harness_id: t.harness_id,
    entrypoint_agent_id: null,
    slug: t.slug,
    name: t.name,
    description: null,
    trigger_type: t.trigger_type,
    output_mode: "store",
    is_active: t.is_active,
    config: {},
    webhook_url: null,
    webhook_secret_set: false,
    last_run_at: null,
    next_run_at: null,
    created_at: now(),
    updated_at: now(),
  };
}

function runView(run: FakeRun) {
  return {
    id: run.id,
    tenant_id: run.tenant_id,
    trigger_definition_id: run.trigger.id,
    conversation_id: null,
    message_id: null,
    parent_run_id: run.parent?.id ?? null,
    root_run_id: run.parent?.id ?? run.id,
    run_type: run.parent ? "sub_run" : "trigger",
    source: "manual",
    workflow_name: run.trigger.slug,
    status: run.status,
    debug_mode: false,
    side_effect_policy: null,
    resume_after: null,
    waiting_reason: null,
    resumed_at: null,
    resume_cause_type: null,
    resume_cause_summary: null,
    output_mode: "store",
    contact_id: null,
    entrypoint_agent_slug: null,
    entrypoint_agent_name: null,
    acting_as: { kind: run.acting_as.kind, name: run.acting_as.name, key_prefix: null, user_id: null },
    entrypoint_node_ref: null,
    external_idempotency_key: null,
    payload: run.payload,
    result: null,
    error_summary: run.error_summary ?? (run.status === "failed" ? "The loop failed." : null),
    openai_trace_id: null,
    openai_trace_url: null,
    started_at: run.created_at,
    ended_at: run.ended_at,
    duration_ms: null,
    created_at: run.created_at,
    ...(run.olderInstance ? {} : { waiting_for_capacity: run.waiting_for_capacity ?? false }),
    operation_id: run.parent ? null : opIdOf("trigger_run", run.id),
  };
}

/** The run's orchestration state, in AgentRunOrchestrationDebugResponse's shape. */
function orchestrationView(run: FakeRun) {
  return {
    run_id: run.id,
    state_id: `state-${run.id}`,
    status: run.status,
    run_payload: run.payload,
    schema_version: "v1",
    step_index: run.stages?.length ?? 0,
    current_node_ref: null,
    last_node_ref: null,
    pending: null,
    review_payload: null,
    review_payload_preview: null,
    error: null,
    graph_snapshot: {},
    graph_node_count: run.stages?.length ?? 0,
    graph_edge_count: 0,
    metrics: { total_stage_duration_ms: 0, wait_time_ms: 0, approval_time_ms: 0, branch_duration_ms: 0, branch_count: 0, branch_status_counts: {}, failure_by_node_type: {} },
    stages: run.stages ?? [],
    replay_steps: [],
    edge_history: [],
    outputs: {},
    branches: {},
  };
}

function loopView(loop: FakeLoop) {
  const last = loop.iterations.at(-1);
  return {
    id: loop.id,
    owner_run_id: loop.run.id,
    root_run_id: loop.run.id,
    node_ref: "masterloop",
    node_name: "Masterloop",
    harness_id: loop.run.trigger.harness_id,
    sandbox_id: loop.plan.sandboxId ?? null,
    state: loop.state,
    reason: loop.reason,
    version: loop.version,
    iteration_number: loop.iterations.length,
    active_child_run_id: null,
    active_child_status: null,
    pause_requested: loop.pause_requested,
    cancel_requested: loop.state === "cancelled",
    cleanup_pending: false,
    deadline_at: new Date(Date.parse(loop.created_at) + 300_000).toISOString(),
    next_wakeup_at: null,
    updated_at: loop.updated_at,
    parent_completion_consumed_at: null,
    limits: LIMITS,
    charged_usage: ZERO,
    content_visible: true,
    goal: "Reach the target",
    progress_summary: last ? `iteration ${last.number}: ${last.outcome}` : null,
    checkpoint_ref: null,
    operation_id: opIdOf("loop", loop.id),
  };
}

function loopDetailView(loop: FakeLoop) {
  const paused = loop.state === "paused";
  return {
    ...loopView(loop),
    resume_enabled: paused,
    open_usage: null,
    blocked_reason: paused && loop.reason === "task_blocked" ? "child_result_unavailable" : null,
    iteration_turn_limit: null,
    terminal_result: loop.state === "completed" ? { status: "done" } : null,
    operation_counts: {},
    artifacts: [],
    sandbox_connection: null,
    ...(loop.plan.publishResume === false ? {} : resumeStanding(loop)),
    ...(paused ? loop.plan.pausedDetail : {}),
  };
}

/** The pauses that are a verdict on the task: a resume names the reason as reviewed. */
const TASK_VERDICTS = new Set(["task_blocked", "invalid_continuation", "completion_evidence_rejected"]);

function resumeKind(loop: FakeLoop): "plain" | "review_required" | "none" {
  return loop.plan.resume ?? (TASK_VERDICTS.has(loop.reason ?? "") ? "review_required" : "plain");
}

/** `resume` and `resume_refusal` as masterloop_runs.py publishes them: a loop that is not paused accepts no resume. */
function resumeStanding(loop: FakeLoop): { resume: "plain" | "review_required" | "none"; resume_refusal: string | null } {
  if (loop.state !== "paused") return { resume: "none", resume_refusal: "loop_resume_reason_not_allowed" };
  const resume = resumeKind(loop);
  return { resume, resume_refusal: resume === "none" ? "loop_control_unavailable" : null };
}

function iterationView(it: FakeIteration, plan: LoopPlan) {
  return {
    id: it.id,
    iteration_number: it.number,
    child_run_id: it.child_run_id,
    child_status: it.child_status,
    started_at: it.started_at,
    ended_at: it.ended_at,
    duration_ms: 25,
    accepted_at: it.accepted ? it.ended_at : null,
    reserved_usage: plan.reserve ?? ZERO,
    // Usage is reported with the acceptance; until then only the reservation is known.
    actual_usage: it.accepted ? (plan.use ?? ZERO) : null,
    accepted_result: it.accepted
      ? {
          version: "loop.continuation.v1",
          outcome: it.outcome,
          progress_summary: `count is ${it.number}`,
          progress_key: `count-${it.number}`,
          next_input: {},
          pending_operation_ids: [],
          result_refs: [],
          checkpoint_ref: null,
          validation_operation_id: null,
          resume_after: null,
          blocked_reason: null,
        }
      : null,
  };
}

function sandboxBase(s: FakeSandbox) {
  return {
    id: s.id,
    tenant_id: s.tenant_id,
    name: s.name,
    runner_tool_definition_id: "00000000-0000-4000-8000-00000000a001",
    runner_id: "00000000-0000-4000-8000-00000000a002",
    external_workspace_id: `ws-${s.name}`,
    profile_id: "python-v1",
    execution_mode: s.execution_mode,
    limits: { workspace_bytes: 5368709120, max_command_seconds: 300, max_response_bytes: 65536, max_write_bytes: 1048576 },
    policy: {
      allow_read: true,
      allow_write: true,
      allow_execute: true,
      allow_export: true,
      registration_retention_days: 30,
      allowed_validation_profiles: {},
      machine_api_key_ids: s.machine_api_key_ids,
    },
    allowed_harness_ids: s.allowed_harness_ids,
    lifecycle_state: s.lifecycle_state,
    config_version: s.config_version,
    observed_revision: `revision-${s.revision}`,
    readiness: s.readiness,
    writer_owner_run_id: s.writer_owner_run_id,
    writer_epoch: 1,
    writer_expires_at: null,
    created_at: now(),
    updated_at: now(),
  };
}

const connection = () => ({ state: "connected", last_contact_at: now() });
const listItem = (s: FakeSandbox) => ({ ...sandboxBase(s), connection: connection() });
const detail = (s: FakeSandbox) => ({ ...sandboxBase(s), connection: connection(), has_work_history: s.activity.length > 0 });

function activityView(s: FakeSandbox, a: FakeActivity) {
  return {
    id: a.id,
    owner_run_id: a.owner_run_id,
    child_run_id: null,
    harness_id: a.harness_id,
    action: a.action,
    kind: a.action === "run_command" ? "command" : "file",
    status: "succeeded",
    result_revision: s.revision,
    workspace_revision: `revision-${s.revision}`,
    cancel_requested: false,
    can_cancel: false,
    artifact: null,
    created_at: a.created_at,
    updated_at: a.created_at,
    operation_id: opIdOf("sandbox_operation", a.id),
  };
}

function jobView(job: FakeJob) {
  return {
    id: job.id,
    sandbox_id: job.sandbox.id,
    run_id: job.run_id,
    direction: job.direction,
    expected_workspace_revision: job.revision,
    status: job.status,
    phase: job.phase,
    operation_link_id: job.operation_link_id,
    artifact_id: job.artifact_id,
    error_code: job.error_code,
    deadline: new Date(Date.parse(job.created_at) + 86_400_000).toISOString(),
    upload_deadline: new Date(Date.parse(job.created_at) + 900_000).toISOString(),
    created_at: job.created_at,
    operation_id: opIdOf("sandbox_archive_job", job.id),
  };
}

// ---------------------------------------------------------------------------
// A small tar reader and writer of the fake's own, as strict as the runner
// ---------------------------------------------------------------------------

/** Reads an uncompressed tar as the runner does: USTAR magic on every header, files and folders only, an end block. */
export function readTar(bytes: Buffer): Map<string, Buffer | null> {
  const entries = new Map<string, Buffer | null>();
  let offset = 0;
  let paxPath: string | undefined;
  const field = (block: Buffer, start: number, length: number) => {
    const end = block.indexOf(0, start);
    return block.toString("utf8", start, end === -1 || end > start + length ? start + length : end);
  };
  for (;;) {
    if (offset + 512 > bytes.length) throw new Error("archive_invalid: no end-of-archive block");
    const block = bytes.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) return entries;
    if (block.toString("latin1", 257, 262) !== "ustar") throw new Error("archive_invalid: header without ustar magic");
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
    if (sum !== Number.parseInt(field(block, 148, 8).trim(), 8)) throw new Error("archive_invalid: bad checksum");
    const size = Number.parseInt(field(block, 124, 12), 8);
    const type = String.fromCodePoint(block[156]!);
    const prefix = field(block, 345, 155);
    let name = (prefix ? `${prefix}/` : "") + field(block, 0, 100);
    const data = bytes.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const record = data.toString("utf8");
      const at = record.indexOf(" path=");
      if (at < 1 || !record.endsWith("\n") || record.indexOf("\n") !== record.length - 1) throw new Error("archive_invalid: PAX record other than path");
      paxPath = record.slice(at + " path=".length, -1);
      continue;
    }
    if (paxPath !== undefined) {
      name = paxPath;
      paxPath = undefined;
    }
    if (type === "5") entries.set(name.endsWith("/") ? name.slice(0, -1) : name, null);
    else if (type === "0") entries.set(name, Buffer.from(data));
    else throw new Error(`archive_invalid: entry type ${type}`);
  }
}

function writeTar(files: Map<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, content] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write("0000600\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    parts.push(h, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Moving records forward
// ---------------------------------------------------------------------------

function outcomeOf(failing: boolean, done: boolean): FakeIteration["outcome"] {
  if (failing) return "blocked";
  return done ? "done" : "continue";
}

/** One step of a loop: the next iteration finishes, or it pauses or ends. */
export function tickLoop(state: LongRunningState, loop: FakeLoop): void {
  if (LOOP_DONE.has(loop.state) || loop.state === "paused") return;
  const pending = loop.iterations.at(-1);
  if (pending && !pending.accepted && pending.child_status === "completed") {
    // The controller's next tick accepts the iteration that ended at the last one.
    pending.accepted = true;
    loop.version++;
    settleLoop(state, loop, pending.number);
    return;
  }
  const number = loop.iterations.length + 1;
  const blocked = loop.plan.blockAt === number;
  const failing = loop.plan.failAt === number;
  const done = !failing && !blocked && number >= loop.plan.iterations;
  const child: FakeRun = {
    id: randomUUID(),
    tenant_id: loop.run.tenant_id,
    trigger: loop.run.trigger,
    status: blocked ? "failed" : "completed",
    payload: {},
    acting_as: loop.run.acting_as,
    created_at: now(),
    ended_at: now(),
    error_summary: blocked ? "ContextBudgetError: context_budget_current_turn_exceeded" : null,
    parent: loop.run,
  };
  state.runs.push(child);
  loop.iterations.push({
    id: randomUUID(),
    number,
    child_run_id: child.id,
    started_at: now(),
    ended_at: now(),
    outcome: outcomeOf(failing, done),
    child_status: blocked ? "failed" : "completed",
    accepted: !blocked && !loop.plan.acceptLater,
  });
  loop.version++;
  loop.updated_at = now();
  if (blocked) {
    loop.state = "paused";
    loop.reason = loop.plan.pauseReason ?? "task_blocked";
    loop.run.status = "waiting";
    return;
  }
  if (loop.plan.acceptLater) return;
  settleLoop(state, loop, number);
}

/** What follows an accepted iteration: the loop fails, completes, pauses on request, or goes on. */
function settleLoop(state: LongRunningState, loop: FakeLoop, number: number): void {
  const failing = loop.plan.failAt === number;
  const done = !failing && number >= loop.plan.iterations;
  const sandbox = state.sandboxes.find((s) => s.id === loop.plan.sandboxId);
  if (sandbox) {
    sandbox.activity.push({ id: randomUUID(), owner_run_id: loop.run.id, harness_id: loop.run.trigger.harness_id, action: "run_command", log: `iteration ${number}: ok\n`, created_at: now() });
  }
  if (failing) {
    loop.state = "failed";
    loop.reason = "blocked";
    finishRun(loop.run, "failed", sandbox);
  } else if (done) {
    loop.state = "completed";
    if (sandbox) {
      for (const [file, content] of Object.entries(loop.plan.output ?? {})) sandbox.files.set(file, Buffer.from(content));
      sandbox.revision++;
    }
    finishRun(loop.run, "completed", sandbox);
  } else if (loop.pause_requested) {
    loop.state = "paused";
    loop.reason = "user_paused";
    loop.pause_requested = false;
    loop.run.status = "waiting";
  }
}

function finishRun(run: FakeRun, status: string, sandbox: FakeSandbox | undefined) {
  run.status = status;
  run.ended_at = now();
  if (sandbox?.writer_owner_run_id === run.id) sandbox.writer_owner_run_id = null;
}

function tickJob(job: FakeJob): void {
  if (job.status !== "active") return;
  const sandbox = job.sandbox;
  if (job.phase === "acquire") job.phase = "operation";
  else if (job.phase === "operation") {
    job.operation_link_id ??= randomUUID();
    if (job.direction === "import") job.phase = "awaiting_upload";
    else {
      if (`revision-${sandbox.revision}` !== job.revision) return failJob(job, "sandbox_revision_conflict");
      const chosen = new Map([...sandbox.files].filter(([name]) => !job.paths || job.paths.some((p) => name === p || name.startsWith(`${p}/`))));
      job.export = writeTar(chosen);
      job.artifact_id = randomUUID();
      job.phase = "staging";
    }
  } else if (job.phase === "awaiting_upload") {
    if (job.uploaded) job.phase = "transfer";
  } else if (job.phase === "transfer") {
    if (`revision-${sandbox.revision}` !== job.revision) return failJob(job, "sandbox_revision_conflict");
    let entries;
    try {
      entries = readTar(job.uploaded!);
    } catch {
      return failJob(job, "sandbox_transfer_source_invalid");
    }
    sandbox.files = new Map([...entries].filter((e): e is [string, Buffer] => e[1] !== null));
    sandbox.revision++;
    job.phase = "finish";
  } else if (job.phase === "staging" || job.phase === "finish") {
    job.status = "succeeded";
    job.phase = "done";
  }
}

function failJob(job: FakeJob, code: string): void {
  job.status = "failed";
  job.error_code = code;
}

// ---------------------------------------------------------------------------
// Routes, by path segment; each handler answers or returns false
// ---------------------------------------------------------------------------

interface Request {
  state: LongRunningState;
  rc: RouteContext;
  /** The path's segments after /api/v1/. */
  seg: string[];
  body: Record<string, unknown>;
  header(name: string): string | undefined;
}

/** Answers, then tells the router the request was handled. */
function answer(rc: RouteContext, status: number, body: unknown): true {
  rc.send(status, body);
  return true;
}

const isId = (value: string | undefined): value is string => value !== undefined && UUID.test(value);
const loopsOfRun = (state: LongRunningState, run: FakeRun) => state.loops.filter((l) => l.run.id === run.id);

export function handleLongRunning(state: LongRunningState, rc: RouteContext): boolean {
  if (!rc.path.startsWith("/api/v1/")) return false;
  const req: Request = {
    state,
    rc,
    seg: rc.path.slice("/api/v1/".length).split("/"),
    body: (rc.json ?? {}) as Record<string, unknown>,
    header(name) {
      const value = rc.headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    },
  };
  const [area, second, third] = req.seg;
  if (area === "triggers" && second === "runs" && isId(third)) return runRoutes(req);
  if (area === "triggers") return triggerRoutes(req);
  if (area === "tenants" && third === "api-keys" && req.seg.length === 3) return apiKeyRoute(req);
  if (area === "sandboxes") return sandboxRoutes(req);
  return false;
}

// Triggers ------------------------------------------------------------------

function triggerRoutes(req: Request): boolean {
  const { state, rc, seg } = req;
  const tid = rc.tenantId;
  if (seg.length === 1 && rc.method === "GET") {
    const harness = rc.url.searchParams.get("harness_id");
    return answer(rc, 200, state.triggers.filter((t) => t.tenant_id === tid && (!harness || t.harness_id === harness)).map(triggerView));
  }
  if (!isId(seg[1]) || seg.length > 3) return false;
  const trigger = state.triggers.find((t) => t.tenant_id === tid && t.id === seg[1]);
  if (!trigger) return answer(rc, 404, { detail: "Trigger not found" });
  if (seg.length === 2 && rc.method === "GET") return answer(rc, 200, triggerView(trigger));
  if (seg[2] === "run" && rc.method === "POST") return startRun(req, trigger);
  if (seg[2] === "execution-identity") return identityRoute(req, trigger);
  return false;
}

function runOperation(state: LongRunningState, run: FakeRun): (advance: boolean) => LiveView {
  return (advance) => {
    if (advance) for (const loop of loopsOfRun(state, run)) tickLoop(state, loop);
    const paused = loopsOfRun(state, run).some((l) => l.state === "paused");
    const statuses: Record<string, LiveView["status"]> = { completed: "succeeded", failed: "failed", cancelled: "cancelled" };
    const status = paused ? "needs_action" : (statuses[run.status] ?? "running");
    return {
      status,
      phase: run.status,
      error: status === "failed" ? { code: "trigger_run_failed", message: "The run failed." } : null,
      action: paused ? { reason: "The loop is paused (user_paused) and goes on once someone resumes it.", admin_url: `https://admin.example/triggers/runs/${run.id}` } : null,
      result_ref: { type: "agent_run", id: run.id, href: `/api/v1/triggers/runs/${run.id}` },
    };
  };
}

function loopOperation(state: LongRunningState, loop: FakeLoop): (advance: boolean) => LiveView {
  const statuses: Record<string, LiveView["status"]> = { paused: "needs_action", completed: "succeeded", failed: "failed", cancelled: "cancelled" };
  return (advance) => {
    if (advance) tickLoop(state, loop);
    const status = statuses[loop.state] ?? "running";
    return { status, phase: loop.state, error: status === "failed" ? { code: "loop_failed", message: "The loop failed." } : null };
  };
}

function startRun(req: Request, trigger: FakeTrigger): boolean {
  const { state, rc, body } = req;
  const run: FakeRun = {
    id: randomUUID(),
    tenant_id: rc.tenantId,
    trigger,
    status: "running",
    payload: (body.payload as Record<string, unknown>) ?? {},
    acting_as: { kind: rc.actor.kind, name: rc.actor.name },
    created_at: now(),
    ended_at: null,
  };
  state.runs.push(run);
  rc.liveOperation("trigger_run", run.id, rc.tenantId, runOperation(state, run));
  if (trigger.loop) {
    const loop: FakeLoop = {
      id: randomUUID(),
      tenant_id: rc.tenantId,
      run,
      plan: trigger.loop,
      state: "running",
      reason: null,
      version: 1,
      pause_requested: false,
      iterations: [],
      created_at: now(),
      updated_at: now(),
      controls: new Map(),
    };
    state.loops.push(loop);
    const sandbox = state.sandboxes.find((s) => s.id === trigger.loop!.sandboxId);
    if (sandbox) sandbox.writer_owner_run_id = run.id;
    rc.liveOperation("loop", loop.id, rc.tenantId, loopOperation(state, loop));
  } else {
    // Without a loop the run completes; a stage's error went to the blueprint's failure output.
    run.status = "completed";
    run.ended_at = now();
    const failure = trigger.stageError;
    if (failure) {
      run.stages = [
        { key: "node:start", stage_index: 1, status: "completed", node_ref: { kind: "node", id: "start" }, error: null },
        {
          key: failure.key,
          stage_index: failure.index,
          status: "completed_with_error",
          node_ref: { kind: "node", id: failure.key.replace(/^node:/, "") },
          error: { type: failure.type, message: failure.message, failed_at: now() },
        },
      ];
    }
  }
  return answer(rc, 202, runView(run));
}

function identityRoute(req: Request, trigger: FakeTrigger): boolean {
  const { state, rc, body } = req;
  const view = () => {
    const key = state.apiKeys.find((k) => k.id === trigger.identity.api_key_id);
    const sandboxes = state.sandboxes.filter((s) => s.tenant_id === rc.tenantId && s.id === trigger.loop?.sandboxId);
    return {
      trigger_id: trigger.id,
      api_key_id: trigger.identity.api_key_id,
      version: trigger.identity.version,
      required_solutions: trigger.required_solutions,
      sandboxes_missing_key: key ? sandboxes.filter((s) => !s.machine_api_key_ids.includes(key.id)).map((s) => ({ id: s.id, name: s.name })) : [],
      selected_key: key ? { id: key.id, name: key.name, key_prefix: key.key_prefix, problem: null, uncovered_solutions: [] } : null,
    };
  };
  if (rc.method === "GET") return answer(rc, 200, view());
  if (rc.method !== "PUT") return false;
  if (body.expected_version !== trigger.identity.version) return answer(rc, 409, { detail: "execution_identity_version_conflict" });
  const keyId = body.api_key_id as string | null;
  if (keyId !== null && !state.apiKeys.some((k) => k.id === keyId && k.tenant_id === rc.tenantId && k.is_active)) {
    return answer(rc, 422, { detail: "execution_identity_key_unavailable" });
  }
  trigger.identity = { api_key_id: keyId, version: trigger.identity.version + 1 };
  return answer(rc, 200, view());
}

function apiKeyRoute(req: Request): boolean {
  const { state, rc, seg } = req;
  if (rc.method !== "GET") return false;
  if (seg[1] !== rc.tenantId) return answer(rc, 403, { detail: "Insufficient permissions" });
  const keys = state.apiKeys.filter((k) => k.tenant_id === rc.tenantId);
  const offset = Number(rc.url.searchParams.get("offset") ?? 0);
  const limit = Number(rc.url.searchParams.get("limit") ?? 50);
  const items = keys
    .slice(offset, offset + limit)
    .map((k) => ({ id: k.id, name: k.name, key_prefix: k.key_prefix, scopes: ["admin"], harness_ids: null, is_active: k.is_active, last_used_at: null, created_at: now() }));
  return answer(rc, 200, { items, total: keys.length });
}

// Runs and loops ------------------------------------------------------------

function runRoutes(req: Request): boolean {
  const { state, rc, seg } = req;
  // A run's traces are the base fake's.
  if (seg[3] === "traces") return false;
  const run = state.runs.find((r) => r.tenant_id === rc.tenantId && r.id === seg[2]);
  if (!run) return answer(rc, 404, { detail: "Run not found" });
  const loops = loopsOfRun(state, run);
  const rest = seg.slice(3);
  if (rest.length === 0 && rc.method === "GET") return answer(rc, 200, runView(run));
  if (rest[0] === "orchestration-state" && rest.length === 1 && rc.method === "GET") {
    return run.stages ? answer(rc, 200, orchestrationView(run)) : answer(rc, 404, { detail: "Run has no orchestration state" });
  }
  if (rest[0] === "cancel" && rest.length === 1 && rc.method === "POST") return cancelRun(state, rc, run, loops);
  if (rest[0] !== "loops") return false;
  if (rest.length === 1 && rc.method === "GET") {
    for (const loop of loops) tickLoop(state, loop);
    return answer(rc, 200, { items: loops.map(loopView), next_cursor: null });
  }
  const loop = loops.find((l) => l.id === rest[1]);
  if (!loop) return answer(rc, 404, { detail: "loop_not_found" });
  if (rest.length === 2 && rc.method === "GET") {
    tickLoop(state, loop);
    return answer(rc, 200, loopDetailView(loop));
  }
  if (rest[2] === "iterations" && rc.method === "GET") {
    const cursor = Number(rc.url.searchParams.get("cursor") ?? 0);
    const limit = Number(rc.url.searchParams.get("limit") ?? 20);
    const items = loop.iterations.slice(cursor, cursor + limit).map((it) => iterationView(it, loop.plan));
    return answer(rc, 200, { items, next_cursor: cursor + limit < loop.iterations.length ? cursor + limit : null, content_visible: true });
  }
  if ((rest[2] === "pause" || rest[2] === "resume") && rc.method === "POST") return controlLoop(req, loop, rest[2]);
  return false;
}

function cancelRun(state: LongRunningState, rc: RouteContext, run: FakeRun, loops: FakeLoop[]): boolean {
  if (!RUN_DONE.has(run.status)) {
    for (const loop of loops.filter((l) => !LOOP_DONE.has(l.state))) {
      loop.state = "cancelled";
      loop.version++;
    }
    finishRun(run, "cancelled", state.sandboxes.find((s) => s.writer_owner_run_id === run.id));
  }
  return answer(rc, 200, runView(run));
}

function controlLoop(req: Request, loop: FakeLoop, action: "pause" | "resume"): boolean {
  const { rc, body } = req;
  const key = req.header("idempotency-key");
  if (!isId(key)) return answer(rc, 422, { detail: [{ loc: ["header", "Idempotency-Key"], msg: "Field required", type: "missing" }] });
  const replay = loop.controls.get(key);
  if (replay) return answer(rc, 202, replay);
  if (body.expected_version !== loop.version) return answer(rc, 409, { detail: "loop_version_conflict" });
  if (action === "pause") {
    if (LOOP_DONE.has(loop.state) || loop.state === "paused") return answer(rc, 409, { detail: "loop_not_active" });
    loop.pause_requested = true;
  } else {
    if (loop.state !== "paused") return answer(rc, 409, { detail: "loop_not_paused" });
    const reviewed = body.reviewed_reason as string | undefined;
    const kind = resumeKind(loop);
    if (reviewed !== undefined && kind !== "review_required") return answer(rc, 422, { detail: "loop_control_invalid" });
    if (kind === "none") return answer(rc, 409, { detail: "loop_control_unavailable" });
    if (reviewed !== undefined && reviewed !== loop.reason) return answer(rc, 409, { detail: "loop_review_reason_mismatch" });
    if (reviewed === undefined && kind === "review_required") return answer(rc, 409, { detail: "loop_resume_review_required" });
    loop.state = "running";
    loop.reason = null;
    loop.run.status = "running";
  }
  loop.version++;
  const receipt = {
    loop_id: loop.id,
    action,
    state: loop.state,
    reason: loop.reason,
    version: loop.version,
    pause_requested: loop.pause_requested,
    accepted_at: now(),
    reviewed_reason: (body.reviewed_reason as string | undefined) ?? null,
  };
  loop.controls.set(key, receipt);
  return answer(rc, 202, receipt);
}

// Sandboxes -----------------------------------------------------------------

interface SandboxRequest extends Request {
  sandbox: FakeSandbox;
  /** The segments after /sandboxes/{id}. */
  rest: string[];
  harness: string | null;
}

function sandboxRoutes(req: Request): boolean {
  const { state, rc, seg } = req;
  if (seg.length === 1 && rc.method === "GET") {
    const after = rc.url.searchParams.get("after");
    const limit = Number(rc.url.searchParams.get("limit") ?? 50);
    const all = state.sandboxes.filter((s) => s.tenant_id === rc.tenantId).sort((a, b) => (a.id < b.id ? -1 : 1));
    return answer(rc, 200, all.filter((s) => !after || s.id > after).slice(0, limit).map(listItem));
  }
  if (!isId(seg[1])) return false;
  const sandbox = state.sandboxes.find((s) => s.tenant_id === rc.tenantId && s.id === seg[1]);
  if (!sandbox) return answer(rc, 404, { detail: "sandbox_not_found" });
  const sreq: SandboxRequest = { ...req, sandbox, rest: seg.slice(2), harness: rc.url.searchParams.get("harness_id") };
  const [first] = sreq.rest;
  if (sreq.rest.length === 0 && rc.method === "GET") return answer(rc, 200, detail(sandbox));
  if (first === "validate" && rc.method === "POST") return validateSandbox(sreq);
  if (first === "refresh-workspace" && rc.method === "POST") return refreshSandbox(sreq);
  if (first === "files" && rc.method === "GET") return sreq.rest[1] === "content" ? fileContent(sreq) : listFiles(sreq);
  if (first === "activity" && rc.method === "GET") return activityRoutes(sreq);
  if (first === "artifact-jobs") return jobRoutes(sreq);
  return false;
}

/** The solution a read names, when the Sandbox allows it; otherwise answers and returns false. */
function allowedHarness(req: SandboxRequest): boolean {
  if (!isId(req.harness ?? undefined)) {
    answer(req.rc, 422, { detail: [{ loc: ["query", "harness_id"], msg: "Field required", type: "missing" }] });
    return false;
  }
  if (!req.sandbox.allowed_harness_ids.includes(req.harness!)) {
    answer(req.rc, 403, { detail: "sandbox_harness_not_allowed" });
    return false;
  }
  return true;
}

/** The If-Match the version routes require; otherwise answers and returns false. */
function versionMatches(req: SandboxRequest): boolean {
  const value = req.header("if-match");
  if (!value) {
    answer(req.rc, 428, { detail: "If-Match with the current Sandbox config version is required" });
    return false;
  }
  if (value !== `"${req.sandbox.config_version}"`) {
    answer(req.rc, 409, { detail: "sandbox_config_version_changed" });
    return false;
  }
  return true;
}

function validateSandbox(req: SandboxRequest): boolean {
  const { sandbox } = req;
  if (!versionMatches(req)) return true;
  sandbox.config_version += 2;
  sandbox.lifecycle_state = sandbox.healthy ? "ready" : "unavailable";
  const quota = sandbox.healthy ? { name: "workspace_quota", passed: true } : { name: "workspace_quota", passed: false, reason: "quota_unavailable" };
  sandbox.readiness = { passed: sandbox.healthy, checks: [{ name: "connection_contract", passed: true }, quota], run_id: randomUUID(), checked_at: now() };
  return answer(req.rc, 200, sandboxBase(sandbox));
}

function refreshSandbox(req: SandboxRequest): boolean {
  const { sandbox, rc } = req;
  const key = req.header("idempotency-key");
  if (!key) return answer(rc, 422, { detail: [{ loc: ["header", "idempotency-key"], msg: "Field required", type: "missing" }] });
  if (!versionMatches(req)) return true;
  if (sandbox.execution_mode !== "customer_vm") return answer(rc, 422, { detail: "sandbox_workspace_refresh_unavailable" });
  if (!sandbox.refreshKeys.has(key)) {
    sandbox.revision++;
    sandbox.config_version++;
    sandbox.refreshKeys.set(key, sandbox.revision);
  }
  return answer(rc, 200, sandboxBase(sandbox));
}

function listFiles(req: SandboxRequest): boolean {
  const { sandbox, rc } = req;
  if (!allowedHarness(req)) return true;
  const raw = rc.url.searchParams.get("path") ?? ".";
  let folder = raw;
  if (raw === ".") folder = "";
  else if (raw.startsWith("./")) folder = raw.slice(2);
  const limit = Number(rc.url.searchParams.get("limit") ?? 50);
  const prefix = folder ? `${folder}/` : "";
  const children = new Map<string, { path: string; kind: "file" | "directory"; size: number }>();
  for (const [name, content] of sandbox.files) {
    if (!name.startsWith(prefix)) continue;
    const [first, ...more] = name.slice(prefix.length).split("/");
    const child = `${prefix}${first}`;
    children.set(child, more.length ? { path: child, kind: "directory", size: 0 } : { path: child, kind: "file", size: content.length });
  }
  const entries = [...children.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  const start = Number(rc.url.searchParams.get("cursor") ?? 0);
  return answer(rc, 200, {
    run_id: randomUUID(),
    entries: entries.slice(start, start + limit),
    next_cursor: start + limit < entries.length ? String(start + limit) : null,
    workspace_revision: `revision-${sandbox.revision}`,
    consistent: true,
  });
}

function fileContent(req: SandboxRequest): boolean {
  const { sandbox, rc } = req;
  if (!allowedHarness(req)) return true;
  const file = sandbox.files.get(rc.url.searchParams.get("path") ?? "");
  if (!file) return answer(rc, 404, { detail: "sandbox_path_not_found" });
  const offset = Number(rc.url.searchParams.get("offset") ?? 0);
  const length = Number(rc.url.searchParams.get("length") ?? 32768);
  const encoding = rc.url.searchParams.get("encoding") ?? "base64";
  const slice = file.subarray(offset, offset + length);
  return answer(rc, 200, {
    run_id: randomUUID(),
    content: slice.toString(encoding === "utf-8" ? "utf8" : "base64"),
    encoding,
    offset,
    next_offset: offset + length < file.length ? offset + length : null,
    size: file.length,
    digest: createHash("sha256").update(file).digest("hex"),
    workspace_revision: `revision-${sandbox.revision}`,
    consistent: true,
  });
}

function activityRoutes(req: SandboxRequest): boolean {
  const { sandbox, rc, rest, harness } = req;
  if (!allowedHarness(req)) return true;
  if (rest.length === 1) {
    const entries = sandbox.activity.filter((a) => a.harness_id === harness).map((a) => activityView(sandbox, a));
    return answer(rc, 200, { run_id: randomUUID(), entries, next_cursor: null });
  }
  const activity = sandbox.activity.find((a) => a.id === rest[1]);
  if (!activity) return answer(rc, 404, { detail: "sandbox_operation_unavailable" });
  if (rest.length === 2) return answer(rc, 200, { run_id: activity.owner_run_id, operation: activityView(sandbox, activity) });
  if (rest[2] === "logs") {
    const bytes = Buffer.from(activity.log);
    const digest = createHash("sha256").update(bytes).digest("hex");
    return answer(rc, 200, {
      run_id: activity.owner_run_id,
      operation_link_id: activity.id,
      content_base64: bytes.toString("base64"),
      encoding: "utf-8",
      snapshot_digest: digest,
      offset: 0,
      next_offset: null,
      size_bytes: bytes.length,
      page_truncated: false,
      retention_limited: true,
      complete_history: false,
      content_digest: digest,
    });
  }
  if (rest[2] !== "receipt") return false;
  if (sandbox.execution_mode !== "isolated_container") return answer(rc, 404, { detail: "sandbox_validation_receipt_unavailable" });
  return answer(rc, 200, { run_id: activity.owner_run_id, operation_link_id: activity.id, receipt: { policy: "runner_validation", passed: true, profile: "orders-v1" } });
}

// Archive jobs --------------------------------------------------------------

function jobRoutes(req: SandboxRequest): boolean {
  const { state, sandbox, rc, rest } = req;
  if (rest.length === 1 && rc.method === "POST") return createJob(req);
  const job = state.jobs.get(rest[1] ?? "");
  if (job?.sandbox.id !== sandbox.id) return answer(rc, 404, { detail: "sandbox_artifact_job_unavailable" });
  if (rest.length === 2 && rc.method === "GET") {
    tickJob(job);
    return answer(rc, 200, jobView(job));
  }
  if (rest[2] !== "content") return false;
  if (rc.method === "PUT") return uploadJob(req, job);
  if (rc.method === "GET") return downloadJob(rc, job);
  return false;
}

function jobOperation(job: FakeJob): (advance: boolean) => LiveView {
  return (advance) => {
    if (advance) tickJob(job);
    const status = job.status === "active" || job.status === "cancelling" ? "running" : job.status;
    return { status, phase: job.phase, error: job.status === "failed" ? { code: job.error_code ?? "failed", message: "The archive job failed." } : null };
  };
}

/** Why the instance refuses a new job, or undefined. */
function jobRefusal(req: SandboxRequest): [number, string] | undefined {
  const { sandbox, body } = req;
  if (sandbox.execution_mode === "customer_vm") return [422, "sandbox_capability_unavailable"];
  if (sandbox.lifecycle_state !== "ready") return [409, "sandbox_not_ready"];
  if (sandbox.writer_owner_run_id) return [409, "sandbox_writer_unresolved"];
  if (typeof body.harness_id !== "string" || !sandbox.allowed_harness_ids.includes(body.harness_id)) return [403, "sandbox_permission_denied"];
  return undefined;
}

function createJob(req: SandboxRequest): boolean {
  const { state, sandbox, rc, body } = req;
  const key = req.header("idempotency-key");
  if (!isId(key)) return answer(rc, 422, { detail: "sandbox_idempotency_key_invalid" });
  const spec = JSON.stringify(body);
  const existing = state.jobs.get(`${sandbox.id}:${key}`);
  if (existing) return existing.spec === spec ? answer(rc, 202, jobView(existing)) : answer(rc, 409, { detail: "sandbox_idempotency_conflict" });
  const refusal = jobRefusal(req);
  if (refusal) return answer(rc, refusal[0], { detail: refusal[1] });
  const job: FakeJob = {
    id: randomUUID(),
    tenant_id: rc.tenantId,
    sandbox,
    run_id: randomUUID(),
    direction: body.direction === "export" ? "export" : "import",
    revision: typeof body.expected_workspace_revision === "string" ? body.expected_workspace_revision : "",
    status: "active",
    phase: "acquire",
    sha256: typeof body.sha256 === "string" ? body.sha256 : null,
    size: typeof body.size_bytes === "number" ? body.size_bytes : null,
    paths: Array.isArray(body.paths) ? body.paths.map(String) : null,
    operation_link_id: null,
    artifact_id: null,
    error_code: null,
    uploaded: null,
    export: null,
    created_at: now(),
    spec,
  };
  state.jobs.set(`${sandbox.id}:${key}`, job);
  state.jobs.set(job.id, job);
  rc.liveOperation("sandbox_archive_job", job.id, rc.tenantId, jobOperation(job));
  return answer(rc, 202, jobView(job));
}

function uploadJob(req: SandboxRequest, job: FakeJob): boolean {
  const { rc } = req;
  if (job.direction !== "import" || job.status !== "active" || job.phase !== "awaiting_upload") return answer(rc, 409, { detail: "sandbox_artifact_upload_not_ready" });
  if (req.header("content-type") !== "application/octet-stream" || req.header("content-length") !== String(job.size)) {
    return answer(rc, 422, { detail: "sandbox_artifact_upload_headers_invalid" });
  }
  if (rc.raw.length !== job.size || createHash("sha256").update(rc.raw).digest("hex") !== job.sha256) {
    return answer(rc, 422, { detail: "sandbox_transfer_source_mismatch" });
  }
  job.uploaded = Buffer.from(rc.raw);
  return answer(rc, 200, jobView(job));
}

function downloadJob(rc: RouteContext, job: FakeJob): boolean {
  if (job.status !== "succeeded" || job.direction !== "export" || !job.export) return answer(rc, 409, { detail: "sandbox_artifact_not_ready" });
  rc.sendBytes(200, job.export, {
    "content-type": "application/x-tar",
    "content-disposition": `attachment; filename="sandbox-${job.id}.tar"`,
    "x-content-sha256": createHash("sha256").update(job.export).digest("hex"),
  });
  return true;
}
