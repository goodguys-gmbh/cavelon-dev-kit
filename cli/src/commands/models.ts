import { CAPACITY_TUTORIAL_PAGE } from "../capacity.js";
import { CURSOR_OPTION, intOption, LIMIT_OPTION, pageOf, positional, stringOption, type CommandSpec, type Context } from "../command.js";
import type { OpenApiDoc } from "../contracts.js";
import { CavelonError, ExitCode, usageError } from "../errors.js";
import { confirmation, PERSON_CONFIRMS_HELP } from "../confirm-token.js";
import { moreHint, table } from "../format.js";
import { callStable, workflowOperation } from "../invoke.js";
import { deref, jsonBodySchema, validateBody, type Operation } from "../openapi.js";
import { cavelonCommand, fill } from "../printed.js";
import { STATE_DIR } from "../local-state.js";
import { listedPages } from "./docs.js";
import { refreshInventory } from "./inventory.js";
import { ENV_OPTION } from "./values.js";

/**
 * The tenant's Model Registry rows and the one limit the kit changes on them:
 * `max_concurrent_requests`, how many requests the row's endpoint serves at
 * once. Every row with the same
 * `base_url` shares that count, and a row without a `base_url` reaches its
 * provider through the platform's own routes, so it takes no limit. A row is
 * shown by what it is and where it points, never with its API key: the key's
 * masked form and anything in the URL besides scheme, host, port and path stay
 * out of the output.
 */

const LIST_ROUTE = "/api/v1/model-registry";
const ROW_ROUTE = "/api/v1/model-registry/{model_registry_id}";
const LIMIT_FIELD = "max_concurrent_requests";
/** The kit's code for the same refusal `validate` reports in a package. */
const WITHOUT_ENDPOINT = "model_endpoint_limit_without_base_url";

/** A Model Registry row (ModelResponse) as far as the kit reads it. */
interface ModelRow {
  id: string;
  model_id: string;
  display_name?: string | null;
  provider?: string | null;
  base_url?: string | null;
  api_key_type?: string | null;
  capabilities?: string[] | null;
  max_concurrent_requests?: number | null;
  is_active?: boolean | null;
}

/** The row's endpoint: scheme, host, port and path. User info, query and fragment may hold a credential and are left out. */
export function endpointOf(baseUrl: string | null | undefined): string | null {
  const raw = (baseUrl ?? "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "(not a URL)";
  }
  if (!url.hostname) return "(not a URL)";
  let path = url.pathname;
  while (path.endsWith("/")) path = path.slice(0, -1);
  return `${url.protocol}//${url.host}${path}`;
}

/** What `models` shows of a row: never its key, only whether it has one and of which kind. */
function rowView(row: ModelRow, all: ModelRow[]) {
  const endpoint = endpointOf(row.base_url);
  const sharing = endpoint ? all.filter((other) => other.id !== row.id && endpointOf(other.base_url) === endpoint).map((other) => other.model_id) : [];
  return {
    id: row.id,
    model_id: row.model_id,
    display_name: row.display_name ?? null,
    provider: row.provider ?? null,
    endpoint,
    max_concurrent_requests: row.max_concurrent_requests ?? null,
    is_active: row.is_active ?? true,
    capabilities: row.capabilities ?? [],
    api_key_type: row.api_key_type ?? null,
    ...(sharing.length ? { shares_endpoint_with: sharing } : {}),
  };
}

function limitText(limit: number | null): string {
  return limit === null ? "none" : String(limit);
}

async function readRows(ctx: Context): Promise<ModelRow[]> {
  const rows = await callStable<ModelRow[]>(ctx, "GET", LIST_ROUTE, "the Model Registry");
  return Array.isArray(rows) ? rows : [];
}

/** The row a person named by its id, its model_id or its display name. */
function findRow(rows: ModelRow[], ref: string): ModelRow {
  const byId = rows.find((r) => r.id === ref) ?? rows.find((r) => r.model_id === ref);
  if (byId) return byId;
  const byName = rows.filter((r) => (r.display_name ?? "").toLowerCase() === ref.toLowerCase());
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw usageError(
      `Several Model Registry rows are called "${ref}": ${byName.map((r) => r.model_id).join(", ")}.`,
      `Name the row by its model_id or id; \`${cavelonCommand("models", "list")}\` shows them.`,
    );
  }
  throw new CavelonError(ExitCode.failure, {
    code: "model_not_found",
    status: 404,
    message: `This tenant's Model Registry has no row "${ref}".`,
    hint: `\`${cavelonCommand("models", "list")}\` shows its rows by model_id and id.`,
  });
}

