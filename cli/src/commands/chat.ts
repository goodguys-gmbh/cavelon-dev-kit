import { parseDuration, positional, stringOption, type CommandSpec, type Context, type Input } from "../command.js";
import { confirmation, confirmTokenRequired, PERSON_CONFIRMS_HELP } from "../confirm-token.js";
import { named, readDefaultRoute } from "../default-route.js";
import { CavelonError, ExitCode, usageError } from "../errors.js";
import { clip } from "../format.js";
import { harnessNotFoundError, lookupHarness, type HarnessSummary } from "../harness-ref.js";
import { callStable, workflowOperation } from "../invoke.js";
import type { Session } from "../session.js";
import { cavelonCommand, fill } from "../printed.js";
import { MCP_MAX_WAIT_MS } from "./async.js";
import { accessFor, activationStep, mayActivate } from "../access.js";
import { AS_CHAT_USER_OPTION, chatUserReader, chatUserReaderError } from "../chat-reader.js";

/**
 * Talking to one solution, and taking one out of service. The tenant's chat
 * and widget answer only with the default route, so a solution that is not
 * the default is tried by naming it; a draft answers a person as a Playground
 * run (the API endpoints reference, "Try a draft solution").
 */

/** The fields of a ChatResponse the kit reads. */
interface ChatResponse {
  response: string;
  session_id: string;
  conversation_id: string;
  agent_run_id?: string | null;
  ui_directives?: unknown[] | null;
  retrieval_warning?: string | null;
  limit_error?: Record<string, unknown> | null;
}

/** The solution a command acts on: --harness, else the env file's, else cavelon.yaml's. */
function harnessRef(session: Session, input: Input): { ref?: string; source?: string } {
  const option = stringOption(input, "harness");
  if (option) return { ref: option, source: "option" };
  if (session.envFile?.harness) return { ref: session.envFile.harness, source: `env/${session.envFile.name}.yaml` };
  if (session.project?.harness) return { ref: session.project.harness, source: "cavelon.yaml" };
  return {};
}

async function findHarness(ctx: Context, ref: string, source: string | undefined, command: (slug: string) => string): Promise<HarnessSummary> {
  const { harness, candidates } = await lookupHarness(ctx, ref);
  if (harness) return harness;
  throw harnessNotFoundError(ref, candidates, source === "option" ? undefined : source, command);
}

const HARNESS_OPTION = {
  type: "string" as const,
  value: "<harness>",
  description: "The solution (harness): its name, slug or id; default: env file, then cavelon.yaml.",
};
const ENV_OPTION = { type: "string" as const, value: "<name>", description: "Use env/<name>.yaml: its tenant and solution." };
const DEFAULT_CHAT_TIMEOUT = "2m";

/** A refusal of the chat route, with what to do about it. */
function chatError(error: unknown, harness: HarnessSummary | undefined, may: boolean | null = null): unknown {
  if (!(error instanceof CavelonError) || error.status !== 409) return error;
  const hint = !harness
    ? `Nothing answers on the tenant's default route yet: name a solution with --harness, or make an active one the default (\`${cavelonCommand("harness", "default", fill("solution"))}\`).`
    : harness.status !== "active"
      ? `${named(harness)} is ${harness.status}: a draft answers only a person's token (as a Playground run), never a tenant API key. Use a personal access token, or activate it first (${activationStep(may, cavelonCommand("activate", "--harness", harness.slug))}).`
      : "A session belongs to the solution it started with: leave out --session to start a new one.";
  return new CavelonError(error.exitCode, { code: error.code, status: error.status, message: error.message, hint, docs: error.docs, details: error.details });
}

