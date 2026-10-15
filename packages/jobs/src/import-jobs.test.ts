import { describe, expect, it } from 'vitest';
import {
  importAttachmentsJob,
  importExtractJob,
  importFinishJob,
  importLoadJob,
  importRecoverJob,
} from './jobs.js';

describe('import job boundaries', () => {
  it('keeps the global recovery tick free of tenant IDs and credentials', () => {
    expect(importRecoverJob.schema.parse({})).toEqual({});
    expect(importRecoverJob.schema.safeParse({ credentials: 'secret' }).success).toBe(false);
    expect(
      importRecoverJob.schema.safeParse({ brandId: '0192c3f0-0000-7000-8000-00000000000a' })
        .success,
    ).toBe(false);
  });
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
