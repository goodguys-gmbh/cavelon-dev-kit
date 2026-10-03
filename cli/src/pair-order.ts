import type { ErrorCatalog } from "./contracts.js";
import { catalogEntry } from "./package-check.js";

/**
 * A Masterloop parent and its iteration solution.
 * The iteration passes readiness only through the parent's loop suite, the
 * parent's Masterloop check refuses a draft iteration, and a live parent's
 * import refuses one too; a draft parent binds a draft iteration. So one order
 * activates both without the override, and `activate` never forces. Where
 * `apply` or `activate` meets a refusal of that order, the kit gives the
 * catalog's own sentence and hint, the step it points at, and the order.
 */

export const PAIR_ORDER = [
  "apply the iteration solution",
  "apply the parent",
  "run the parent's loop suite",
  "activate the iteration solution",
  "activate the parent",
] as const;

export const DRAFT_ITERATION_NEEDS_DRAFT_PARENT = "runtime_draft_iteration_needs_draft_parent";
export const ITERATION_UNAVAILABLE = "runtime_external_iteration_harness_unavailable";
/** The parent's Masterloop check: its readiness names the catalog's sentence, not the code. */
export const ITERATION_DRAFT = "masterloop_iteration_harness_draft";

/** The kit's pointer to the step each code is about. */
const POINTERS: Record<string, string> = {
  [ITERATION_UNAVAILABLE]:
    "Step 1 comes first: `cavelon apply` the iteration solution into its own solution, bind that solution's id " +
    "under runtime_bindings in the parent's env/<name>.yaml, then apply the parent (step 2).",
  [DRAFT_ITERATION_NEEDS_DRAFT_PARENT]:
    "Step 2 binds a draft iteration only into a draft parent: apply the parent into a draft solution " +
    "(a new one, or `cavelon harness new <slug>`), or activate the iteration solution first (step 4).",
  [ITERATION_DRAFT]:
    "Step 4 comes before step 5: once the parent's loop suite passed, `cavelon activate` the iteration solution, " +
    "then activate the parent.",
};

export const PAIR_ORDER_CODES = Object.keys(POINTERS);

/** The order as one sentence. */
export function pairOrderText(): string {
  return `The order that needs no override: ${PAIR_ORDER.map((step, i) => `${i + 1}. ${step}`).join("; ")}. \`cavelon activate\` never forces.`;
}

/** The kit's pointer and the order for a code of the pair, or undefined for any other code. */
export function pairOrderPointer(code: string): string | undefined {
  const pointer = POINTERS[code];
  return pointer ? `${pointer} ${pairOrderText()}` : undefined;
}

export interface PairOrderHint {
  code: string;
  hint: string;
}

/**
 * The first code of the pair that these texts (preview blockers, readiness
 * details, an error's message) name, by its code or by the catalog's sentence
 * for it, with the catalog's sentence and hint, the kit's pointer and the order.
 */
export function pairOrderHint(catalog: ErrorCatalog | null | undefined, texts: Array<string | undefined>): PairOrderHint | undefined {
  const said = texts.filter((t): t is string => typeof t === "string" && t !== "");
  for (const code of PAIR_ORDER_CODES) {
    const entry = catalogEntry(catalog, code);
    const named = new RegExp(`\\b${code}\\b`);
    if (!said.some((t) => named.test(t) || (entry?.message ? t.includes(entry.message) : false))) continue;
    const catalogSentence = entry ? [entry.message, entry.hint].filter(Boolean).join(" ") : "";
    return { code, hint: [`${code}:`, catalogSentence, pairOrderPointer(code)].filter(Boolean).join(" ") };
  }
  return undefined;
}
