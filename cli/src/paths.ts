import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "./command.js";
import { CavelonError, ExitCode } from "./errors.js";
import { findProject } from "./project.js";

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

/**
 * A path an MCP tool was given, confined to the solution: under the folder of
 * the nearest `cavelon.yaml`, or the working directory without one, after
 * following symlinks, and never in the kit's config or cache directory (which
 * hold the stored token and the instance's contracts), wherever those are.
 * An agent that reads a web page or a document can be told to name any path;
 * the solution is the only place a tool needs. The CLI is a person, who may
 * name any file, so there the path is only resolved.
 */
export async function confinedPath(ctx: Context, raw: string, what: string): Promise<string> {
  const resolved = path.resolve(ctx.io.cwd, raw);
  if (ctx.mode !== "mcp") return resolved;
  const root = (await findProject(ctx.io.cwd))?.root ?? ctx.io.cwd;
  const real = await realPath(resolved);
  if (!within(await realPath(root), real)) {
    throw new CavelonError(ExitCode.usage, {
      code: "path_outside_solution",
      message: `${what} ${raw} is outside the solution folder ${root}; over MCP a tool reads and writes only there.`,
      hint: "Name a file inside the solution folder, or ask the person to run the command in their terminal.",
    });
  }
  for (const dir of [configDir(ctx.io.env), cacheDir(ctx.io.env)]) {
    if (within(await realPath(path.resolve(ctx.io.cwd, dir)), real, true)) {
      throw new CavelonError(ExitCode.usage, {
        code: "path_in_kit_directory",
        message: `${what} ${raw} is in cavelon's own directory ${dir}, which holds its login and cache; no tool reads or writes there.`,
      });
    }
  }
  return resolved;
}

/** The real path of a file, or of its nearest existing folder plus the rest, for a file still to be written. */
async function realPath(file: string): Promise<string> {
  const rest: string[] = [];
  let current = file;
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...rest.reverse());
    } catch (error) {
      const parent = path.dirname(current);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === current) throw error;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Whether `file` is `dir` or under it. `fold` ignores case, as the default file
 * systems of Windows and macOS do; it only ever widens a refusal, never what a
 * tool may reach, since a case-sensitive volume can hold both spellings.
 */
function within(dir: string, file: string, fold = false): boolean {
  const norm = (p: string) => (fold && (process.platform === "win32" || process.platform === "darwin") ? p.toLowerCase() : p);
  const rel = path.relative(norm(dir), norm(file));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
