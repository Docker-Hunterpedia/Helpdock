import {
  type Attachment,
  META_ATTACHMENT_LIMITS,
  type MetaPlatform,
  splitMetaText,
} from '@helpdock/schemas';

/**
 * How many messages a reply becomes on a platform (M10-08, DESIGN §6.3
 * Composer, Meta mode): the text in the parts the platform accepts, then one
 * message per file. The text is cut by the very function the `meta.send` job
 * cuts it with (`splitMetaText`, in `@helpdock/schemas` for this), after the
 * same opening line the job puts first ("Lina · Helpdock", `metaOpeningLine`),
 * so the count under the textarea and the parts that go cannot disagree.
 *
 * What is *not* decided here is the planner's answer about files. The api
 * decides which file a platform takes (`planOutgoingFile`), and the delivery's
 * `leftOut` is what it decided; this only names the one case DESIGN has the
 * composer warn about before Send, a file that is not a PDF on a platform that
 * takes PDF alone (Instagram), because the guide states that rule outright and
 * an agent who sees it before sending can pick another file.
 */

export interface PlannedLeftOut {
  readonly name: string;
  /** The platform sends PDF files only. */
  readonly reason: 'pdf-only';
}

export interface MetaMessagePlan {
  /** Messages the text becomes, the opening line included; 0 for nothing to send. */
  readonly textParts: number;
  /** Files that will go, each as a message of its own. */
  readonly files: number;
  readonly total: number;
  readonly leftOut: readonly PlannedLeftOut[];
}

/** A document the platform does not list among the types it takes as a file (Instagram: PDF only). */
const leftOutByType = (attachment: Attachment, platform: MetaPlatform): boolean => {
  const accepted = META_ATTACHMENT_LIMITS[platform].fileTypes;

  return accepted !== null && attachment.kind === 'file' && !accepted.includes(attachment.mime);
};

/**
 * The text as the job sends it (`replyTextParts` in the api): the opening line,
 * a newline and the words, cut at the platform's limit, the line counting toward
 * it and only the first message carrying it. A reply that is only files is the
 * line alone, as a message of its own, so the customer still sees who wrote.
 * Nothing at all (no words, no files) is nothing to send.
 */
export const replyTextParts = (
  words: string,
  platform: MetaPlatform,
  openingLine: string,
  hasFiles: boolean,
): string[] => {
  const trimmed = words.trim();
  if (trimmed === '' && !hasFiles) {
    return [];
  }
  if (openingLine === '') {
    return splitMetaText(trimmed, platform);
  }

  return splitMetaText(trimmed === '' ? openingLine : `${openingLine}\n${trimmed}`, platform);
};

export const planMetaMessages = ({
  body,
  attachments,
  platform,
  openingLine,
}: {
  readonly body: string;
  readonly attachments: readonly Attachment[];
  readonly platform: MetaPlatform;
  /** "Lina · Helpdock", or '' while the brand's name has not been read. */
  readonly openingLine: string;
}): MetaMessagePlan => {
  // A file the pipeline refused never goes; the composer's chip already said so.
  const candidates = attachments.filter((attachment) => attachment.status !== 'rejected');
  const leftOut = candidates
    .filter((attachment) => leftOutByType(attachment, platform))
    .map((attachment): PlannedLeftOut => ({ name: attachment.originalName, reason: 'pdf-only' }));
  const files = candidates.length - leftOut.length;
  const textParts = replyTextParts(body, platform, openingLine, candidates.length > 0).length;

  return { textParts, files, total: textParts + files, leftOut };
};
