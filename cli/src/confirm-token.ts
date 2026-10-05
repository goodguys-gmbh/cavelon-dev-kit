import { createHash } from "node:crypto";
import type { Context, Input } from "./command.js";
import { CavelonError, ExitCode, type ExitCodeValue } from "./errors.js";
import { canonical } from "./package-files.js";

/** The token a preview returns for confirming exactly it: 12 hex digits of the change's hash. */
export const CONFIRM_TOKEN = /^[0-9a-f]{12}$/;

/**
 * The token that confirms exactly one previewed change: a hash of where it
 * goes (instance, tenant), which tool makes it and what it changes, so a
 * different change, tenant or instance needs a new preview. It holds no
 * secret; it only makes confirming take a preview first.
 */
export function confirmToken(target: { url?: string; tenant?: string }, tool: string, change: unknown): string {
  return createHash("sha256")
    .update(canonical({ instance: target.url ?? null, tenant: target.tenant ?? null, tool, change }))
    .digest("hex")
    .slice(0, 12);
}

/** Whether `confirm` was given at all: true in a terminal, a token (or a refused true) over MCP. */
export function confirmGiven(input: Input): boolean {
  const value = input.options.confirm;
  return value !== undefined && value !== false && value !== "";
}

export interface Confirmation {
  confirmed: boolean;
  /** What a preview adds over MCP: the token, and whether the token given was another change's. */
  fields: { confirm_token?: string; token_mismatch?: true };
  /** The line a preview's text adds when the token given was another change's. */
  mismatch?: string;
  /** Set when the token given was another change's: the preview is returned with exit 4. */
  exitCode?: ExitCodeValue;
  /** A preview's `confirm` field: the command a terminal confirms with, or over MCP how to confirm with the token. */
  confirm(command: string): string;
}

/**
 * Whether a changing command was confirmed. In a terminal `--confirm` is
 * enough: whoever runs the command typed the change. Over MCP `confirm` takes
 * the `confirm_token` the tool's preview returned for exactly this change, so
 * an agent cannot skip the preview or confirm another change than the one it
 * showed; `true` is refused, never taken as yes.
 *
 * `tool` names the kind of change, so a token of one tool confirms nothing
 * else; `change` is what the preview shows would happen, without what varies
 * between two calls for the same change (timestamps, progress).
 */
export async function confirmation(ctx: Context, input: Input, tool: string, change: unknown): Promise<Confirmation> {
  const given = input.options.confirm;
  if (ctx.mode !== "mcp") return { confirmed: given === true, fields: {}, confirm: (command) => command };
  if (given === true) throw confirmTokenRequired(tool);
  const session = await ctx.session();
  const token = confirmToken({ url: session.url, tenant: session.tenant }, tool, change);
  const confirm = () => confirmWith(tool, token);
  if (typeof given !== "string" || !given) return { confirmed: false, fields: { confirm_token: token }, confirm };
  if (given === token) return { confirmed: true, fields: {}, confirm };
  return {
    confirmed: false,
    fields: { confirm_token: token, token_mismatch: true },
    confirm,
    mismatch: "The confirm token is not this change's: the change differs from its preview, or the token is another one's. Nothing was changed.",
    exitCode: ExitCode.conflict,
  };
}

/** `confirm: true` over MCP, where only a preview's token confirms. */
export function confirmTokenRequired(tool: string): CavelonError {
  return new CavelonError(ExitCode.usage, {
    code: "confirm_token_required",
    message: `${tool} confirms only with the confirm_token its preview returned, not with true; nothing was changed.`,
    hint: `Call ${tool} without confirm, show the person what it would do, then call it again with the same arguments and confirm set to its confirm_token.`,
  });
}

/** The instruction a preview gives over MCP, for its `confirm` field. */
export function confirmWith(tool: string, token: string): string {
  return `Show the person this, then call ${tool} again with the same arguments and confirm: "${token}" to make exactly this change.`;
}
