import { createHash } from "node:crypto";
import { actingTarget, targetLine, type ActingTarget, type PlatformTarget } from "./acting.js";
import { drivenByAgent } from "./agent-env.js";
import type { Context, Input } from "./command.js";
import { CavelonError, ExitCode, type ExitCodeValue } from "./errors.js";
import { canonical } from "./package-files.js";
import { PREVIEW_TOKEN } from "./printed.js";

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

/** Whether `confirm` was given at all: a flag or a token in a terminal, a token (or a refused true) over MCP. */
export function confirmGiven(input: Input): boolean {
  const value = input.options.confirm;
  return value !== undefined && value !== false && value !== "";
}

export interface Confirmation {
  confirmed: boolean;
  /**
   * What a preview adds: where the change would go (`target`), and for an
   * agent the token and whether the confirm given was not this change's.
   */
  fields: { target?: ActingTarget; confirm_token?: string; token_mismatch?: true; token_required?: true };
  /** The preview's line naming the instance, tenant and mode the change acts on; empty once confirmed. */
  where: string;
  /** The line a preview's text adds when a confirm was given but did not confirm: another change's token, or a bare flag. */
  mismatch?: string;
  /** Set when a confirm was given but did not confirm: exit 4 for another change's token, 5 for a bare flag. */
  exitCode?: ExitCodeValue;
  /**
   * A preview's `confirm` field: the command a person confirms with; in an
   * agent's shell the same command with the token; over MCP how to confirm
   * with the token.
   */
  confirm(command: string): string;
}

/** The confirming command with the token after its `--confirm`, as an agent's shell needs it. */
export function withToken(printed: string, token: string): string {
  // A line printed in an agent's shell names the token it needs where the preview's token now goes.
  const command = printed.replace(` --confirm ${PREVIEW_TOKEN}`, " --confirm");
  if (command.endsWith(" --confirm")) return `${command} ${token}`;
  const at = command.indexOf(" --confirm ");
  if (at >= 0) return `${command.slice(0, at)} --confirm ${token}${command.slice(at + " --confirm".length)}`;
  return `${command} --confirm ${token}`;
}

/**
 * Whether a changing command was confirmed. In a person's terminal
 * `--confirm` is enough: whoever runs the command typed the change. Over MCP
 * `confirm` takes the `confirm_token` the tool's preview returned for exactly
 * this change, so an agent cannot skip the preview or confirm another change
 * than the one it showed; `true` is refused, never taken as yes. A coding
 * agent's shell (`drivenByAgent`) is held to the same: `--confirm <token>`
 * confirms, and a bare `--confirm` only shows the preview, so an agent with a
 * shell cannot skip what the MCP tool asks of it. A token given in a person's
 * terminal is checked too.
 *
 * `tool` names the kind of change, so a token of one tool confirms nothing
 * else; `change` is what the preview shows would happen, without what varies
 * between two calls for the same change (timestamps, progress). A preview
 * also names the instance, tenant and mode it acts on (`target`, `where`);
 * `platform` marks a change sent in Platform mode.
 */
export async function confirmation(ctx: Context, input: Input, tool: string, change: unknown, options: PlatformTarget = {}): Promise<Confirmation> {
  const gate = await gateOf(ctx, input, tool, change);
  if (gate.confirmed) return { ...gate, where: "" };
  // A preview names where the change goes, so the person who approves sees the tenant an agent passed, or that none is chosen.
  const target = await actingTarget(ctx, options);
  return { ...gate, fields: { target, ...gate.fields }, where: targetLine(target) };
}

async function gateOf(ctx: Context, input: Input, tool: string, change: unknown): Promise<Omit<Confirmation, "where">> {
  const given = input.options.confirm;
  const driven = drivenByAgent(ctx);
  const tokenGiven = typeof given === "string" && given !== "";
  if (!driven && !tokenGiven) return { confirmed: given === true, fields: {}, confirm: (command) => command };
  if (driven?.by === "mcp" && given === true) throw confirmTokenRequired(tool);
  const session = await ctx.session();
  const token = confirmToken({ url: session.url, tenant: session.tenant }, tool, change);
  const confirm = (command: string) => (driven?.by === "mcp" ? confirmWith(tool, token) : driven ? withToken(command, token) : command);
  if (given === true && driven?.by === "agent") {
    return {
      confirmed: false,
      fields: { confirm_token: token, token_required: true },
      confirm,
      mismatch: `--confirm alone does not confirm when a coding agent runs cavelon. Nothing was changed: show the person this preview, and with their yes run the command below, which carries this change's token.`,
      exitCode: ExitCode.needsAction,
    };
  }
  if (!tokenGiven) return { confirmed: false, fields: { confirm_token: token }, confirm };
  if (given === token) return { confirmed: true, fields: {}, confirm };
  return {
    confirmed: false,
    fields: { confirm_token: token, token_mismatch: true },
    confirm,
    mismatch: "The confirm token is not this change's: the change differs from its preview, or the token is another one's. Nothing was changed.",
    exitCode: ExitCode.conflict,
  };
}

/**
 * A bare `--confirm` in a coding agent's shell, where a command must refuse
 * it before it does anything (activate, whose activation would go ahead).
 */
export function shellTokenRequired(command: string): CavelonError {
  return new CavelonError(ExitCode.needsAction, {
    code: "confirm_token_required",
    message: "--confirm alone does not confirm when a coding agent runs cavelon; nothing was changed.",
    hint: `Run \`${command}\` without --confirm, show the person the preview, and with their yes run the command it prints, which carries the change's token.`,
  });
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
