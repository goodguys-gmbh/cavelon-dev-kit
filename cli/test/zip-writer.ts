import { deflateRawSync } from "node:zlib";

/**
 * A real zip archive for the tests, built here so no binary is checked in:
 * stored or deflated files, directories, and optionally the zip64 records an
 * archive past 65535 entries or 4 GiB carries.
 */

export interface ZipEntry {
  name: string;
  content?: Buffer | string;
  /** Deflate the content (default); false stores it as it is. */
  deflate?: boolean;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** One file's local header with its data, and its central directory record. */
function records(entry: ZipEntry, offset: number, zip64: boolean): { local: Buffer; central: Buffer } {
  const name = Buffer.from(entry.name, "utf8");
  const raw = Buffer.from(entry.content ?? "");
  const directory = entry.name.endsWith("/");
  const method = directory || entry.deflate === false ? 0 : 8;
  const packed = method === 8 ? deflateRawSync(raw) : raw;
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);

  // With zip64, the central record's sizes move into the extra field, as large archives have them.
  const extra = Buffer.alloc(zip64 ? 20 : 0);
  if (zip64) {
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(16, 2);
    extra.writeBigUInt64LE(BigInt(raw.length), 4);
    extra.writeBigUInt64LE(BigInt(packed.length), 12);
  }
  const version = zip64 ? 45 : 20;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(version, 4);
  central.writeUInt16LE(version, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(zip64 ? 0xffffffff : packed.length, 20);
  central.writeUInt32LE(zip64 ? 0xffffffff : raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(extra.length, 30);
  central.writeUInt32LE(directory ? 0x10 : 0, 38);
  central.writeUInt32LE(offset, 42);
  return { local: Buffer.concat([local, name, packed]), central: Buffer.concat([central, name, extra]) };
}

/** The zip64 end record and its locator, for a directory of `count` records at `offset`. */
function zip64Tail(count: number, directorySize: number, offset: number): Buffer {
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12);
  record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(count), 24);
  record.writeBigUInt64LE(BigInt(count), 32);
  record.writeBigUInt64LE(BigInt(directorySize), 40);
  record.writeBigUInt64LE(BigInt(offset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(offset + directorySize), 8);
  locator.writeUInt32LE(1, 16);
  return Buffer.concat([record, locator]);
}

export function buildZip(entries: ZipEntry[], options: { zip64?: boolean } = {}): Buffer {
  const zip64 = Boolean(options.zip64);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const { local, central } = records(entry, offset, zip64);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  const tail = zip64 ? [zip64Tail(entries.length, directory.length, offset)] : [];
  return Buffer.concat([...locals, directory, ...tail, end]);
}
