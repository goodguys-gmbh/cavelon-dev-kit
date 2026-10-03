import { promises as fs } from "node:fs";

/**
 * What a zip archive declares about its files, read from its central
 * directory without unpacking anything: the figures the instance checks an
 * archive upload against (file count, unpacked size, compression ratio per
 * file). Directories count as nothing, as there.
 */

export interface ZipSummary {
  /** Files, not directories. */
  files: number;
  /** The files' declared sizes once unpacked, added up. */
  uncompressedBytes: number;
  /** The highest unpacked-to-packed ratio of one file; Infinity when a non-empty file packs to nothing. */
  maxRatio: number;
  /** The file with that ratio. */
  maxRatioEntry: string | null;
}

export class ZipError extends Error {
  constructor(
    message: string,
    /** True when the file has no zip end record at all: it is not a zip archive. */
    readonly notZip: boolean,
  ) {
    super(message);
    this.name = "ZipError";
  }
}

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const EOCD64 = 0x06064b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
/** More records than the instance reads at all; the summary stops counting there. */
const MAX_RECORDS = 100_000;

async function readAt(handle: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new ZipError("The archive ends early.", false);
  return buffer;
}

function u64(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError("The archive declares a size no file has.", false);
  return Number(value);
}

/** The end record's position in the tail: the last signature whose comment fits. */
function findEnd(tail: Buffer): number {
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD && i + EOCD_SIZE + tail.readUInt16LE(i + 20) <= tail.length) return i;
  }
  return -1;
}

interface Directory {
  records: number;
  size: number;
  offset: number;
}

async function directoryOf(handle: fs.FileHandle, fileSize: number): Promise<Directory> {
  if (fileSize < EOCD_SIZE) throw new ZipError("The file is too short to be a zip archive.", true);
  const tailStart = Math.max(0, fileSize - EOCD_SIZE - MAX_COMMENT);
  const tail = await readAt(handle, tailStart, fileSize - tailStart);
  const end = findEnd(tail);
  if (end < 0) throw new ZipError("The file has no zip end record; it is not a zip archive.", true);
  let records = tail.readUInt16LE(end + 10);
  let size = tail.readUInt32LE(end + 12);
  let offset = tail.readUInt32LE(end + 16);
  if (records === U16_MAX || size === U32_MAX || offset === U32_MAX) {
    // Zip64: the locator sits right before the end record and points at the 64-bit one.
    const locatorAt = tailStart + end - 20;
    if (locatorAt < 0) throw new ZipError("The archive's zip64 record is missing.", false);
    const locator = await readAt(handle, locatorAt, 20);
    if (locator.readUInt32LE(0) !== EOCD64_LOCATOR) throw new ZipError("The archive's zip64 record is missing.", false);
    const record = await readAt(handle, u64(locator, 8), 56);
    if (record.readUInt32LE(0) !== EOCD64) throw new ZipError("The archive's zip64 record is damaged.", false);
    records = u64(record, 32);
    size = u64(record, 40);
    offset = u64(record, 48);
  }
  if (offset + size > fileSize) throw new ZipError("The archive's directory lies outside the file.", false);
  return { records, size, offset };
}

/** The 64-bit sizes a zip64 extra field holds for the 32-bit fields that are full. */
function zip64Sizes(extra: Buffer, uncompressed: number, compressed: number): { uncompressed: number; compressed: number } {
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    if (id === 0x0001) {
      let field = at + 4;
      const fieldEnd = Math.min(field + length, extra.length);
      if (uncompressed === U32_MAX && field + 8 <= fieldEnd) {
        uncompressed = u64(extra, field);
        field += 8;
      }
      if (compressed === U32_MAX && field + 8 <= fieldEnd) compressed = u64(extra, field);
      break;
    }
    at += 4 + length;
  }
  return { uncompressed, compressed };
}

/** As the instance computes it: an empty file has ratio 0, a non-empty one packed to nothing an infinite one. */
function ratioOf(uncompressed: number, compressed: number): number {
  if (uncompressed <= 0) return 0;
  if (compressed <= 0) return Infinity;
  return uncompressed / compressed;
}

export async function readZipSummary(file: string): Promise<ZipSummary> {
  const handle = await fs.open(file, "r");
  try {
    const { size: fileSize } = await handle.stat();
    const directory = await directoryOf(handle, fileSize);
    const data = await readAt(handle, directory.offset, directory.size);
    const summary: ZipSummary = { files: 0, uncompressedBytes: 0, maxRatio: 0, maxRatioEntry: null };
    let at = 0;
    for (let n = 0; n < Math.min(directory.records, MAX_RECORDS); n++) {
      if (at + 46 > data.length || data.readUInt32LE(at) !== CENTRAL_HEADER) throw new ZipError("The archive's directory is damaged.", false);
      const nameLength = data.readUInt16LE(at + 28);
      const extraLength = data.readUInt16LE(at + 30);
      const commentLength = data.readUInt16LE(at + 32);
      const next = at + 46 + nameLength + extraLength + commentLength;
      if (next > data.length) throw new ZipError("The archive's directory is damaged.", false);
      const name = data.toString("utf8", at + 46, at + 46 + nameLength);
      const sizes = zip64Sizes(data.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength), data.readUInt32LE(at + 24), data.readUInt32LE(at + 20));
      at = next;
      if (name.endsWith("/")) continue;
      summary.files++;
      summary.uncompressedBytes += sizes.uncompressed;
      const ratio = ratioOf(sizes.uncompressed, sizes.compressed);
      if (ratio > summary.maxRatio) {
        summary.maxRatio = ratio;
        summary.maxRatioEntry = name;
      }
    }
    if (directory.records > MAX_RECORDS) summary.files = Math.max(summary.files, directory.records);
    return summary;
  } finally {
    await handle.close();
  }
}
