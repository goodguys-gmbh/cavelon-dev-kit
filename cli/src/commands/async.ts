import { capacityNotes, type CapacityNote } from "../capacity.js";
import { stringOption, parseDuration, type CommandSpec, type Context } from "../command.js";
import { CavelonError, ExitCode, usageError } from "../errors.js";
import { combinedExitCode, describe, exitCodeFor, getOperation, isSettled, TERMINAL, waitFor, type Operation, type OperationNote } from "../operations.js";
import { failureLines, resultFailure } from "../results.js";
import { cavelonCommand } from "../printed.js";
import { readEvents } from "../sse.js";

/** Long-running work: bounded waits that resume, and a live stream. */

export const DEFAULT_WAIT = "90s";
/** An MCP tool that starts work never blocks; it returns the state at once. */
const MCP_TIMEOUT_MS = 0;
/**
 * The longest `operation_status` waits when asked to: below the minute after
 * which MCP clients commonly give up on a request.
 */
export const MCP_MAX_WAIT_MS = 50_000;

export const TIMEOUT_OPTION = {
  type: "string" as const,
  value: "<duration>",
  description: `Stop waiting after this long (90s, 5m; default ${DEFAULT_WAIT}). The work goes on; run wait again to resume.`,
};

export function timeoutMs(ctx: Context, raw: string | undefined, fallback = DEFAULT_WAIT): number {
  if (ctx.mode === "mcp") return MCP_TIMEOUT_MS;
  return parseDuration(raw ?? fallback);
}

