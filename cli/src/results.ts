import type { Context } from "./command.js";
import { CavelonError } from "./errors.js";
import { clip } from "./format.js";
import { callStable } from "./invoke.js";
import type { Operation } from "./operations.js";
import { cavelonCommand } from "./shell.js";

/**
 * An operation says whether the work finished; the record it points to says
 * whether the work passed. A test run whose cases failed is a succeeded
 * operation (the run itself completed), so before a wait calls it a success
 * the kit reads the run's summary and, when cases did not pass, names them.
 */

/** The fields of a test run (TestRunResponse) the kit reads. */
export interface TestRunState {
  id: string;
  suite_id: string;
  suite_name?: string | null;
  status: string;
  summary?: Record<string, unknown>;
}

/** The fields of a test result (TestResultResponse) the kit reads. */
export interface TestResultState {
  id: string;
  test_case_name?: string | null;
  step_order?: number | null;
  status: string;
  conversation_id?: string | null;
  agent_run_id?: string | null;
  llm_judge_score?: number | null;
  llm_judge_reasoning?: string | null;
  judge_breakdown?: Record<string, unknown> | null;
  error_message?: string | null;
}

/** Result statuses that are no pass: a failed verdict and a step that could not run or be scored. */
export const NOT_PASSED: ReadonlySet<string> = new Set(["fail", "error"]);

/** The summary's pass, fail and error counts (regression-testing docs: "pass / fail / error counts"). */
export function caseCounts(summary: Record<string, unknown> | undefined): { failed: number; errors: number } {
  const count = (key: string) => {
    const value = Number(summary?.[key] ?? 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  return { failed: count("failed"), errors: count("errors") };
}

/** At most this many cases are named per run; `cavelon trace <run>` lists them all. */
const MAX_CASES = 5;
const REASON_CHARS = 500;

export interface FailedCase {
  case: string;
  step: number | null;
  status: string;
  /** What the instance recorded: the error, else the judge's reasoning. */
  reason: string | null;
  /** The trigger run a trigger case started. */
  run_id: string | null;
}

export interface ResultFailure {
  type: "test_run";
  id: string;
  suite: string;
  failed_cases: number;
  errored_cases: number;
  cases: FailedCase[];
  trace: string;
}

export function failedCase(r: TestResultState, max = REASON_CHARS): FailedCase {
  const reason = r.error_message ?? r.llm_judge_reasoning ?? null;
  return {
    case: r.test_case_name ?? r.id,
    step: r.step_order ?? null,
    status: r.status,
    reason: reason ? clip(reason, max) : null,
    run_id: r.agent_run_id ?? null,
  };
}

/**
 * Whether the record a succeeded operation points to says it failed. Only a
 * test run carries such a verdict today; any other result is taken as the
 * operation reports it. When the run cannot be read, the kit says so and
 * keeps the operation's own state.
 */
export async function resultFailure(ctx: Context, op: Operation): Promise<ResultFailure | undefined> {
  if (op.status !== "succeeded" || op.result_ref?.type !== "test_run") return undefined;
  const id = op.result_ref.id;
  try {
    const run = await callStable<TestRunState>(ctx, "GET", "/api/v1/test-runs/{run_id}", "test runs", { params: { run_id: [id] } });
    const { failed, errors } = caseCounts(run.summary);
    if (failed + errors === 0) return undefined;
    const results = await callStable<TestResultState[]>(ctx, "GET", "/api/v1/test-runs/{run_id}/results", "test results", { params: { run_id: [id] } });
    return {
      type: "test_run",
      id,
      suite: run.suite_name ?? run.suite_id,
      failed_cases: failed,
      errored_cases: errors,
      cases: results.filter((r) => NOT_PASSED.has(r.status)).slice(0, MAX_CASES).map((r) => failedCase(r)),
      trace: cavelonCommand("trace", id),
    };
  } catch (error) {
    if (!(error instanceof CavelonError)) throw error;
    ctx.warn(`Could not read test run ${id} to see whether its cases passed (${error.message}); \`${cavelonCommand("trace", id)}\` shows them.`);
    return undefined;
  }
}

/** "Counter loop (step 1)". */
export function caseLabel(c: Pick<FailedCase, "case" | "step">): string {
  return c.step === null ? c.case : `${c.case} (step ${c.step})`;
}

/** The failure as lines under the operation. */
export function failureLines(failure: ResultFailure): string {
  const counts = [failure.failed_cases ? `${failure.failed_cases} failed` : "", failure.errored_cases ? `${failure.errored_cases} errored` : ""].filter(Boolean).join(", ");
  const lines = [`  test run ${failure.id} (${failure.suite}) finished, but cases did not pass: ${counts}`];
  for (const c of failure.cases) lines.push(`    ${caseLabel(c)}  ${c.status}${c.reason ? ": " + c.reason : ""}`);
  const shown = failure.cases.length;
  const total = failure.failed_cases + failure.errored_cases;
  if (total > shown) lines.push(`    … ${total - shown} more`);
  lines.push(`  Look closer: ${failure.trace}`);
  return lines.join("\n");
}
