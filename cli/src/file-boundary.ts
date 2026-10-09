import { realpath } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { CavelonError, ExitCode } from "./errors.js";

// Bun 1.4.2's promise API drops the separator from Windows drive roots.
// The native API preserves absolute paths, as Node's promise API does.
const nativeRealPath = promisify(realpath.native);

/** Resolve missing children through their nearest existing ancestor too. */
export async function realPath(file: string): Promise<string> {
  const rest: string[] = [];
  let current = path.resolve(file);
  for (;;) {
    try {
      return path.join(await nativeRealPath(current), ...rest.reverse());
    } catch (error) {
      const parent = path.dirname(current);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === current) throw error;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

export function within(dir: string, file: string, fold = false): boolean {
  const norm = (p: string) => (fold && (process.platform === "win32" || process.platform === "darwin") ? p.toLowerCase() : p);
  const rel = path.relative(norm(dir), norm(file));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** A solution-owned file, including a file not yet created behind a directory link. */
export async function solutionPath(root: string, file: string): Promise<string> {
  const real = await realPath(file);
  if (!within(await realPath(root), real)) {
    throw new CavelonError(ExitCode.usage, {
      code: "path_outside_solution",
      message: `${path.relative(root, file)} resolves outside the solution folder; nothing was done to that path.`,
      hint: "Move the file or directory into the solution folder, or use a link whose target stays inside it.",
    });
  }
  return real;
}

/** Preflight a set before a command starts writing any of its generated files. */
export async function solutionPaths(root: string, files: string[], privateDirs: string[] = []): Promise<void> {
  for (const file of files) await solutionPath(root, path.resolve(root, file));
  await checkPrivatePaths(root, files, privateDirs);
}

/** File links must not expose a login or cached contracts kept inside a workspace. */
export async function checkPrivatePaths(root: string, files: string[], privateDirs: string[]): Promise<void> {
  const privateRoots = await Promise.all(privateDirs.map(dir => realPath(dir)));
  for (const file of files) {
    const real = await realPath(path.resolve(root, file));
    if (privateRoots.some(dir => within(dir, real, true) || within(real, dir, true))) {
      throw new CavelonError(ExitCode.usage, {
        code: "path_in_kit_directory",
        message: `${file} overlaps cavelon's credential or cache directory; nothing was done to that path.`,
      });
    }
  }
}
