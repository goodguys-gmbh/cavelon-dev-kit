import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { embeddedContent } from "./embedded.js";

/**
 * How this cavelon came onto the machine, read from where its file lies: the
 * installers record nothing, but each puts the file in a place of its own.
 * `--version` names it, and the update notice gives the one command that
 * updates it that way.
 */

export const REPOSITORY = "goodguys-gmbh/cavelon-dev-kit";
export const NPM_PACKAGE = "@cavelon/cli";
/** The identifier packaging/render.mjs writes into the winget manifest. */
const WINGET_ID = "goodguys.Cavelon";
const RELEASES = `https://github.com/${REPOSITORY}/releases/latest`;

export type InstallMethod = "script" | "executable" | "homebrew" | "winget" | "uv-tool" | "pipx" | "uvx" | "pip" | "npm" | "npx" | "package" | "source";

/**
 * The file a PyPI wheel installs into the environment's data folder beside
 * the executable (packaging/pypi/build_wheels.py): pip, uv and pipx record
 * nothing else in a place `cavelon` can find without Python, and they remove
 * it with the package.
 */
export const PYPI_MARKER = ["share", "cavelon", "pypi"] as const;

export interface Install {
  method: InstallMethod;
  /** The executable, or the npm package's folder. */
  path: string;
  /** The one command that updates this install, where there is one. */
  update?: string;
  /** What to do instead, where no one command fits. */
  advice?: string;
  /** Where a newer release shows first for this method; none for npx and a source checkout. */
  source?: "github" | "npm";
}

export interface InstallFacts {
  /** True for the standalone executable, false for the npm package on Node.js. */
  executable: boolean;
  /** The executable's real path, or the real path of the package's folder. */
  file: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  exists(file: string): boolean;
  /** The real path of a folder; a home folder may be a symbolic link. */
  real?(file: string): string;
}

const LABELS: Record<InstallMethod, string> = {
  script: "the install script",
  executable: "a downloaded executable",
  homebrew: "Homebrew",
  winget: "winget",
  "uv-tool": "uv tool install",
  pipx: "pipx",
  uvx: "uvx",
  pip: "pip",
  npm: "npm i -g",
  npx: "npx",
  package: "a package manager",
  source: "a source checkout",
};

export function installLabel(method: InstallMethod): string {
  return LABELS[method];
}

export function detectInstall(facts: InstallFacts): Install {
  const { file, platform } = facts;
  const p = platform === "win32" ? path.win32 : path.posix;
  const segments = file.split(/[\\/]/);
  if (facts.executable) {
    if (segments.includes("Cellar") && segments[segments.indexOf("Cellar") + 1] === "cavelon") {
      return { method: "homebrew", path: file, update: "brew upgrade cavelon", source: "github" };
    }
    const lower = segments.map((s) => s.toLowerCase());
    const packages = lower.indexOf("packages");
    if (platform === "win32" && packages > 0 && lower[packages - 1] === "winget" && lower[packages + 1]?.startsWith(`${WINGET_ID.toLowerCase()}_`)) {
      return { method: "winget", path: file, update: `winget upgrade ${WINGET_ID}`, source: "github" };
    }
    const pypi = pypiInstall(facts, p, lower);
    if (pypi) return pypi;
    // The install scripts always name it cavelon; a file of another name was downloaded by hand.
    const name = p.basename(file).toLowerCase();
    if (name !== (platform === "win32" ? "cavelon.exe" : "cavelon")) {
      return { method: "executable", path: file, advice: `Download the new one from ${RELEASES}.`, source: "github" };
    }
    return { method: "script", path: file, update: scriptUpdate(facts, p.dirname(file)), source: "github" };
  }
  if (segments.includes("_npx")) {
    return { method: "npx", path: file, advice: "npx starts the newest release of the version range it is given each time; nothing to update." };
  }
  const end = segments.slice(-3).join("/");
  if (end !== `node_modules/${NPM_PACKAGE}`) return { method: "source", path: file };
  // npm i -g puts the package under <prefix>/lib/node_modules and the command
  // into <prefix>/bin (on Windows: <prefix>\node_modules and <prefix>\cavelon.cmd);
  // a project's dependency or another package manager's global folder has no such command.
  const modules = p.dirname(p.dirname(file));
  const shim =
    platform === "win32"
      ? p.join(p.dirname(modules), "cavelon.cmd")
      : p.basename(p.dirname(modules)) === "lib"
        ? p.join(p.dirname(p.dirname(modules)), "bin", "cavelon")
        : undefined;
  if (shim && facts.exists(shim)) return { method: "npm", path: file, update: `npm i -g ${NPM_PACKAGE}`, source: "npm" };
  return { method: "package", path: file, advice: `Update ${NPM_PACKAGE} with the package manager that installed it.`, source: "npm" };
}

