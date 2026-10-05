import { clip } from "./format.js";

/**
 * What `trace` and `test run` read out of a test result and a span beyond
 * their plain fields: each assertion of a step and the answer it judged, the
 * query and hits of a knowledge search, and which span to open first. Every
 * field is read tolerantly: an older instance leaves it out, and then the
 * kit shows what it has.
 */

/** One check of a step: a deterministic assertion (answered_by, handoff_to, tool_called, …) or a judge criterion. */
export interface StepAssertion {
  /** The assertion's type (`answered_by`), or "judge" for a criterion the judge scored. */
  type: string;
  label: string;
  /** Pass or fail; null for a judge criterion that has a score only. */
  passed: boolean | null;
  expected?: unknown;
  observed?: unknown;
  score?: number | null;
  reasoning: string | null;
}

const REASONING_CHARS = 300;
const VALUE_CHARS = 120;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const brief = (value: unknown, max: number): unknown => (typeof value === "string" ? clip(value, max) : value);

/**
 * The assertions of a step from its `judge_breakdown`: the deterministic
 * criteria with their verdict, then the judge's criteria with their score. A
 * result without a breakdown has none.
 */
export function stepAssertions(breakdown: unknown, full = false): StepAssertion[] {
  const b = record(breakdown);
  if (!b) return [];
  const max = full ? Number.MAX_SAFE_INTEGER : REASONING_CHARS;
  const out: StepAssertion[] = [];
  for (const raw of Array.isArray(b.deterministic_criteria) ? b.deterministic_criteria : []) {
    const c = record(raw);
    if (!c) continue;
    const type = text(c.type) ?? "assertion";
    out.push({
      type,
      label: text(c.label) ?? type,
      passed: typeof c.passed === "boolean" ? c.passed : null,
      ...("expected" in c ? { expected: brief(c.expected, full ? max : VALUE_CHARS) } : {}),
      ...("observed" in c ? { observed: brief(c.observed, full ? max : VALUE_CHARS) } : {}),
      reasoning: text(c.reasoning) ? clip(text(c.reasoning)!, max) : null,
    });
  }
  for (const raw of Array.isArray(b.criteria) ? b.criteria : []) {
    const c = record(raw);
    const criterion = c && text(c.criterion);
    if (!c || !criterion) continue;
    out.push({
      type: "judge",
      label: clip(criterion, full ? max : VALUE_CHARS),
      passed: null,
      score: typeof c.score === "number" ? c.score : null,
      reasoning: text(c.reasoning) ? clip(text(c.reasoning)!, max) : null,
    });
  }
  return out;
}

/** "2 of 3 passed" for the deterministic ones; undefined without any. */
export function assertionCount(assertions: StepAssertion[]): string | undefined {
  const judged = assertions.filter((a) => a.passed !== null);
  if (!judged.length) return undefined;
  return `${judged.filter((a) => a.passed).length} of ${judged.length} passed`;
}

/** "Handed off to ticket-agent [handoff_to]": the label, and the type where the label does not say it. */
function assertionName(a: StepAssertion): string {
  if (a.type === "judge") return `criterion "${a.label}"`;
  return a.label === a.type ? a.type : `${a.label} [${a.type}]`;
}

/** One line per assertion, as `trace` prints it under a step. */
export function assertionLine(a: StepAssertion): string {
  const mark = a.passed === true ? "pass" : a.passed === false ? "FAIL" : a.score !== null && a.score !== undefined ? `score ${a.score}` : "judged";
  const values =
    a.passed === false && ("expected" in a || "observed" in a)
      ? ` (expected ${JSON.stringify(a.expected ?? null)}, observed ${JSON.stringify(a.observed ?? null)})`
      : "";
  return `${mark}  ${assertionName(a)}${values}${a.reasoning ? `: ${a.reasoning}` : ""}`;
}

/** The labels of the assertions that failed, for a line under a failed case. */
export function failedAssertions(breakdown: unknown): string[] {
  return stepAssertions(breakdown)
    .filter((a) => a.passed === false)
    .map(assertionName);
}

// ---------------------------------------------------------------------------
// Spans
// ---------------------------------------------------------------------------

/**
 * A span's attributes as an object. The instance stores them as JSON, and a
 * route may hand them on as a JSON string, even one encoded twice; such a
 * string is decoded, a few times at most.
 */
