import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Small, valid PDF and DOCX files built in memory, for the suites that ingest
 * them (`files.test.ts`, the api's knowledge integration test). Built rather
 * than checked in so a reader can see exactly what the file says.
 */

const escapePdf = (text: string): string => text.replace(/[\\()]/g, '\\$&');

/** A PDF with one page per entry, each page's lines in Helvetica. ASCII text only. */
export const minimalPdf = (pages: readonly (readonly string[])[]): Uint8Array => {
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((lines, index) => {
    const pageId = pageIds[index] ?? 0;
    const stream = [
      'BT /F1 12 Tf 14 TL 72 720 Td',
      ...lines.map((line) => `(${escapePdf(line)}) Tj T*`),
      'ET',
    ].join('\n');
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] =
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(body);
    body += `${id} 0 obj\n${objects[id] ?? ''}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    body += `${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, 'latin1'));
};

/** A Zip archive of stored (uncompressed) entries: enough for a DOCX. */
const zip = (entries: readonly { readonly name: string; readonly data: string }[]): Uint8Array => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data, 'utf8');
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
};

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** A DOCX of headings (`# Title`, `## Section`) and paragraphs, one entry each. */
export const minimalDocx = (lines: readonly string[]): Uint8Array => {
  const paragraphs = lines
    .map((line) => {
      const heading = /^(#{1,2})[ \t]+(\S.*)$/.exec(line);
      const style =
        heading === null ? '' : `<w:pPr><w:pStyle w:val="Heading${heading[1]?.length}"/></w:pPr>`;
      return `<w:p>${style}<w:r><w:t>${escapeXml(heading?.[2] ?? line)}</w:t></w:r></w:p>`;
    })
    .join('');
  const styles = [1, 2]
    .map(
      (level) =>
        `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/></w:style>`,
    )
    .join('');
  return zip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    {
      name: 'word/_rels/document.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    },
    {
      name: 'word/styles.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${W}">${styles}</w:styles>`,
    },
    {
      name: 'word/document.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${paragraphs}</w:body></w:document>`,
    },
  ]);
};

export interface CraftedEntry {
  readonly name: string;
  /** What the central directory says the entry unpacks to. */
  readonly declaredSize: number;
  /** The deflated bytes actually stored; none at all for an entry that is only declared. */
  readonly inflated?: Buffer;
}

/** One entry's local header and data, and its directory record, which may carry a file comment. */
const craftedEntry = (
  { name, declaredSize, inflated }: CraftedEntry,
  offset: number,
  comment = Buffer.alloc(0),
): { readonly local: Buffer; readonly central: Buffer } => {
  const label = Buffer.from(name);
  const stored = inflated === undefined ? Buffer.alloc(0) : deflateRawSync(inflated);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(label.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(inflated === undefined ? 0 : crc32(inflated), 16);
  central.writeUInt32LE(stored.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(label.length, 28);
  central.writeUInt16LE(comment.length, 32);
  central.writeUInt32LE(offset, 42);
  return {
    local: Buffer.concat([local, label, stored]),
    central: Buffer.concat([central, label, comment]),
  };
};

/** The classic end record; `diskNumber` is the field a ZIP64 marker can sit in without the count. */
const endRecord = (count: number, directory: Buffer, offset: number, diskNumber = 0): Buffer => {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(diskNumber, 4);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return end;
};

/** A ZIP whose directory says what a test needs it to say, which a real archiver never would. */
export const craftedZip = (entries: readonly CraftedEntry[]): Uint8Array => {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const { local, central } = craftedEntry(entry, offset);
    parts.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directory = Buffer.concat(centrals);
  return new Uint8Array(
    Buffer.concat([...parts, directory, endRecord(entries.length, directory, offset)]),
  );
};

/**
 * A ZIP whose classic directory is one harmless entry, while the ZIP64 directory
 * of `hidden` sits in that entry's file comment, behind a classic end record that
 * flags ZIP64 only in its disk number. A reader that judges ZIP64 by the entry
 * count alone verifies the harmless directory; JSZip follows the flag to the
 * hidden one.
 */
export const zip64SmuggledZip = (hidden: readonly CraftedEntry[]): Uint8Array => {
  const visible = { name: 'word/document.xml', declaredSize: 1, inflated: Buffer.from('x') };
  const { local, central: bare } = craftedEntry(visible, 0);
  const hiddenAt = local.length + bare.length;
  const hiddenDirectory = Buffer.concat(hidden.map((entry) => craftedEntry(entry, 0).central));

  const zip64End = Buffer.alloc(56);
  zip64End.writeUInt32LE(0x06064b50, 0);
  zip64End.writeUInt32LE(44, 4);
  zip64End.writeUInt32LE(hidden.length, 24);
  zip64End.writeUInt32LE(hidden.length, 32);
  zip64End.writeUInt32LE(hiddenDirectory.length, 40);
  zip64End.writeUInt32LE(hiddenAt, 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeUInt32LE(hiddenAt + hiddenDirectory.length, 8);
  locator.writeUInt32LE(1, 16);

  const comment = Buffer.concat([hiddenDirectory, zip64End, locator]);
  const directory = craftedEntry(visible, 0, comment).central;
  return new Uint8Array(
    Buffer.concat([local, directory, endRecord(1, directory, local.length, 0xffff)]),
  );
};
