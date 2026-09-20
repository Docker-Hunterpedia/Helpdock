import { silentLogger } from '@helpdock/jobs';
import { describe, expect, it } from 'vitest';
import type { RealtimeBroadcast, RealtimeBroadcastInput } from '../realtime/broadcast.js';
import { fakeTx, type OutboxRow } from '../testing/media.js';
import {
  ATTACHMENT_EVENTS,
  createAttachmentReadyHandler,
  createAttachmentUploadedHandler,
  enqueueAttachmentReady,
  enqueueAttachmentUploaded,
  type MediaQueue,
} from './attachment-events.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const TICKET = '01937f5e-7e53-7000-8000-00000000000b';
const ATTACHMENT = '01937f5e-7e53-7000-8000-00000000000c';
const DEPARTMENT = '01937f5e-7e53-7000-8000-00000000000d';
const OUTBOX = '01937f5e-7e53-7000-8000-0000000000e1';

const recorder = (): RealtimeBroadcast & { emitted: RealtimeBroadcastInput[] } => {
  const emitted: RealtimeBroadcastInput[] = [];
  return { emitted, emit: async (input) => void emitted.push(input) };
};

const queueRecorder = (): MediaQueue & { added: { jobId: string; payload: unknown }[] } => {
  const added: { jobId: string; payload: unknown }[] = [];
  return { added, add: async (options) => void added.push(options) };
};

describe('enqueueing', () => {
  it('writes the uploaded event through the caller’s transaction', async () => {
    const written: OutboxRow[] = [];

    await enqueueAttachmentUploaded(fakeTx(written), BRAND, {
      attachmentId: ATTACHMENT,
      ticketId: TICKET,
    });

    // Through `tx`, so a confirm that rolls back queues nothing
    // (DOMAIN-RULES §6).
    expect(written).toEqual([
      {
        brandId: BRAND,
        event: ATTACHMENT_EVENTS.uploaded,
        payload: { attachmentId: ATTACHMENT, ticketId: TICKET },
      },
    ]);
  });

  it('writes the finished event with the status it settled on', async () => {
    const written: OutboxRow[] = [];

    await enqueueAttachmentReady(fakeTx(written), BRAND, {
      attachmentId: ATTACHMENT,
      ticketId: TICKET,
      departmentId: DEPARTMENT,
      status: 'ready',
    });

    expect(written[0]?.event).toBe(ATTACHMENT_EVENTS.ready);
    expect(written[0]?.payload).toMatchObject({ status: 'ready' });
  });

  it('refuses a payload that is not one, rather than storing a row nothing can read', () => {
    // Synchronously, before the insert: the caller is a bug, not a request.
    expect(() =>
      enqueueAttachmentReady(fakeTx([]), BRAND, {
        attachmentId: 'not-a-uuid',
        ticketId: TICKET,
        departmentId: DEPARTMENT,
        status: 'ready',
      }),
    ).toThrow();
  });
});

describe('the uploaded handler', () => {
  it('adds one media.process job, keyed by the attachment', async () => {
    const queue = queueRecorder();

    await createAttachmentUploadedHandler(queue)({
      outboxId: OUTBOX,
      brandId: BRAND,
      event: ATTACHMENT_EVENTS.uploaded,
      payload: { attachmentId: ATTACHMENT, ticketId: TICKET },
      tx: fakeTx([]),
      log: silentLogger,
    });

    // `jobId = attachmentId`, not the outbox id: a redelivery of the event —
    // which the outbox promises is possible — must not produce a second job.
    expect(queue.added).toEqual([
      { jobId: ATTACHMENT, payload: { brandId: BRAND, attachmentId: ATTACHMENT } },
    ]);
  });

  it('refuses an event whose payload is not one', async () => {
    await expect(
      createAttachmentUploadedHandler(queueRecorder())({
        outboxId: OUTBOX,
        brandId: BRAND,
        event: ATTACHMENT_EVENTS.uploaded,
        payload: { ticketId: TICKET },
        tx: fakeTx([]),
        log: silentLogger,
      }),
    ).rejects.toThrow();
  });
});

describe('the finished handler', () => {
  it('emits to the ticket room alone', async () => {
    const broadcast = recorder();

    await createAttachmentReadyHandler(broadcast)({
      outboxId: OUTBOX,
      brandId: BRAND,
      event: ATTACHMENT_EVENTS.ready,
      payload: {
        attachmentId: ATTACHMENT,
        ticketId: TICKET,
        departmentId: DEPARTMENT,
        status: 'ready',
      },
      tx: fakeTx([]),
      log: silentLogger,
    });

    // Not the department queue: a list row does not change when a thumbnail
    // appears, and whoever is reading the thread is in the ticket room.
    expect(broadcast.emitted).toHaveLength(1);
    expect(broadcast.emitted[0]?.rooms).toEqual([`ticket:${TICKET}`]);
    expect(broadcast.emitted[0]?.event).toBe('attachment:changed');
  });

  it('carries no cursor, because there is nothing for a client to replay', async () => {
    const broadcast = recorder();

    await createAttachmentReadyHandler(broadcast)({
      outboxId: OUTBOX,
      brandId: BRAND,
      event: ATTACHMENT_EVENTS.ready,
      payload: {
        attachmentId: ATTACHMENT,
        ticketId: TICKET,
        departmentId: DEPARTMENT,
        status: 'rejected',
      },
      tx: fakeTx([]),
      log: silentLogger,
    });

    expect(broadcast.emitted[0]?.seq).toBeNull();
    expect(broadcast.emitted[0]?.data).toMatchObject({ status: 'rejected' });
  });

  it('carries no URL, so nothing outlives the check that issued it', async () => {
    const broadcast = recorder();

    await createAttachmentReadyHandler(broadcast)({
      outboxId: OUTBOX,
      brandId: BRAND,
      event: ATTACHMENT_EVENTS.ready,
      payload: {
        attachmentId: ATTACHMENT,
        ticketId: TICKET,
        departmentId: DEPARTMENT,
        status: 'ready',
      },
      tx: fakeTx([]),
      log: silentLogger,
    });

    expect(Object.keys(broadcast.emitted[0]?.data as object).sort()).toEqual([
      'attachmentId',
      'brandId',
      'departmentId',
      'status',
      'ticketId',
    ]);
  });
});
