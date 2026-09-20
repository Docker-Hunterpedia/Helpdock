import type { Attachment as AttachmentRow, DbTransaction } from '@helpdock/db';
import { DEFAULT_CONTENT_POLICY } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { attachmentRow } from '../testing/media.js';
import { AttachmentLinkError, linkAttachmentsToMessage } from './link.js';
import type { MediaRepository } from './media.repository.js';

const TICKET = '01937f5e-7e53-7000-8000-00000000000b';
const MESSAGE = '01937f5e-7e53-7000-8000-00000000000f';
const AGENT = '01937f5e-7e53-7000-8000-000000000001';
const OTHER_AGENT = '01937f5e-7e53-7000-8000-000000000002';

const id = (n: number): string => `01937f5e-7e53-7000-8000-00000000${String(n).padStart(4, '0')}`;

/**
 * A whole row, not a partial one: every field the column list has. A cast over
 * five fields would hide a renamed column behind a type assertion, and the two
 * fields these rules turn on — `uploader_id` and `status` — are exactly the
 * kind that get renamed.
 */
const attachment = (overrides: Partial<AttachmentRow> = {}): AttachmentRow =>
  attachmentRow({ id: id(1), ticketId: TICKET, uploaderId: AGENT, status: 'ready', ...overrides });

/**
 * A repository that answers from a list. The rules under test are the ones in
 * `link.ts`, and a Postgres would only make them slower to read; the statements
 * themselves are proved in `media.integration.test.ts`.
 */
const attached: { messageId: string; ticketId: string }[] = [];

const repository = (rows: AttachmentRow[], moved?: number) =>
  ({
    claimable: async (_tx: DbTransaction, ticketId: string, ids: readonly string[]) =>
      rows.filter(
        (row) => row.ticketId === ticketId && row.messageId === null && ids.includes(row.id),
      ),
    attachToMessage: async (
      _tx: DbTransaction,
      target: { messageId: string; ticketId: string },
      ids: readonly string[],
    ) => {
      attached.push(target);
      return moved ?? ids.length;
    },
  }) as unknown as MediaRepository;

const tx = {} as DbTransaction;

const link = (
  rows: AttachmentRow[],
  ids: string[],
  options: {
    moved?: number;
    policy?: typeof DEFAULT_CONTENT_POLICY;
    uploaderId?: string;
    landingTicketId?: string;
  } = {},
) =>
  linkAttachmentsToMessage(
    tx,
    {
      ticketId: TICKET,
      messageId: MESSAGE,
      attachmentIds: ids,
      policy: options.policy ?? DEFAULT_CONTENT_POLICY,
      uploaderType: 'staff',
      uploaderId: options.uploaderId ?? AGENT,
      ...(options.landingTicketId === undefined
        ? {}
        : { landingTicketId: options.landingTicketId }),
    },
    repository(rows, options.moved),
  );

