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
 * cuts it with (`splitMetaText`, exported from `@helpdock/schemas` for this),
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
  /** Messages the text becomes; 0 for a reply that is only files. */
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

export const planMetaMessages = (
  body: string,
  attachments: readonly Attachment[],
  platform: MetaPlatform,
): MetaMessagePlan => {
  const textParts = splitMetaText(body, platform).length;
  // A file the pipeline refused never goes; the composer's chip already said so.
  const candidates = attachments.filter((attachment) => attachment.status !== 'rejected');
  const leftOut = candidates
    .filter((attachment) => leftOutByType(attachment, platform))
    .map((attachment): PlannedLeftOut => ({ name: attachment.originalName, reason: 'pdf-only' }));
  const files = candidates.length - leftOut.length;

  return { textParts, files, total: textParts + files, leftOut };
};
