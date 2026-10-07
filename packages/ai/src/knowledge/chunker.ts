import { createHash } from 'node:crypto';
import { detectLocale, type KnowledgeLocale } from './locale.js';

/**
 * The chunker (M7-03, ARCHITECTURE §10: "by headings, ~500 tokens, overlap
 * 60"; [ADR 0020](../../../../docs/decisions/0020-knowledge-chunking-and-fusion.md)).
 *
 * Every loader — article, file, page, Notion, Drive — hands over an
 * {@link ExtractedDocument}: a title and one or more parts (a PDF page, or the
 * whole text), each in a light Markdown where a line opening with `#` is a
 * heading. The chunker then:
 *
 * 1. splits each part at its headings into sections, keeping the path of
 *    headings above each one (`Billing › Refunds`);
 * 2. cuts each section into units — paragraphs, then sentences of a paragraph
 *    too long for one chunk, then runs of words of a sentence too long still;
 * 3. packs units greedily into chunks of at most {@link CHUNK_MAX_TOKENS},
 *    starting each chunk after the first of a section with the last
 *    {@link CHUNK_OVERLAP_TOKENS} of the one before it, so a sentence that
 *    answers a question is never only half in a chunk.
 *
 * A chunk never crosses a heading or a part: a heading changes the subject,
 * and a page number is a citation. Each chunk's text opens with its heading
 * path, which the reader and the model both use for context.
 *
 * Tokens are estimated, not counted: every model family tokenises
 * differently and the budget only has to keep a chunk well inside any
 * embedding model's input. A word counts one token per four characters,
 * at least one.
 */

export const CHUNK_MAX_TOKENS = 500;
export const CHUNK_OVERLAP_TOKENS = 60;

export interface DocumentPart {
  /** Markdown-ish text: `#` lines are headings, blank lines separate paragraphs. */
  readonly text: string;
  /** Carried into every chunk of the part, for example `{ page: 3 }`. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface ExtractedDocument {
  readonly title: string;
  readonly parts: readonly DocumentPart[];
}

export interface Chunk {
  readonly ordinal: number;
  readonly content: string;
  readonly contentHash: string;
  readonly tokenCount: number;
  readonly locale: KnowledgeLocale;
  readonly meta: Readonly<Record<string, unknown>>;
}

export interface ChunkOptions {
  readonly maxTokens?: number;
  readonly overlapTokens?: number;
}

const CHARS_PER_TOKEN = 4;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const SENTENCE_END = /(?<=[.!?؟。])\s+/u;

const wordTokens = (word: string): number => Math.max(1, Math.ceil(word.length / CHARS_PER_TOKEN));

export const estimateTokens = (text: string): number =>
  text
    .split(/\s+/)
    .filter((word) => word !== '')
    .reduce((sum, word) => sum + wordTokens(word), 0);

export const hashText = (text: string): string => createHash('sha256').update(text).digest('hex');

interface Section {
  readonly headings: readonly string[];
  readonly body: string;
}

const sectionsOf = (text: string): Section[] => {
  const sections: Section[] = [];
  const path: string[] = [];
  let lines: string[] = [];

  const flush = (): void => {
    const body = lines.join('\n').trim();
    if (body !== '') {
      sections.push({ headings: [...path], body });
    }
    lines = [];
  };

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = HEADING.exec(line);
    if (heading === null) {
      lines.push(line);
      continue;
    }
    flush();
    const level = heading[1]?.length ?? 1;
    path.length = Math.min(path.length, level - 1);
    path.push(heading[2] ?? '');
  }
  flush();
  return sections;
};

/** Cuts a run of words into pieces of at most `max` tokens. */
const wordRuns = (text: string, max: number): string[] => {
  const runs: string[] = [];
  let run: string[] = [];
  let tokens = 0;
  for (const word of text.split(/\s+/).filter((candidate) => candidate !== '')) {
    const cost = wordTokens(word);
    if (tokens + cost > max && run.length > 0) {
      runs.push(run.join(' '));
      run = [];
      tokens = 0;
    }
    run.push(word);
    tokens += cost;
  }
  if (run.length > 0) {
    runs.push(run.join(' '));
  }
  return runs;
};

const unitsOf = (body: string, max: number): string[] =>
  body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .flatMap((paragraph) =>
      estimateTokens(paragraph) <= max
        ? [paragraph]
        : paragraph
            .split(SENTENCE_END)
            .flatMap((sentence) =>
              estimateTokens(sentence) <= max ? [sentence] : wordRuns(sentence, max),
            ),
    );

/** The tail of the previous chunk that opens the next one: whole units, else the last words. */
const overlapOf = (units: readonly string[], budget: number): string[] => {
  const tail: string[] = [];
  let tokens = 0;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index] ?? '';
    const cost = estimateTokens(unit);
    if (tokens + cost > budget) {
      if (tail.length === 0) {
        const words = unit.split(/\s+/);
        const kept: string[] = [];
        let used = 0;
        for (let word = words.length - 1; word >= 0; word -= 1) {
          used += wordTokens(words[word] ?? '');
          if (used > budget) {
            break;
          }
          kept.unshift(words[word] ?? '');
        }
        if (kept.length > 0) {
          tail.push(kept.join(' '));
        }
      }
      break;
    }
    tail.unshift(unit);
    tokens += cost;
  }
  return tail;
};

const packSection = (
  section: Section,
  title: string,
  maxTokens: number,
  overlapTokens: number,
): { content: string; headings: readonly string[] }[] => {
  const path = section.headings.length > 0 ? section.headings : title === '' ? [] : [title];
  const prefix = path.length > 0 ? `${path.join(' › ')}\n\n` : '';
  const budget = Math.max(1, maxTokens - estimateTokens(prefix));
  const units = unitsOf(section.body, budget);
  const chunks: { content: string; headings: readonly string[] }[] = [];

  let current: string[] = [];
  let tokens = 0;
  let fresh = 0;
  for (const unit of units) {
    const cost = estimateTokens(unit);
    if (tokens + cost > budget && fresh > 0) {
      chunks.push({ content: prefix + current.join('\n\n'), headings: path });
      current = overlapOf(current, Math.min(overlapTokens, budget - cost));
      tokens = current.reduce((sum, kept) => sum + estimateTokens(kept), 0);
      fresh = 0;
    }
    current.push(unit);
    tokens += cost;
    fresh += 1;
  }
  if (fresh > 0) {
    chunks.push({ content: prefix + current.join('\n\n'), headings: path });
  }
  return chunks;
};

export const chunkDocument = (
  document: ExtractedDocument,
  { maxTokens = CHUNK_MAX_TOKENS, overlapTokens = CHUNK_OVERLAP_TOKENS }: ChunkOptions = {},
): Chunk[] => {
  const chunks: Chunk[] = [];
  for (const part of document.parts) {
    for (const section of sectionsOf(part.text)) {
      for (const piece of packSection(section, document.title, maxTokens, overlapTokens)) {
        chunks.push({
          ordinal: chunks.length,
          content: piece.content,
          contentHash: hashText(piece.content),
          tokenCount: estimateTokens(piece.content),
          locale: detectLocale(piece.content),
          meta: { ...part.meta, headings: piece.headings },
        });
      }
    }
  }
  return chunks;
};
