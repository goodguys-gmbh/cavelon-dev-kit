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
  /** Slugs resolved to tenant ids, so a slug costs one lookup, not one per call. */
  tenant_ids?: Record<string, string>;
}

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
