import type { AttachmentUploaderType } from '@helpdock/schemas';
import type { Principal } from '../auth/principal.js';

/**
 * Who an upload belongs to, in the vocabulary of `attachments.uploader_*`.
 *
 * It is the same identity `linkAttachmentsToMessage` compares against, so it
 * has to be derived in exactly one place: the rule "whoever uploaded it is who
 * may attach it" is only worth anything if both halves compute the identity the
 * same way.
 *
 * A visitor is a `contact` here even before a contact row exists, because the
 * widget's uploads belong to the person on the other end of the conversation
 * and not to the desk. An api key and a worker are both `system`: neither is a
 * person, and both are distinguished by `uploader_id`.
 */
export interface Uploader {
  readonly type: AttachmentUploaderType;
  readonly id: string;
}

export const uploaderFor = (principal: Principal): Uploader => {
  switch (principal.type) {
    case 'staff':
      return { type: 'staff', id: principal.id };
    case 'visitor':
      return { type: 'contact', id: principal.id };
    case 'apikey':
      return { type: 'system', id: principal.id };
    case 'system':
      return { type: 'system', id: principal.jobId };
  }
};