describe('linkAttachmentsToMessage', () => {
  it('does nothing for a message with no attachments', async () => {
    await expect(link([], [])).resolves.toBe(0);
  });

  it('links what the uploader uploaded against this ticket', async () => {
    const rows = [attachment({ id: id(1) }), attachment({ id: id(2), status: 'pending' })];

    await expect(link(rows, [id(1), id(2)])).resolves.toBe(2);
  });

  it('counts a repeated id once, so a double-click does not spend the brand’s allowance', async () => {
    await expect(link([attachment({ id: id(1) })], [id(1), id(1), id(1)])).resolves.toBe(1);
  });

  it('refuses more than the brand allows per message', async () => {
    const rows = Array.from({ length: 6 }, (_, index) => attachment({ id: id(index + 1) }));
    const ids = rows.map((row) => row.id);

    await expect(link(rows, ids)).rejects.toMatchObject({
      name: 'AttachmentLinkError',
      problem: 'too_many',
    });
  });

  it('honours a brand that allows more, and one that allows none', async () => {
    const rows = Array.from({ length: 6 }, (_, index) => attachment({ id: id(index + 1) }));
    const generous = { ...DEFAULT_CONTENT_POLICY, maxAttachmentsPerMessage: 6 };
    const none = { ...DEFAULT_CONTENT_POLICY, maxAttachmentsPerMessage: 0 };

    await expect(
      link(
        rows,
        rows.map((row) => row.id),
        { policy: generous },
      ),
    ).resolves.toBe(6);
    await expect(link(rows, [id(1)], { policy: none })).rejects.toMatchObject({
      problem: 'too_many',
    });
  });

  it('refuses an attachment uploaded by somebody else', async () => {
    // Two agents composing on one ticket cannot take each other's drafts.
    const rows = [attachment({ id: id(1), uploaderId: OTHER_AGENT })];

    await expect(link(rows, [id(1)])).rejects.toMatchObject({ problem: 'not_yours' });
  });

  it('refuses an attachment uploaded by a visitor when staff is composing', async () => {
    const rows = [attachment({ id: id(1), uploaderType: 'contact', uploaderId: AGENT })];

    await expect(link(rows, [id(1)])).rejects.toMatchObject({ problem: 'not_yours' });
  });

  it('refuses an attachment that belongs to another ticket', async () => {
    const rows = [attachment({ id: id(1), ticketId: '01937f5e-7e53-7000-8000-0000000000ff' })];

    // The same answer as "no such attachment": distinguishing them would
    // confirm that a row on a ticket the caller cannot read exists.
    await expect(link(rows, [id(1)])).rejects.toMatchObject({ problem: 'not_found' });
  });

  it('refuses an id nothing matches', async () => {
    await expect(link([], [id(9)])).rejects.toMatchObject({ problem: 'not_found' });
  });

  it('refuses an attachment already attached to a message', async () => {
    const rows = [attachment({ id: id(1), messageId: '01937f5e-7e53-7000-8000-0000000000aa' })];

    await expect(link(rows, [id(1)])).rejects.toMatchObject({ problem: 'not_found' });
  });

  it.each(['rejected', 'infected'] as const)('refuses an attachment that is %s', async (status) => {
    // The two the pipeline will never move out of.
    await expect(link([attachment({ id: id(1), status })], [id(1)])).rejects.toMatchObject({
      problem: 'not_usable',
    });
  });

  it('leaves an attachment on its own ticket when the reply stayed there', async () => {
    attached.length = 0;

    await link([attachment({ id: id(1) })], [id(1)]);

    expect(attached).toEqual([{ messageId: MESSAGE, ticketId: TICKET }]);
  });

  it('moves it to the continuation the reply landed on (M1-08, §2.3)', async () => {
    // The uploads were made against the closed ticket and the message was
    // written to the ticket that continues it. An attachment left behind would
    // be on a different ticket from the message that renders it.
    const continuation = '01937f5e-7e53-7000-8000-0000000000c0';
    attached.length = 0;

    await link([attachment({ id: id(1) })], [id(1)], { landingTicketId: continuation });

    expect(attached).toEqual([{ messageId: MESSAGE, ticketId: continuation }]);
  });

  it('allows one that is still processing, which is the normal case', async () => {
    // A composer that had to wait for the worker before the reply could go
    // would be a composer that waits on ffmpeg. The thread shows a placeholder.
    await expect(link([attachment({ id: id(1), status: 'processing' })], [id(1)])).resolves.toBe(1);
  });

  it('refuses the whole send when another transaction claimed one first', async () => {
    // Refusing beats committing a message that is short an attachment somebody
    // believes they sent with it.
    const rows = [attachment({ id: id(1) }), attachment({ id: id(2) })];

    await expect(link(rows, [id(1), id(2)], { moved: 1 })).rejects.toMatchObject({
      problem: 'already_attached',
    });
  });

  it('carries a key rather than a sentence, so the admin renders a translated string', async () => {
    const error = await link([], [id(9)]).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AttachmentLinkError);
    expect((error as AttachmentLinkError).problem).toBe('not_found');
  });
});
