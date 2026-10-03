import type { Context } from "../command.js";
import { CavelonError } from "../errors.js";
import { table } from "../format.js";
import { callStable } from "../invoke.js";
import { STATE_DIR, writeState } from "../local-state.js";

/**
 * `.cavelon/inventory.md`: what the tenant holds, from the last pull, for the
 * skills to read when they need it. It changes on every pull, so it lives in
 * local state rather than in AGENTS.md, which every session would load.
 */

interface Listing {
  label: string;
  path: string;
  query?: Record<string, string | number | boolean>;
}

const LISTINGS: Listing[] = [
  { label: "solutions", path: "/api/v1/harnesses" },
  { label: "knowledge bases", path: "/api/v1/knowledge-bases", query: { page_size: 100 } },
  { label: "tools", path: "/api/v1/tools" },
  { label: "test suites", path: "/api/v1/test-suites" },
  { label: "sandboxes", path: "/api/v1/sandboxes" },
];

/** Rows per section; the inventory says how many more there are. */
const MAX_ROWS = 100;
const COLUMNS = ["slug", "name", "status", "id"];

function itemsOf(data: unknown): Array<Record<string, unknown>> {
  const list = Array.isArray(data) ? data : data && typeof data === "object" ? ((data as { items?: unknown }).items ?? (data as { tools?: unknown }).tools) : undefined;
  return Array.isArray(list) ? list.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object") : [];
}

function row(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out.slug = item.slug ?? item.key ?? null;
  out.name = item.name ?? item.display_name ?? null;
  out.status = item.status ?? item.lifecycle_state ?? item.scope ?? null;
  out.id = item.id ?? null;
  return out;
}

export interface InventoryResult {
  file: string;
  counts: Array<{ label: string; count: number | null }>;
}

export async function writeInventory(ctx: Context, root: string, now: Date): Promise<InventoryResult> {
  const sections: string[] = [];
  const counts: InventoryResult["counts"] = [];
  for (const listing of LISTINGS) {
    let body: string;
    try {
      const data = await callStable<unknown>(ctx, "GET", listing.path, `listing ${listing.label}`, { query: listing.query });
      const items = itemsOf(data);
      counts.push({ label: listing.label, count: items.length });
      const rows = items.slice(0, MAX_ROWS).map(row);
      const columns = COLUMNS.filter((c) => rows.some((r) => r[c] !== null && r[c] !== undefined));
      body = items.length
        ? `\`\`\`text\n${table(rows, columns, 50)}\n\`\`\`${items.length > MAX_ROWS ? `\n\n… and ${items.length - MAX_ROWS} more.` : ""}`
        : "None.";
    } catch (error) {
      counts.push({ label: listing.label, count: null });
      body = `Not readable here: ${error instanceof CavelonError ? error.message : String(error)}`;
    }
    sections.push(`## ${listing.label[0]!.toUpperCase()}${listing.label.slice(1)}\n\n${body}`);
  }
  const text = [
    "# Tenant inventory",
    "",
    `Written by \`cavelon pull\` at ${now.toISOString()}; \`cavelon pull\` refreshes it. Local state, never committed.`,
    "",
    ...sections.flatMap((s) => [s, ""]),
  ].join("\n");
  await writeState(root, "inventory.md", text);
  return { file: `${STATE_DIR}/inventory.md`, counts };
}
