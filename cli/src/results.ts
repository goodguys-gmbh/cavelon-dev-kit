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
  return { failed: summaryCount(summary, "failed"), errors: summaryCount(summary, "errors") };
}

function summaryCount(summary: Record<string, unknown> | undefined, key: string): number {
  const value = Number(summary?.[key] ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Counts that are no pass. Besides a failed or errored verdict, a step or case
 * that was never measured makes the run say nothing about the solution; the
 * instance then marks it not comparable and leaves out its pass rate. An
 * instance older than a count does not send it, which reads as 0.
 */
const NOT_PASSED_COUNTS = ["failed", "errors", "technical_errors", "not_run", "cases_not_run", "missing_results", "unmeasurable_cases", "skipped"];
/** Counts a person clears: a manual verdict, or a value or knowledge base the case needs. */
const WAITING_COUNTS = ["pending_review", "calibration_required"];

export interface RunVerdict {
  /** Every count above 0 that is no pass, by the summary's own field names. */
  counts: Record<string, number>;
  /** False when the instance says the run cannot be compared; null when it does not say. */
  comparable: boolean | null;
  non_comparable_reasons: string[];
  /** 0 passed; 1 failed or measured nothing; 5 answers wait for a person. */
  exit_code: 0 | 1 | 5;
}

/**
 * Whether a finished run passed, by its summary. The regression-testing docs
 * say to treat a run without a pass rate as failed; an instance that publishes
 * `comparable` says so directly, and an older one sends `pass_rate: null`.
 */
export function runVerdict(summary: Record<string, unknown> | undefined): RunVerdict {
  const counts: Record<string, number> = {};
  for (const key of [...NOT_PASSED_COUNTS, ...WAITING_COUNTS]) {
    const value = summaryCount(summary, key);
    if (value > 0) counts[key] = value;
  }
  const said = summary?.comparable;
  const comparable = typeof said === "boolean" ? said : summary && "pass_rate" in summary && summary.pass_rate == null ? false : null;
  const reasons = Array.isArray(summary?.non_comparable_reasons) ? summary.non_comparable_reasons.map(String) : [];
  let exitCode: RunVerdict["exit_code"] = 0;
  if (NOT_PASSED_COUNTS.some((k) => k in counts)) exitCode = 1;
  else if (WAITING_COUNTS.some((k) => k in counts)) exitCode = 5;
  else if (comparable === false) exitCode = 1;
  return { counts, comparable, non_comparable_reasons: reasons, exit_code: exitCode };
}

/** "3 not run, 2 pending review". */
export function countsText(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([key, value]) => `${value} ${key === "errors" ? "errored" : key.replaceAll("_", " ")}`)
    .join(", ");
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
  /** Every count of the summary above 0 that is no pass, by its field name. */
  counts: Record<string, number>;
  comparable: boolean | null;
  non_comparable_reasons: string[];
  /** 1: cases failed or were not measured; 5: answers wait for a person. */
  exit_code: 1 | 5;
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
 * Whether the record a succeeded operation points to says it did not pass:
 * a test run whose cases failed, were not measured, or wait for a person.
 * Only a test run carries such a verdict today; any other result is taken as the
 * operation reports it. When the run cannot be read, the kit says so and
 * keeps the operation's own state.
 */
export async function resultFailure(ctx: Context, op: Operation): Promise<ResultFailure | undefined> {
  if (op.status !== "succeeded" || op.result_ref?.type !== "test_run") return undefined;
  const id = op.result_ref.id;
  try {
    const run = await callStable<TestRunState>(ctx, "GET", "/api/v1/test-runs/{run_id}", "test runs", { params: { run_id: [id] } });
    const verdict = runVerdict(run.summary);
    if (verdict.exit_code === 0) return undefined;
    const { failed, errors } = caseCounts(run.summary);
    const results = await callStable<TestResultState[]>(ctx, "GET", "/api/v1/test-runs/{run_id}/results", "test results", { params: { run_id: [id] } });
    return {
      type: "test_run",
      id,
      suite: run.suite_name ?? run.suite_id,
      failed_cases: failed,
      errored_cases: errors,
      counts: verdict.counts,
      comparable: verdict.comparable,
      non_comparable_reasons: verdict.non_comparable_reasons,
      exit_code: verdict.exit_code,
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
  const head = `  test run ${failure.id} (${failure.suite}) finished, but`;
  const counts = countsText(failure.counts);
  const lines = [
    counts
      ? `${head} ${failure.exit_code === 5 ? "answers wait for a person" : "cases did not pass"}: ${counts}`
      : `${head} it measured nothing comparable and has no pass rate`,
  ];
  if (failure.comparable === false && failure.non_comparable_reasons.length) lines.push(`  Not comparable: ${failure.non_comparable_reasons.join(", ")}`);
  for (const c of failure.cases) lines.push(`    ${caseLabel(c)}  ${c.status}${c.reason ? ": " + c.reason : ""}`);
  const shown = failure.cases.length;
  const total = failure.failed_cases + failure.errored_cases;
  if (total > shown) lines.push(`    … ${total - shown} more`);
  lines.push(`  Look closer: ${failure.trace}`);
  return lines.join("\n");
}
