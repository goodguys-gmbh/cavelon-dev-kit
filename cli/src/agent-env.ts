import type { Context } from "./command.js";

/**
 * Whether a coding agent runs this `cavelon`. An agent with a shell can run
 * any command, so the guards of the MCP `api` tool would hold only for the
 * agents that use MCP; the variables below are the ones the agents set for
 * the commands their shell tool runs, as their own documentation or source
 * says (Kiro documents none). `CAVELON_AGENT=1` is for an agent that sets
 * none: a person puts it into that agent's shell environment.
 *
 * This is a guard against an agent's mistake, not a boundary: the instance
 * enforces the token's role and ceiling whatever the shell says.
 */
export const AGENT_VARIABLES: ReadonlyArray<{ variable: string; agent: string }> = [
  { variable: "CAVELON_AGENT", agent: "any agent whose shell environment sets it" },
  { variable: "CLAUDECODE", agent: "Claude Code" },
  { variable: "CODEX_THREAD_ID", agent: "Codex" },
  // Codex sets this one inside its macOS sandbox, whatever else it sets.
  { variable: "CODEX_SANDBOX", agent: "Codex" },
  { variable: "CURSOR_AGENT", agent: "Cursor" },
  { variable: "GEMINI_CLI", agent: "Gemini CLI" },
  { variable: "COPILOT_CLI", agent: "GitHub Copilot CLI" },
  { variable: "COPILOT_AGENT", agent: "GitHub Copilot in VS Code" },
  // The cross-vendor variable newer agents set; last, so an agent's own variable is the one named.
  { variable: "AI_AGENT", agent: "an agent that follows the AI_AGENT convention" },
];

type Env = Record<string, string | undefined>;

function isSet(value: string | undefined): boolean {
  const text = value?.trim().toLowerCase();
  return Boolean(text) && text !== "0" && text !== "false";
}

/** The variable that says a coding agent runs this command, or undefined for a person's terminal. */
export function agentVariable(env: Env): string | undefined {
  return AGENT_VARIABLES.find(({ variable }) => isSet(env[variable]))?.variable;
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