/**
 * The executable of a PyPI wheel. It lies in a Python environment's scripts
 * folder (`bin`, or `Scripts` on Windows), with the wheel's marker in that
 * environment's data folder: the scripts folder's parent for a virtual
 * environment (uv tool, pipx, uvx, a venv) and for a system or user install
 * on macOS and Linux, and its grandparent for a user install on Windows
 * (`%APPDATA%\Python\Python3XY\Scripts`). The wheels are built from the
 * GitHub release, so a newer release shows there first.
 */
function pypiInstall(facts: InstallFacts, p: path.PlatformPath, lower: string[]): Install | undefined {
  const prefix = p.dirname(p.dirname(facts.file));
  const roots = facts.platform === "win32" ? [prefix, p.dirname(prefix)] : [prefix];
  if (!roots.some((root) => facts.exists(p.join(root, ...PYPI_MARKER)))) return undefined;
  const file = facts.file;
  const follows = (a: string, b: string) => lower.some((s, i) => s === a && lower[i + 1] === b);
  // Where the person moved uv's or pipx's folders, the variable names them.
  const under = (dir: string | undefined) => {
    if (!dir) return false;
    const fold = (v: string) => (facts.platform === "win32" ? v.toLowerCase() : v);
    return fold(file).startsWith(fold(p.join(dir, p.sep)));
  };
  if (follows("uv", "tools") || under(facts.env.UV_TOOL_DIR)) return { method: "uv-tool", path: file, update: "uv tool upgrade cavelon", source: "github" };
  if (follows("pipx", "venvs") || under(facts.env.PIPX_HOME)) return { method: "pipx", path: file, update: "pipx upgrade cavelon", source: "github" };
  // uvx builds its environment in uv's cache and reuses it until asked for the latest.
  if (lower.includes("uv") && lower.some((s) => s.startsWith("archive-v"))) {
    return { method: "uvx", path: file, advice: "uvx reuses the release it cached; `uvx cavelon@latest` runs the newest.", source: "github" };
  }
  return { method: "pip", path: file, update: "pip install --upgrade cavelon", source: "github" };
}

/** Running the install script again, into the folder it installed to when that is not its default. */
function scriptUpdate(facts: InstallFacts, dir: string): string {
  const { env } = facts;
  if (facts.platform === "win32") {
    const command = `irm https://github.com/${REPOSITORY}/releases/latest/download/install.ps1 | iex`;
    const local = env.LOCALAPPDATA;
    const usual = local ? path.win32.join(local, "Programs", "cavelon") : undefined;
    if (usual && sameFolder(facts, usual, dir, true)) return command;
    return `$env:CAVELON_INSTALL_DIR = '${dir.replaceAll("'", "''")}'; ${command}`;
  }
  const command = `curl -fsSL https://github.com/${REPOSITORY}/releases/latest/download/install.sh | sh`;
  const home = env.HOME;
  if (home && sameFolder(facts, path.posix.join(home, ".local", "bin"), dir, false)) return command;
  return `${command} -s -- --dir ${shellQuote(dir)}`;
}

function sameFolder(facts: InstallFacts, usual: string, dir: string, fold: boolean): boolean {
  const norm = (p: string) => (fold ? p.toLowerCase() : p);
  return norm(usual) === norm(dir) || (facts.real !== undefined && norm(facts.real(usual)) === norm(dir));
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./~+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function realOrSame(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

/** This process's install. */
export function currentInstall(env: Record<string, string | undefined>): Install {
  const executable = embeddedContent() !== undefined;
  // dist/install.js and src/install.ts both sit one level below the package's folder.
  const file = executable
    ? realOrSame(process.execPath)
    : realOrSame(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  return detectInstall({ executable, file, platform: process.platform, env, exists: existsSync, real: realOrSame });
}
