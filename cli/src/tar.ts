import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CavelonError, ExitCode, usageError } from "./errors.js";

/**
 * The archive a Sandbox imports: uncompressed USTAR with identity encoding,
 * regular files and folders only, a PAX `path` record only where USTAR
 * cannot hold a name. Every name is checked before it goes in, and the bytes
 * do not depend on the machine (sorted, mtime 0, no owner), so the same
 * folder always gives the same digest.
 */

const BLOCK = 512;
const MAX_NAME_BYTES = 1024;

export interface ArchiveEntry {
  /** Forward slashes, relative, checked by archiveName. */
  name: string;
  directory: boolean;
  content?: Uint8Array;
}

export interface Archive {
  bytes: Uint8Array;
  sha256: string;
  files: number;
  directories: number;
}

/** A path inside the archive from its parts, or an error naming what is wrong. */
export function archiveName(parts: string[]): string {
  if (parts.length === 0) throw usageError("An empty path cannot go into the archive.");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") throw usageError(`"${parts.join("/")}" has an empty, "." or ".." part.`);
    for (const ch of part) {
      const code = ch.codePointAt(0)!;
      if (code < 0x20 || code === 0x7f || code === 0x2f || code === 0x5c) {
        throw usageError(`"${parts.join("/")}" has a character a Sandbox path cannot hold (a control character, or a slash or backslash in a name).`);
      }
    }
  }
  const name = parts.join("/");
  if (Buffer.byteLength(name, "utf8") > MAX_NAME_BYTES) throw usageError(`"${name.slice(0, 80)}…" is longer than ${MAX_NAME_BYTES} bytes.`);
  return name;
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(name: string, size: number, type: "0" | "5" | "x", prefix = ""): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, "utf8");
  block.write(octal(type === "5" ? 0o755 : 0o644, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(0, 12), 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write(type, 156, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  block.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

function padded(content: Uint8Array): Buffer[] {
  const rest = content.length % BLOCK;
  return rest ? [Buffer.from(content), Buffer.alloc(BLOCK - rest)] : [Buffer.from(content)];
}

/** USTAR's name and prefix fields, or undefined when the name needs a PAX record. */
function ustarFields(name: string): { name: string; prefix: string } | undefined {
  if (!/^[\x20-\x7e]+$/.test(name)) return undefined;
  if (name.length <= 100) return { name, prefix: "" };
  for (let at = name.indexOf("/"); at !== -1; at = name.indexOf("/", at + 1)) {
    const prefix = name.slice(0, at);
    const rest = name.slice(at + 1);
    if (prefix.length <= 155 && rest.length <= 100 && rest.length > 0) return { name: rest, prefix };
  }
  return undefined;
}

function paxRecord(name: string): Buffer {
  const body = ` path=${name}\n`;
  let length = Buffer.byteLength(body, "utf8");
  // The length counts its own digits.
  while (String(length).length + Buffer.byteLength(body, "utf8") !== length) length = String(length).length + Buffer.byteLength(body, "utf8");
  return Buffer.from(`${length}${body}`, "utf8");
}

/** One entry's blocks: its header (after a PAX record where USTAR cannot hold the name), then its content. */
function entryBlocks(entry: ArchiveEntry): Buffer[] {
  const name = entry.directory ? `${entry.name}/` : entry.name;
  const size = entry.directory ? 0 : (entry.content?.length ?? 0);
  const type = entry.directory ? "5" : "0";
  const fields = ustarFields(name);
  const blocks: Buffer[] = [];
  if (fields) blocks.push(header(fields.name, size, type, fields.prefix));
  else {
    const record = paxRecord(entry.name);
    blocks.push(header("PaxHeader", record.length, "x"), ...padded(record), header(name.replaceAll(/[^\x20-\x7e]/g, "_").slice(-100), size, type));
  }
  if (size) blocks.push(...padded(entry.content!));
  return blocks;
}

function byName(a: ArchiveEntry, b: ArchiveEntry): number {
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

export function buildArchive(entries: ArchiveEntry[]): Archive {
  const sorted = [...entries].sort(byName);
  const bytes = Buffer.concat([...sorted.flatMap(entryBlocks), Buffer.alloc(BLOCK * 2)]);
  const directories = sorted.filter((e) => e.directory).length;
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), files: sorted.length - directories, directories };
}

/** Whether these bytes start like an uncompressed tar archive. */
export function isUstar(bytes: Uint8Array): boolean {
  return bytes.length >= BLOCK && Buffer.from(bytes.subarray(257, 262)).toString("latin1") === "ustar";
}

const COMPRESSED = [".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz", ".tar.zst", ".tzst"];

/**
 * A folder, a tar archive or one file, as the archive a Sandbox imports:
 * a folder with everything in it, a tar as it is, any other file under its
 * own name. Links and special files are refused, never followed.
 */
export async function archiveFrom(source: string, maxBytes: number): Promise<Archive & { from: "folder" | "tar" | "file" }> {
  let stat;
  try {
    // The path the caller named may be a link; links inside the folder are refused below.
    stat = await fs.stat(source);
  } catch {
    throw usageError(`${source} does not exist.`);
  }
  const lower = source.toLowerCase();
  if (stat.isFile() && COMPRESSED.some((ext) => lower.endsWith(ext))) {
    throw usageError(`${path.basename(source)} is compressed; a Sandbox imports an uncompressed tar.`, "Decompress it first (for example `gunzip`), or pass the folder.");
  }
  if (stat.isFile() && lower.endsWith(".tar")) {
    if (stat.size > maxBytes) throw tooLarge(stat.size, maxBytes);
    const bytes = new Uint8Array(await fs.readFile(source));
    if (!isUstar(bytes)) throw usageError(`${path.basename(source)} is not an uncompressed (USTAR) tar archive.`);
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), files: -1, directories: -1, from: "tar" };
  }
  if (stat.isFile()) {
    if (stat.size > maxBytes) throw tooLarge(stat.size, maxBytes);
    const name = archiveName([path.basename(source)]);
    return { ...buildArchive([{ name, directory: false, content: await fs.readFile(source) }]), from: "file" };
  }
  if (!stat.isDirectory()) throw usageError(`${source} is neither a folder nor a file.`);
  const entries: ArchiveEntry[] = [];
  const refused: string[] = [];
  let total = 0;
  const walk = async (dir: string, parts: string[]): Promise<void> => {
    const items = await fs.readdir(dir, { withFileTypes: true });
    const visit = async (item: (typeof items)[number]): Promise<void> => {
      const here = [...parts, item.name];
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        entries.push({ name: archiveName(here), directory: true });
        return walk(full, here);
      }
      if (!item.isFile()) {
        refused.push(here.join("/"));
        return;
      }
      const name = archiveName(here);
      total += (await fs.stat(full)).size + BLOCK;
      if (total > maxBytes) throw tooLarge(total, maxBytes);
      entries.push({ name, directory: false, content: await fs.readFile(full) });
    };
    await Promise.all(items.map(visit));
  };
  await walk(source, []);
  refused.sort((a, b) => a.localeCompare(b, "en"));
  if (refused.length) {
    throw usageError(
      `${refused.length} entries are links or special files, which a Sandbox does not take: ${refused.slice(0, 5).join(", ")}${refused.length > 5 ? ", …" : ""}.`,
      "Replace links with the files they point to, or leave them out of the folder.",
    );
  }
  if (!entries.some((e) => !e.directory)) throw usageError(`${source} holds no files.`);
  const archive = buildArchive(entries);
  if (archive.bytes.length > maxBytes) throw tooLarge(archive.bytes.length, maxBytes);
  return { ...archive, from: "folder" };
}

function tooLarge(size: number, max: number): CavelonError {
  return new CavelonError(ExitCode.validation, {
    code: "sandbox_transfer_size_limit",
    message: `The archive would be ${size} bytes; a Sandbox imports at most ${max} bytes at once.`,
    hint: "Seed fewer or smaller files; a seed replaces the workspace, so everything the loop starts from goes into one archive.",
  });
}
