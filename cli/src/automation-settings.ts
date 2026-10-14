import { promises as fs } from "node:fs";
import path from "node:path";
import { CavelonError, ExitCode } from "./errors.js";
import { withoutBom, writePrivateFile } from "./fsutil.js";
import { configDir } from "./paths.js";

export type McpMode = "standard" | "yolo";
type Env = Record<string, string | undefined>;

/** Personal startup policy, outside solution files and the MCP tool surface. */
export async function readMcpMode(env: Env): Promise<McpMode> {
  const file = path.join(configDir(env), "automation.json");
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("expected a regular file");
    const value: unknown = JSON.parse(withoutBom(await fs.readFile(file, "utf8")));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
    const settings = value as Record<string, unknown>;
    if (settings.format !== 1 || !["standard", "yolo"].includes(String(settings.mcp_mode))) throw new Error("unrecognized settings format or mode");
    return settings.mcp_mode as McpMode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "standard";
    throw new CavelonError(ExitCode.failure, {
      code: "automation_settings_invalid",
      message: `Cannot read the personal MCP mode in ${file}; leaving this file unchanged.`,
      hint: "Restore a regular JSON file with format: 1 and mcp_mode: standard or yolo, or move it aside and run cavelon setup again.",
    });
  }
}

export async function saveMcpMode(env: Env, mode: McpMode): Promise<boolean> {
  if (await readMcpMode(env) === mode) return false;
  await writePrivateFile(configDir(env), path.join(configDir(env), "automation.json"), JSON.stringify({ format: 1, mcp_mode: mode }, null, 2) + "\n");
  return true;
}
