/**
 * A minimal ZIP writer (PKWARE APPNOTE 6.3: local headers, central directory, UTF-8 names, deflate or store) for the
 * complete-project backup (decision D12). Built on Node's zlib, so no extra dependency. No ZIP64: an archive over
 * 4 GiB or 65,535 entries is refused rather than written incorrectly.
 */
import { crc32, deflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** Forward slashes, relative, no "..": callers pass reviewed project paths. */
  path: string;
  data: Buffer;
  modified: Date;
}

const LIMIT = 0xffffffff;

function dosTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function zip(entries: ZipEntry[]): Buffer {
  if (entries.length > 0xffff)
    throw new RangeError("Too many files for one archive.");
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    if (
      !entry.path ||
      entry.path.startsWith("/") ||
      entry.path.split("/").some((part) => part === ".." || part === "")
    )
      throw new RangeError("Invalid archive path.");
    const name = Buffer.from(entry.path, "utf8");
    const deflated = deflateRawSync(entry.data);
    const stored = deflated.length >= entry.data.length;
    const body = stored ? entry.data : deflated;
    const checksum = crc32(entry.data);
    const { time, date } = dosTime(entry.modified);
    if (entry.data.length > LIMIT || offset > LIMIT)
      throw new RangeError("The archive would exceed 4 GiB.");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // made by: MS-DOS/FAT attributes, 2.0
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(stored ? 0 : 8, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    parts.push(local, name, body);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  if (offset + directory.length > LIMIT)
    throw new RangeError("The archive would exceed 4 GiB.");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