export const chat: CommandSpec = {
  name: "chat",
  summary: "Send one message to a solution and print its answer, with the session to continue and the conversation to trace.",
  description:
    "The tenant's chat and widget answer only with the default route; this names the solution, so an active solution that is\n" +
    "not the default, or a draft, can be tried before it answers anyone. A draft answers a person's token as a Playground run\n" +
    "(counted as testing), never a tenant API key. Without --harness: the env file's or cavelon.yaml's solution, else the\n" +
    "tenant's default route. Each call is one turn; --session continues a conversation. Not streamed: waits for the whole\n" +
    `answer, at most --timeout (default ${DEFAULT_CHAT_TIMEOUT}; ${MCP_MAX_WAIT_MS / 1000} s as an MCP tool).\n` +
    "--as-chat-user reads knowledge and binds database query identity as that Chat User, with a personal access token.\n" +
    "Choose an id with `cavelon api list_chat_users -p tenant_id=<tenant_id>`; email_verified says whether an email-bound\n" +
    "query can bind that address. Without the option, keeps the usual reader.",
  readOnly: false,
  mcpEffect: "Starts or continues a conversation with the solution and runs its agents (model usage, its tools' actions); changes no configuration.",
  mcpTool: "chat",
  operations: ["POST /api/v1/chat"],
  positionals: [{ name: "message", description: "What the user says.", required: true }],
  options: {
    harness: HARNESS_OPTION,
    env: ENV_OPTION,
    session: { type: "string", value: "<session_id>", description: "Continue this conversation (the session_id a previous chat printed)." },
    "as-chat-user": AS_CHAT_USER_OPTION,
    timeout: { type: "string", value: "<duration>", description: `Wait at most this long for the answer (90s, 5m; default ${DEFAULT_CHAT_TIMEOUT}).` },
  },
  examples: ['cavelon chat "When are you open?" --harness support-faq', 'cavelon chat "And on Saturdays?" --session <session_id>', 'cavelon chat "Hello" --json'],
  async run(ctx, input) {
    const message = positional(input, "message")!;
    if (!message.trim()) throw usageError("The message is empty.");
    const raw = stringOption(input, "timeout");
    const timeout = Math.min(parseDuration(raw ?? DEFAULT_CHAT_TIMEOUT), ctx.mode === "mcp" ? MCP_MAX_WAIT_MS : Number.MAX_SAFE_INTEGER);
    const session = await ctx.session();
    const reader = await chatUserReader(ctx, input, "/api/v1/chat");
    const { ref, source } = harnessRef(session, input);
    const harness = ref ? await findHarness(ctx, ref, source, (slug) => cavelonCommand("chat", fill("message"), "--harness", slug)) : undefined;
    const body: Record<string, unknown> = { message, stream: false, ...reader };
    if (harness) body.harness_id = harness.id;
    const sessionId = stringOption(input, "session");
    if (sessionId) body.session_id = sessionId;
    let answer: ChatResponse;
    try {
      answer = await callStable<ChatResponse>(ctx, "POST", "/api/v1/chat", "chatting with a solution", { body, timeoutMs: timeout });
    } catch (error) {
      throw chatUserReaderError(chatError(error, harness, error instanceof CavelonError && error.status === 409 ? mayActivate(await accessFor(await ctx.client())) : null), reader);
    }
    const target = harness ? { id: harness.id, slug: harness.slug, name: harness.name, status: harness.status } : null;
    if (answer.retrieval_warning) ctx.warn(answer.retrieval_warning);
    const next = {
      continue: cavelonCommand("chat", fill("message"), "--session", answer.session_id, ...(reader ? ["--as-chat-user", reader.reader_chat_user_id, ...(harness ? ["--harness", harness.slug] : [])] : [])),
      trace: cavelonCommand("trace", answer.conversation_id, "--kind", "conversation"),
    };
    const who = harness ? named(harness) : "The default route";
    const directives = answer.ui_directives?.length ? `\n(${answer.ui_directives.length} UI directive${answer.ui_directives.length === 1 ? "" : "s"}, such as a form; --json shows them)` : "";
    const limit = answer.limit_error ? `\nlimit: ${clip(JSON.stringify(answer.limit_error), 300)}` : "";
    return {
      data: { harness: target, ...answer, ...reader, next },
      text: [
        ...(reader ? [`Reading as Chat User ${reader.reader_chat_user_id}.`] : []),
        `${who} answered:`,
        `${answer.response || "(no text)"}${directives}${limit}`,
        "",
        `session:          ${answer.session_id}   continue with: ${next.continue}`,
        `conversation_id:  ${answer.conversation_id}   its traces: ${next.trace}`,
      ].join("\n"),
    };
  },
};

