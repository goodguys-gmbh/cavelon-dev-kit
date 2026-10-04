import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { readJsonFile, readTextFile, writeFileAtomic } from "./fsutil.js";

/**
 * `.cavelon/` in a solution folder: local state, never committed (it ignores
 * itself). The tenant's inventory from the last pull, the last pull itself,
 * and the open previews. A preview file holds the exact request it previewed,
 * so `apply --confirm <id>` imports what the person saw. Never a token.
 */

export const STATE_DIR = ".cavelon";

export interface PullRecord {
  at: string;
  instance: string;
  tenant_id: string | null;
  harness: { id: string; slug: string } | null;
  scope: string;
  package_version: string | null;
  files: { written: string[]; unchanged: string[]; removed: string[]; kept: string[] };
}

export interface ImportRequest {
  package: Record<string, unknown>;
  mode: "overwrite" | "replace";
  harness_id?: string;
  runtime_bindings?: Record<string, string>;
}

export interface StoredPreview {
  preview_id: string;
  created_at: string;
  instance: string;
  tenant_id: string | null;
  env: string | null;
  harness: { id: string; slug: string; created: boolean } | null;
  /** The package files' content when previewed, to tell when they changed since. */
  package_digest: string;
  /** Each package file's digest when previewed; absent in a preview an older kit stored. */
  file_digests?: Record<string, string>;
  request: ImportRequest;
  preview: Record<string, unknown>;
}

export function stateDir(root: string): string {
  return path.join(root, STATE_DIR);
}

/** Create `.cavelon/` with a `.gitignore` that ignores everything in it. */
export async function ensureStateDir(root: string): Promise<boolean> {
  const dir = stateDir(root);
  const ignore = path.join(dir, ".gitignore");
  if ((await readTextFile(ignore)) !== undefined) return false;
  await writeFileAtomic(ignore, "# Local cavelon state; never committed.\n*\n");
  return true;
}

export async function writeState(root: string, name: string, content: string): Promise<void> {
  await ensureStateDir(root);
  await writeFileAtomic(path.join(stateDir(root), name), content);
}

export async function readPull(root: string): Promise<PullRecord | undefined> {
  return readJsonFile<PullRecord>(path.join(stateDir(root), "pull.json"));
}

/** The package files' digests as the last pull or apply left them (the name is older than the apply). */
const PULLED_FILES = "pulled-files.json";

/** The SHA-256 of a file's bytes, through a symlink; undefined when there is no file. */
export async function fileDigest(file: string): Promise<string | undefined> {
  const bytes = await fs.readFile(file).catch(() => undefined);
  return bytes && createHash("sha256").update(bytes).digest("hex");
}

/** The digests of files in a solution folder, by their path relative to it; a missing file is left out. */
export async function fileDigests(root: string, files: string[]): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const file of files) {
    const value = await fileDigest(path.join(root, file));
    if (value) digests[file] = value;
  }
  return digests;
}

/**
 * The package files as the last pull left them, by digest. Outside git, and
 * for files not committed yet, it is the only way to tell a local edit from
 * what the instance holds.
 */
export async function writePulledFiles(root: string, files: string[]): Promise<void> {
  await writeState(root, PULLED_FILES, JSON.stringify({ digests: await fileDigests(root, files) }, null, 2));
}

/**
 * Add the files an apply imported, as they were when previewed: the instance
 * holds them now, so a later pull may replace them like files it wrote.
 */
export async function rememberAppliedFiles(root: string, digests: Record<string, string>): Promise<void> {
  const known = await readPulledFiles(root);
  await writeState(root, PULLED_FILES, JSON.stringify({ digests: { ...known, ...digests } }, null, 2));
}

/** The package files' digests as the last pull or apply left them. */
export async function readPulledFiles(root: string): Promise<Record<string, string>> {
  const stored = await readJsonFile<{ digests?: Record<string, string> }>(path.join(stateDir(root), PULLED_FILES));
  return stored?.digests && typeof stored.digests === "object" ? stored.digests : {};
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** A file name for a preview id, whatever characters the instance put into it. */
function previewFile(root: string, previewId: string): string {
  const safe = /^[A-Za-z0-9._-]{1,100}$/.test(previewId) ? previewId : createHash("sha256").update(previewId).digest("hex").slice(0, 32);
  return path.join(stateDir(root), "previews", `${safe}.json`);
}

export async function savePreview(root: string, preview: StoredPreview): Promise<string> {
  await ensureStateDir(root);
  const file = previewFile(root, preview.preview_id);
  await writeFileAtomic(file, JSON.stringify(preview, null, 2));
  return file;
}

export async function loadPreview(root: string, previewId: string): Promise<StoredPreview | undefined> {
  const stored = await readJsonFile<StoredPreview>(previewFile(root, previewId));
  return stored?.preview_id === previewId ? stored : undefined;
}

export async function deletePreview(root: string, previewId: string): Promise<void> {
  await fs.rm(previewFile(root, previewId), { force: true });
}

/** The open previews, newest first. */
export async function listPreviews(root: string): Promise<Array<Pick<StoredPreview, "preview_id" | "created_at" | "env" | "harness">>> {
  const dir = path.join(stateDir(root), "previews");
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const stored = await readJsonFile<StoredPreview>(path.join(dir, name));
    if (stored?.preview_id) out.push({ preview_id: stored.preview_id, created_at: stored.created_at, env: stored.env, harness: stored.harness });
  }
  return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}
