import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { readTextFile } from "./fsutil.js";
import { CavelonError, ExitCode, usageError } from "./errors.js";
import { layoutFrom, type Layout } from "./package-files.js";

/**
 * The solution a working directory belongs to: the nearest `cavelon.yaml`
 * from the current directory upwards, as git looks for `.git`. It names the
 * instance and the tenant, never a token. Unknown keys are kept and ignored,
 * so a file written by a newer kit still reads.
 */

export const PROJECT_FILE = "cavelon.yaml";

export interface ProjectConfig {
  file: string;
  root: string;
  instance?: string;
  tenant?: string;
  harness?: string;
  /** The package format version the files are written in. */
  packageVersion?: string;
  layout: Layout;
  raw: Record<string, unknown>;
}

function stringField(value: unknown, ...keys: string[]): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    for (const key of keys) {
      const nested = (value as Record<string, unknown>)[key];
      if (typeof nested === "string" && nested.trim()) return nested.trim();
    }
  }
  return undefined;
}

export async function findProject(cwd: string): Promise<ProjectConfig | undefined> {
  let dir = path.resolve(cwd);
  for (;;) {
    const file = path.join(dir, PROJECT_FILE);
    const text = await readTextFile(file);
    if (text !== undefined) return parseProject(file, text);
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function parseProject(file: string, text: string): ProjectConfig {
  let raw: unknown;
  try {
    raw = parse(text) ?? {};
  } catch (error) {
    throw new CavelonError(ExitCode.validation, {
      code: "project_file_invalid",
      message: `${file} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CavelonError(ExitCode.validation, {
      code: "project_file_invalid",
      message: `${file} must be a YAML mapping.`,
    });
  }
  const map = raw as Record<string, unknown>;
  refuseCredentials(file, map);
  return {
    file,
    root: path.dirname(file),
    instance: stringField(map.instance, "url") ?? stringField(map.url),
    tenant: stringField(map.tenant, "id", "slug"),
    harness: stringField(map.harness, "slug", "id"),
    packageVersion: stringField(map.package_version),
    layout: layoutFrom(map),
    raw: map,
  };
}

function refuseCredentials(file: string, map: Record<string, unknown>): void {
  for (const forbidden of ["token", "api_key", "secret"]) {
    if (forbidden in map) {
      throw new CavelonError(ExitCode.validation, {
        code: "project_file_has_secret",
        message: `${file} has a "${forbidden}" key. Solution files never hold a credential.`,
        hint: "Remove it, revoke the token, and use `cavelon login` or CAVELON_TOKEN instead.",
      });
    }
  }
}

/**
 * `env/<name>.yaml`: where `apply --env <name>` goes and how it binds the
 * package's runtime requirements there. It names a tenant and a solution,
 * never a token or a secret value.
 */
export interface EnvFile {
  name: string;
  file: string;
  tenant?: string;
  harness?: string;
  mode?: "overwrite" | "replace";
  /** Runtime requirement key → the target's resource id. */
  runtimeBindings: Record<string, string>;
  raw: Record<string, unknown>;
}

export const ENV_DIR = "env";
const ENV_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function envFilePath(project: ProjectConfig, name: string): string {
  if (!ENV_NAME.test(name)) {
    throw usageError(`"${name}" is not an environment name.`, "Use letters, digits, dashes and underscores, as in --env test.");
  }
  return path.join(project.root, ENV_DIR, `${name}.yaml`);
}

/** The environments the solution has an env file for, by name. */
export async function envNames(project: ProjectConfig): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(path.join(project.root, ENV_DIR));
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".yaml"))
    .map((entry) => entry.slice(0, -".yaml".length))
    .filter((name) => ENV_NAME.test(name))
    .sort();
}

/**
 * A missing env file is refused, never read as "no env file": a typo in
 * `--env prod`, or a prod file nobody has written yet, would otherwise act in
 * cavelon.yaml's tenant and report success.
 */
export async function readEnvFile(project: ProjectConfig, name: string): Promise<EnvFile> {
  const file = envFilePath(project, name);
  const text = await readTextFile(file);
  if (text === undefined) {
    const known = await envNames(project);
    throw usageError(
      `No ${ENV_DIR}/${name}.yaml in this solution; nothing was sent.`,
      known.length
        ? `Its env files: ${known.join(", ")}. Pass one of them to --env, or write ${ENV_DIR}/${name}.yaml first.`
        : "`cavelon init` writes env/test.yaml and env/prod.yaml.",
    );
  }
  let raw: unknown;
  try {
    raw = parse(text) ?? {};
  } catch (error) {
    throw new CavelonError(ExitCode.validation, {
      code: "env_file_invalid",
      message: `${file} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CavelonError(ExitCode.validation, { code: "env_file_invalid", message: `${file} must be a YAML mapping.` });
  }
  const map = raw as Record<string, unknown>;
  refuseCredentials(file, map);
  const bindings: Record<string, string> = {};
  const declared = map.runtime_bindings;
  if (declared !== undefined && declared !== null) {
    if (typeof declared !== "object" || Array.isArray(declared)) {
      throw new CavelonError(ExitCode.validation, {
        code: "env_file_invalid",
        message: `${file}: runtime_bindings must map each requirement key to a resource id.`,
      });
    }
    for (const [key, value] of Object.entries(declared as Record<string, unknown>)) {
      if (value === null || value === undefined || value === "") continue;
      if (typeof value !== "string") {
        throw new CavelonError(ExitCode.validation, {
          code: "env_file_invalid",
          message: `${file}: runtime_bindings.${key} must be a resource id, got ${JSON.stringify(value)}.`,
        });
      }
      bindings[key] = value.trim();
    }
  }
  const mode = stringField(map.mode);
  if (mode !== undefined && mode !== "overwrite" && mode !== "replace") {
    throw new CavelonError(ExitCode.validation, {
      code: "env_file_invalid",
      message: `${file}: mode must be overwrite or replace, got "${mode}".`,
    });
  }
  return {
    name,
    file,
    tenant: stringField(map.tenant, "id", "slug"),
    harness: stringField(map.harness, "slug", "id"),
    mode: mode as EnvFile["mode"],
    runtimeBindings: bindings,
    raw: map,
  };
}
