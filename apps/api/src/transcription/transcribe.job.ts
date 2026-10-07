import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type Ai, AiHttpError } from '@helpdock/ai';
import { attachments, type Db, type DbTransaction } from '@helpdock/db';
import {
  type AiTranscribePayload,
  aiTranscribeJob,
  type JobLogger,
  parseJobPayload,
} from '@helpdock/jobs';
import { type Job, UnrecoverableError } from 'bullmq';
import { eq } from 'drizzle-orm';
import { objectKeyBeside } from '../media/keys.js';
import type { ObjectStorage } from '../media/storage.js';
import { withTempDir } from '../media/temp-dir.js';
import { withSystemJob } from '../tenant/system-job.js';
import type { TranscriptionConfigReader } from './transcription-config.js';

/**
 * `ai.transcribe` (M7-09): a voice note to text, for the agents reading the
 * ticket.
 *
 * ```
 * system transaction   the attachment, if it still wants a transcript
 * no transaction       download the Opus variant (or the original), transcribe()
 * system transaction   transcript, language, status = done
 * ```
 *
 * A note the endpoint refuses outright (4xx) is `failed` and not retried; a
 * server error or an unreachable endpoint is retried by BullMQ, and the last
 * attempt leaves it `failed`. The transcript is never sent to the visitor.
 */

/** Whisper's own limit on one request. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export interface TranscribeDeps {
  readonly db: Db;
  readonly ai: Pick<Ai, 'transcribe'>;
  readonly storage: Pick<ObjectStorage, 'download'>;
  readonly config: TranscriptionConfigReader;
  readonly log: JobLogger;
}

const finish = (
  tx: DbTransaction,
  attachmentId: string,
  values: { status: 'done' | 'failed'; text?: string; language?: string | null },
) =>
  tx
    .update(attachments)
    .set({
      transcriptStatus: values.status,
      transcriptText: values.text ?? null,
      transcriptLanguage: values.language ?? null,
      transcribedAt: new Date(),
    })
    .where(eq(attachments.id, attachmentId));

export const runTranscription = async (
  deps: TranscribeDeps,
  payload: AiTranscribePayload,
  { jobId, lastAttempt }: { readonly jobId: string; readonly lastAttempt: boolean },
): Promise<'done' | 'failed' | 'skipped'> => {
  const inBrand = <T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> =>
    withSystemJob(deps.db, payload.brandId, `${aiTranscribeJob.name}:${jobId}`, fn);

  const row = await inBrand(async (tx) => {
    const [found] = await tx
      .select({
        ticketId: attachments.ticketId,
        s3Key: attachments.s3Key,
        variants: attachments.variants,
        mime: attachments.mime,
        transcriptStatus: attachments.transcriptStatus,
      })
      .from(attachments)
      .where(eq(attachments.id, payload.attachmentId))
      .limit(1);
    return found;
  });
  const config = await deps.config();
  if (
    row === undefined ||
    row.transcriptStatus === 'done' ||
    row.transcriptStatus === 'failed' ||
    config === null
  ) {
    return 'skipped';
  }

  const variant = row.variants.opus === undefined ? 'original' : 'opus';
  const mime = variant === 'opus' ? 'audio/ogg' : row.mime;
  try {
    const result = await withTempDir(async (dir) => {
      const file = path.join(dir, variant === 'opus' ? 'voice.ogg' : 'voice');
      await deps.storage.download(objectKeyBeside(row.s3Key, variant), file, MAX_AUDIO_BYTES);
      return deps.ai.transcribe({
        brandId: payload.brandId,
        ticketId: row.ticketId,
        config,
        audio: await readFile(file),
        fileName: variant === 'opus' ? 'voice.ogg' : 'voice.webm',
        mime,
      });
    });
    await inBrand((tx) =>
      finish(tx, payload.attachmentId, {
        status: 'done',
        text: result.text,
        language: result.language,
      }),
    );
    return 'done';
  } catch (error) {
    const refused = error instanceof AiHttpError && error.status >= 400 && error.status < 500;
    if (!refused && !lastAttempt) {
      throw error;
    }
    deps.log.warn({ attachmentId: payload.attachmentId, err: error }, 'transcription failed');
    await inBrand((tx) => finish(tx, payload.attachmentId, { status: 'failed' }));
    return 'failed';
  }
};

/** The `ai` queue's share for transcription; null for any other job. */
export const createTranscribeProcessor =
  (deps: TranscribeDeps) =>
  (job: Job): Promise<void> | null => {
    if (job.name !== aiTranscribeJob.name) {
      return null;
    }
    let payload: AiTranscribePayload;
    try {
      payload = parseJobPayload(aiTranscribeJob, job.data);
    } catch (error) {
      throw new UnrecoverableError(error instanceof Error ? error.message : 'invalid payload');
    }
    const attempts = job.opts.attempts ?? 1;
    return runTranscription(deps, payload, {
      jobId: job.id ?? job.name,
      lastAttempt: job.attemptsMade + 1 >= attempts,
    }).then((outcome) => {
      deps.log.info(
        { job: job.name, attachmentId: payload.attachmentId, outcome },
        'transcription',
      );
    });
  };
