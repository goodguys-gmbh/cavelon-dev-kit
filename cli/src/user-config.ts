import { createHash } from "node:crypto";
import path from "node:path";
import { configDir } from "./paths.js";
import { readJsonFile, writeFileAtomic } from "./fsutil.js";

/**
 * The user's own settings, per instance: which instance is current, which
 * tenant `cavelon use` chose, and which store holds the token. Never a token.
 */

export interface InstanceSettings {
  /** The tenant chosen with `cavelon use`, as given (slug or id). */
  tenant?: string;
  /** Its id, resolved when it was chosen. */
  tenant_id?: string;
  tenant_name?: string;
  /** The chosen tenant's slug, when the instance told it. */
  tenant_slug?: string;
  /** Where `login` stored the token. */
  credential_store?: "keyring" | "file";
  token_kind?: TokenKind;
  logged_in_at?: string;
  /**
   * Written by earlier releases: slugs resolved to ids, for any token and
   * forever. Never read any more; dropped when the cache is next written.
   */
  tenant_ids?: Record<string, string>;
  /**
   * Names and slugs resolved to tenant ids, so a slug costs one lookup, not
   * one per call. Each entry holds for the credential that resolved it and
   * for a day: a renamed or reused slug, or another token, resolves again.
   */
  tenant_refs?: Record<string, CachedTenantRef>;
}

export interface CachedTenantRef {
  id: string;
  /** credentialFingerprint() of the token that resolved it; never the token. */
  credential: string;
  resolved_at: string;
}

/** How long a resolved slug is trusted before it is resolved again. */
export const TENANT_REF_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Which credential resolved a cached slug: 16 hex digits of the token's
 * SHA-256, which tell two tokens apart and give nothing of either away.
 */
export function credentialFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/** The cached id of a name or slug, when this credential resolved it within the last day. */
export function cachedTenantRef(settings: InstanceSettings, ref: string, token: string | undefined, now: Date): string | undefined {
  const entry = settings.tenant_refs?.[ref];
  if (!entry || !token || entry.credential !== credentialFingerprint(token)) return undefined;
  const age = now.getTime() - new Date(entry.resolved_at).getTime();
  return age >= 0 && age < TENANT_REF_TTL_MS ? entry.id : undefined;
}

/** The settings with these names and slugs cached as resolving to `id` for this credential; expired entries and the old cache go. */
export function withTenantRefs(settings: InstanceSettings, refs: Array<string | undefined>, id: string, token: string, now: Date): InstanceSettings {
  const credential = credentialFingerprint(token);
  const kept = Object.entries(settings.tenant_refs ?? {}).filter(([, e]) => now.getTime() - new Date(e.resolved_at).getTime() < TENANT_REF_TTL_MS);
  const added = refs.filter((r): r is string => Boolean(r) && !isUuidLike(r!)).map((r) => [r, { id, credential, resolved_at: now.toISOString() }] as const);
  const { tenant_ids: _old, ...rest } = settings;
  return { ...rest, tenant_refs: Object.fromEntries([...kept, ...added]) };
}

/** The settings without the cached entry of this name or slug. */
export function withoutTenantRef(settings: InstanceSettings, ref: string): InstanceSettings {
  const { [ref]: _gone, ...others } = settings.tenant_refs ?? {};
  return { ...settings, tenant_refs: others };
}

const isUuidLike = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export type TokenKind = "personal_access_token" | "api_key" | "unknown";

export interface UserConfig {
  current_instance?: string;
  instances: Record<string, InstanceSettings>;
}

type Env = Record<string, string | undefined>;

export function userConfigPath(env: Env): string {
  return path.join(configDir(env), "config.json");
}

export async function loadUserConfig(env: Env): Promise<UserConfig> {
  const raw = await readJsonFile<Partial<UserConfig>>(userConfigPath(env));
  return { current_instance: raw?.current_instance, instances: raw?.instances ?? {} };
}

export async function saveUserConfig(env: Env, config: UserConfig): Promise<void> {
  await writeFileAtomic(userConfigPath(env), JSON.stringify(config, null, 2) + "\n", 0o600, 0o700);
}

export async function updateInstance(
  env: Env,
  url: string,
  change: (current: InstanceSettings) => InstanceSettings | undefined,
  options: { makeCurrent?: boolean } = {},
): Promise<UserConfig> {
  const config = await loadUserConfig(env);
  const next = change({ ...(config.instances[url] ?? {}) });
  if (next === undefined) {
    delete config.instances[url];
    if (config.current_instance === url) config.current_instance = undefined;
  } else {
    config.instances[url] = next;
    if (options.makeCurrent) config.current_instance = url;
  }
  await saveUserConfig(env, config);
  return config;
}

export function tokenKind(token: string): TokenKind {
  if (token.startsWith("cvpat_")) return "personal_access_token";
  if (token.startsWith("cbp_")) return "api_key";
  return "unknown";
}
