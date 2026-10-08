import type { Context } from "./command.js";
import { CavelonError } from "./errors.js";
import { table } from "./format.js";

/** Effective per-tenant caps and counts, when the database connector publishes them. */
export interface DatabaseTenantLimit {
  limit: number;
  current: number;
  source: "platform" | "tenant";
  platform_limit: number;
}

export interface DatabaseTenantLimits {
  connections: DatabaseTenantLimit;
  queries: DatabaseTenantLimit;
}

const KEYS = {
  connections: "database_connections_per_tenant",
  queries: "database_queries_per_tenant",
} as const;
export type DatabaseLimitRow = DatabaseTenantLimit & { key: string };

function validLimit(value: unknown): value is DatabaseTenantLimit {
  if (!value || typeof value !== "object") return false;
  const item = value as DatabaseTenantLimit;
  return Number.isInteger(item.limit) && item.limit >= 1 &&
    Number.isInteger(item.current) && item.current >= 0 &&
    Number.isInteger(item.platform_limit) && item.platform_limit >= 1 &&
    (item.source === "platform" || item.source === "tenant");
}

/** Missing counts stay missing; current may exceed a lowered cap. */
export function databaseLimitRows(limits: unknown, keys?: string[]): DatabaseLimitRow[] {
  if (!limits || typeof limits !== "object") return [];
  const published = limits as Partial<DatabaseTenantLimits>;
  return (Object.keys(KEYS) as Array<keyof typeof KEYS>).flatMap(name => {
    const value = published[name];
    const key = KEYS[name];
    return validLimit(value) && (!keys || keys.includes(key)) ? [{ key, ...value }] : [];
  });
}

export function databaseLimitsText(rows: DatabaseLimitRow[]): string {
  return `Database limits and current counts:\n${table(rows.map(row => ({ ...row })), ["key", "current", "limit", "source", "platform_limit"])}`;
}

/** Counts supplement metadata; an older or unavailable route must not hide the limits. */
export async function readDatabaseLimits(ctx: Context, keys: string[]): Promise<DatabaseLimitRow[]> {
  if (!keys.some(key => Object.values(KEYS).includes(key as typeof KEYS[keyof typeof KEYS]))) return [];
  try {
    const response = await (await ctx.client()).get<{ limits?: unknown }>("/api/v1/database-connectors/instance", { allow: [403, 404] });
    if (response.status !== 200) {
      ctx.warn(`Database counts are unavailable (${response.status}); the published limits still stand.`);
      return [];
    }
    return databaseLimitRows(response.data?.limits, keys);
  } catch (error) {
    if (!(error instanceof CavelonError)) throw error;
    ctx.warn("Database counts could not be read; the published limits still stand.");
    return [];
  }
}
