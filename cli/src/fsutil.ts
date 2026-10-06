import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export async function readTextFile(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * `text` without the UTF-8 byte-order mark that Windows PowerShell 5.1 and older
 * Notepad put first: the YAML parser takes it only before a mapping, JSON never.
 * Only for text the kit parses; a customer's file it rewrites keeps its bytes.
 */
export function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Write a file in one step (temp file, then rename), so a crash never leaves
 * half a file. `mode` applies before any content is written. Permissions only
 * ever narrow: a new file gets `mode` less the umask, and a file that is
 * replaced keeps no more than both its own mode and `mode`.
 */
export async function writeFileAtomic(file: string, content: string, mode = 0o644, dirMode = 0o755): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: dirMode });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await fs.open(tmp, "w", mode);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  const existing = await fs.stat(file).then((st) => st.mode & 0o777, () => undefined);
  if (existing !== undefined) await fs.chmod(tmp, existing & mode).catch(() => undefined);
  await fs.rename(tmp, file);
}

/**
 * Write a file only its owner may read (0600) in folders only its owner may
 * enter (0700), from `base` down. `mkdir` gives its mode only to a folder it
 * creates, so a folder an earlier version left 0755 is narrowed here, on the
 * next write; owner bits stay as they are. Where the file system has no such
 * modes (Windows), nothing changes.
 */
export async function writePrivateFile(base: string, file: string, content: string): Promise<void> {
  await writeFileAtomic(file, content, 0o600, 0o700);
  const root = path.resolve(base);
  for (let dir = path.dirname(path.resolve(file)); ; dir = path.dirname(dir)) {
    const rel = path.relative(root, dir);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) break;
    const mode = await fs.stat(dir).then((st) => st.mode & 0o777, () => undefined);
    if (mode !== undefined && mode & 0o077) await fs.chmod(dir, mode & 0o700).catch(() => undefined);
    if (rel === "") break;
  }
}