export function spanAttributes(value: unknown): Record<string, unknown> | undefined {
  let current = value;
  for (let i = 0; i < 3 && typeof current === "string"; i++) {
    const trimmed = current.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith('"')) return undefined;
    try {
      current = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  return record(current);
}

/** One hit of a knowledge search, as the retrieval span records it. */
export interface RetrievalHit {
  rank: number | null;
  title: string | null;
  score: number | null;
  citation_state: string | null;
  /** False on every hit of a search the agent judged no usable evidence. */
  cited: boolean | null;
  document_id: string | null;
  knowledge_base_id: string | null;
}

/** What a knowledge search asked and found, from its retrieval span. */
export interface RetrievalView {
  query: string | null;
  knowledge_outcome: string | null;
  source_count: number | null;
  sources: RetrievalHit[];
  /** Hits beyond the ones the trace keeps. */
  sources_total: number | null;
  retrieval_status: string | null;
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** The search a retrieval span records; undefined for a span without one. */
export function retrievalView(attributes: Record<string, unknown> | undefined): RetrievalView | undefined {
  if (!attributes) return undefined;
  const sources = Array.isArray(attributes.sources) ? attributes.sources : [];
  const query = text(attributes.query) ?? text(record(attributes.pipeline_metadata)?.query);
  if (!query && !sources.length && !("knowledge_outcome" in attributes) && !("source_count" in attributes)) return undefined;
  const hits: RetrievalHit[] = sources
    .map((raw, index): RetrievalHit | undefined => {
      const s = record(raw);
      if (!s) return undefined;
      return {
        rank: num(s.rank) ?? index + 1,
        title: text(s.title) ?? text(s.filename),
        score: num(s.score),
        citation_state: text(s.citation_state),
        cited: typeof s.cited === "boolean" ? s.cited : null,
        document_id: text(s.document_id),
        knowledge_base_id: text(s.knowledge_base_id),
      };
    })
    .filter((h): h is RetrievalHit => Boolean(h));
  const status = text(attributes.retrieval_status) ?? text(record(attributes.pipeline_metadata)?.retrieval_status);
  return {
    query,
    knowledge_outcome: text(attributes.knowledge_outcome),
    source_count: num(attributes.source_count) ?? (hits.length ? hits.length : null),
    sources: hits,
    sources_total: num(attributes.sources_total),
    retrieval_status: status,
  };
}

/** The search as lines: the query, the outcome, and the hits as a table's rows. */
export function retrievalRows(view: RetrievalView): Array<Record<string, unknown>> {
  return view.sources.map((h) => ({
    rank: h.rank,
    title: h.title,
    score: h.score === null ? null : Math.round(h.score * 1000) / 1000,
    citable: h.citation_state === null ? null : h.citation_state === "citable" ? "yes" : "no",
    cited: h.cited === false ? "no" : null,
    document_id: h.document_id,
  }));
}

/** The fields of a span the kit chooses by. */
export interface SpanLike {
  id: string;
  parent_span_id?: string | null;
  span_type?: string;
  status?: string;
  sequence?: number;
  error_json?: unknown;
}

/**
 * The span worth opening first: one that failed, else the last model call
 * (what the agent finally said), else the last knowledge search, else the
 * last span below the root. The root span of a trace carries no content of
 * its own, so it is never the one suggested while there is another.
 */
export function suggestedSpan<T extends SpanLike>(spans: T[]): T | undefined {
  const inOrder = spans.slice().sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const last = (pick: (s: T) => boolean) => inOrder.filter(pick).pop();
  return (
    last((s) => Boolean(s.error_json) || s.status === "error" || s.status === "errored") ??
    last((s) => s.span_type === "llm") ??
    last((s) => s.span_type === "retrieval") ??
    last((s) => Boolean(s.parent_span_id)) ??
    inOrder[0]
  );
}

// ---------------------------------------------------------------------------
// Knowledge outcomes
// ---------------------------------------------------------------------------

/** The error catalog's area for the values of a retrieval span's `knowledge_outcome`. */
export const KNOWLEDGE_OUTCOME_AREA = "knowledge_outcome";

/** The instance's regression-testing page, where the mapping of the recorded value to the trace's is. */
export const KNOWLEDGE_OUTCOME_PAGE = "concepts/regression-testing";

export interface KnowledgeOutcome {
  /** The value, as the span records it (no error code: the catalog lists it under its own area). */
  value: string;
  message: string;
  hint: string;
  /** What the agent records for it, where that differs from what the trace shows. */
  recorded_as?: string;
}

/**
 * The values of a retrieval span's `knowledge_outcome`, as the instance's
 * regression-testing docs describe them, for an instance whose error catalog
 * does not list them yet (area `knowledge_outcome`). A catalog that lists a
 * value always wins. The agent records one of four values; the trace refines
 * its `no_usable_evidence` by what the search returned.
 */
export const KNOWLEDGE_OUTCOMES: readonly KnowledgeOutcome[] = [
  {
    value: "usable_evidence",
    message: "The agent recorded usable_evidence: what this search returned supports the answer.",
    hint: "Nothing to fix. The answer's sources come from this search's hits.",
  },
  {
    value: "content_gap",
    recorded_as: "no_usable_evidence",
    message: "The agent recorded no_usable_evidence and the search returned no hits at all.",
    hint: "Add a document that answers the question, or check that the knowledge base the agent searches holds it.",
  },
  {
    value: "unusable_hits",
    recorded_as: "no_usable_evidence",
    message:
      "The agent recorded no_usable_evidence although the search returned hits: none of them answers the question. A question the knowledge base does not cover usually shows here, not as content_gap, because a search almost always returns its closest passages.",
    hint: "Read the hits on the retrieval span (`cavelon trace … --span <span_id>`). Add the missing content, or improve the document whose passage should have answered it.",
  },
  {
    value: "retrieval_fault",
    message:
      "The search failed technically: the agent recorded retrieval_fault, or it recorded no_usable_evidence for a search that reported an error, a partial or unavailable result, or no knowledge base it may read.",
    hint: "Read the retrieval span's status and attributes, fix the knowledge base binding or the service, and ask again.",
  },
  {
    value: "deliberately_unanswerable",
    message: "The agent recorded deliberately_unanswerable: policy or the nature of the request, not missing content, made it decline.",
    hint: "Nothing to add to the knowledge base. Change the agent's instructions if it should answer.",
  },
  {
    value: "no_usable_evidence",
    message:
      "What the agent records when a search's result cannot support the answer. The trace never shows it: it shows content_gap (no hits), unusable_hits (hits, none usable) or retrieval_fault (the search failed).",
    hint: "Look up the value on the search's retrieval span: `cavelon explain <value>`.",
  },
];

export function knowledgeOutcome(code: string): KnowledgeOutcome | undefined {
  const wanted = code.trim().toLowerCase().replaceAll(" ", "_").replaceAll("-", "_");
  return KNOWLEDGE_OUTCOMES.find((o) => o.value === wanted);
}
