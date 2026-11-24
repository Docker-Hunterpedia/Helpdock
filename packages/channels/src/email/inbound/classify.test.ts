import { describe, expect, it } from 'vitest';
import {
  authenticationFailed,
  automatedReason,
  domainsAlign,
  type SenderCheck,
  senderCheck,
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

describe('senderCheck (DOMAIN-RULES §4.3, §4.4)', () => {
  const ar = (...values: string[]): Record<string, string[]> => ({
    'authentication-results': values,
  });
  type Row = readonly [
    string,
    readonly [Record<string, string[]>, Partial<InboundEmail>?, string?],
    SenderCheck,
  ];

  it.each([
    ['dmarc=pass', [ar('mx.example; dmarc=pass header.from=example.com')], 'aligned'],
    ['an aligned DKIM pass', [ar('mx.example; dkim=pass header.d=example.com')], 'aligned'],
    [
      'an aligned DKIM pass on a subdomain of the From domain',
      [ar('mx.example; dkim=pass header.d=mail.example.com')],
      'aligned',
    ],
    [
      'an aligned DKIM pass on the parent of a subdomain From',
      [ar('mx.example; dkim=pass header.d=example.com'), {}, 'mona@news.example.com'],
      'aligned',
    ],
    [
      'an aligned SPF pass, with the mailfrom as an address',
      [ar('mx.example; spf=pass smtp.mailfrom=bounce@example.com')],
      'aligned',
    ],
    [
      'SPF softfail with an aligned DKIM pass (forwarded mail)',
      [ar('mx.example; spf=softfail smtp.mailfrom=example.com; dkim=pass header.d=example.com')],
      'aligned',
    ],
    [
      'dmarc=fail even with SPF and DKIM passing for another domain',
      [
        ar(
          'mx.example; spf=pass smtp.mailfrom=evil.test; dkim=pass header.d=evil.test; dmarc=fail',
        ),
      ],
      'misaligned',
    ],
    [
      'passes that all belong to another domain, with no DMARC verdict',
      [ar('mx.example; spf=pass smtp.mailfrom=evil.test; dkim=pass header.d=evil.test')],
      'misaligned',
    ],
    ['an SPF fail', [ar('mx.example; spf=fail smtp.mailfrom=example.com')], 'misaligned'],
    ['an SPF softfail alone', [ar('mx.example; spf=softfail')], 'misaligned'],
    ['a DKIM fail', [ar('mx.example; dkim=fail header.d=example.com')], 'misaligned'],
    [
      'a Received-SPF fail',
      [{ 'received-spf': ['Fail (domain does not designate)'] }],
      'misaligned',
    ],
    ['no header at all', [{}], 'unknown'],
    [
      'none, neutral and temperror',
      [ar('mx.example; spf=none; dkim=neutral; dmarc=temperror')],
      'unknown',
    ],
    ['a pass that names no domain', [ar('mx.example; spf=pass')], 'unknown'],
    ['a malformed header', [ar('this is not; a report = at all;;')], 'unknown'],
    [
      'two headers, one aligned DKIM pass beating a failure in the other',
      [ar('relay.example; spf=fail', 'mx.example; dkim=pass header.d=example.com')],
      'aligned',
    ],
    [
      'two headers, a failure in one and nothing aligned in the other',
      [ar('relay.example; spf=pass smtp.mailfrom=example.com', 'mx.example; dkim=fail')],
      'misaligned',
    ],
    [
      'two headers, dmarc=fail in one beating dmarc=pass in the other',
      [ar('a.example; dmarc=pass', 'b.example; dmarc=fail')],
      'misaligned',
    ],
  ] satisfies Row[])('reads %s as %s', (_label, [headers, overrides, from], expected) => {
    const message = email(
      { ...headers },
      {
        ...(overrides ?? {}),
        ...(from === undefined ? {} : { from: { address: from, name: null } }),
      },
    );
    expect(senderCheck(message)).toBe(expected);
  });

  it('has no opinion on a message with no sender', () => {
    expect(senderCheck(email({}, { from: null }))).toBe('unknown');
  });
});

describe('domainsAlign', () => {
  it.each([
    ['example.com', 'example.com', true],
    ['mail.example.com', 'example.com', true],
    ['example.com', 'mail.example.com', true],
    ['Example.COM', 'example.com', true],
    ['badexample.com', 'example.com', false],
    ['example.com.evil.test', 'example.com', false],
    ['', 'example.com', false],
  ])('%s and %s: %s', (a, b, expected) => {
    expect(domainsAlign(a, b)).toBe(expected);
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
