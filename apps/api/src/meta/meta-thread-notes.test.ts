import type { MetaEvent } from '@helpdock/channels';
import type { DbTransaction, MetaAccount, Ticket } from '@helpdock/db';
import { describe, expect, it, vi } from 'vitest';
import type { MetaEventContext } from './meta-inbound.service.js';
import {
  MetaThreadNotes,
  noteKeys,
  noteOutcome,
  REACTION_EMOJI_MAX_LENGTH,
  reactionNote,
  UNSENT_ID_PREFIX,
  unsentMessageId,
} from './meta-thread-notes.js';

const NOW = new Date('2026-10-11T08:00:00Z');
const tx = {} as DbTransaction;
const TICKET = { id: 'ticket-1', contactId: 'contact-1' } as Ticket;
const context = {
  tx,
  account: { id: 'account-1', brandId: 'brand-1', platform: 'messenger' } as MetaAccount,
  now: NOW,
} as MetaEventContext;

describe('noteKeys', () => {
  it('name the message a line is about, never the customer', () => {
    expect(noteKeys.unsupported('mid.1')).toBe('unsupported:mid.1');
    expect(noteKeys.unsent('mid.1')).toBe('unsent:mid.1');
    expect(noteKeys.reaction('mid.1', 'react', new Date(1_760_000_000_000))).toBe(
      'reaction:mid.1:react:1760000000000',
    );
    expect(noteKeys.edit('mid.1', 2)).toBe('edit:mid.1:2');
    expect(noteKeys.numberChanged('conversation-1', new Date(1_760_000_000_000))).toBe(
      'number:conversation-1:1760000000000',
    );
  });

  it('tell a reaction from its being taken back, so each is written once', () => {
    const at = new Date(1_760_000_000_000);

    expect(noteKeys.reaction('mid.1', 'react', at)).not.toBe(
      noteKeys.reaction('mid.1', 'unreact', at),
    );
  });

  it('cannot be a message’s own key, which never holds a colon', () => {
    for (const key of [noteKeys.unsupported('m'), noteKeys.unsent('m')]) {
      expect(key).not.toBe('m');
      expect(key).toContain(':');
    }
  });
});

describe('noteOutcome', () => {
  it.each([
    ['written', { outcome: 'handled' }],
    ['duplicate', { outcome: 'duplicate' }],
    ['no-open-ticket', { outcome: 'ignored', reason: 'no-open-ticket' }],
  ] as const)('counts a line that came out %s', (result, outcome) => {
    expect(noteOutcome(result)).toEqual(outcome);
  });
});

describe('reactionNote', () => {
  const reaction = (over: Partial<Extract<MetaEvent, { kind: 'reaction' }>> = {}) =>
    ({
      kind: 'reaction',
      platform: 'whatsapp',
      timestamp: new Date(1_760_000_000_000),
      customerId: 'US.1',
      messageId: 'wamid.1',
      action: 'react',
      emoji: '👍',
      ...over,
    }) as Extract<MetaEvent, { kind: 'reaction' }>;

  it('is the emoji, keyed by the message, the way and the time', () => {
    expect(reactionNote(reaction())).toEqual({
      line: { kind: 'reaction', emoji: '👍' },
      key: 'reaction:wamid.1:react:1760000000000',
    });
  });

  it('does not put the customer in the key', () => {
    expect(reactionNote(reaction({ customerId: 'US.13491208655302741918' })).key).not.toContain(
      'US.13491208655302741918',
    );
  });

  it('is a reaction taken back, whatever emoji it still names', () => {
    expect(reactionNote(reaction({ action: 'unreact', emoji: null })).line).toEqual({
      kind: 'reaction',
      emoji: null,
    });
    expect(reactionNote(reaction({ action: 'unreact', emoji: '👍' })).line).toEqual({
      kind: 'reaction',
      emoji: null,
    });
  });

  it('is a plain reaction when Meta named no emoji', () => {
    expect(reactionNote(reaction({ emoji: null })).line).toEqual({ kind: 'reactionPlain' });
    expect(reactionNote(reaction({ emoji: '' })).line).toEqual({ kind: 'reactionPlain' });
  });

  it('cuts a value that is not an emoji, between code points and never inside one', () => {
    const long = '👍'.repeat(100);

    const { line } = reactionNote(reaction({ emoji: long }));

    expect(line).toEqual({ kind: 'reaction', emoji: '👍'.repeat(REACTION_EMOJI_MAX_LENGTH) });
  });

  it('has no key when Meta gave the event no time, and is then written every time', () => {
    expect(reactionNote(reaction({ timestamp: null })).key).toBeNull();
  });
});

