import type { Context } from "./command.js";
import { CavelonError, ExitCode } from "./errors.js";
import type { ApiClient, ChangeConfirmer, QueryValue } from "./http.js";
import { operationForPath } from "./openapi.js";
import { cavelonCommand } from "./printed.js";

/**
 * The instance binds a confirmation to the exact request, not to a person's
 * answer. The same personal access token can issue the id and send the change.
 * An instance that publishes `confirmations.enforced` refuses a personal access
 * token's guarded change (`x-cavelon-confirmation` in its OpenAPI) without a
 * confirmation id that names exactly that change: `POST <confirmations.path>`
 * with `{method, path, body}` issues one, valid once and for minutes, sent in
 * `<confirmations.header>`.
 *
 * The kit asks for an id only after the person approved the change
 * (`Context.approved`): in their own terminal with --confirm, or in the MCP
 * client's dialog. Asking the person is the kit's responsibility alone;
 * the instance cannot tell whether that question was asked or answered.
 */

/** Where the instance issues confirmation ids, and the header a change carries one in. */
export interface ConfirmationOffer {
  path: string;
  header: string;
}

/** The documented route and header, for a 428 whose body does not name them. */
const DOCUMENTED: ConfirmationOffer = { path: "/api/v1/confirmations", header: "X-Cavelon-Confirmation" };

const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

/** The offer in `/meta/capabilities`, when the instance enforces it; undefined on an instance that does not publish it or has it off. */
export async function enforcedOffer(ctx: Context): Promise<ConfirmationOffer | undefined> {
  const caps = await (await ctx.contracts()).capabilities().catch(() => null);
  const offer = caps?.confirmations as Record<string, unknown> | undefined;
  if (!offer || typeof offer !== "object" || offer.enforced !== true) return undefined;
  return offerFrom(offer.path, offer.header);
}

function offerFrom(path: unknown, header: unknown): ConfirmationOffer {
  return {
    path: typeof path === "string" && path.startsWith("/") ? path : DOCUMENTED.path,
    header: typeof header === "string" && HEADER_NAME.test(header) ? header : DOCUMENTED.header,
  };
}

/** Whether the instance's OpenAPI marks the operation `method path` resolves to as requiring a bound confirmation. */
async function marked(ctx: Context, method: string, path: string): Promise<boolean> {
  const doc = await (await ctx.contracts()).openapi().catch(() => undefined);
  const found = doc ? operationForPath(doc, method, path) : undefined;
  return found?.op.confirmation === true;
}

/** The request's path below the instance's base path (which a proxy strips), and its query as sent. */
function ownPath(client: ApiClient, path: string, query?: Record<string, QueryValue>): { pathname: string; search: string } {
  const url = client.resolve(path, query);
  const base = new URL(client.url.endsWith("/") ? client.url : `${client.url}/`).pathname;
  return { pathname: base.length > 1 && url.pathname.startsWith(base) ? url.pathname.slice(base.length - 1) : url.pathname, search: url.search };
}

/**
 * The path as the instance binds the id to it: with its values decoded, as
 * the instance reads the request's path, and the query as it is sent (the
 * instance sorts it).
 */
export function confirmedPath(client: ApiClient, path: string, query?: Record<string, QueryValue>): string {
  const own = ownPath(client, path, query);
  return `${decodeURIComponent(own.pathname)}${own.search}`;
}

