import { createHash, randomUUID } from "node:crypto";
import { stringOption, type Context, type Input, type OptionSpec } from "./command.js";
import { CavelonError, ExitCode, usageError } from "./errors.js";
import { cavelonCommand } from "./printed.js";
import { isUuid } from "./session.js";

/**
 * What an instance offers, from its published capabilities, and the
 * idempotency keys the Sandbox and loop routes require.
 */

/**
 * Refuse a command whose feature the instance has switched off, with the
 * instance's own error code. An instance that publishes no capabilities is
 * left to answer for itself.
 */
export async function requireFeature(ctx: Context, feature: string, code: string, what: string): Promise<void> {
  const caps = await (await ctx.contracts()).capabilities();
  if (caps?.features?.[feature] === false) {
    throw new CavelonError(ExitCode.failure, {
      code,
      message: `This instance has ${what} switched off.`,
      hint: `Its operator switches it on (${feature.toUpperCase()}); \`${cavelonCommand("status")}\` shows the instance.`,
    });
  }
}

/** The execution modes the instance offers new Sandboxes, or undefined when it does not say. */
export async function instanceModes(ctx: Context): Promise<string[] | undefined> {
  const caps = await (await ctx.contracts()).capabilities();
  const sandbox = caps?.sandbox as { execution_modes?: unknown } | undefined;
  return Array.isArray(sandbox?.execution_modes) ? sandbox.execution_modes.map(String) : undefined;
}

export const UUID_KEY_OPTION: OptionSpec = {
  type: "string",
  value: "<uuid>",
  description: "The Idempotency-Key to send (a UUID), so a retry of the same call does nothing twice.",
};

/** The key the caller passed, or a new one. */
export function idempotencyKey(input: Input): string {
  const given = stringOption(input, "idempotency-key");
  if (given === undefined) return randomUUID();
  if (!isUuid(given)) throw usageError("--idempotency-key must be a UUID.");
  return given.toLowerCase();
}

/**
 * An error that leaves open whether the instance got the request (a timeout,
 * a cut connection, a 5xx), with the key a retry must send again: a new key
 * would start the work a second time.
 */
export function withRetryKey(error: unknown, key: string): unknown {
  if (!(error instanceof CavelonError) || error.exitCode !== ExitCode.server) return error;
  // The network hints start with a bare "Retry"; this one says how.
  const rest = error.hint?.replace(/^Retry[;.]\s*/, "");
  const details = error.details && typeof error.details === "object" && !Array.isArray(error.details) ? error.details : {};
  return new CavelonError(error.exitCode, {
    code: error.code,
    message: error.message,
    hint: [`Retry with --idempotency-key ${key}, so the instance does not do it twice.`, rest ? rest[0]!.toUpperCase() + rest.slice(1) : ""].filter(Boolean).join(" "),
    docs: error.docs,
    status: error.status,
    details: { ...details, idempotency_key: key },
    blockers: error.blockers,
  });
}

/** A UUID that depends only on `seed`: the same request gets the same key. */
export function stableKey(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
