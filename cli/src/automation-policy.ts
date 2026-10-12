import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { actingTarget } from "./acting.js";
import type { Context } from "./command.js";
import { canonical } from "./package-files.js";
import { lookupHarness } from "./harness-ref.js";

/**
 * A process launch can authorize routine work, never a person-only operation.
 * Keep the credential fingerprint private and bind to resolved tenant identity:
 * a changed login or another solution must not inherit this allowance.
 */
export async function yoloScope(ctx: Context): Promise<string | undefined> {
  const session = await ctx.session();
  const target = await actingTarget(ctx);
  if (!session.token || target.mode !== "tenant" || !target.tenant?.id) return undefined;
  const selected = session.envFile?.harness ?? session.project?.harness;
  const harness = selected ? (await lookupHarness(ctx, selected)).harness : undefined;
  if (selected && !harness) return undefined;
  return canonical({
    instance: target.instance,
    tenant: target.tenant.id,
    credential: createHash("sha256").update(session.token).digest("hex"),
    root: await realpath(session.project?.root ?? ctx.io.cwd),
    harness: selected ?? null,
    harness_id: harness?.id ?? null,
    environment: ctx.globals.solutionEnv ?? null,
    bindings: session.envFile?.runtimeBindings ?? {},
    mode: session.envFile?.mode ?? null,
  });
}

/** Only a caller that established routine effects may use this allowance. */
export async function yoloAllows(ctx: Context, harness?: { id: string; slug?: string | null }): Promise<boolean> {
  if (!ctx.globals.yolo) return false;
  const original = await ctx.globals.yoloScope;
  const current = await yoloScope(ctx);
  if (!original || current !== original) {
    ctx.warn("YOLO does not cover this target, credential or solution folder; using the standard confirmation policy. Restart with the intended target to enable it there.");
    return false;
  }
  if (harness) {
    const session = await ctx.session();
    const selected = session.envFile?.harness ?? session.project?.harness;
    if (!selected || (await lookupHarness(ctx, selected)).harness?.id !== harness.id) {
      ctx.warn("YOLO covers only the solution selected at startup; using the standard confirmation policy for this solution.");
      return false;
    }
  }
  return true;
}
