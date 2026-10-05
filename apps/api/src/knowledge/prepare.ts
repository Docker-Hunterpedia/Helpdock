import {
  type Chunk,
  chunkDocument,
  type ExtractedDocument,
  estimateTokens,
  hashText,
  screenIngestedText,
} from '@helpdock/ai';

/**
 * A document on its way into `knowledge_chunks` (M7-03): chunked, and every
 * chunk passed through the injection filter of M7-08 while the brand has it
 * on. A line that reads like an instruction to the model is removed and the
 * chunk is flagged `suspicious`; the findings go to the sync log.
 *
 * The document's hash is over its title and text as loaded, before
 * screening, so the indexing key of DOMAIN-RULES §6 changes only when the
 * source does.
 */

export interface PreparedChunk extends Chunk {
  readonly suspicious: boolean;
}

export interface PreparedDocument {
  readonly contentHash: string;
  readonly chunks: readonly PreparedChunk[];
  /** The injection rules that matched, across every chunk. */
  readonly findings: readonly string[];
  readonly suspiciousChunks: number;
}

export const prepareDocument = (
  document: ExtractedDocument,
  { injectionFilter }: { readonly injectionFilter: boolean },
): PreparedDocument => {
  const contentHash = hashText(
    JSON.stringify([document.title, document.parts.map((part) => [part.text, part.meta ?? {}])]),
  );
  const findings = new Set<string>();
  const chunks = chunkDocument(document).flatMap((chunk): PreparedChunk[] => {
    if (!injectionFilter) {
      return [{ ...chunk, suspicious: false }];
    }
    const screened = screenIngestedText(chunk.content);
    for (const finding of screened.findings) {
      findings.add(finding);
    }
    const content = screened.text.trim();
    if (content === '') {
      return [];
    }
    return [
      {
        ...chunk,
        content,
        contentHash: hashText(content),
        tokenCount: estimateTokens(content),
        suspicious: screened.suspicious,
      },
    ];
  });

  return {
    contentHash,
    chunks: chunks.map((chunk, ordinal) => ({ ...chunk, ordinal })),
    findings: [...findings],
    suspiciousChunks: chunks.filter((chunk) => chunk.suspicious).length,
  };
};
