import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Context } from "./command.js";
import { CavelonError, ExitCode } from "./errors.js";
import { findProject } from "./project.js";
import { realPath, within } from "./file-boundary.js";
export { realPath, within } from "./file-boundary.js";

/**
 * Where the kit keeps its state on the user's machine, never in the
 * repository: the login per instance (config dir) and each instance's
 * contracts per version (cache dir, `~/.cache/cavelon/` by default).
 */

type Env = Record<string, string | undefined>;

export function homeDir(env: Env): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function configDir(env: Env): string {
  if (env.CAVELON_CONFIG_DIR) return env.CAVELON_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, "cavelon");
  if (process.platform === "win32" && env.APPDATA) return path.join(env.APPDATA, "cavelon");
  return path.join(homeDir(env), ".config", "cavelon");
}

export function cacheDir(env: Env): string {
  if (env.CAVELON_CACHE_DIR) return env.CAVELON_CACHE_DIR;
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, "cavelon");
  if (process.platform === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, "cavelon", "cache");
  return path.join(homeDir(env), ".cache", "cavelon");
}

/** Match filesystem reads: relative private directories belong to the process cwd,
 * never the per-call solution_dir selected by an MCP request. */
export function privateDirs(env: Env): string[] {
  return [configDir(env), cacheDir(env)].map(dir => path.resolve(dir));
}

/**
 * A file-system-safe name for an instance URL: its host, port and path to read,
 * then a hash of the whole URL. The readable part folds `:` and `/` into `_` and
 * drops the scheme, so without the hash `host:8443` and `host/8443`, or http and
 * https, would share one cache, and a release's copies are kept until its version
 * changes.
 */
export function instanceKey(url: string): string {
  const parsed = new URL(url);
  const parts = [parsed.hostname, parsed.port, parsed.pathname.replace(/^\/+|\/+$/g, "")].filter(Boolean);
  const readable = parts.join("_").replace(/[^A-Za-z0-9._-]+/g, "_");
  return `${readable}-${createHash("sha256").update(url).digest("hex").slice(0, 8)}`;
}

/**
 * A path an MCP tool was given, confined to the solution: under the folder of
 * the nearest `cavelon.yaml`, or the working directory without one, after
 * following symlinks, and never in the kit's config or cache directory (which
 * hold the stored token and the instance's contracts), wherever those are.
 * An agent that reads a web page or a document can be told to name any path;
 * the solution is the only place a tool needs. The CLI is a person, who may
 * name any file, so there the path is only resolved, unless the caller
 * confines it because a coding agent runs the CLI (`cavelon api`).
 */
export async function confinedPath(ctx: Context, raw: string, what: string, confine = ctx.mode === "mcp"): Promise<string> {
  const resolved = path.resolve(ctx.io.cwd, raw);
  if (!confine) return resolved;
  const root = (await findProject(ctx.io.cwd))?.root ?? ctx.io.cwd;
  const real = await realPath(resolved);
  if (!within(await realPath(root), real)) {
    const who = ctx.mode === "mcp" ? "over MCP a tool" : "run by a coding agent, cavelon";
    throw new CavelonError(ExitCode.usage, {
      code: "path_outside_solution",
      message: `${what} ${raw} is outside the solution folder ${root}; ${who} reads and writes only there.`,
      hint: "Name a file inside the solution folder, or ask the person to run the command in their terminal.",
    });
  }
  for (const dir of privateDirs(ctx.io.env)) {
    if (within(await realPath(dir), real, true)) {
      throw new CavelonError(ExitCode.usage, {
        code: "path_in_kit_directory",
        message: `${what} ${raw} is in cavelon's own directory ${dir}, which holds its login and cache; no tool reads or writes there.`,
      });
    }
  }
  return resolved;
}
