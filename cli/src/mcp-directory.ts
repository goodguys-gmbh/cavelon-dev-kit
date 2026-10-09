import { promises as fs } from "node:fs";
import path from "node:path";
import type { Io } from "./io.js";
import { CavelonError, ExitCode, usageError } from "./errors.js";
import { privateDirs, realPath, within } from "./paths.js";

/** A per-call cwd; never change the process or another call's workspace. */
export async function solutionDirectory(io: Io, selection: unknown): Promise<{ io: Io; selected?: string; directory?: string }> {
  if (selection === undefined) return { io };
  if (typeof selection !== "string" || !selection.trim() || selection.includes("\0")) {
    throw usageError("solution_dir must be a nonempty solution folder path.");
  }
  const root = await realPath(io.cwd);
  const directory = await realPath(path.resolve(io.cwd, selection));
  if (!within(root, directory)) {
    throw new CavelonError(ExitCode.usage, {
      code: "path_outside_solution",
      message: `The solution folder ${selection} is outside the MCP workspace ${io.cwd}; nothing was done.`,
      hint: "Select a folder inside the workspace, or start a separate MCP session in that repository.",
    });
  }
  for (const privateDir of privateDirs(io.env)) {
    if (within(await realPath(privateDir), directory, true)) {
      throw new CavelonError(ExitCode.usage, {
        code: "path_in_kit_directory",
        message: "solution_dir cannot select cavelon's credential or cache directory; nothing was done.",
      });
    }
  }
  const stat = await fs.stat(directory).catch(() => undefined);
  if (!stat?.isDirectory()) throw usageError(`The solution folder ${selection} is not an existing directory; nothing was done.`);
  return { io: { ...io, cwd: directory }, selected: selection, directory };
}
