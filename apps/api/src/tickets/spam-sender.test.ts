import { describe, expect, it } from 'vitest';
import { type IdentityRow, senderOf } from './spam-sender.js';

const at = (minute: number): Date => new Date(Date.UTC(2026, 8, 24, 10, minute));

const IDENTITIES: readonly IdentityRow[] = [
  { kind: 'visitor', value: '0199f4b2-0000-7000-8000-000000000001', createdAt: at(0) },
  { kind: 'telegram', value: '123456789', createdAt: at(1) },
  { kind: 'phone', value: '+15550100123', createdAt: at(2) },
  { kind: 'email', value: 'spam@promo-deals.biz', createdAt: at(3) },
];

describe('senderOf', () => {
  it('blocks the chat of a Telegram ticket, not the person everywhere', () => {
    expect(senderOf('telegram', IDENTITIES)).toEqual({ kind: 'telegram', value: '123456789' });
  });

  it('blocks the address of an email ticket', () => {
    expect(senderOf('email', IDENTITIES)).toEqual({
      kind: 'email',
      value: 'spam@promo-deals.biz',
    });
  });

  it('falls back to the phone number when a chat ticket has no address', () => {
    expect(
      senderOf(
        'chat',
        IDENTITIES.filter((row) => row.kind !== 'email'),
      ),
    ).toEqual({
      kind: 'phone',
      value: '+15550100123',
    });
  });

  it('prefers the address the contact was created with over one added later', () => {
    const two: IdentityRow[] = [
      { kind: 'email', value: 'later@example.com', createdAt: at(9) },
      { kind: 'email', value: 'first@example.com', createdAt: at(1) },
    ];

    expect(senderOf('manual', two)?.value).toBe('first@example.com');
  });

  it('never blocks a visitor id or an external id', () => {
    expect(
      senderOf('chat', [
        { kind: 'visitor', value: '0199f4b2-0000-7000-8000-000000000001', createdAt: at(0) },
        { kind: 'external', value: 'crm-42', createdAt: at(0) },
      ]),
    ).toBeNull();
  });
});
