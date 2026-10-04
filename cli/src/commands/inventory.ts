import path from "node:path";
import type { Context } from "../command.js";
import { CavelonError } from "../errors.js";
import { table } from "../format.js";
import { readJsonFile } from "../fsutil.js";
import { callStable } from "../invoke.js";
import { STATE_DIR, stateDir, writeState } from "../local-state.js";

/**
 * `.cavelon/inventory.md`: what the tenant holds, from the last pull, for the
 * skills to read when they need it. It changes on every pull, so it lives in
 * local state rather than in AGENTS.md, which every session would load.
 * `.cavelon/inventory.json` holds the same names for `validate`, which checks
 * the package's references to the tenant against them offline.
 */

/** The names `validate` checks references against, by what the package calls them. */
export type InventoryKind = "solutions" | "knowledge_bases" | "tools" | "skills" | "models";

interface Listing {
  label: string;
  path: string;
  query?: Record<string, string | number | boolean>;
  /** Kept in inventory.json under this kind, by this field of each item. */
  kind?: InventoryKind;
  field?: string;
}

const LISTINGS: Listing[] = [
  { label: "solutions", path: "/api/v1/harnesses", kind: "solutions", field: "slug" },
  { label: "knowledge bases", path: "/api/v1/knowledge-bases", query: { page_size: 100 }, kind: "knowledge_bases", field: "name" },
  { label: "tools", path: "/api/v1/tools", kind: "tools", field: "slug" },
  { label: "skills", path: "/api/v1/skills", kind: "skills", field: "slug" },
  { label: "models", path: "/api/v1/model-registry", kind: "models", field: "model_id" },
  { label: "test suites", path: "/api/v1/test-suites" },
  { label: "sandboxes", path: "/api/v1/sandboxes" },
];

const INVENTORY_JSON = "inventory.json";

/**
 * The tenant's names from the last pull: each kind's list, or null where the
 * listing could not be read. `models` is refreshed by `models list` too.
 */
export interface TenantInventory {
  written_at: string;
  names: Partial<Record<InventoryKind, string[] | null>>;
  /** When a kind was read later than the rest (`models list`). */
  refreshed_at?: Partial<Record<InventoryKind, string>>;
}

export async function readInventory(root: string): Promise<TenantInventory | undefined> {
  const inventory = await readJsonFile<TenantInventory>(path.join(stateDir(root), INVENTORY_JSON));
  return inventory && typeof inventory === "object" && inventory.names && typeof inventory.names === "object" ? inventory : undefined;
}

/** Record one kind read now, as `models list` does, in the inventory of the last pull or a new one. */
export async function refreshInventory(root: string, kind: InventoryKind, names: string[], now: Date): Promise<void> {
  const inventory = (await readInventory(root)) ?? { written_at: now.toISOString(), names: {} };
  inventory.names[kind] = [...new Set(names)].sort((a, b) => a.localeCompare(b, "en"));
  inventory.refreshed_at = { ...inventory.refreshed_at, [kind]: now.toISOString() };
  await writeState(root, INVENTORY_JSON, `${JSON.stringify(inventory, null, 2)}\n`);
}

/** Rows per section; the inventory says how many more there are. */
const MAX_ROWS = 100;
const COLUMNS = ["slug", "name", "status", "id"];

function itemsOf(data: unknown): Array<Record<string, unknown>> {
  const list = Array.isArray(data) ? data : data && typeof data === "object" ? ((data as { items?: unknown }).items ?? (data as { tools?: unknown }).tools) : undefined;
  return Array.isArray(list) ? list.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object") : [];
}

function row(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out.slug = item.slug ?? item.key ?? item.model_id ?? null;
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
  const names: TenantInventory["names"] = {};
  for (const listing of LISTINGS) {
    let body: string;
    try {
      const data = await callStable<unknown>(ctx, "GET", listing.path, `listing ${listing.label}`, { query: listing.query });
      const items = itemsOf(data);
      counts.push({ label: listing.label, count: items.length });
      if (listing.kind) names[listing.kind] = [...new Set(items.map((i) => i[listing.field!]).filter((v): v is string => typeof v === "string"))].sort((a, b) => a.localeCompare(b, "en"));
      const rows = items.slice(0, MAX_ROWS).map(row);
      const columns = COLUMNS.filter((c) => rows.some((r) => r[c] !== null && r[c] !== undefined));
      body = items.length
        ? `\`\`\`text\n${table(rows, columns, 50)}\n\`\`\`${items.length > MAX_ROWS ? `\n\n… and ${items.length - MAX_ROWS} more.` : ""}`
        : "None.";
    } catch (error) {
      counts.push({ label: listing.label, count: null });
      if (listing.kind) names[listing.kind] = null;
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
  const inventory: TenantInventory = { written_at: now.toISOString(), names };
  await writeState(root, INVENTORY_JSON, `${JSON.stringify(inventory, null, 2)}\n`);
  return { file: `${STATE_DIR}/inventory.md`, counts };
}
