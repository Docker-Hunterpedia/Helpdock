import { describe, expect, it } from 'vitest';
import {
  authenticationFailed,
  automatedReason,
  threadHintsOf,
  ticketTokensIn,
} from './classify.js';
import type { InboundEmail } from './inbound-email.js';

const email = (
  headers: Record<string, string[]> = {},
  overrides: Partial<InboundEmail> = {},
): InboundEmail => ({
  messageId: 'm@example.com',
  inReplyTo: null,
  references: [],
  from: { address: 'mona@example.com', name: null },
  to: [],
  cc: [],
  subject: '',
  date: null,
  html: null,
  text: '',
  headers: new Map(Object.entries(headers)),
  attachments: [],
  ...overrides,
});

describe('automatedReason (DOMAIN-RULES §4.3)', () => {
  it('lets a person through', () => {
    expect(automatedReason(email())).toBeNull();
    expect(automatedReason(email({ 'auto-submitted': ['no'] }))).toBeNull();
  });

  it.each([
    [{ 'auto-submitted': ['auto-replied'] }, 'auto-submitted'],
    [{ 'auto-submitted': ['auto-generated'] }, 'auto-submitted'],
    [{ precedence: ['bulk'] }, 'precedence'],
    [{ precedence: ['List'] }, 'precedence'],
    [{ precedence: ['junk'] }, 'precedence'],
    [{ 'list-id': ['<news.example.com>'] }, 'list'],
    [{ 'list-unsubscribe': ['<mailto:u@example.com>'] }, 'list'],
    [{ 'x-autoreply': ['yes'] }, 'auto-reply'],
    [{ 'x-autorespond': ['yes'] }, 'auto-reply'],
  ] as const)('reads %j as %s', (headers, reason) => {
    expect(automatedReason(email({ ...headers } as unknown as Record<string, string[]>))).toBe(
      reason,
    );
  });

  it.each(['noreply', 'no-reply', 'mailer-daemon', 'donotreply', 'postmaster'])(
    'treats %s@ as automated',
    (local) => {
      expect(
        automatedReason(email({}, { from: { address: `${local}@example.com`, name: null } })),
      ).toBe('automated-address');
    },
  );

  it('does not read Outlook’s X-Auto-Response-Suppress, which ordinary mail carries too', () => {
    expect(automatedReason(email({ 'x-auto-response-suppress': ['All'] }))).toBeNull();
  });
});

describe('authenticationFailed (M2-07)', () => {
  it.each([
    [{ 'authentication-results': ['mx.example; spf=fail smtp.mailfrom=a'] }],
    [{ 'authentication-results': ['mx.example; spf=softfail'] }],
    [{ 'authentication-results': ['mx.example; spf=pass; dkim=fail header.d=x'] }],
    [{ 'received-spf': ['Fail (domain does not designate)'] }],
    [{ 'received-spf': ['softfail'] }],
  ])('reports a failure in %j', (headers) => {
    expect(authenticationFailed(email(headers))).toBe(true);
  });

  it('ignores passes, neutral results and absent headers', () => {
    expect(authenticationFailed(email())).toBe(false);
    expect(
      authenticationFailed(email({ 'authentication-results': ['mx; spf=pass; dkim=pass'] })),
    ).toBe(false);
    expect(authenticationFailed(email({ 'received-spf': ['neutral'] }))).toBe(false);
  });
});

describe('thread hints (DOMAIN-RULES §4.3, part 1)', () => {
  it('reads every [PREFIX-N] token, upper-casing the prefix', () => {
    expect(ticketTokensIn('Re: [hd-1042] and [BILL-7] but not [X-1] or [HD-]')).toEqual([
      { prefix: 'HD', number: 1042 },
      { prefix: 'BILL', number: 7 },
    ]);
  });

  it('lists In-Reply-To first, then References newest first, once each', () => {
    const hints = threadHintsOf(
      email({}, { inReplyTo: 'b@x', references: ['a@x', 'b@x'], subject: '[HD-1]' }),
    );

    expect(hints.messageIds).toEqual(['b@x', 'a@x']);
    expect(hints.ticketNumbers).toEqual([{ prefix: 'HD', number: 1 }]);
  });
});