describe('MetaThreadNotes.write', () => {
  const harness = (setup: { open?: Ticket | undefined; seen?: boolean } = {}) => {
    const router = {
      openTicket: vi.fn(async () => ('open' in setup ? setup.open : TICKET)),
      writeSystemLine: vi.fn(async (_tx: unknown, _line: unknown) => 'line-id'),
    };
    const lifecycleReads = { localeForContact: vi.fn(async () => 'ar' as const) };
    const repository = { systemLineSeen: vi.fn(async () => setup.seen === true) };
    return {
      notes: new MetaThreadNotes({ router, lifecycleReads, repository } as never),
      router,
      lifecycleReads,
      repository,
    };
  };

  it('writes the line in the contact’s language under its key', async () => {
    const { notes, router, lifecycleReads } = harness();

    await expect(
      notes.write(context, 'ticket-1', { line: { kind: 'unsupported' }, key: 'unsupported:mid.1' }),
    ).resolves.toBe('written');

    expect(lifecycleReads.localeForContact).toHaveBeenCalledWith(tx, 'brand-1', 'contact-1');
    expect(router.writeSystemLine).toHaveBeenCalledExactlyOnceWith(tx, {
      ticket: TICKET,
      accountId: 'account-1',
      text: expect.stringContaining('لا يمكن'),
      externalMessageId: 'unsupported:mid.1',
    });
  });

  it('writes a line that has no key without one, every time', async () => {
    const { notes, router, repository } = harness();

    await notes.write(context, 'ticket-1', { line: { kind: 'unsupported' }, key: null });

    expect(repository.systemLineSeen).not.toHaveBeenCalled();
    expect(router.writeSystemLine.mock.calls[0]?.[1]).not.toHaveProperty('externalMessageId');
  });

  it('writes nothing for a key whose line is already in the brand, on whatever channel', async () => {
    const { notes, router, repository } = harness({ seen: true });

    await expect(
      notes.write(context, 'ticket-1', { line: { kind: 'unsupported' }, key: 'unsupported:mid.1' }),
    ).resolves.toBe('duplicate');

    expect(repository.systemLineSeen).toHaveBeenCalledWith(tx, 'brand-1', 'unsupported:mid.1');
    expect(router.writeSystemLine).not.toHaveBeenCalled();
  });

  it('writes nothing where the conversation has no ticket, or its ticket is closed or spam', async () => {
    const none = harness();
    await expect(
      none.notes.write(context, null, { line: { kind: 'unsupported' }, key: 'k' }),
    ).resolves.toBe('no-open-ticket');
    expect(none.router.openTicket).not.toHaveBeenCalled();

    const closed = harness({ open: undefined });
    await expect(
      closed.notes.write(context, 'ticket-1', { line: { kind: 'unsupported' }, key: 'k' }),
    ).resolves.toBe('no-open-ticket');
    expect(closed.router.writeSystemLine).not.toHaveBeenCalled();
  });
});

describe('unsentMessageId', () => {
  it('reads the mid back out of the key the unsent line was written with, and nothing else', () => {
    expect(unsentMessageId(noteKeys.unsent('m_abc'))).toBe('m_abc');
    expect(unsentMessageId('m_abc')).toBeNull();
    expect(unsentMessageId(UNSENT_ID_PREFIX)).toBeNull();
    expect(noteKeys.unsent('m_abc').startsWith(UNSENT_ID_PREFIX)).toBe(true);
  });
});
