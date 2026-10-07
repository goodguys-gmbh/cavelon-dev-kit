import { accessFor } from "./access.js";
import { stringOption, type Context, type Input } from "./command.js";
import { CavelonError, ExitCode, usageError, validationError } from "./errors.js";
import { workflowOperation } from "./invoke.js";
import { deref, jsonBodySchema, schemaErrors } from "./openapi.js";
import { cavelonCommand } from "./printed.js";

/** The permissions published for an as_chat_user reader on chat and test-run requests. */
const READER_PERMISSIONS = ["knowledge_bases.view", "end_users.read"];

export const AS_CHAT_USER_OPTION = {
  type: "string" as const,
  value: "<id>",
  description: "Read knowledge and identity-bound queries as this tenant's Chat User; needs knowledge_bases.view and end_users.read.",
};

export interface ChatUserReader {
  reader_mode: "as_chat_user";
  reader_chat_user_id: string;
}

const chooseReader = "Choose a current Chat User of the acting tenant with `cavelon api list_chat_users -p tenant_id=<tenant_id>`; `cavelon whoami` shows the acting tenant and credential's permissions. Check email_verified for an email-bound query.";

/** Never silently lose a requested reader on an older instance. Omission keeps the instance's default. */
export async function chatUserReader(ctx: Context, input: Input, path: string): Promise<ChatUserReader | undefined> {
  const id = stringOption(input, "as-chat-user");
  if (id === undefined) return undefined;
  if (!id.trim()) throw usageError("The Chat User id is empty.", chooseReader);
  const { doc, op } = await workflowOperation(ctx, "POST", path, "Chat User reader selection");
  const body = doc ? deref(doc, jsonBodySchema(op)) as { properties?: Record<string, Record<string, unknown>> } | undefined : undefined;
  const mode = body?.properties?.reader_mode;
  const user = body?.properties?.reader_chat_user_id;
  if (!doc || !mode || !user || schemaErrors(doc, mode, "as_chat_user").length) {
    throw new CavelonError(ExitCode.failure, {
      code: "operation_unavailable",
      message: "This instance does not publish Chat User reader selection for this request. Nothing was sent.",
      hint: `The instance may be older than this feature${doc ? "" : ", or its OpenAPI is unavailable"}; ask its operator for reader support. Omit --as-chat-user to keep the usual reader; \`${cavelonCommand("status")}\` shows the instance version.`,
      details: { sent: false },
    });
  }
  if (schemaErrors(doc, user, id).length) {
    throw validationError("The Chat User id does not match the instance's reader_chat_user_id schema.", { sent: false }, chooseReader);
  }
  const access = await accessFor(await ctx.client());
  if (path === "/api/v1/chat" && (access?.kind === "api_key" || (await ctx.session()).tokenKind === "api_key")) {
    throw new CavelonError(ExitCode.unauthorized, {
      code: "chat_user_reader_forbidden",
      message: "A tenant API key cannot choose a Chat User reader for chat. Nothing was sent.",
      hint: `Use a personal access token whose role holds ${READER_PERMISSIONS.join(" and ")}, or omit --as-chat-user for the usual reader. ${chooseReader}`,
      details: { sent: false, credential: "api_key" },
    });
  }
  const missing = access?.permissions ? READER_PERMISSIONS.filter((p) => !access.permissions!.includes(p)) : [];
  if (missing.length) {
    throw new CavelonError(ExitCode.unauthorized, {
      code: "chat_user_reader_forbidden",
      message: `Reading as a Chat User needs ${missing.join(" and ")}, which this credential does not hold. Nothing was sent.`,
      hint: `A person whose role holds ${READER_PERMISSIONS.join(" and ")} uses a credential with those permissions; a personal access token acts at most as its ceiling role. ${chooseReader}`,
      details: { sent: false, missing_permissions: missing },
    });
  }
  return { reader_mode: "as_chat_user", reader_chat_user_id: id };
}

/** Keep the instance's status and code when a reader is rejected, with the next useful step. */
export function chatUserReaderError(error: unknown, reader: ChatUserReader | undefined): unknown {
  if (!reader || !(error instanceof CavelonError)) return error;
  if (error.status !== 403 && !(error.status === 422 && /reader|chat.?user/i.test(error.message))) return error;
  return new CavelonError(error.exitCode, {
    code: error.code, status: error.status, message: error.message,
    hint: [error.hint, error.status === 403 ? `Chat reader selection needs a personal access token; chat and test runs need ${READER_PERMISSIONS.join(" and ")}. An older instance may refuse a token even when it publishes reader fields.` : undefined, chooseReader].filter(Boolean).join(" "),
    docs: error.docs, details: error.details,
  });
}
