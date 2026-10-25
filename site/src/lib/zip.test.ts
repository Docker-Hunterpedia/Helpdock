import { crc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createZip } from './zip.ts';

/** Reads a zip back through its central directory, as an unzip tool does. */
function readZip(bytes: Uint8Array): Map<string, string> {
  const zip = Buffer.from(bytes);
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  const files = new Map<string, string>();
  for (let i = 0; i < count; i += 1) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    const checksum = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26);
    const data = inflateRawSync(zip.subarray(dataStart, dataStart + compressedSize));
    expect(crc32(data)).toBe(checksum);
    files.set(name, data.toString('utf8'));
    cursor += 46 + nameLength;
  }
  return files;
}

describe('createZip', () => {
  it('writes entries an unzip tool reads back byte for byte, UTF-8 names included', () => {
    const files = readZip(
      createZip([
        { path: 'helpdock/SKILL.md', content: '# Helpdock\n' },
        { path: 'helpdock/references/مرحبا.md', content: 'نص عربي' },
      ]),
    );
    expect(Object.fromEntries(files)).toEqual({
      'helpdock/SKILL.md': '# Helpdock\n',
      'helpdock/references/مرحبا.md': 'نص عربي',
    });
  });

  it('gives the same bytes for the same files, so a rebuild changes nothing', () => {
    const entries = [{ path: 'a.md', content: 'same' }];
    expect(createZip(entries)).toEqual(createZip(entries));
  });

  it('writes an empty archive that is still a valid zip', () => {
    expect(readZip(createZip([])).size).toBe(0);
  });
});
