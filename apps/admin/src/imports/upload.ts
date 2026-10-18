import type { ImportFileUploadRequest } from '@helpdock/schemas';
import { type PutObject, UploadError, type UploadProgress } from '../media/upload.js';
import type { ImportsApi } from './api.js';

/** Reuses the media PUT driver for progress, cancellation and signed headers without API credentials. */
export async function uploadImportSource(
  input: {
    api: ImportsApi;
    brandId: string;
    runId: string;
    file: File;
    source:
      | Pick<
          Extract<ImportFileUploadRequest, { format: 'csv' }>,
          'format' | 'entity' | 'inventoryMapping'
        >
      | { format: 'bundle' };
    onProgress?: (progress: UploadProgress) => void;
    signal?: AbortSignal;
  },
  put: PutObject = input.api.putFile,
) {
  input.signal?.throwIfAborted();
  const upload = await input.api.uploadFile(input.brandId, input.runId, {
    ...input.source,
    fileName: input.file.name,
    size: input.file.size,
  });
  try {
    input.signal?.throwIfAborted();
    const status = await put({
      url: upload.url,
      headers: upload.headers,
      body: input.file,
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (status < 200 || status >= 300)
      throw new UploadError('upload_failed', 'The source upload was refused', status);
    return await input.api.confirmFile(input.brandId, input.runId, upload.file.id);
  } catch (error) {
    try {
      await input.api.discardFile(input.brandId, input.runId, upload.file.id);
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'import.upload-cleanup-failed');
    }
    throw error;
  }
}
