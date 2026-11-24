/**
 * Minimal zip writer for tests, so archives (including malicious ones a normal zip tool
 * refuses to make: "../" names, absolute paths, symlinks, duplicates, lying size
 * headers) are built in the test instead of committed as binaries.
 *
 *   writeZip(file, [{ name: 'run_1/run.json', data: '{...}' }, { name: '../evil.png', data }])
 *
 * Entry options: name (written verbatim), data (Buffer|string), mode (unix mode incl.
 * file type, default 0o100644; 0o120777 makes a symlink whose target is `data`),
 * deflate (default true for files), declaredSize (overrides the uncompressed size header).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DOS_TIME = 0;
const DOS_DATE = (2026 - 1980) << 9 | 11 << 5 | 24;

export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const isDir = entry.name.endsWith('/');
    const raw = isDir ? Buffer.alloc(0) : Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const deflate = !isDir && entry.deflate !== false && raw.length > 0;
    const body = deflate ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32(raw);
    const size = entry.declaredSize ?? raw.length;
    const mode = entry.mode ?? (isDir ? 0o40755 : 0o100644);
    const method = deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(((mode << 16) | (isDir ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export function writeZip(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildZip(entries));
  return file;
}

/**
 * Entries for every file under `dir`, named `<prefix>/<relative path>` like
 * actions/upload-artifact names them (forward slashes, no directory entries).
 */
export function folderEntries(dir, prefix = '') {
  const out = [];
  const walk = (abs, rel) => {
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(path.join(abs, d.name), childRel);
      else if (d.isFile()) out.push({ name: prefix ? `${prefix}/${childRel}` : childRel, data: fs.readFileSync(path.join(abs, d.name)) });
    }
  };
  walk(dir, '');
  return out;
}