/** `none` clears the limit; anything else must be a whole number (the instance's schema bounds it). */
function parseLimit(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (value === "none" || value === "null") return null;
  if (!/^\d+$/.test(value)) throw usageError(`<limit> must be a whole number of requests at once, or none to clear it; got "${raw}".`);
  return Number(value);
}

/** An instance whose update route does not take the field is older than endpoint limits. */
function requireLimitField(doc: OpenApiDoc | undefined, op: Operation): void {
  const schema = jsonBodySchema(op);
  if (!doc || !schema) return;
  const properties = (deref(doc, schema) as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (properties && LIMIT_FIELD in properties) return;
  throw new CavelonError(ExitCode.failure, {
    code: "operation_unavailable",
    message: `This instance's Model Registry rows have no ${LIMIT_FIELD} (PATCH ${ROW_ROUTE} does not take it), so nothing was sent.`,
    hint: `The instance is older than endpoint limits; \`${cavelonCommand("status")}\` shows its version.`,
  });
}

export const modelsList: CommandSpec = {
  name: "models list",
  summary: "List the tenant's Model Registry rows with their endpoint and max_concurrent_requests; never a key.",
  description:
    "Each row's endpoint (scheme, host, port, path of its base_url) and how many requests it may send there at once\n" +
    "(max_concurrent_requests; none means no limit). Rows with the same base_url share that count. A row without a base_url\n" +
    "reaches its provider through the platform's routes and takes no limit. Keys are never shown, only their kind.",
  readOnly: true,
  idempotent: true,
  mcpTool: "models_list",
  options: { limit: LIMIT_OPTION, cursor: CURSOR_OPTION, env: ENV_OPTION },
  examples: ["cavelon models list", "cavelon models list --json"],
  async run(ctx, input) {
    const limit = intOption(input, "limit", { min: 1, max: 500, fallback: 50 })!;
    const session = await ctx.session();
    const rows = await readRows(ctx);
    // In a solution folder, validate warns about an agent's model that is not among these.
    if (session.project) {
      await refreshInventory(session.project.root, "models", rows.map((r) => r.model_id), ctx.io.now()).catch((error: unknown) =>
        ctx.warn(`Could not keep the model list for validate in ${STATE_DIR}/ (${error instanceof Error ? error.message : String(error)}).`),
      );
    }
    const page = pageOf(rows, limit, stringOption(input, "cursor"));
    const items = page.items.map((row) => rowView(row, rows));
    if (!items.length) {
      return {
        data: { items, next_cursor: page.next_cursor, total: page.total },
        text: "This tenant's Model Registry has no rows; the instance's defaults serve its agents.",
      };
    }
    const shown = items.map((row) => ({
      ...row,
      endpoint: row.endpoint ?? "(platform route)",
      max_concurrent_requests: limitText(row.max_concurrent_requests),
      active: row.is_active ? "yes" : "no",
    }));
    const pages = await listedPages(ctx, [CAPACITY_TUTORIAL_PAGE]);
    const lines = [
      table(shown, ["model_id", "provider", "endpoint", "max_concurrent_requests", "active"], 60) + moreHint(page.next_cursor, cavelonCommand("models", "list")),
      "",
      `Rows with the same endpoint share one max_concurrent_requests count. Change it with: ${cavelonCommand("models", "set-limit", fill("model_id"), fill("n|none"))}`,
      ...pages.map((p) => `Plan it for a self-hosted endpoint: ${cavelonCommand("docs", "get", p)}`),
    ];
    return { data: { items, next_cursor: page.next_cursor, total: page.total }, text: lines.join("\n") };
  },
};

export const modelsSetLimit: CommandSpec = {
  name: "models set-limit",
  summary: "Set or clear how many requests a Model Registry row's endpoint gets at once (needs --confirm).",
  description:
    "Sets the row's max_concurrent_requests to <n>, or clears it with none. Without --confirm, shows the old and new value\n" +
    "and changes nothing. A row without a base_url is refused before anything is sent: it reaches its provider through the\n" +
    "platform's routes, which have their own limits. Every row with the same base_url shares the count. Propose a value to\n" +
    "the person and let them decide; the instance's capacity tutorial says how to find it.\n" +
    PERSON_CONFIRMS_HELP,
  readOnly: false,
  destructive: true,
  idempotent: true,
  mcpTool: "models_set_limit",
  operations: ["PATCH /api/v1/model-registry/{model_registry_id}"],
  positionals: [
    { name: "model", description: "The row's model_id, id or display name (`cavelon models list`).", required: true },
    { name: "limit", description: "Requests the endpoint serves at once (a whole number), or none to clear the limit.", required: true },
  ],
  options: {
    confirm: { type: "boolean", mcpToken: true, description: "Change it; without this nothing is changed." },
    env: ENV_OPTION,
  },
  examples: ["cavelon models set-limit llama-70b 8", "cavelon models set-limit llama-70b 8 --confirm", "cavelon models set-limit llama-70b none --confirm"],
  async run(ctx, input) {
    const ref = positional(input, "model")!;
    const limit = parseLimit(positional(input, "limit")!);
    const { doc, op } = await workflowOperation(ctx, "PATCH", ROW_ROUTE, "changing Model Registry rows");
    requireLimitField(doc, op);
    // The instance's own bounds, before anything is sent or shown as possible.
    if (doc) validateBody(doc, op, { [LIMIT_FIELD]: limit });
    const rows = await readRows(ctx);
    const row = findRow(rows, ref);
    const model = rowView(row, rows);
    const previous = model.max_concurrent_requests;
    if (limit !== null && !model.endpoint) {
      throw new CavelonError(ExitCode.validation, {
        code: WITHOUT_ENDPOINT,
        message: `Model "${row.model_id}" has no base_url, so it takes no max_concurrent_requests; nothing was sent.`,
        hint:
          "The limit counts requests to the row's own endpoint (a self-hosted model server). A row without one reaches its " +
          "provider through the platform's routes, which have their own rate limits. Give the row its base_url first (the Admin's " +
          "model form, or model_registry in package/), then set the limit.",
        details: { model_id: row.model_id, id: row.id, sent: false },
      });
    }
    const base = { model, previous, limit };
    const label = `Model ${row.model_id}${model.endpoint ? ` (${model.endpoint})` : ""}`;
    if (previous === limit) {
      return { data: { ...base, changed: false, sent: false }, text: `${label} already has max_concurrent_requests ${limitText(limit)}; nothing to change.` };
    }
    const sharing = model.shares_endpoint_with?.length ? ` It shares the count with ${model.shares_endpoint_with.join(", ")} (same endpoint).` : "";
    const gate = await confirmation(ctx, input, "models_set_limit", { row: row.id, previous, limit }, {
      person: {
        what: `${label}: max_concurrent_requests ${limitText(previous)} → ${limitText(limit)}.${sharing}`,
        words: ["models", "set-limit", row.model_id, limitText(limit), "--confirm"],
      },
    });
    if (!gate.confirmed) {
      const confirm = gate.confirm(cavelonCommand("models", "set-limit", row.model_id, limitText(limit), "--confirm"));
      return {
        data: { ...base, changed: false, sent: false, confirm, ...gate.fields },
        text: `${label}: max_concurrent_requests ${limitText(previous)} → ${limitText(limit)}.${sharing}\n${gate.where}\n${gate.mismatch ? `${gate.mismatch}\n` : ""}Nothing was changed. Change it with: ${confirm}`,
        ...(gate.exitCode ? { exitCode: gate.exitCode } : {}),
      };
    }
    const saved = await callStable<ModelRow>(ctx, "PATCH", ROW_ROUTE, "changing Model Registry rows", {
      params: { model_registry_id: [row.id] },
      body: { [LIMIT_FIELD]: limit },
    });
    const now = rowView({ ...row, ...saved }, rows);
    return {
      data: { model: now, previous, limit: now.max_concurrent_requests, changed: true, sent: true },
      text: `Changed ${label}: max_concurrent_requests ${limitText(previous)} → ${limitText(now.max_concurrent_requests)}.${sharing}`,
    };
  },
};
