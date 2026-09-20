import type { Attachment, AttachmentStatus } from '@helpdock/schemas';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RealtimeClient, RealtimeListener } from '../realtime/client.js';
import type { AttachmentUploader } from './upload.js';
import { isSettled, useAttachment } from './use-attachment.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const TICKET = '01937f5e-7e53-7000-8000-00000000000b';
const ATTACHMENT = '01937f5e-7e53-7000-8000-00000000000c';

/** Real timers, tiny gaps: fake timers and `waitFor` fight over the clock. */
const FAST = { startMs: 2, maxMs: 4, timeoutMs: 2_000 };

const row = (status: AttachmentStatus): Attachment => ({
  id: ATTACHMENT,
  ticketId: TICKET,
  messageId: null,
  uploaderType: 'staff',
  originalName: 'shot.png',
  mime: 'image/png',
  kind: 'image',
  size: 12,
  status,
  rejectReason: status === 'rejected' ? 'mime_mismatch' : null,
  scanStatus: 'skipped',
  variants: {},
  createdAt: new Date().toISOString(),
  processedAt: null,
});

/** Answers each status in turn and then repeats the last one for ever. */
const uploaderReturning = (...statuses: AttachmentStatus[]) => {
  const queue = [...statuses];
  const status = vi.fn(async () =>
    row(queue.length > 1 ? (queue.shift() as AttachmentStatus) : (queue[0] as AttachmentStatus)),
  );

  return { status, upload: vi.fn() } as unknown as AttachmentUploader & { status: typeof status };
};

const realtimeStub = () => {
  let listener: RealtimeListener | undefined;

  return {
    client: {
      subscribe: (next: RealtimeListener) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    } as unknown as RealtimeClient,
    notify: (attachmentId = ATTACHMENT) =>
      listener?.attachmentChanged?.({
        brandId: BRAND,
        ticketId: TICKET,
        departmentId: BRAND,
        attachmentId,
        status: 'ready',
      }),
    get subscribed(): boolean {
      return listener !== undefined;
    },
  };
};

const render = (
  uploader: AttachmentUploader,
  extras: {
    realtime?: RealtimeClient;
    initial?: Attachment;
    timing?: { startMs?: number; maxMs?: number; timeoutMs?: number };
  } = {},
) =>
  renderHook(() =>
    useAttachment({
      brandId: BRAND,
      ticketId: TICKET,
      attachmentId: ATTACHMENT,
      uploader,
      timing: FAST,
      ...extras,
    }),
  );

describe('isSettled', () => {
  it('calls a row the pipeline will not move again settled', () => {
    expect(isSettled(row('ready'))).toBe(true);
    expect(isSettled(row('rejected'))).toBe(true);
    expect(isSettled(row('infected'))).toBe(true);
  });

  it('keeps waiting on a row that is still moving, or is not there yet', () => {
    expect(isSettled(row('pending'))).toBe(false);
    expect(isSettled(row('processing'))).toBe(false);
    expect(isSettled(undefined)).toBe(false);
  });
});

describe('useAttachment', () => {
  it('never reads anything for a row that is already settled', async () => {
    const uploader = uploaderReturning('ready');

    const { result } = render(uploader, { initial: row('ready') });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(uploader.status).not.toHaveBeenCalled();
    expect(result.current.settling).toBe(false);
  });

  it('polls until the row settles, then stops', async () => {
    const uploader = uploaderReturning('processing', 'processing', 'ready');

    const { result } = render(uploader);

    await waitFor(() => expect(result.current.attachment?.status).toBe('ready'));

    const reads = uploader.status.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Nothing more once it has settled: a composer that kept polling a finished
    // attachment would poll for as long as the tab is open.
    expect(uploader.status.mock.calls.length).toBe(reads);
    expect(result.current.settling).toBe(false);
  });

  it('keeps polling through a failed read, because a failure is not a verdict', async () => {
    const status = vi
      .fn<() => Promise<Attachment>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(row('ready'));
    const uploader = { status, upload: vi.fn() } as unknown as AttachmentUploader;

    const { result } = render(uploader);

    await waitFor(() => expect(result.current.attachment?.status).toBe('ready'));
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('gives up after the deadline and says so, so a placeholder can offer a retry', async () => {
    const uploader = uploaderReturning('processing');

    const { result } = render(uploader, { timing: { startMs: 1, maxMs: 2, timeoutMs: 15 } });

    await waitFor(() => expect(result.current.timedOut).toBe(true));
    expect(result.current.settling).toBe(true);
  });

  it('re-reads at once when a frame arrives, rather than trusting the frame', async () => {
    // DOMAIN-RULES §7: the socket is a notification and REST is the truth. The
    // frame carries no variants and no URL, so it can only say "look again".
    const uploader = uploaderReturning('ready');
    const realtime = realtimeStub();

    const { result } = render(uploader, {
      realtime: realtime.client,
      timing: { startMs: 10_000, maxMs: 10_000, timeoutMs: 60_000 },
    });
    expect(realtime.subscribed).toBe(true);

    realtime.notify();

    // The first scheduled poll is ten seconds away, so anything that arrives
    // before then came from the frame.
    await waitFor(() => expect(result.current.attachment?.status).toBe('ready'));
  });

  it('ignores a frame about another attachment', async () => {
    const uploader = uploaderReturning('processing');
    const realtime = realtimeStub();

    render(uploader, {
      realtime: realtime.client,
      timing: { startMs: 10_000, maxMs: 10_000, timeoutMs: 60_000 },
    });

    realtime.notify('01937f5e-7e53-7000-8000-0000000000ff');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A thread with ten placeholders would otherwise re-read all ten every time
    // any one of them finished.
    expect(uploader.status).not.toHaveBeenCalled();
  });

  it('unsubscribes when it goes away', () => {
    const realtime = realtimeStub();

    const { unmount } = render(uploaderReturning('processing'), { realtime: realtime.client });
    unmount();

    expect(realtime.subscribed).toBe(false);
  });
});
