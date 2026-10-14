import { describe, expect, it } from 'vitest';
import { importAttachmentsJob, importExtractJob, importFinishJob, importLoadJob } from './jobs.js';

describe('import job boundaries', () => {
  it.each([importExtractJob, importLoadJob, importAttachmentsJob, importFinishJob])(
    '%s accepts only run and brand IDs',
    (job) => {
      const payload = {
        brandId: '0192c3f0-0000-7000-8000-00000000000a',
        runId: '0192c3f0-0000-7000-8000-00000000000b',
      };
      expect(job.schema.parse(payload)).toEqual(payload);
      expect(job.schema.safeParse({ ...payload, credentials: 'secret' }).success).toBe(false);
      expect(job.schema.safeParse({ ...payload, runId: 'bad' }).success).toBe(false);
    },
  );
});