export const deactivate: CommandSpec = {
  name: "deactivate",
  summary: "Take an active solution out of service (status inactive); previews first, --confirm deactivates.",
  description:
    "An active solution answers live traffic: the conversations, channels and API keys that name it. Deactivating sets its\n" +
    "status to inactive, not back to draft (a draft has not been activated yet; an inactive solution was taken out of\n" +
    "service). It keeps its configuration and answers no live traffic until it is activated again (`cavelon activate`,\n" +
    "through its readiness gate). Without --confirm nothing changes: the preview says what would stop. Show it to a person\n" +
    "and confirm only with their yes. The tenant's default route is refused before anything is sent: make another solution\n" +
    "the default first (`cavelon harness default <solution>`). An instance that publishes no deactivate route is said so; a\n" +
    "person deactivates in the Admin there.\n" +
    PERSON_CONFIRMS_HELP,
  readOnly: false,
  destructive: true,
  idempotent: true,
  mcpTool: "deactivate",
  operations: ["POST /api/v1/harnesses/{harness_id}/deactivate"],
  options: {
    harness: HARNESS_OPTION,
    env: ENV_OPTION,
    confirm: { type: "boolean", mcpToken: true, description: "Deactivate it (after a person saw the preview)." },
  },
  examples: ["cavelon deactivate --harness support-faq", "cavelon deactivate --harness support-faq --confirm",
    "cavelon deactivate --harness support-faq --confirm <token>",
  ],
  async run(ctx, input) {
    const session = await ctx.session();
    const { ref, source } = harnessRef(session, input);
    if (!ref) throw usageError("Which solution?", `Pass --harness <name or slug> (\`${cavelonCommand("harness", "list")}\` shows them), or set harness in cavelon.yaml or the env file.`);
    // Refused before anything is read, as every confirming tool refuses true.
    if (ctx.mode === "mcp" && input.options.confirm === true) throw confirmTokenRequired("deactivate");
    // Before anything else: an instance without the route cannot do it, whatever the solution.
    await workflowOperation(ctx, "POST", "/api/v1/harnesses/{harness_id}/deactivate", "deactivating solutions").catch((error: unknown) => {
      if (error instanceof CavelonError && error.code === "operation_unavailable") {
        throw new CavelonError(ExitCode.failure, {
          code: "operation_unavailable",
          message: "This instance publishes no route to deactivate a solution; nothing was changed.",
          hint: `A person deactivates it in the Admin; the instance may be older than the route (\`${cavelonCommand("status")}\` shows its version).`,
        });
      }
      throw error;
    });
    const harness = await findHarness(ctx, ref, source, (slug) => cavelonCommand("deactivate", "--harness", slug));
    const target = { id: harness.id, slug: harness.slug, name: harness.name, status: harness.status };
    if (harness.status !== "active") {
      return { data: { changed: false, harness: target }, text: `${named(harness)} is ${harness.status}, not active; nothing to deactivate.` };
    }
    const route = await readDefaultRoute(ctx).catch(() => undefined);
    if (route?.current?.id === harness.id) {
      throw new CavelonError(ExitCode.needsAction, {
        code: "default_route_deactivate",
        message: `${named(harness)} is the tenant's default route: the tenant's chat and widget answer with it. Nothing was changed.`,
        hint: `Ask the person which solution should answer there instead, make it the default (\`${cavelonCommand("harness", "default", fill("solution"))}\`, previews first), then deactivate this one.`,
        details: { harness: target },
      });
    }
    const confirmCommand = cavelonCommand("deactivate", "--harness", harness.slug, "--confirm");
    const gate = await confirmation(ctx, input, "deactivate", { harness: harness.id, status: harness.status }, {
      person: { what: `Deactivate ${named(harness)}: it goes inactive and out of live traffic.`, words: ["deactivate", "--harness", harness.slug, "--confirm"] },
    });
    if (!gate.confirmed) {
      const known = route?.known ? "" : " (this instance does not say which solution is the default route)";
      return {
        data: { changed: false, harness: target, would: "deactivate", confirm: gate.confirm(confirmCommand), ...gate.fields },
        text: [
          `Deactivating ${named(harness)} sets it inactive and takes it out of live traffic: the conversations, channels and API keys that name it are no longer answered by it until it is activated again${known}.`,
          gate.where, ...(gate.mismatch ? [gate.mismatch] : []),
          `Show this to a person; with their yes: ${gate.confirm(confirmCommand)}`,
        ].join("\n"),
        ...(gate.exitCode ? { exitCode: gate.exitCode } : {}),
      };
    }
    const updated = await callStable<HarnessSummary>(ctx, "POST", "/api/v1/harnesses/{harness_id}/deactivate", "deactivating solutions", {
      params: { harness_id: [harness.id] },
    });
    return {
      data: { changed: true, harness: { ...target, status: updated?.status ?? target.status } },
      text: `Deactivated ${named(harness)}; status ${updated?.status ?? "unknown"}. ${
        mayActivate(await accessFor(await ctx.client())) === false
          ? "A person who may activate puts it back through its readiness gate, in the Admin; this credential may not activate."
          : `\`${cavelonCommand("activate", "--harness", harness.slug)}\` puts it back through its readiness gate.`
      }`,
    };
  },
};