/** The confirmation id for exactly this request, from the instance; undefined where it says the change needs none. */
async function issue(client: ApiClient, offer: ConfirmationOffer, method: string, path: string, body: unknown): Promise<string | undefined> {
  const response = await client.request<{ confirmation_id?: unknown }>("POST", offer.path, {
    json: { method, path, body: body ?? null },
    confirmation: false,
    // An instance without the route, or one that says this change or credential needs none: the change goes as it is, and the instance decides.
    allow: [400, 404, 405, 422],
  });
  const id = response.status === 201 || response.status === 200 ? response.data?.confirmation_id : undefined;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

/**
 * The client's hook that adds a confirmation id to a change the person
 * approved. Up front where the kit knows the change is one the instance
 * guards (`approved.guarded`) and the instance marks the operation and
 * enforces the check; otherwise only once the instance asked for it with
 * `428 confirmation_required`, when the request is sent once more. Never
 * without the person's approval, and never for an API key, which the instance
 * does not ask.
 */
export function changeConfirmer(ctx: Context, client: ApiClient): ChangeConfirmer {
  return async (request, asked) => {
    const approved = ctx.approved;
    if (!approved || !client.target.token?.startsWith("cvpat_")) return undefined;
    let offer: ConfirmationOffer | undefined;
    if (asked) offer = offerFrom(asked.confirmations, asked.header);
    else {
      if (!approved.guarded) return undefined;
      offer = await enforcedOffer(ctx);
      if (!offer || !(await marked(ctx, request.method, ownPath(client, request.path).pathname))) return undefined;
    }
    const path = confirmedPath(client, request.path, request.query);
    const id = await issue(client, offer, request.method, path, request.body);
    return id ? { [offer.header]: id } : undefined;
  };
}

/** The codes an instance answers a change with when its bound confirmation is missing or invalid. */
export const CONFIRMATION_REQUIRED = "confirmation_required";
export const CONFIRMATION_INVALID = "confirmation_invalid";

/**
 * A 428 as the kit says it: what happened, that nothing was changed, and what
 * the person does. The instance's own hint is written for a kit that sends no
 * id; this one does, after the person's yes.
 */
export function confirmationRefused(error: CavelonError, sentId: boolean): CavelonError {
  if (error.status !== 428 || (error.code !== CONFIRMATION_REQUIRED && error.code !== CONFIRMATION_INVALID)) return error;
  const details = error.details && typeof error.details === "object" && !Array.isArray(error.details) ? (error.details as Record<string, unknown>) : {};
  const hint =
    error.code === CONFIRMATION_INVALID
      ? "Run the command again: it previews the change, and once the person approves it cavelon asks the instance for a new confirmation. " +
        `A confirmation lasts minutes and confirms one change once. \`${cavelonCommand("explain", CONFIRMATION_INVALID)}\` says more.`
      : sentId
        ? `The instance asked again for a confirmation cavelon sent. \`${cavelonCommand("explain", CONFIRMATION_REQUIRED)}\` says more.`
        : "The instance requires a confirmation bound to this exact change; cavelon asks the person first. The person runs the command in their own terminal with --confirm " +
          "(or approves it in the MCP client's dialog), where cavelon asks the instance for the confirmation; or makes the change in the Admin. " +
          `\`${cavelonCommand("explain", CONFIRMATION_REQUIRED)}\` says more.`;
  return new CavelonError(ExitCode.needsAction, {
    code: error.code,
    message: error.message.includes("Nothing was changed") ? error.message : `${error.message} Nothing was changed.`,
    hint,
    docs: error.docs,
    status: error.status,
    details: { ...details, confirmation_sent: sentId },
  });
}

/** What `explain` adds for the two codes: how cavelon gets the confirmation, and who gives it. */
export function confirmationPointer(code: string): string | undefined {
  if (code !== CONFIRMATION_REQUIRED && code !== CONFIRMATION_INVALID) return undefined;
  return (
    "Only after the person approved the change does cavelon ask the instance for this confirmation: in their own terminal with " +
    "--confirm, or in the MCP client's dialog when an agent confirms with the preview's token. The instance binds the id to the token, tenant and exact request; " +
    "it does not verify the person's answer. Asking the person is cavelon's responsibility; never answer on their behalf. " +
    (code === CONFIRMATION_INVALID
      ? "An expired, used or other change's confirmation needs a new preview and the person's yes again."
      : "An older cavelon sends none: update it, or make the change in the Admin.")
  );
}
