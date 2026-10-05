import { closest, displayName, exactMatch } from "./choose.js";
import type { Context } from "./command.js";
import { CavelonError, ExitCode } from "./errors.js";
import { callStable } from "./invoke.js";
import { isUuid } from "./session.js";
import { shellWord } from "./shell.js";

/**
 * A solution (harness) named by id, slug or name. The instance looks one up
 * by id or by its exact slug; a name, or a slug in other letter case, is
 * matched in the tenant's list of solutions.
 */

export interface HarnessSummary {
  id: string;
  slug: string;
  name: string;
  status: string;
  is_default?: boolean;
}

/** Undefined when nothing matched; `candidates` holds the closest solutions then. */
export interface HarnessLookup<T> {
  harness?: T;
  candidates: T[];
}

function notFound(error: unknown): boolean {
  return error instanceof CavelonError && error.status === 404;
}

export async function listHarnesses<T extends HarnessSummary = HarnessSummary>(ctx: Context): Promise<T[]> {
  return callStable<T[]>(ctx, "GET", "/api/v1/harnesses", "listing solutions");
}

export async function lookupHarness<T extends HarnessSummary = HarnessSummary>(ctx: Context, ref: string): Promise<HarnessLookup<T>> {
  if (isUuid(ref)) {
    try {
      return { harness: await callStable<T>(ctx, "GET", "/api/v1/harnesses/{harness_id}", "reading solutions", { params: { harness_id: [ref] } }), candidates: [] };
    } catch (error) {
      if (!notFound(error)) throw error;
      return { candidates: [] };
    }
  }
  try {
    return { harness: await callStable<T>(ctx, "GET", "/api/v1/harnesses/by-slug/{slug}", "finding solutions by slug", { params: { slug: [ref] } }), candidates: [] };
  } catch (error) {
    if (!notFound(error)) throw error;
  }
  const all = await listHarnesses<T>(ctx);
  const hit = exactMatch(all, ref);
  if (hit) return { harness: hit, candidates: [] };
  return { candidates: closest(all, ref) };
}

/** A solution that is not in this tenant, naming the closest ones and the command for each. */
export function harnessNotFoundError(ref: string, candidates: HarnessSummary[], source?: string, command?: (slug: string) => string): CavelonError {
  const near = candidates.map(displayName).join(", ");
  const lines = candidates.map((h) => `  ${command ? command(h.slug) : `--harness ${shellWord(h.slug)}`}`).join("\n");
  return new CavelonError(ExitCode.failure, {
    code: "solution_not_found",
    message: `No solution "${ref}" in this tenant${source ? ` (from ${source})` : ""}.${near ? ` Closest: ${near}.` : ""}`,
    hint:
      (candidates.length ? `If you meant one of them:\n${lines}\n` : "") +
      "`cavelon harness list` shows this tenant's solutions with name, slug and id; `cavelon harness new <slug> --name <name>` creates one as a draft (`cavelon init --harness <name>` does too).",
    details: candidates.length ? { candidates: candidates.map((h) => ({ id: h.id, slug: h.slug, name: h.name })) } : undefined,
  });
}

/** The solution's id, from its id, slug or name; a miss names the closest. */
export async function resolveHarnessId(ctx: Context, ref: string): Promise<string> {
  if (isUuid(ref)) return ref;
  const { harness, candidates } = await lookupHarness(ctx, ref);
  if (!harness) throw harnessNotFoundError(ref, candidates);
  return harness.id;
}

/** A slug from a solution's name: lower-case letters, digits and single dashes. */
export function slugFromName(name: string): string {
  const plain = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  let slug = plain.replace(/[^a-z0-9]+/g, "-");
  while (slug.startsWith("-")) slug = slug.slice(1);
  while (slug.endsWith("-")) slug = slug.slice(0, -1);
  slug = slug.slice(0, 60);
  while (slug.endsWith("-")) slug = slug.slice(0, -1);
  return slug;
}

/** What a solution's slug looks like. */
export const SLUG = /^[a-z0-9][a-z0-9-]*$/;
