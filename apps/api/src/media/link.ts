import type { DbTransaction } from '@helpdock/db';
import type { AttachmentUploaderType, ContentPolicy } from '@helpdock/schemas';
import { MediaRepository } from './media.repository.js';

/**
 * Attaching uploads to the message they were composed with (M1-10), called from
 * the message-create path in `tickets/tickets.service.ts`.
 *
 * It is here rather than there because the rules are the media pipeline's, and
 * it is a plain function rather than a service because it has to run *inside*
 * the transaction that inserts the message: a message that commits without its
 * attachments is a message with holes in it, and attachments that commit
 * without their message are rows nothing renders.
 *
 * Four rules, and each one refuses rather than skipping. A request that names
 * an attachment it may not have gets an error, never a message that quietly
 * dropped it — the person would send it believing the file was there.
 *
 * 1. **The count is the brand's.** `maxAttachmentsPerMessage`, from the same
 *    content policy the presign endpoint enforced (REQUIREMENTS §4.6).
 * 2. **The ticket is the same one.** An attachment uploaded against ticket A
 *    cannot be attached to a message on ticket B, even by someone who may read
 *    both — otherwise an upload's department scope would be decided twice.
 * 3. **The uploader is the same principal.** Whoever uploaded it is who may
 *    attach it. Two agents composing on one ticket cannot take each other's
 *    drafts.
 * 4. **The state allows it.** Everything except `rejected` and `infected`,
 *    which are the two the pipeline will never move out of. An attachment that
 *    is still `processing` may be sent — it is the normal state a second after
 *    the upload is confirmed, and a composer that had to wait for the worker
 *    before the reply could go would be a composer that waits on ffmpeg. The
 *    thread renders a placeholder until `attachment.ready` arrives.
 */

/** Why a link was refused. A key, so the api answers a translated string. */
export type AttachmentLinkProblem =
  | 'too_many'
  | 'not_found'
  | 'not_yours'
  | 'already_attached'
  | 'not_usable';

export class AttachmentLinkError extends Error {
  readonly problem: AttachmentLinkProblem;

  constructor(problem: AttachmentLinkProblem, message: string) {
    super(message);
    this.name = 'AttachmentLinkError';
    this.problem = problem;
  }
}

export interface LinkAttachmentsInput {
  /** The ticket the uploads were made against, which is where they are found. */
  readonly ticketId: string;
  /**
   * The ticket the message was actually written to. The two differ when a
   * customer's reply to a closed ticket landed on a continuation of it
   * (DOMAIN-RULES §2.3, M1-08): the uploads are on the closed parent and the
   * message is on the continuation, so the rows are moved across with it.
   * Defaults to {@link LinkAttachmentsInput.ticketId}.
   *
   * A continuation is created in the same brand and department as the ticket it
   * continues, so the denormalised `department_id` the policy reads stays true
   * without the move having to touch it.
   */
  readonly landingTicketId?: string;
  readonly messageId: string;
  readonly attachmentIds: readonly string[];
  readonly policy: ContentPolicy;
  /** The principal composing the message, as `attachments.uploader_*` records it. */
  readonly uploaderType: AttachmentUploaderType;
  readonly uploaderId: string;
}

/**
 * Points the named attachments at `messageId`, or throws. Returns how many rows
 * it moved, which is always `attachmentIds.length` when it returns at all.
 */
export const linkAttachmentsToMessage = async (
  tx: DbTransaction,
  input: LinkAttachmentsInput,
  repository: MediaRepository = new MediaRepository(),
): Promise<number> => {
  const requested = [...new Set(input.attachmentIds)];
  if (requested.length === 0) {
    return 0;
  }

  if (requested.length > input.policy.maxAttachmentsPerMessage) {
    throw new AttachmentLinkError(
      'too_many',
      `This brand allows ${input.policy.maxAttachmentsPerMessage} attachments per message`,
    );
  }

  // Unclaimed rows on this ticket that this transaction can see. Anything
  // missing from the answer is missing for one of three reasons, and the reads
  // below tell them apart so the caller learns which.
  const rows = await repository.claimable(tx, input.ticketId, requested);
  const byId = new Map(rows.map((row) => [row.id, row]));

  for (const id of requested) {
    const row = byId.get(id);
    if (row === undefined) {
      // A row on another ticket, in another department, already attached, or
      // never there at all. They are one answer on purpose: distinguishing them
      // would confirm that an attachment on a ticket the caller cannot read
      // exists (DOMAIN-RULES §1.2).
      throw new AttachmentLinkError('not_found', 'No such attachment on this ticket');
    }
    if (row.uploaderType !== input.uploaderType || row.uploaderId !== input.uploaderId) {
      throw new AttachmentLinkError('not_yours', 'That attachment was uploaded by somebody else');
    }
    if (row.status === 'rejected' || row.status === 'infected') {
      throw new AttachmentLinkError('not_usable', 'That attachment cannot be sent');
    }
  }

  const moved = await repository.attachToMessage(
    tx,
    { messageId: input.messageId, ticketId: input.landingTicketId ?? input.ticketId },
    requested,
  );
  if (moved !== requested.length) {
    // Another transaction claimed one between the read above and this write.
    // Refusing beats sending a message that is short an attachment.
    throw new AttachmentLinkError(
      'already_attached',
      'That attachment was attached to another message',
    );
  }

  return moved;
};
