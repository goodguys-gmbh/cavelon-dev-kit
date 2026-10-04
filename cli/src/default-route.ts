import type { Context } from "./command.js";
import { listHarnesses, type HarnessSummary } from "./harness-ref.js";
import { callStable } from "./invoke.js";
import { cavelonCommand } from "./shell.js";

/**
 * The tenant's default route: the solution that answers where a conversation
 * names none (the tenant's chat, its widget). A fresh tenant has an empty
 * `default` solution there, so a new solution answers nobody until it becomes
 * the default. The instance marks it with `is_default` in the solution list;
 * an older instance marks nothing, and then the kit says it does not know.
 */

export interface DefaultRoute {
  /** False when the instance's solution list has no `is_default`. */
  known: boolean;
  current?: HarnessSummary;
}

export async function readDefaultRoute(ctx: Context): Promise<DefaultRoute> {
  const all = await listHarnesses(ctx);
  const known = all.some((h) => typeof h.is_default === "boolean");
  return { known, current: known ? all.find((h) => h.is_default === true) : undefined };
}

export const named = (h: Pick<HarnessSummary, "name" | "slug">) => (h.name && h.name !== h.slug ? `${h.name} (${h.slug})` : h.slug);

/** The command that previews making a solution the default route, and the one that confirms it. */
export function defaultCommands(slug: string): { preview: string; confirm: string } {
  return { preview: cavelonCommand("harness", "default", slug), confirm: cavelonCommand("harness", "default", slug, "--confirm") };
}

/** What a change of the default route does, for a preview a person reads. */
export function defaultChangeLine(target: Pick<HarnessSummary, "name" | "slug">, route: DefaultRoute): string {
  const now = route.current ? named(route.current) : route.known ? "no solution" : "unknown (this instance does not say)";
  return `default → ${now} now; would become ${named(target)}. This changes live traffic: the tenant's chat and widget answer with it where a conversation names no solution.`;
}

export async function setDefaultRoute<T>(ctx: Context, harnessId: string): Promise<T> {
  return callStable<T>(ctx, "POST", "/api/v1/harnesses/{harness_id}/default", "setting the default route", {
    params: { harness_id: [harnessId] },
  });
}
