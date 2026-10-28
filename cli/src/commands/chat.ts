import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { boolOption, listOption, parseDuration, positional, stringOption, type CommandSpec, type Context, type Input } from "../command.js";
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
import { deref, jsonBodySchema } from "../openapi.js";
import { confinedPath } from "../paths.js";

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
  /**
   * How the turn ended. A recent instance always sends it: completed,
   * cancelled, waiting or blocked, and null for a turn that failed or was
   * refused (by a limit, say). An older instance leaves it out, and then the
   * turn was answered: absent is not null.
   */
  status?: string | null;
}

/** The fields of an UploadFileResponse the kit reads. */
interface UploadedFile {
  file_id: string;
  filename: string;
  processing_status?: string;
}

/** The conversations the instance lists, as far as finding a session's needs. */
interface ListedConversation {
  id: string;
  session_id?: string | null;
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
const CHAT_ROUTE = "/api/v1/chat";
const CHAT_FILES_ROUTE = "/api/v1/chat/files";
const CONVERSATIONS_ROUTE = "/api/v1/conversations";
/** How long the kit looks for a timed-out turn's conversation; over MCP it comes out of the tool's wait. */
const LOOKUP_MS = 5_000;

const unavailable = (message: string, hint: string) =>
  new CavelonError(ExitCode.failure, { code: "operation_unavailable", message, hint, details: { sent: false } });

/** The fields a request body publishes, or undefined when the instance's OpenAPI cannot say. */
async function bodyFields(ctx: Context, method: string, route: string, what: string, multipart = false): Promise<Record<string, unknown> | undefined> {
  const { doc, op } = await workflowOperation(ctx, method, route, what);
  if (!doc) return undefined;
  const schema = multipart ? op.requestBody?.content?.["multipart/form-data"]?.schema : jsonBodySchema(op);
  const body = schema ? (deref(doc, schema) as { properties?: Record<string, unknown> } | undefined) : undefined;
  return body?.properties ?? {};
}

/**
 * --draft: the draft's settings on an active solution, as the Playground runs
 * them. Refused before anything is sent where the instance does not publish
 * `preview_draft`, or the credential cannot use it: a tenant API key never
 * can, and a token whose published permissions lack playground.use cannot.
 */
async function checkDraft(ctx: Context, fields: Record<string, unknown> | undefined): Promise<void> {
  if (fields && !fields.preview_draft) {
    throw unavailable(
      "This instance does not publish preview_draft on chat, so --draft cannot try a draft's settings. Nothing was sent.",
      `The instance may be older than this feature; \`${cavelonCommand("status")}\` shows its version. A solution that is still a draft answers a person's token as a Playground run without --draft.`,
    );
  }
  const access = await accessFor(await ctx.client());
  if (access?.kind === "api_key" || (await ctx.session()).tokenKind === "api_key") {
    throw new CavelonError(ExitCode.unauthorized, {
      code: "forbidden",
      message: "A tenant API key cannot chat with a solution's draft. Nothing was sent.",
      hint: "Use a personal access token whose role holds playground.use, or leave out --draft to chat with the published version.",
      details: { sent: false, credential: "api_key" },
    });
  }
  if (access?.permissions && !access.permissions.includes("playground.use")) {
    throw new CavelonError(ExitCode.unauthorized, {
      code: "permission_missing",
      message: "Chatting with a draft needs playground.use, which this credential does not hold. Nothing was sent.",
      hint: "A person whose role holds playground.use uses a token with it, or leave out --draft to chat with the published version.",
      details: { sent: false, missing_permissions: ["playground.use"] },
    });
  }
}

/**
 * --file: each file uploaded to the turn's conversation (`scope`
 * conversation, by the session the kit sends the turn with) and named in
 * `file_ids`. Checked before anything is sent: a form without `scope` or
 * `session_id` would put the file into a knowledge base instead.
 */
async function uploadFiles(ctx: Context, files: string[], sessionId: string, chatFields: Record<string, unknown> | undefined, deadline: number): Promise<UploadedFile[]> {
  if (!files.length) return [];
  if (chatFields && !chatFields.file_ids) {
    throw unavailable("This instance's chat takes no file_ids, so --file cannot attach a file. Nothing was sent.", `The instance may be older than this feature; \`${cavelonCommand("status")}\` shows its version.`);
  }
  const resolved: string[] = [];
  for (const raw of files) {
    const file = await confinedPath(ctx, raw, "The file");
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat?.isFile()) throw usageError(`${raw} is not a file. Nothing was sent.`, "Name a file to attach with --file <path>.");
    resolved.push(file);
  }
  const form = await bodyFields(ctx, "POST", CHAT_FILES_ROUTE, "attaching a file to a chat message", true);
  if (form && (!form.scope || !form.session_id)) {
    throw unavailable(
      "This instance's chat file upload publishes no conversation scope or session, so --file cannot attach a file to this turn. Nothing was sent.",
      `The instance may be older than this feature; \`${cavelonCommand("status")}\` shows its version.`,
    );
  }
  const uploaded: UploadedFile[] = [];
  for (const file of resolved) {
    const result = await callStable<UploadedFile>(ctx, "POST", CHAT_FILES_ROUTE, "attaching a file to a chat message", {
      body: { scope: "conversation", session_id: sessionId },
      files: [{ field: "file", path: file }],
      timeoutMs: Math.max(1_000, deadline - Date.now()),
    }).catch((error: unknown) => {
      throw uploadsOff(error) ?? error;
    });
    uploaded.push({ file_id: result.file_id, filename: result.filename ?? path.basename(file), processing_status: result.processing_status });
  }
  return uploaded;
}

