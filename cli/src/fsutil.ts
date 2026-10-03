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
