import type { Context } from "./command.js";
import type { ApiClient } from "./http.js";
import { changedBy, formatValue, readLimits, type Limit, type PublishedLimits } from "./limits.js";
import { cavelonCommand, fill } from "./printed.js";
import type { Operation, OperationNote } from "./operations.js";

/**
 * Run capacity and model endpoint capacity, as an instance publishes them.
 * A trigger or channel run that
 * meets a full run cap stays queued and the instance retries it every 5 to
 * 20 seconds; a call to a model endpoint at its limit waits for a slot. The
 * kit says so instead of calling such a run stuck, and when a run or a call
 * is refused for capacity, it names the limit to raise and who raises it.
 *
 * A run says itself whether it waits for run capacity (`waiting_for_capacity`),
 * so the kit says so from the first poll. Only on
 * an instance that does not publish the field does it infer the wait from how
 * long the run has been queued.
 */

/** On an instance without `waiting_for_capacity`: a run still queued after this long waits for run capacity rather than for a normal start (the instance retries every 5–20 s). */
export const CAPACITY_WAIT_AFTER_MS = 30_000;

export const RUN_CAPACITY_BUSY = "run_capacity_busy";
export const MODEL_ENDPOINT_BUSY = "model_endpoint_busy";
export type CapacityCode = typeof RUN_CAPACITY_BUSY | typeof MODEL_ENDPOINT_BUSY;
export const CAPACITY_CODES: readonly CapacityCode[] = [RUN_CAPACITY_BUSY, MODEL_ENDPOINT_BUSY];

/** The published run caps, the tenant's first; the slot waits the instance applies. */
export const RUN_CAP_KEYS = ["max_concurrent_agent_runs_per_tenant", "max_concurrent_agent_runs_global"];
export const RUN_SLOT_WAIT_KEY = "agent_run_slot_wait_seconds";
export const ENDPOINT_SLOT_WAIT_KEY = "model_endpoint_slot_wait_seconds";
export const CAPACITY_KEYS = [...RUN_CAP_KEYS, RUN_SLOT_WAIT_KEY, ENDPOINT_SLOT_WAIT_KEY];

/** The route that gives one tenant its own run cap (`limits.manage`). */
const TENANT_LIMITS_ROUTE = "PATCH /api/v1/tenants/{tenant_id}/limits";
/** The route of the operator's platform run caps. */
const PLATFORM_CAPS_ROUTE = "/api/v1/platform-settings/runs/capacity";

/** The instance's docs pages on capacity, read with `cavelon docs get`. */
export const CAPACITY_CONCEPT_PAGE = "concepts/capacity-and-concurrency";
export const CAPACITY_TUTORIAL_PAGE = "tutorials/plan-model-capacity";
export const CAPACITY_PAGES = [CAPACITY_CONCEPT_PAGE, CAPACITY_TUTORIAL_PAGE];

/** Run and operation statuses of work that has not started yet. */
const NOT_STARTED: ReadonlySet<string> = new Set(["queued", "pending"]);

/** Where an operator changes a platform value, from the entry's `origin`; undefined when the instance does not say. */
export function originText(limit: Pick<Limit, "origin" | "setting">): string | undefined {
  switch (limit.origin) {
    case "platform_setting":
      return `a platform setting, changed in the Admin (Platform › Operations › Rate limits) or at ${PLATFORM_CAPS_ROUTE}`;
    case "environment":
      return `the environment variable ${limit.setting} (a deploy), until a platform setting replaces it in the Admin`;
    case "default":
      return `the built-in default; the operator sets it in the Admin (Platform › Operations › Rate limits) or with ${limit.setting}`;
    default:
      return limit.origin ? `origin ${limit.origin}` : undefined;
  }
}

/** One run cap in words: its value, where it is set and who changes it. */
export function capText(limit: Limit): string {
  const value = formatValue(limit);
  if (limit.source === "tenant") {
    return `${limit.key} is ${value}, this tenant's own cap (${limit.setting}; ${changedBy(limit)} changes it with ${TENANT_LIMITS_ROUTE})`;
  }
  const where = originText(limit) ?? `${limit.setting} (source: ${limit.source})`;
  return `${limit.key} is ${value}, set by ${where}; ${changedBy(limit)} changes it`;
}

/** The published run caps, the tenant's first. */
export function runCaps(limits: PublishedLimits | undefined): Limit[] {
  return RUN_CAP_KEYS.map((key) => limits?.byKey.get(key)).filter((l): l is Limit => Boolean(l));
}

/** The capacity entries of the published limits, in a fixed order; for `status`. */
export function capacityLimits(limits: PublishedLimits | undefined): Limit[] {
  return CAPACITY_KEYS.map((key) => limits?.byKey.get(key)).filter((l): l is Limit => Boolean(l));
}

