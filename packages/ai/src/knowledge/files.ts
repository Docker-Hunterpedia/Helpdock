import mammoth from 'mammoth';
import { extractText } from 'unpdf';
import type { ExtractedDocument } from './chunker.js';
import { htmlToText } from './html.js';

/**
 * Uploaded files into documents (M7-03): PDF through unpdf, one part per page
 * so a citation can name the page; DOCX through mammoth's HTML, so its
 * headings survive; Markdown and plain text as they are.
 *
 * The caller has already checked the bytes against the declared type
 * (`sniffKnowledgeFile`), so a parser here is only ever handed the format it
 * expects. A parser that still fails throws, and the sync records the reason.
 */

export const KNOWLEDGE_FILE_TYPES = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/markdown': 'md',
  'text/plain': 'txt',
} as const;

export type KnowledgeFileMime = keyof typeof KNOWLEDGE_FILE_TYPES;
export type KnowledgeFileType = (typeof KNOWLEDGE_FILE_TYPES)[KnowledgeFileMime];

export const isKnowledgeFileMime = (mime: string): mime is KnowledgeFileMime =>
  Object.hasOwn(KNOWLEDGE_FILE_TYPES, mime);

/** 25 MB, the cap the add-source dialog states. */
export const KNOWLEDGE_FILE_MAX_BYTES = 25 * 1024 * 1024;

/** A file name without its extension, for a title when the file has none of its own. */
const baseName = (fileName: string): string => fileName.replace(/\.[^.]+$/, '');

const firstHeading = (text: string): string | undefined =>
  /^#{1,6}[ \t]+(\S.*)$/m.exec(text)?.[1]?.trim();

const extractPdf = async (bytes: Uint8Array, fileName: string): Promise<ExtractedDocument> => {
  // A copy: pdf.js transfers the buffer it is given to its worker and detaches it.
  const { text } = await extractText(new Uint8Array(bytes), { mergePages: false });
  return {
    title: baseName(fileName),
    parts: text.map((page, index) => ({ text: page, meta: { page: index + 1 } })),
  };
};

const extractDocx = async (bytes: Uint8Array, fileName: string): Promise<ExtractedDocument> => {
  const { value } = await mammoth.convertToHtml(
    { buffer: Buffer.from(bytes) },
    { externalFileAccess: false },
  );
  const { text } = htmlToText(value);
  return { title: firstHeading(text) ?? baseName(fileName), parts: [{ text }] };
};

const extractPlain = (bytes: Uint8Array, fileName: string): ExtractedDocument => {
  const text = new TextDecoder('utf-8').decode(bytes);
  return { title: firstHeading(text) ?? baseName(fileName), parts: [{ text }] };
};

export const extractFile = (
  bytes: Uint8Array,
  mime: KnowledgeFileMime,
  fileName: string,
): Promise<ExtractedDocument> => {
  switch (KNOWLEDGE_FILE_TYPES[mime]) {
    case 'pdf':
      return extractPdf(bytes, fileName);
    case 'docx':
      return extractDocx(bytes, fileName);
    default:
      return Promise.resolve(extractPlain(bytes, fileName));
  }
};
