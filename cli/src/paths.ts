import os from "node:os";
import path from "node:path";

/**
 * Where the kit keeps its state on the user's machine, never in the
 * repository: the login per instance (config dir) and each instance's
 * contracts per version (cache dir, `~/.cache/cavelon/` by default).
 */

type Env = Record<string, string | undefined>;

function home(env: Env): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function configDir(env: Env): string {
  if (env.CAVELON_CONFIG_DIR) return env.CAVELON_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, "cavelon");
  if (process.platform === "win32" && env.APPDATA) return path.join(env.APPDATA, "cavelon");
  return path.join(home(env), ".config", "cavelon");
}

export function cacheDir(env: Env): string {
  if (env.CAVELON_CACHE_DIR) return env.CAVELON_CACHE_DIR;
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, "cavelon");
  if (process.platform === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, "cavelon", "cache");
  return path.join(home(env), ".cache", "cavelon");
}

/** A file-system-safe name for an instance URL: host, port and path. */
export function instanceKey(url: string): string {
  const parsed = new URL(url);
  const parts = [parsed.hostname, parsed.port, parsed.pathname.replace(/^\/+|\/+$/g, "")].filter(Boolean);
  return parts.join("_").replace(/[^A-Za-z0-9._-]+/g, "_");
}