/**
 * The instance refuses a chat file with 403 when the tenant's document
 * uploads, or their conversation scope, are off ("… not enabled for this
 * tenant"). That is a tenant setting, not the token's role, so the hint
 * names the setting instead of the generic permission hint.
 */
function uploadsOff(error: unknown): CavelonError | undefined {
  if (!(error instanceof CavelonError) || error.status !== 403 || !/not enabled for this tenant/i.test(error.message)) return undefined;
  return new CavelonError(ExitCode.unauthorized, {
    code: "chat_uploads_off",
    message: `${error.message} The message was not sent.`,
    hint: "Files in a chat are a tenant setting: someone who manages the tenant's uploads turns on document uploads and their Chat/Run Context scope in the Admin (Settings › Documents). Leave out --file to send the message without it.",
    status: 403,
    details: { sent: false },
  });
}

/** The conversation a session belongs to, from the newest the instance lists; undefined when it cannot say in time. */
async function conversationOf(ctx: Context, sessionId: string, harness: HarnessSummary | undefined): Promise<string | undefined> {
  try {
    const list = await callStable<ListedConversation[]>(ctx, "GET", CONVERSATIONS_ROUTE, "listing conversations", {
      query: { ...(harness ? { harness_id: harness.id } : {}) },
      timeoutMs: LOOKUP_MS,
    });
    return (Array.isArray(list) ? list : []).find((c) => c.session_id === sessionId)?.id;
  } catch {
    return undefined;
  }
}

/**
 * A turn the kit stopped waiting for. The instance runs a non-streaming turn
 * to its end even when the client gives up, and stores its answer: sending
 * the message again would run it twice. So the hint says where to read it,
 * never to retry.
 */
async function turnTimedOut(ctx: Context, waitedMs: number, sessionId: string, harness: HarnessSummary | undefined): Promise<CavelonError> {
  const conversationId = await conversationOf(ctx, sessionId, harness);
  const read = conversationId
    ? `Read it, with the answer once it is there: \`${cavelonCommand("api", "get_conversation", "--param", `conversation_id=${conversationId}`)}\` (GET ${CONVERSATIONS_ROUTE}/{conversation_id}); \`${cavelonCommand("trace", conversationId, "--kind", "conversation")}\` shows its traces.`
    : `Find its conversation by session_id ${sessionId} in \`${cavelonCommand("api", "list_conversations", ...(harness ? ["--param", `harness_id=${harness.id}`] : []))}\`, then read it with \`${cavelonCommand("api", "get_conversation", "--param", "conversation_id=<conversation_id>")}\` (GET ${CONVERSATIONS_ROUTE}/{conversation_id}).`;
  return new CavelonError(ExitCode.timeout, {
    code: "chat_turn_timeout",
    message: `No answer within ${Math.round(waitedMs / 1000)} s. The turn goes on on the instance, which stores its answer; sending the message again would run it twice.`,
    hint: `${read} Continue the conversation with \`${cavelonCommand("chat", fill("message"), "--session", sessionId)}\`; a longer --timeout waits for the next turn's answer.`,
    details: { sent: true, session_id: sessionId, ...(conversationId ? { conversation_id: conversationId } : {}), ...(harness ? { harness_id: harness.id } : {}) },
  });
}

