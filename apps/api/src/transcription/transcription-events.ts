import { attachments } from '@helpdock/db';
import {
  aiTranscribeJob,
  type OutboxEventContext,
  type OutboxEventHandler,
  registerEventHandler,
} from '@helpdock/jobs';
import { and, eq, isNull } from 'drizzle-orm';
import { ATTACHMENT_EVENTS, attachmentReadyPayloadSchema } from '../media/attachment-events.js';
import type { TranscriptionConfigReader } from './transcription-config.js';

/**
 * M7-09's subscriber of `attachment.ready`: a voice note that finished
 * processing, on an install with a transcription endpoint, is marked
 * `pending` and handed to the `ai.transcribe` job. The mark is written in the
 * handler's transaction and the job id is the attachment's, so a redelivered
 * event neither adds a second job nor asks twice.
 */

export const TRANSCRIPTION_SUBSCRIBER = 'transcription';

export interface TranscribeQueue {
  add(options: {
    jobId: string;
    payload: { brandId: string; attachmentId: string };
  }): Promise<void>;
}

export const transcribeJobId = (attachmentId: string): string =>
  `${aiTranscribeJob.name}:${attachmentId}`;

export const createTranscriptionHandler =
  (queue: TranscribeQueue, config: TranscriptionConfigReader): OutboxEventHandler =>
  async ({ brandId, payload, tx }: OutboxEventContext): Promise<void> => {
    const ready = attachmentReadyPayloadSchema.parse(payload);
    if (ready.status !== 'ready' || (await config()) === null) {
      return;
    }
    const marked = await tx
      .update(attachments)
      .set({ transcriptStatus: 'pending' })
      .where(
        and(
          eq(attachments.id, ready.attachmentId),
          eq(attachments.kind, 'audio'),
          isNull(attachments.transcriptStatus),
        ),
      )
      .returning({ id: attachments.id });
    if (marked.length === 0) {
      return;
    }
    await queue.add({
      jobId: transcribeJobId(ready.attachmentId),
      payload: { brandId, attachmentId: ready.attachmentId },
    });
  };

export const registerTranscriptionHandlers = (
  queue: TranscribeQueue,
  config: TranscriptionConfigReader,
): void => {
  registerEventHandler(
    ATTACHMENT_EVENTS.ready,
    createTranscriptionHandler(queue, config),
    TRANSCRIPTION_SUBSCRIBER,
  );
};