/** How long ago the instance created the work; undefined when the time is unknown. */
function sinceMs(createdAt: string | null | undefined, now: Date): number | undefined {
  if (!createdAt) return undefined;
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return undefined;
  return Math.max(0, now.getTime() - created);
}

/** How long work has been queued, from the instance's created_at; undefined when it has started or the time is unknown. */
export function queuedForMs(status: string | undefined, createdAt: string | null | undefined, now: Date): number | undefined {
  if (!status || !NOT_STARTED.has(status)) return undefined;
  return sinceMs(createdAt, now);
}

/** The fields of a run, or of its operation, that say whether it waits for run capacity. */
export interface QueuedState {
  status?: string;
  created_at?: string | null;
  /** The run's own answer; absent on an older instance. */
  waiting_for_capacity?: boolean | null;
}

/** True or false as the run publishes it; undefined on an instance without the field. */
export function publishedWait(run: QueuedState): boolean | undefined {
  return typeof run.waiting_for_capacity === "boolean" ? run.waiting_for_capacity : undefined;
}

/**
 * Whether a run waits for run capacity: as it says itself, or, on an instance
 * that does not say, when it is still queued after a normal start.
 */
export function waitsForCapacity(run: QueuedState, now: Date): boolean {
  const published = publishedWait(run);
  if (published !== undefined) return published;
  const queued = queuedForMs(run.status, run.created_at, now);
  return queued !== undefined && queued >= CAPACITY_WAIT_AFTER_MS;
}

export interface CapacityWait {
  waiting_for: "run_capacity";
  /** False when the run said so itself; true when the kit inferred it from the time queued (an older instance). */
  inferred: boolean;
  /** Seconds since the run was created; null when the instance does not say. */
  queued_seconds: number | null;
  /** The run caps the instance publishes, with where each is set. */
  caps: Array<{ key: string; value: Limit["value"]; source: string; origin: string | null; setting: string; changeable_by: string }>;
  note: string;
}

/**
 * A run (or its operation) that waits for run capacity: the instance starts
 * it once a slot frees. Undefined when it does not wait: it says so itself,
 * or, on an older instance, it is within a normal start or has started.
 */
export function capacityWait(run: QueuedState, now: Date, limits?: PublishedLimits): CapacityWait | undefined {
  if (!waitsForCapacity(run, now)) return undefined;
  const inferred = publishedWait(run) === undefined;
  const queued = sinceMs(run.created_at, now);
  const seconds = queued === undefined ? null : Math.round(queued / 1000);
  const caps = runCaps(limits);
  const named = caps.length ? ` ${caps.map(capText).join("; ")}.` : "";
  return {
    waiting_for: "run_capacity",
    inferred,
    queued_seconds: seconds,
    caps: caps.map((l) => ({ key: l.key, value: l.value, source: l.source, origin: l.origin ?? null, setting: l.setting, changeable_by: l.changeable_by })),
    note: `waiting for run capacity${seconds === null ? "" : ` (queued ${seconds} s)`}: every run slot is in use, and the instance starts it once one frees; it is not stuck.${named}`,
  };
}

/** The capacity code a failure names, in its code or its text. */
export function capacityCodeIn(...texts: Array<string | null | undefined>): CapacityCode | undefined {
  return CAPACITY_CODES.find((code) => texts.some((text) => typeof text === "string" && text.includes(code)));
}

/**
 * The kit's side of a capacity refusal: which limit to raise, who can, and
 * that retrying later is fine. It adds to the instance's catalog entry; the
 * values come from the published limits when there are any.
 */
export function capacityHint(code: CapacityCode, limits?: PublishedLimits): string {
  if (code === RUN_CAPACITY_BUSY) {
    const caps = runCaps(limits);
    const now = caps.length ? ` Now: ${caps.map(capText).join("; ")}.` : "";
    // An instance that publishes the operator's change lets the operator do it from the kit.
    const kit = caps.some((c) => c.change?.requires_role?.length)
      ? ` With a Platform-mode personal access token, the operator runs ${cavelonCommand("limits", "set", "max_concurrent_agent_runs_per_tenant", fill("n"), "--tenant", fill("tenant"), "--confirm")}.`
      : "";
    return (
      "Retrying later is fine; a trigger or channel run waits for a free slot on its own. " +
      "To run more at once, the instance operator raises max_concurrent_agent_runs_per_tenant: for this tenant alone " +
      `with ${TENANT_LIMITS_ROUTE} (limits.manage), or for every tenant as a platform setting in the Admin ` +
      `(Platform › Operations › Rate limits); max_concurrent_agent_runs_global caps the whole instance.${kit}${now}`
    );
  }
  const wait = limits?.byKey.get(ENDPOINT_SLOT_WAIT_KEY);
  const waited = wait ? ` (${ENDPOINT_SLOT_WAIT_KEY} is ${formatValue(wait)}; ${changedBy(wait)} changes it with ${wait.setting})` : "";
  return (
    `Retrying later is fine. The model endpoint was serving its max_concurrent_requests and no slot freed in time${waited}. ` +
    "If the endpoint can serve more at once, a tenant admin raises max_concurrent_requests on its Model Registry row " +
    `(${cavelonCommand("models", "set-limit", fill("model_id"), fill("n"))}, the Admin's model form, or PATCH /api/v1/model-registry/{model_registry_id}); ` +
    "every row with the same base_url shares that count."
  );
}

