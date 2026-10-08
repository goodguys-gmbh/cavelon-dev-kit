import type { Context } from "./command.js";
import { CavelonError, ExitCode } from "./errors.js";

/**
 * Whether a coding agent runs this `cavelon`. An agent with a shell can run
 * any command, so the guards of the MCP `api` tool would hold only for the
 * agents that use MCP; the variables below are the ones the agents set for
 * the commands their shell tool runs, as their own documentation or source
 * says, so the guard holds without anything for a person to configure.
 * `CAVELON_AGENT=1` is for an agent that sets none: a person puts it into
 * that agent's shell environment.
 *
 * A variable with a `value` counts only with that value (compared without
 * case). Some agents set theirs in every terminal of their app, not only the
 * agent's (Kiro's TERM_PROGRAM, OpenCode, Gemini CLI's `!` commands): a
 * person typing there is guarded too, which errs on the safe side.
 *
 * This is a guard against an agent's mistake, not a boundary: the instance
 * enforces the token's role and ceiling whatever the shell says.
 */
export const AGENT_VARIABLES: ReadonlyArray<{ variable: string; value?: string; agent: string }> = [
  { variable: "CAVELON_AGENT", agent: "any agent whose shell environment sets it" },
  { variable: "CLAUDECODE", agent: "Claude Code" },
  { variable: "CODEX_THREAD_ID", agent: "Codex" },
  { variable: "CODEX_CI", agent: "Codex" },
  // Codex sets this one inside its macOS sandbox, whatever else it sets.
  { variable: "CODEX_SANDBOX", agent: "Codex" },
  { variable: "CURSOR_AGENT", agent: "Cursor" },
  { variable: "GEMINI_CLI", agent: "Gemini CLI" },
  { variable: "QWEN_CODE", agent: "Qwen Code" },
  { variable: "COPILOT_CLI", agent: "GitHub Copilot CLI" },
  { variable: "COPILOT_AGENT", agent: "GitHub Copilot in VS Code" },
  // kiro-cli sets it only while its agent drives the command; it holds a path.
  { variable: "AGENT_CONTEXT_OUT", agent: "Kiro CLI" },
  // The Kiro IDE marks no agent terminal; it sets this in every terminal it opens.
  { variable: "TERM_PROGRAM", value: "kiro", agent: "Kiro" },
  { variable: "OPENCODE", agent: "OpenCode" },
  // Pi's shell tools expose the current session by default.
  { variable: "PI_SESSION_ID", agent: "Pi" },
  // Goose's developer shell exposes its current session by default.
  { variable: "AGENT_SESSION_ID", agent: "Goose or another agent exposing its session" },
  { variable: "GROK_AGENT", agent: "Grok Build" },
  // The cross-vendor variable newer agents set; last, so an agent's own variable is the one named.
  { variable: "AI_AGENT", agent: "an agent that follows the AI_AGENT convention" },
];

type Env = Record<string, string | undefined>;

function isSet(value: string | undefined, expected: string | undefined): boolean {
  const text = value?.trim().toLowerCase();
  if (expected !== undefined) return text === expected;
  return Boolean(text) && text !== "0" && text !== "false";
}

/** The variable that says a coding agent runs this command, or undefined for a person's terminal. */
export function agentVariable(env: Env): string | undefined {
  return AGENT_VARIABLES.find(({ variable, value }) => isSet(env[variable], value))?.variable;
}

/**
 * Who drives the command when the agent guards apply: an MCP client, or a
 * coding agent's shell (named by its variable). Undefined for a person.
 */
export type DrivenBy = { by: "mcp" } | { by: "agent"; variable: string };

export function drivenByAgent(ctx: Context): DrivenBy | undefined {
  if (ctx.mode === "mcp") return { by: "mcp" };
  const variable = agentVariable(ctx.io.env);
  return variable ? { by: "agent", variable } : undefined;
}

/**
 * Refuse a command that stays with a person when an agent runs it, before it
 * asks for or sends anything. The refusal says who runs it instead and never
 * what tells an agent from a person: naming the variable would tell the agent
 * how to get past the guard.
 */
export function refuseForAgent(ctx: Context, what: string, command: string): void {
  if (!drivenByAgent(ctx)) return;
  throw new CavelonError(ExitCode.needsAction, {
    code: "operation_for_a_person",
    message: `${what} stays with a person, so cavelon does not do it when a coding agent runs it; nothing was sent.`,
    hint: `A person runs this in their own terminal: \`${command}\`, or does it in the Admin.`,
    details: { sent: false },
  });
}
