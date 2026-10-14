import { confirmation, PERSON_CONFIRMS_HELP } from "../confirm-token.js";
import { createHash } from "node:crypto";
import { positional, type CommandSpec } from "../command.js";
import { CavelonError, ExitCode, usageError } from "../errors.js";
import { clip, keyValues } from "../format.js";
import { callStable, previewRequest } from "../invoke.js";
import { cavelonCommand } from "../printed.js";
import { resolveQuery, type Query } from "./db.js";
import { managementPreflight } from "./db-connections.js";

const ROUTE = "/api/v1/database-connectors/queries/{query_id}";
type Change = "delete" | "enable" | "disable" | "rename";

const evidenceFor = (query: Query) => ({ id: query.id, slug: query.slug, version: query.version, kind: query.kind, is_enabled: query.is_enabled,
  sql_sha256: createHash("sha256").update(query.sql_text).digest("hex") });

function queryChange(change: Change): CommandSpec {
  const method = change === "delete" ? "DELETE" : "PATCH";
  const tool = `db_query_${change}`;
  return {
    name: `db queries ${change}`,
    summary: `${change[0]!.toUpperCase()}${change.slice(1)} a saved database query; preview first, then the person confirms.`,
    description: "Needs database_connectors.manage. Each preview is bound to this query's version and the exact change.\n" +
      "Rechecks the query after approval; a changed query needs a fresh preview.\n" +
      "Deleting also removes its agent and skill assignments; the result lists what the instance removed.\n" +
      "Run cavelon pull afterwards so the package follows the saved query.\n" + PERSON_CONFIRMS_HELP,
    readOnly: false, destructive: change === "delete", mcpTool: tool, operations: [`${method} ${ROUTE}`],
    positionals: [{ name: "query", required: true, description: "Saved query's slug or id." },
      ...(change === "rename" ? [{ name: "new-slug", required: true, description: "New tool slug, checked against the instance's schema." }] : [])],
    options: { confirm: { type: "boolean", mcpToken: true, description: "Send the exact previewed change after the person's approval." } },
    examples: [`cavelon db queries ${change} order_status${change === "rename" ? " order_lookup" : ""}`],
    async run(ctx, input) {
      const { doc, op } = await managementPreflight(ctx, method, ROUTE);
      const query = await resolveQuery(ctx, positional(input, "query")!);
      const slug = positional(input, "new-slug");
      if (change === "rename" && !slug?.trim()) throw usageError("Give the new query slug.");
      const body = change === "delete" ? undefined : change === "rename" ? { slug } : { is_enabled: change === "enable" };
      previewRequest(doc, op, { params: { query_id: [query.id] }, body });
      const words = ["db", "queries", change, query.id, ...(slug ? [slug] : []), "--confirm"];
      const evidence = evidenceFor(query);
      const gate = await confirmation(ctx, input, tool, { query: evidence, method, body }, {
        person: { what: `${change} saved ${query.kind ?? "unknown-kind"} database query ${query.slug} (version ${query.version}, SQL SHA-256 ${evidence.sql_sha256})${slug ? ` to ${slug}` : ""}${change === "delete" ? " and remove its agent and skill assignments" : ""}.`, words },
      });
      if (!gate.confirmed) return {
        data: { sent: false, query: evidence, change, body: body ?? null,
          confirm: gate.confirm(cavelonCommand(...words)), ...gate.fields },
        text: `${keyValues([["query", query.slug], ["version", query.version], ["kind", query.kind], ["sql_sha256", evidence.sql_sha256], ["change", change], ["new_slug", slug]])}\n${gate.where}\n${gate.mismatch ?? "Nothing was changed."}\n${gate.confirm(cavelonCommand(...words))}`,
        exitCode: gate.exitCode,
      };
      await managementPreflight(ctx, method, ROUTE);
      // Another editor can change SQL while the person reads the approval dialog.
      if (JSON.stringify(evidenceFor(await resolveQuery(ctx, query.id))) !== JSON.stringify(evidence)) {
        ctx.approved = undefined;
        throw new CavelonError(ExitCode.conflict, {
          code: "token_mismatch", message: "The saved query changed while approval was pending. Nothing was changed by this command.",
          hint: "Request a fresh preview and approve the query as it is now.", details: { sent: false },
        });
      }
      const result = await callStable<Record<string, unknown>>(ctx, method, ROUTE, "saved database query management", { params: { query_id: [query.id] }, body });
      const next = `Run ${cavelonCommand("pull")} so package/ follows this change.`;
      return { data: { sent: true, change, ...result, next_step: next },
        text: `${change} completed for ${query.slug}.${change === "delete" ? `\nRemoved assignments: ${clip(JSON.stringify(result.removed_references ?? {}), 3000)}` : ""}\n${next}` };
    },
  };
}

export const dbQueryDelete = queryChange("delete");
export const dbQueryEnable = queryChange("enable");
export const dbQueryDisable = queryChange("disable");
export const dbQueryRename = queryChange("rename");
