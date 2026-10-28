import { boolOption, stringOption, type CommandSpec, type Context, type Input } from "../command.js";
import { CavelonError, ExitCode, usageError } from "../errors.js";
import { clip, keyValues } from "../format.js";
import { harnessNotFoundError, lookupHarness, type HarnessSummary } from "../harness-ref.js";
import { callStable, workflowOperation } from "../invoke.js";
import { packageToSend } from "../managed-fields.js";
import { readPackage } from "../package-files.js";
import { PERSONA_SECTION } from "../package-format.js";
import { cavelonCommand } from "../printed.js";
import type { Session } from "../session.js";
import { ruleFields } from "../engagement.js";
import { schemaFor } from "./solution.js";

/**
 * What a website visitor would be offered on one page at one moment, from the
 * solution folder's engagement rules (or the ones the solution holds): the
 * starter questions, the calendar's open doors, the banners and the
 * decoration. The instance matches the rules on its own clock and marks the
 * route read-only: nothing is stored, translated or counted.
 */

const PREVIEW_ROUTE = "/api/v1/bot-persona/engagement/preview";
const WIDGET_DOCS = "/docs/channels/widget";

interface PreviewResponse {
  teaser_messages?: string[];
  engagement?: {
    has_rules?: boolean;
    starters_rule_id?: string | null;
    has_campaigns?: boolean;
    calendar?: { rule_id: string; title?: string; today?: number | null; days_total?: number; doors?: Array<{ day: number; title?: string; question?: string | null }>; next_unlock_at?: string | null } | null;
    banners?: Array<{ rule_id: string; display?: Record<string, unknown> }>;
    decoration?: { rule_id: string; effect?: string; accessory?: string; badge_emoji?: string | null; places?: string[] } | null;
    server_now?: string | null;
  };
}

function harnessRef(session: Session, input: Input): { ref?: string; source?: string } {
  const option = stringOption(input, "harness");
  if (option) return { ref: option, source: "option" };
  if (session.envFile?.harness) return { ref: session.envFile.harness, source: `env/${session.envFile.name}.yaml` };
  if (session.project?.harness) return { ref: session.project.harness, source: "cavelon.yaml" };
  return {};
}