function intervalMs(ctx: Context): number {
  const fromEnv = Number(ctx.io.env.CAVELON_POLL_INTERVAL_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 1000;
}

/**
 * How long `wait` waits. As the MCP tool `operation_status` it returns the
 * state at once unless given a timeout, and waits at most MCP_MAX_WAIT_MS.
 */
function waitTimeoutMs(ctx: Context, raw: string | undefined): number {
  if (ctx.mode !== "mcp") return parseDuration(raw ?? DEFAULT_WAIT);
  if (raw === undefined || raw === "") return 0;
  const asked = parseDuration(raw);
  if (asked > MCP_MAX_WAIT_MS) {
    ctx.warn(`operation_status waits at most ${MCP_MAX_WAIT_MS / 1000} s, not ${raw}; call it again to keep waiting.`);
    return MCP_MAX_WAIT_MS;
  }
  return asked;
}

/** Wait for operations and shape the answer every waiting command prints. */
export async function waitAndReport(ctx: Context, ids: string[], timeout: number) {
  const client = await ctx.client();
  const progress = !ctx.json && ctx.io.stderr.isTTY && ctx.mode === "cli";
  const { operations, timedOut, waitedMs } = await waitFor(ctx, client, ids, {
    timeoutMs: timeout,
    intervalMs: intervalMs(ctx),
    onChange: progress ? (op) => ctx.io.stderr.write(`${ctx.style.dim(describe(op).split("\n")[0]!)}\n`) : undefined,
  });
  const pending = operations.filter((o) => !isSettled(o)).map((o) => o.id);
  const resume = cavelonCommand("wait", ...pending);
  // A run queued past a normal start waits for run capacity; a failure for capacity says which limit to raise;
  // a finished test run whose cases failed is a failure.
  const note = capacityNotes(ctx, client);
  const notes = await Promise.all(operations.map(async (op) => withResult(await note(op), await resultFailure(ctx, op))));
  const exitCode = combinedExitCode(operations, notes);
  const waits = notes.flatMap((n, i) => (n?.capacity_wait ? [{ operation_id: operations[i]!.id, ...n.capacity_wait }] : []));
  const refusals = notes.flatMap((n, i) => (n?.capacity_refusal ? [{ operation_id: operations[i]!.id, ...n.capacity_refusal }] : []));
  const failedResults = notes.flatMap((n, i) => (n?.result_failure ? [{ operation_id: operations[i]!.id, ...n.result_failure }] : []));
  const data = {
    operations,
    settled: pending.length === 0,
    timed_out: timedOut,
    timeout_ms: timeout,
    waited_ms: waitedMs,
    ...(pending.length ? { resume } : {}),
    ...(waits.length ? { capacity_waits: waits } : {}),
    ...(refusals.length ? { capacity_refusals: refusals } : {}),
    ...(failedResults.length ? { failed_results: failedResults } : {}),
  };
  const lines = operations.map((op, i) => describe(op, notes[i]));
  // `body` leaves out the resume line, for a caller that ends its own output with one.
  const body = lines.join("\n");
  const why = waits.length === pending.length ? "Waiting for run capacity" : "Still running";
  if (pending.length) {
    lines.push(
      timeout === 0 ? `${why}. Wait with: ${resume}` : `${why} after the timeout; resume with: ${resume}`,
    );
  }
  return { data, text: lines.join("\n"), exitCode, body, pending, why };
}

function withResult(note: OperationNote | undefined, failure: OperationNote["result_failure"]): OperationNote | undefined {
  return failure ? { ...note, result_failure: failure } : note;
}

export const wait: CommandSpec = {
  name: "wait",
  summary: "Wait until operations finish, need a person, or the timeout passes.",
  description:
    "Exit 0 when all succeeded, 1 when one failed or was cancelled, 5 when one needs a person,\n" +
    "6 when one still runs at the end (timed_out says whether it waited the whole timeout; --timeout 0 reads the state once).\n" +
    "A test run that finished with failed cases counts as failed, and its cases are named.\n" +
    "The state is printed in every case with waited_ms, and a second `wait` resumes. As the MCP tool operation_status it\n" +
    `returns the state at once unless given a timeout, and waits at most ${MCP_MAX_WAIT_MS / 1000} s.`,
  readOnly: true,
  idempotent: true,
  mcpTool: "operation_status",
  positionals: [{ name: "operation", description: "Operation ids (op_…).", required: true, variadic: true }],
  options: {
    timeout: {
      ...TIMEOUT_OPTION,
      description:
        `Stop waiting after this long (90s, 5m; default ${DEFAULT_WAIT}). The work goes on; run wait again to resume. ` +
        `As an MCP tool: none by default (returns at once), at most ${MCP_MAX_WAIT_MS / 1000}s.`,
    },
  },
  examples: ["cavelon wait op_test_run_0f…", "cavelon wait op_a op_b --timeout 5m --json"],
  async run(ctx, input) {
    const ids = (input.positionals.operation as string[]).filter(Boolean);
    return waitAndReport(ctx, [...new Set(ids)], waitTimeoutMs(ctx, stringOption(input, "timeout")));
  },
};

interface EndFrame {
  type: "end";
  reason: "terminal" | "lifetime" | "gone" | "error";
}

interface OperationFrame {
  type: "operation";
  operation?: Operation;
  [key: string]: unknown;
}

export const watch: CommandSpec = {
  name: "watch",
  mcpInstead: "wait",
  summary: "Stream an operation's changes until it ends (server-sent events).",
  description: "Prints one line per change (one JSON object per line with --json). A needs_action state is shown and the stream goes on.",
  readOnly: true,
  idempotent: true,
  mcpTool: false,
  positionals: [{ name: "operation", description: "Operation id (op_…).", required: true }],
  options: {
    timeout: { ...TIMEOUT_OPTION, description: "Stop watching after this long (default 10m)." },
  },
  async run(ctx, input) {
    const id = (input.positionals.operation as string | undefined)!;
    if (!id) throw usageError("Missing <operation>.");
    const client = await ctx.client();
    const deadline = Date.now() + timeoutMs(ctx, stringOption(input, "timeout"), "10m");
    const note = capacityNotes(ctx, client);
    const emit = async (op: Operation) => {
      const extra: CapacityNote | undefined = await note(op);
      if (ctx.json) ctx.io.stdout.write(`${JSON.stringify({ type: "operation", operation: op, ...extra })}\n`);
      else ctx.io.stdout.write(`${describe(op, extra)}\n`);
    };
    let last: Operation | undefined;
    let fallback = false;
    let failures = 0;
    while (Date.now() < deadline) {
      if (failures > 0) {
        // A dropped or empty stream: back off before reconnecting, and give up after a few in a row.
        if (failures > 5) {
          throw new CavelonError(ExitCode.server, {
            code: "stream_error",
            message: `The event stream of ${id} kept dropping.`,
            hint: `\`${cavelonCommand("wait", id)}\` polls instead.`,
          });
        }
        await ctx.io.sleep(Math.min(1000 * 2 ** (failures - 1), 10_000, Math.max(0, deadline - Date.now())));
        if (Date.now() >= deadline) break;
      }
      if (fallback) {
        const op = await getOperation(client, id);
        if (!last || last.status !== op.status || last.progress?.current !== op.progress?.current) await emit(op);
        last = op;
        if (TERMINAL.has(op.status)) break;
        await ctx.io.sleep(Math.min(intervalMs(ctx) * 2, Math.max(0, deadline - Date.now())));
        continue;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
      let reason: EndFrame["reason"] | undefined;
      let changes = 0;
      try {
        const response = await client.fetchRaw("GET", `/api/v1/operations/${encodeURIComponent(id)}/events`, {
          accept: "text/event-stream",
          signal: controller.signal,
        });
        if (response.status === 404 || response.status === 406 || !response.body) {
          await response.body?.cancel();
          // No stream for this id or instance: read the state, then poll.
          last = await getOperation(client, id);
          await emit(last);
          if (TERMINAL.has(last.status)) break;
          fallback = true;
          continue;
        }
        if (!response.ok) {
          throw await client.refusal(response.status, await response.text(), `GET /api/v1/operations/${id}/events`);
        }
        for await (const event of readEvents(response.body)) {
          let frame: OperationFrame | EndFrame;
          try {
            frame = JSON.parse(event.data) as OperationFrame | EndFrame;
          } catch {
            continue;
          }
          if (frame.type === "end") {
            reason = frame.reason;
            break;
          }
          const op = (frame.operation ?? (frame as unknown as Operation)) as Operation;
          if (op?.id) {
            last = op;
            changes++;
            await emit(op);
          }
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        // An answer from the instance (401, 500, …) is final; a broken connection is not.
        if (error instanceof CavelonError && error.status !== undefined) throw error;
        failures++;
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (reason === "terminal" || (last && TERMINAL.has(last.status))) break;
      if (reason === "gone") {
        throw new CavelonError(ExitCode.failure, { code: "operation_gone", message: `Operation ${id} no longer exists.` });
      }
      if (reason === "error") {
        throw new CavelonError(ExitCode.server, { code: "stream_error", message: `The instance ended the stream of ${id} with an error.` });
      }
      // "lifetime" (or a stream that ended early): reconnect and keep watching.
      failures = reason === "lifetime" && changes > 0 ? 0 : failures + 1;
    }
    if (!last) last = await getOperation(client, id);
    const settled = TERMINAL.has(last.status);
    // The operation says the work finished; a test run's summary says whether its cases passed.
    const failure = settled ? await resultFailure(ctx, last) : undefined;
    if (failure) {
      if (ctx.json) ctx.io.stdout.write(`${JSON.stringify({ type: "result", operation_id: id, result_failure: failure })}\n`);
      else ctx.io.stdout.write(`${failureLines(failure)}\n`);
    }
    if (!settled) {
      const wait = (await note(last))?.capacity_wait;
      ctx.io.stderr.write(`Stopped watching; ${id} is still ${last.status}. Resume: ${cavelonCommand("watch", id)}\n${wait ? `  ${wait.note}\n` : ""}`);
    }
    // Lines were streamed already; print nothing more.
    const unsettled = last.status === "needs_action" ? ExitCode.needsAction : ExitCode.timeout;
    return { data: undefined, text: "", exitCode: settled ? exitCodeFor(last, { result_failure: failure }) : unsettled };
  },
};