export interface CapacityNote extends OperationNote {
  capacity_wait?: CapacityWait;
  capacity_refusal?: { code: CapacityCode; hint: string };
}

/** A run as its operation's result_ref reads it; undefined when there is no link or it cannot be read. */
function readLinkedRun(client: ApiClient, op: Operation): Promise<RunState | undefined> {
  const href = op.result_ref?.type === "agent_run" ? op.result_ref.href : undefined;
  if (!href) return Promise.resolve(undefined);
  return client
    .get<RunState>(href, { allow: [403, 404] })
    .then((response) => (response.status === 200 && response.data && typeof response.data === "object" ? response.data : undefined))
    .catch(() => undefined);
}

/**
 * Notes on operations for one command: a run operation that waits for run
 * capacity, and a failure for capacity with its hint. A queued run operation's
 * run is read for its `waiting_for_capacity`; on an instance without it, the
 * time queued decides. The limits are read once and only when a note needs
 * them (or given, when the command has them already); a failed run is read
 * once for its failure summary, which names the code. Reading never fails the
 * command.
 */
export function capacityNotes(ctx: Context, client: ApiClient, known?: PublishedLimits) {
  let limits: Promise<PublishedLimits | undefined> | undefined = known ? Promise.resolve(known) : undefined;
  const published = () => (limits ??= readLimits(ctx).catch(() => undefined));
  const failures = new Map<string, Promise<CapacityCode | undefined>>();

  const failureCode = (op: Operation): Promise<CapacityCode | undefined> => {
    const own = capacityCodeIn(op.error?.code, op.error?.message);
    const href = op.result_ref?.type === "agent_run" ? op.result_ref.href : undefined;
    if (own || !href) return Promise.resolve(own);
    let code = failures.get(op.id);
    if (!code) {
      code = client
        .get<{ error_summary?: string | null }>(href, { allow: [403, 404] })
        .then((response) => (response.status === 200 ? capacityCodeIn(response.data?.error_summary) : undefined))
        .catch(() => undefined);
      failures.set(op.id, code);
    }
    return code;
  };

  return async function note(op: Operation): Promise<CapacityNote | undefined> {
    if (op.status === "failed") {
      const code = await failureCode(op);
      return code ? { capacity_refusal: { code, hint: capacityHint(code, await published()) } } : undefined;
    }
    // Only a run that has not started can wait for a slot; its run says whether it does.
    if (op.result_ref?.type !== "agent_run" || !NOT_STARTED.has(op.status)) return undefined;
    const run = await readLinkedRun(client, op);
    const state: QueuedState = { status: op.status, created_at: op.created_at ?? run?.created_at, waiting_for_capacity: run?.waiting_for_capacity };
    if (!waitsForCapacity(state, ctx.io.now())) return undefined;
    const wait = capacityWait(state, ctx.io.now(), await published());
    return wait ? { capacity_wait: wait } : undefined;
  };
}

/** The fields of a trigger run (AgentRunResponse) a capacity note reads. */
export interface RunState extends QueuedState {
  status: string;
  error_summary?: string | null;
}

/** A run's capacity wait, or its capacity refusal with the hint; the limits are read only when a note needs them. */
export async function runCapacityNote(ctx: Context, run: RunState): Promise<CapacityNote | undefined> {
  const code = run.status === "failed" ? capacityCodeIn(run.error_summary) : undefined;
  if (!code && !waitsForCapacity(run, ctx.io.now())) return undefined;
  const limits = await readLimits(ctx).catch(() => undefined);
  if (code) return { capacity_refusal: { code, hint: capacityHint(code, limits) } };
  const wait = capacityWait(run, ctx.io.now(), limits);
  return wait ? { capacity_wait: wait } : undefined;
}

/** The note as text lines under a run or an operation. */
export function noteLines(note: CapacityNote | undefined): string {
  if (note?.capacity_wait) return `\n  ${note.capacity_wait.note}`;
  if (note?.capacity_refusal) return `\n  ${note.capacity_refusal.code}: ${note.capacity_refusal.hint}`;
  return "";
}
