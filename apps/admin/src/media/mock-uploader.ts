import type { Attachment } from '@helpdock/schemas';
import type { AttachmentUploader, UploadAttachmentInput } from './upload.js';
import { kindOf } from './upload.js';

/**
 * The uploader the fixture and the browser suite run against, chosen by the
 * same `VITE_AUTH_API` switch as every other adapter.
 *
 * It is the pipeline's *timing* rather than its bytes: `upload` reports
 * progress and resolves at `processing`, exactly as the real one does, and
 * `status` answers `ready` from the second look onwards — so a composer that
 * only worked because its placeholder settled instantly cannot pass here.
 */
export class MockAttachmentUploader implements AttachmentUploader {
  readonly #rows = new Map<string, Attachment>();
  readonly #looks = new Map<string, number>();
  #sequence = 0;

  async upload({ ticketId, file, onProgress, signal }: UploadAttachmentInput): Promise<Attachment> {
    onProgress?.({ loaded: 0, total: file.size, ratio: 0 });
    await Promise.resolve();
    signal?.throwIfAborted();
    onProgress?.({ loaded: file.size, total: file.size, ratio: 1 });

    this.#sequence += 1;
    const attachment: Attachment = {
      id: `0192c3f0-1a2b-7c3d-8e4f-0000000a${String(this.#sequence).padStart(4, '0')}`,
      ticketId,
      messageId: null,
      uploaderType: 'staff',
      originalName: file.name,
      mime: file.type,
      kind: kindOf(file.type),
      size: file.size,
      status: 'processing',
      rejectReason: null,
      scanStatus: 'skipped',
      variants: {},
      createdAt: new Date().toISOString(),
      processedAt: null,
    };

    this.#rows.set(attachment.id, attachment);

    return attachment;
  }

  /** The row as this fixture holds it, for the ticket fixture to link. */
  row(attachmentId: string): Attachment | undefined {
    return this.#rows.get(attachmentId);
  }

  status(_brandId: string, _ticketId: string, attachmentId: string): Promise<Attachment> {
    const row = this.#rows.get(attachmentId);
    if (row === undefined) {
      return Promise.reject(new Error(`no such attachment: ${attachmentId}`));
    }

    const looks = (this.#looks.get(attachmentId) ?? 0) + 1;
    this.#looks.set(attachmentId, looks);
    if (looks < 2) {
      return Promise.resolve(row);
    }

    const ready: Attachment = {
      ...row,
      status: 'ready',
      scanStatus: 'clean',
      processedAt: new Date().toISOString(),
    };
    this.#rows.set(attachmentId, ready);

    return Promise.resolve(ready);
  }
}
