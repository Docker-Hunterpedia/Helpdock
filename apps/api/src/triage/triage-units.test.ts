import type { DbTransaction } from '@helpdock/db';
import { silentLogger } from '@helpdock/jobs';
import { describe, expect, it } from 'vitest';
import {
  NoRequestContextError,
  RequestContext,
  runInRequestContext,
} from '../context/request-context.js';
import { inRequestTenant } from '../tenant/step-transactions.js';
import { transcriptionConfigFrom } from '../transcription/transcription-config.js';
import { createTranscriptionHandler } from '../transcription/transcription-events.js';
import { createTriageRequestedHandler } from './triage-events.js';

const brandId = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const uuid = (n: number) => `0192c3f0-1a2b-7c3d-8e4f-${String(n).padStart(12, '0')}`;

describe('the ai.triage_requested handler (M7-07)', () => {
  it('adds ai.classify under the outbox row’s id, with the brand from the event', async () => {
    const added: { jobId: string; name: string; payload: unknown }[] = [];
    const handler = createTriageRequestedHandler({
      add: async (job) => {
        added.push(job);
      },
    });

    await handler({
      outboxId: uuid(9),
      brandId,
      event: 'ai.triage_requested',
      payload: {
        ticketId: uuid(1),
        ruleId: uuid(2),
        runId: uuid(3),
        actionIndex: 0,
        mode: 'suggest',
        fields: ['priority'],
        chain: [uuid(2)],
      },
      tx: {} as DbTransaction,
      log: silentLogger,
    });

    expect(added).toEqual([
      {
        jobId: uuid(9),
        name: 'ai.classify',
        payload: expect.objectContaining({ brandId, mode: 'suggest', fields: ['priority'] }),
      },
    ]);
  });
});

describe('the transcription subscriber (M7-09)', () => {
  it('asks for nothing while the install has no endpoint, or for an attachment that failed', async () => {
    const added: string[] = [];
    const queue = { add: async ({ jobId }: { jobId: string }) => void added.push(jobId) };
    const context = {
      outboxId: uuid(9),
      brandId,
      event: 'attachment.ready',
      tx: {} as DbTransaction,
      log: silentLogger,
    };
    const ready = { attachmentId: uuid(4), ticketId: uuid(1), departmentId: uuid(5) };

    await createTranscriptionHandler(
      queue,
      async () => null,
    )({
      ...context,
      payload: { ...ready, status: 'ready' },
    });
    await createTranscriptionHandler(queue, async () => ({
      endpoint: 'https://whisper.test',
      model: 'whisper-1',
      apiKey: '',
    }))({ ...context, payload: { ...ready, status: 'rejected' } });

    expect(added).toEqual([]);
  });

  it('reads the endpoint from the settings, and treats an empty one as off', async () => {
    const values: Record<string, string> = {
      'transcription.endpoint': '',
      'transcription.model': 'whisper-1',
      'transcription.apiKey': 'k',
    };
    const settings = { get: async (key: string) => values[key] } as never;

    expect(await transcriptionConfigFrom(settings)()).toBeNull();
    values['transcription.endpoint'] = 'https://whisper.test/v1/audio/transcriptions';
    expect(await transcriptionConfigFrom(settings)()).toEqual({
      endpoint: 'https://whisper.test/v1/audio/transcriptions',
      model: 'whisper-1',
      apiKey: 'k',
    });
  });
});

describe('inRequestTenant', () => {
  it('refuses a route the interceptor gave no step context', () => {
    const context = new RequestContext({ requestId: 'r', method: 'POST', path: '/' });

    expect(() =>
      runInRequestContext(context, () => inRequestTenant({} as never, async () => 1)),
    ).toThrow(NoRequestContextError);
  });
});
