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

export type InstallMethod = "script" | "executable" | "homebrew" | "winget" | "npm" | "npx" | "package" | "source";

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