/** The page as the widget reports it: a host and a path, from a URL or a path. */
export function pageOf(value: string | undefined): { page_host?: string; page_path: string } {
  const given = value?.trim();
  if (!given) return { page_path: "/" };
  if (given.startsWith("/")) return { page_path: given.split(/[?#]/)[0] || "/" };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(given) ? given : `https://${given}`);
  } catch {
    throw usageError(`--page must be a page's URL or path, got "${given}".`, "For example --page https://www.example.at/tarife/winter or --page /tarife/winter.");
  }
  return { page_host: url.hostname, page_path: url.pathname || "/" };
}

/** The moment, as the instance takes it; a time without an offset is UTC there. */
function momentOf(value: string | undefined): string | undefined {
  const given = value?.trim();
  if (!given) return undefined;
  if (Number.isNaN(Date.parse(given))) throw usageError(`--at must be a date and time, got "${given}".`, "For example --at 2026-12-14T09:00:00+01:00.");
  return given;
}

/**
 * The rules to preview: the folder's, with the solution's rules of the kinds
 * cavelon.yaml leaves to the Admin, as an import would leave them; undefined
 * for the rules the solution holds.
 */
async function folderRules(ctx: Context, session: Session, harnessId: string): Promise<{ rules?: unknown[]; source: string }> {
  const project = session.project;
  if (!project) return { source: "the solution (no solution folder here)" };
  const disk = await readPackage(project.root, project.layout);
  const unreadable = disk.findings.find((f) => f.severity === "error" && f.file?.includes(PERSONA_SECTION));
  if (unreadable) throw new CavelonError(ExitCode.validation, { code: unreadable.code, message: `${unreadable.file}: ${unreadable.message}` });
  const { schema } = await schemaFor(ctx, project.packageVersion, false);
  const sent = packageToSend(disk.package, project.managed, schema);
  const persona = sent.package[PERSONA_SECTION] as Record<string, unknown> | undefined;
  const field = ruleFields(schema)[0];
  const list = field ? persona?.[field.field] : undefined;
  if (!field || !Array.isArray(list)) return { source: `the solution (the folder's ${PERSONA_SECTION} sets no engagement rules)` };
  const kinds = persona?.[`${field.field}_kinds`];
  if (!Array.isArray(kinds)) return { rules: list, source: "the solution folder" };
  // The kinds the folder does not manage stay as the solution holds them, as an import keeps them.
  const held = await callStable<Record<string, unknown>>(ctx, "GET", "/api/v1/bot-persona", "reading the persona", { query: { harness_id: harnessId } });
  const others = (Array.isArray(held?.[field.field]) ? (held[field.field] as unknown[]) : []).filter((rule) => {
    const kind = rule && typeof rule === "object" ? (rule as Record<string, unknown>)[field.discriminator] : undefined;
    return !kinds.includes(kind);
  });
  return { rules: [...others, ...list], source: `the solution folder (${kinds.join(", ")}) and the solution's other kinds` };
}

function previewText(page: { page_host?: string; page_path: string }, at: string | undefined, source: string, p: PreviewResponse): string {
  const e = p.engagement ?? {};
  const calendar = e.calendar;
  const doors = calendar?.doors ?? [];
  return keyValues([
    ["page", `${page.page_host ?? "(any host)"}${page.page_path}`],
    ["at", at ?? `now${e.server_now ? ` (${e.server_now})` : ""}`],
    ["rules", source],
    [
      "starters",
      p.teaser_messages?.length
        ? `${e.starters_rule_id ? `rule ${e.starters_rule_id}` : "the persona's teasers"}${p.teaser_messages.map((t) => `\n  - ${clip(t, 120)}`).join("")}`
        : "none",
    ],
    [
      "calendar",
      calendar
        ? `${calendar.rule_id} "${clip(calendar.title ?? "", 60)}": ${doors.length} open door${doors.length === 1 ? "" : "s"}` +
          (calendar.today ? `, today door ${calendar.today}` : "") +
          (calendar.next_unlock_at ? `, next opens ${calendar.next_unlock_at}` : "") +
          doors.slice(-5).map((d) => `\n  - door ${d.day}${d.title ? ` "${clip(d.title, 60)}"` : ""}${d.question ? ` asks: ${clip(d.question, 80)}` : ""}`).join("")
        : "none",
    ],
    ["banners", e.banners?.length ? e.banners.map((b) => `\n  - ${b.rule_id}${typeof b.display?.trigger === "string" ? ` (${b.display.trigger})` : ""}`).join("") : "none"],
    [
      "decoration",
      e.decoration
        ? `${e.decoration.rule_id}: ${[e.decoration.effect, e.decoration.accessory, e.decoration.badge_emoji].filter((v) => v && v !== "none").join(", ")}${e.decoration.places?.length ? ` on ${e.decoration.places.join(", ")}` : ""}`
        : "none",
    ],
  ]);
}

export const engagementPreview: CommandSpec = {
  name: "engagement preview",
  summary: "Show what a visitor gets on a page at a moment: starters, open doors, banners, decoration. Stores and counts nothing.",
  description:
    "Sends the solution folder's engagement rules (persona.engagement_rules) to the instance's preview for one page and one moment,\n" +
    "and shows what the widget would offer there: the starter questions, the door calendar's open doors, the banners and the\n" +
    "decoration. The instance matches the rules on its clock as it does for a visitor and checks them as a save would; nothing\n" +
    "is stored, translated or counted. With managed_kinds in cavelon.yaml, the solution's rules of the other kinds join the folder's,\n" +
    "as an import keeps them. Without a solution folder, or with --stored, the rules the solution holds are previewed.\n" +
    "The instance must mark the preview read-only (x-cavelon-read-only); an older one is refused before anything is sent.",
  readOnly: true,
  idempotent: true,
  mcpTool: "engagement_preview",
  options: {
    harness: { type: "string", value: "<harness>", description: "The solution: its name, slug or id; default: env file, then cavelon.yaml." },
    env: { type: "string", value: "<name>", description: "Use env/<name>.yaml: its tenant and solution." },
    page: { type: "string", value: "<url|path>", description: "The page: its URL (https://www.example.at/tarife/winter) or a path (/tarife/winter); default /, on any host." },
    at: { type: "string", value: "<time>", description: "The moment, as ISO 8601 with an offset (2026-12-14T09:00:00+01:00); without one, UTC. Default: now." },
    stored: { type: "boolean", description: "Preview the rules the solution holds on the instance, not the folder's." },
  },
  examples: [
    "cavelon engagement preview --page https://www.example.at/tarife/winter --at 2026-12-14T09:00:00+01:00",
    "cavelon engagement preview --page /kontakt --stored --json",
  ],
  async run(ctx, input) {
    const session = await ctx.session();
    const page = pageOf(stringOption(input, "page"));
    const at = momentOf(stringOption(input, "at"));
    const { ref, source } = harnessRef(session, input);
    if (!ref) throw usageError("Name the solution: --harness <name or slug>, or work in its folder (cavelon.yaml names it).");
    const { harness, candidates } = await lookupHarness<HarnessSummary>(ctx, ref);
    if (!harness) throw harnessNotFoundError(ref, candidates, source === "option" ? undefined : source);
    // A POST is read-only only where the instance says so: an older instance's preview is not sent.
    const { doc, op } = await workflowOperation(ctx, "POST", PREVIEW_ROUTE, "previewing engagement rules");
    if (doc && !op.readOnly) {
      throw new CavelonError(ExitCode.failure, {
        code: "operation_unavailable",
        message: `This instance does not mark POST ${PREVIEW_ROUTE} read-only, so the kit does not send it as a read.`,
        hint: `Preview the rules in the Admin (Persona and Engagement pages); a newer instance marks the route read-only. \`${cavelonCommand("status")}\` shows its version.`,
      });
    }
    const chosen = boolOption(input, "stored") ? { source: "the solution (--stored)" } : await folderRules(ctx, session, harness.id);
    const body = { ...(chosen.rules ? { rules: chosen.rules } : {}), ...page, ...(at ? { at } : {}) };
    const result = await callStable<PreviewResponse>(ctx, "POST", PREVIEW_ROUTE, "previewing engagement rules", { query: { harness_id: harness.id }, body });
    return {
      data: { harness: { id: harness.id, slug: harness.slug }, page, at: at ?? null, rules_from: chosen.source, ...result, docs: WIDGET_DOCS },
      text: previewText(page, at, chosen.source, result),
    };
  },
};
