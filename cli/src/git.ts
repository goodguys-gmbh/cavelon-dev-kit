import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * An executable found in the absolute directories of PATH only. A relative
 * entry ("", ".", "bin") names a folder in whatever repository the kit runs in,
 * and Windows would otherwise look in the working directory first, so a
 * repository could carry its own program. On Windows each of `extensions` is
 * tried in turn. Undefined when the program is not installed.
 */
export async function findProgram(
  name: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  extensions: string[] = [".exe"],
): Promise<string | undefined> {
  const windows = platform === "win32";
  const pathApi = windows ? path.win32 : path.posix;
  const search = (windows ? (env.PATH ?? env.Path) : env.PATH) ?? "";
  const names = windows ? extensions.map((ext) => name + ext) : [name];
  for (const entry of search.split(pathApi.delimiter)) {
    // Windows allows an entry in quotes.
    const dir = windows && entry.length > 1 && entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
    if (!dir || !pathApi.isAbsolute(dir)) continue;
    for (const file of names) {
      const candidate = pathApi.join(dir, file);
      const found = await fs
        .stat(candidate)
        .then((st) => st.isFile() && (windows || (st.mode & 0o111) !== 0))
        .catch(() => false);
      if (found) return candidate;
    }
  }
  return undefined;
}

/** The git executable on PATH, or undefined when git is not installed. */
export function resolveGit(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  return findProgram("git", env, platform);
}

/**
 * The few things the kit asks git, read-only: where the hooks live, where a
 * folder sits in its repository, and whether files have uncommitted changes.
 * Undefined when git is missing or the folder is not in a repository.
 */
export async function git(args: string[], cwd: string): Promise<string | undefined> {
  const executable = await resolveGit();
  if (!executable) return undefined;
  return new Promise((resolve) => {
    execFile(executable, args, { cwd, timeout: 10_000, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? undefined : stdout);
    });
  });
}

/** Paths under `paths` (relative to `cwd`) with uncommitted changes, or undefined outside git. */
export async function uncommitted(cwd: string, paths: string[]): Promise<string[] | undefined> {
  const out = await git(["status", "--porcelain", "--untracked-files=all", "--", ...paths], cwd);
  if (out === undefined) return undefined;
  return out
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}