/** What the turn's status says, before the answer; undefined for an answered turn. A missing status (an older instance) is one. */
function statusLine(answer: ChatResponse, who: string): string | undefined {
  if (!("status" in answer) || answer.status === undefined) return undefined;
  const status = answer.status;
  if (status === null) return `${who} did not complete the turn (status null): it failed or was refused. The instance says:`;
  if (status === "completed") return undefined;
  if (status === "cancelled") return `${who} did not answer: the turn was cancelled. The message is stored, without an answer.`;
  if (status === "waiting") return `${who} is waiting (status waiting): the turn has not finished; its answer so far:`;
  if (status === "blocked") return `${who} blocked the turn (status blocked):`;
  return `${who} ended the turn with status ${status}:`;
}

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
    `answer, at most --timeout (default ${DEFAULT_CHAT_TIMEOUT}; ${(MCP_MAX_WAIT_MS - LOOKUP_MS) / 1000} s as an MCP tool, which then looks up\n` +
    `a turn not answered in time within its ${MCP_MAX_WAIT_MS / 1000} s).\n` +
    "--as-chat-user reads knowledge and binds database query identity as that Chat User, with a personal access token.\n" +
    "Choose an id with `cavelon api list_chat_users -p tenant_id=<tenant_id>`; email_verified says whether an email-bound\n" +
    "query can bind that address. Without the option, keeps the usual reader.\n" +
    "--file uploads a file to the turn's conversation first (POST /api/v1/chat/files) and names it in file_ids, so the\n" +
    "solution's wait for a file still being read (settings.attached_documents) can be tried. A personal access token whose\n" +
    "role holds playground.use chats as the Playground does: an active solution answers with its unpublished draft where\n" +
    "one is pending, with or without --draft. --draft (preview_draft) says so explicitly and is refused before sending where\n" +
    "the draft cannot be reached. A tenant API key, and a token without playground.use, chat with the published version.\n" +
    "The first turn carries a session_id the kit chose. A turn that is not answered in time goes on on the instance, which\n" +
    "stores its answer: the error says how to read the conversation; sending the message again would run it twice. A\n" +
    "status the instance reports (cancelled, waiting, blocked) is shown. A cancelled turn, and one a recent instance reports\n" +
    "with status null (failed or refused, such as by a limit), exits 1; an older instance sends no status for an answered turn.",
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
    file: { type: "string", multiple: true, value: "<path>", description: "Attach this file to the message (uploaded to the conversation first)." },
    draft: { type: "boolean", description: "Answer with the active solution's draft, as the Playground does; refused where it cannot (needs playground.use)." },
    timeout: { type: "string", value: "<duration>", description: `Wait at most this long for the answer (90s, 5m; default ${DEFAULT_CHAT_TIMEOUT}).` },
  },
  examples: [
    'cavelon chat "When are you open?" --harness support-faq',
    'cavelon chat "And on Saturdays?" --session <session_id>',
    'cavelon chat "What does this invoice say?" --file invoice.pdf --draft',
    'cavelon chat "Hello" --json',
  ],
  async run(ctx, input) {
    const message = positional(input, "message")!;
    if (!message.trim()) throw usageError("The message is empty.");
    const raw = stringOption(input, "timeout");
    const started = Date.now();
    // Over MCP the look for a timed-out turn's conversation comes out of the tool's wait.
    const timeout = Math.min(parseDuration(raw ?? DEFAULT_CHAT_TIMEOUT), ctx.mode === "mcp" ? MCP_MAX_WAIT_MS - LOOKUP_MS : Number.MAX_SAFE_INTEGER);
    const deadline = started + timeout;
    const session = await ctx.session();
    const reader = await chatUserReader(ctx, input, CHAT_ROUTE);
    const { ref, source } = harnessRef(session, input);
    const harness = ref ? await findHarness(ctx, ref, source, (slug) => cavelonCommand("chat", fill("message"), "--harness", slug)) : undefined;
    const draft = boolOption(input, "draft");
    const files = listOption(input, "file");
    const chatFields = draft || files.length ? await bodyFields(ctx, "POST", CHAT_ROUTE, "chatting with a solution") : undefined;
    if (draft) await checkDraft(ctx, chatFields);
    // A session the kit chose: a first turn that is not answered in time can still be found by it.
    const sessionId = stringOption(input, "session") ?? randomUUID();
    const attached = await uploadFiles(ctx, files, sessionId, chatFields, deadline);
    const body: Record<string, unknown> = { message, stream: false, ...reader, session_id: sessionId };
    if (harness) body.harness_id = harness.id;
    if (attached.length) body.file_ids = attached.map((f) => f.file_id);
    if (draft) body.preview_draft = true;
    let answer: ChatResponse;
    try {
      answer = await callStable<ChatResponse>(ctx, "POST", CHAT_ROUTE, "chatting with a solution", { body, timeoutMs: Math.max(1_000, deadline - Date.now()) });
    } catch (error) {
      if (error instanceof CavelonError && error.code === "request_timeout") throw await turnTimedOut(ctx, Date.now() - started, sessionId, harness);
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
    const ended = statusLine(answer, who);
    const cancelled = answer.status === "cancelled";
    // Present and null: a recent instance's turn that failed or was refused. Absent: an older instance's answered turn.
    const incomplete = "status" in answer && answer.status === null;
    const said = cancelled ? (answer.response ? [answer.response] : []) : [`${answer.response || (incomplete ? "(no message)" : "(no text)")}${directives}${limit}`];
    return {
      data: { harness: target, ...answer, ...reader, ...(attached.length ? { files: attached } : {}), ...(draft ? { draft: true } : {}), next },
      text: [
        ...(reader ? [`Reading as Chat User ${reader.reader_chat_user_id}.`] : []),
        ...attached.map((f) => `Attached ${f.filename} (${f.file_id}${f.processing_status ? `, ${f.processing_status}` : ""}).`),
        ...(draft ? ["Answered with the draft (preview_draft), as the Playground does."] : []),
        ended ?? `${who} answered:`,
        ...said,
        "",
        `session:          ${answer.session_id}   continue with: ${next.continue}`,
        `conversation_id:  ${answer.conversation_id}   its traces: ${next.trace}`,
      ].join("\n"),
      ...(cancelled || incomplete ? { exitCode: ExitCode.failure } : {}),
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
