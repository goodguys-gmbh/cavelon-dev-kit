import type { Context } from "./command.js";
import { CavelonError, ExitCode, type ExitCodeValue } from "./errors.js";
import type { ApiClient } from "./http.js";
import { cavelonCommand } from "./printed.js";
import { failureLines, type ResultFailure } from "./results.js";

/**
 * The instance's one resource for asynchronous work. Every kind reads as the
 * same Operation shape, and `needs_action` stops a wait with its own exit code
 * and the Admin link. A succeeded operation whose result says it did not pass
 * (a test run with failed or unmeasured cases, see results.ts) counts as
 * failed, or as needing a person when its answers wait for a verdict.
 */

export type OperationStatus = "queued" | "running" | "needs_action" | "succeeded" | "failed" | "cancelled";

export interface Operation {
  id: string;
  kind: string;
  status: OperationStatus;
  progress?: { phase?: string | null; current?: number | null; total?: number | null; fraction?: number | null };
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  result_ref?: { type: string; id: string; href?: string | null } | null;
  error?: { code: string; message: string } | null;
  action?: { reason: string; admin_url: string } | null;
}

export const TERMINAL: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"]);

export function isSettled(op: Operation): boolean {
  return TERMINAL.has(op.status) || op.status === "needs_action";
}

export function exitCodeFor(op: Operation, note?: OperationNote): ExitCodeValue {
  if (note?.result_failure) return note.result_failure.exit_code;
  switch (op.status) {
    case "succeeded":
      return ExitCode.ok;
    case "needs_action":
      return ExitCode.needsAction;
    case "failed":
    case "cancelled":
      return ExitCode.failure;
    default:
      return ExitCode.timeout;
  }
}

/** The worst exit code of several operations, in the order an agent must act on them. */
export function combinedExitCode(ops: Operation[], notes: Array<OperationNote | undefined> = []): ExitCodeValue {
  const codes = new Set(ops.map((op, i) => exitCodeFor(op, notes[i])));
  for (const code of [ExitCode.failure, ExitCode.needsAction, ExitCode.timeout] as const) if (codes.has(code)) return code;
  return ExitCode.ok;
}

function operationsUnavailable(): CavelonError {
  return new CavelonError(ExitCode.failure, {
    code: "operations_unavailable",
    message: "This instance does not offer the operations API (/api/v1/operations).",
    hint: "It is turned on with OPERATIONS_API_ENABLED on the instance; ask its operator.",
  });
}

export async function getOperation(client: ApiClient, id: string, signal?: AbortSignal): Promise<Operation> {
  try {
    const response = await client.get<Operation>(`/api/v1/operations/${encodeURIComponent(id)}`, { signal });
    return response.data;
  } catch (error) {
    if (error instanceof CavelonError && error.status === 404) {
      if (!id.startsWith("op_")) {
        throw new CavelonError(ExitCode.usage, {
          code: "not_an_operation_id",
          message: `"${id}" is not an operation id (they start with op_).`,
          hint: `Commands that start work print the operation id; \`${cavelonCommand("status")}\` lists running ones.`,
        });
      }
      // Either the id is unknown, or the route is missing altogether.
      const probe = await client.get("/api/v1/operations", { query: { limit: 1 }, allow: [404] });
      if (probe.status === 404) throw operationsUnavailable();
      throw new CavelonError(ExitCode.failure, {
        code: "operation_not_found",
        status: 404,
        message: `No operation ${id} in this tenant.`,
        hint: `Operation ids are per tenant; check \`${cavelonCommand("whoami")}\`.`,
      });
    }
    throw error;
  }
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs: number;
  onChange?(op: Operation): void;
}

/**
 * Poll until every operation is settled or the time is up. Returns the last
 * state of each; an unsettled one is simply still running, and the next
 * `wait` picks it up where this one stopped.
 */
/**
 * Read operations until all settle or the timeout passes. `timedOut` is true
 * only when it waited and the time ran out, never for a timeout of 0, which
 * reads the state once and returns it.
 */
export async function waitFor(
  ctx: Context,
  client: ApiClient,
  ids: string[],
  options: WaitOptions,
): Promise<{ operations: Operation[]; timedOut: boolean; waitedMs: number }> {
  const started = Date.now();
  const deadline = started + options.timeoutMs;
  const latest = new Map<string, Operation>();
  let interval = options.intervalMs;
  for (;;) {
    for (const id of ids) {
      const previous = latest.get(id);
      if (previous && isSettled(previous)) continue;
      const remaining = Math.max(1000, deadline - Date.now());
      const op = await getOperation(client, id, AbortSignal.timeout(Math.min(remaining, 30_000)));
      if (!previous || previous.status !== op.status || previous.progress?.current !== op.progress?.current) options.onChange?.(op);
      latest.set(id, op);
    }
    const ops = ids.map((id) => latest.get(id)!);
    if (ops.every(isSettled)) return { operations: ops, timedOut: false, waitedMs: Date.now() - started };
    const left = deadline - Date.now();
    if (left <= 0) return { operations: ops, timedOut: options.timeoutMs > 0, waitedMs: Date.now() - started };
    await ctx.io.sleep(Math.min(interval, left));
    interval = Math.min(Math.round(interval * 1.5), 5000);
  }
}

/** What the kit adds to an operation: a capacity wait, the hint for a capacity refusal, or a result that failed. */
export interface OperationNote {
  capacity_wait?: { note: string };
  capacity_refusal?: { code: string; hint: string };
  result_failure?: ResultFailure;
}

export function describe(op: Operation, note?: OperationNote): string {
  const progress = op.progress;
  const parts = [`${op.id}  ${op.kind}  ${op.status}`];
  if (progress?.phase) parts.push(`phase ${progress.phase}`);
  if (progress?.current != null && progress?.total != null) parts.push(`${progress.current}/${progress.total}`);
  let line = parts.join("  ");
  if (note?.capacity_wait) line += `\n  ${note.capacity_wait.note}`;
  if (op.error) line += `\n  error ${op.error.code}: ${op.error.message}`;
  if (note?.capacity_refusal) line += `\n  ${note.capacity_refusal.code}: ${note.capacity_refusal.hint}`;
  if (note?.result_failure) line += `\n${failureLines(note.result_failure)}`;
  if (op.action) line += `\n  needs a person: ${op.action.reason}\n  ${op.action.admin_url}`;
  return line;
}
