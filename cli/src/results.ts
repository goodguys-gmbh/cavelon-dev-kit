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
export const NOT_PASSED_COUNTS = ["failed", "errors", "technical_errors", "not_run", "cases_not_run", "missing_results", "unmeasurable_cases", "skipped"];
/** Counts a person clears: a manual verdict, or a value or knowledge base the case needs. */
export const WAITING_COUNTS = ["pending_review", "calibration_required"];

/** The instance's regression-testing page, where its results table names the statuses. */
export const TESTING_PAGE = "concepts/regression-testing";

/**
 * A result status that is neither a pass nor a failed verdict. Agents meet
 * these in `test run` and `trace` and look them up with `cavelon explain`,
 * but they are no error code, so the instance's catalog does not list them;
 * the meanings follow the instance's regression-testing docs.
 */
export interface CaseStatus {
  status: string;
  /** The run summary's counts of this status. */
  counts: string[];
  /** A few words, printed next to the count. */
  short: string;
  meaning: string;
  next: string;
  /** The section of the regression-testing page that says more. */
  section: string;
}

export const CASE_STATUSES: readonly CaseStatus[] = [
  {
    status: "calibration_required",
    counts: ["calibration_required"],
    short: "a knowledge base or value the case needs was not ready",
    meaning:
      "The instance did not run the case. When it accepted the run (its preflight), a knowledge base the case needs had no ready documents (knowledge_base_not_ready), or a {{var:…}} value the case refers to was not set (tenant_value_missing); the result's reason names which. The run keeps that verdict even if the documents become ready while it runs.",
    next: "Wait until the knowledge base's documents are processed (`cavelon wait` on the upload's operation), or set the value (`cavelon variables set`), then start a new run.",
    section: "preflight-is-decided-when-the-run-is-accepted",
  },
  {
    status: "pending_review",
    counts: ["pending_review"],
    short: "the answer waits for a person's verdict",
    meaning: "The case ran, and its answer waits for a manual verdict: Auto-Evaluate is off for the suite, so no judge scored it.",
    next: "Tell the person: they set Pass, Fail or Skip on the result in the instance. To have the judge score it, turn Auto-Evaluate on for the suite and run it again.",
    section: "reviewing-results",
  },
  {
    status: "not_run",
    counts: ["not_run", "cases_not_run", "missing_results"],
    short: "the step produced no result",
    meaning:
      "The step produced no result: the run was cancelled or stopped before it (after repeated provider refusals, for example), or the case was held back before any step ran. The run is not comparable and has no pass rate.",
    next: "`cavelon trace <test-run-id>` shows which steps ran and the reasons recorded; fix the cause and start a new run.",
    section: "reviewing-results",
  },
  {
    status: "not_evaluated",
    counts: ["unevaluated_steps"],
    short: "a preparation step, not scored",
    meaning:
      "A preparation step (`evaluate: false`, or a fixed response): it sets up the dialog for a later step and is not scored, so it counts toward neither side of the pass rate. It does not fail a run.",
    next: "Nothing, unless the step should be judged: then give it `evaluate: true` and a reference answer or criteria.",
    section: "reviewing-results",
  },
  {
    status: "skip",
    counts: ["skipped"],
    short: "the step was skipped",
    meaning: "The step was skipped: a person set a Skip verdict to park the case, or the run was cancelled before the step. The run is not comparable and has no pass rate.",
    next: "When the case applies again, a person replaces the Skip verdict in the instance; after a cancelled run, start a new one.",
    section: "reviewing-results",
  },
];

/** A case status by its name or a summary count's, as people write it: "Calibration Required", "skipped". */
export function caseStatus(name: string): CaseStatus | undefined {
  const wanted = name.trim().toLowerCase().replaceAll(" ", "_").replaceAll("-", "_");
  return CASE_STATUSES.find((s) => s.status === wanted || s.counts.includes(wanted));
}

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

/** "3 not run, 2 pending review (the answer waits for a person's verdict)": a waiting count says why. */
export function countsText(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([key, value]) => {
      const why = WAITING_COUNTS.includes(key) ? caseStatus(key)?.short : undefined;
      return `${value} ${key === "errors" ? "errored" : key.replaceAll("_", " ")}${why ? ` (${why})` : ""}`;
    })
    .join(", ");
}

/** The case statuses behind a run's counts, for the `cavelon explain` that says what to do. */
function explainedStatuses(counts: Record<string, number>): string[] {
  const statuses = Object.keys(counts).map((key) => caseStatus(key)?.status);
  return [...new Set(statuses.filter((s): s is string => Boolean(s)))];
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
      // A waiting case carries the reason too: which knowledge base or value it needs.
      cases: results
        .filter((r) => NOT_PASSED.has(r.status) || WAITING_COUNTS.includes(r.status))
        .slice(0, MAX_CASES)
        .map((r) => failedCase(r)),
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
  const total = failure.failed_cases + failure.errored_cases + WAITING_COUNTS.reduce((sum, key) => sum + (failure.counts[key] ?? 0), 0);
  if (total > shown) lines.push(`    … ${total - shown} more`);
  const statuses = explainedStatuses(failure.counts);
  if (statuses.length) lines.push(`  What to do: ${statuses.map((s) => cavelonCommand("explain", s)).join("; ")}`);
  lines.push(`  Look closer: ${failure.trace}`);
  return lines.join("\n");
}
