import { describe, expect, it } from 'vitest';
import { ChannelCapabilityError } from '../adapter.js';
import { MAX_TAGS } from '../html/sanitize.js';
import { EmailChannelAdapter, MissingSenderError, toEmailInboundMessage } from './email-adapter.js';
import type { InboundEmail, InboundEnvelope } from './inbound/inbound-email.js';

const email = (overrides: Partial<InboundEmail> = {}): InboundEmail => ({
  messageId: 'reply@example.com',
  inReplyTo: 'sent@helpdock.test',
  references: ['root@helpdock.test'],
  from: { address: 'mona@example.com', name: 'Mona' },
  to: [{ address: 'support@helpdock.test', name: 'Support' }],
  cc: [{ address: 'karim@example.com', name: null }],
  subject: 'Re: [HD-1042] Refund',
  date: new Date('2026-09-15T10:00:00Z'),
  html: '<p>Thanks<img src="https://x.example/p.gif"></p>',
  text: 'Thanks',
  headers: new Map([['authentication-results', ['mx; spf=fail']]]),
  attachments: [],
  ...overrides,
});

const envelope = (overrides: Partial<InboundEmail> = {}): InboundEnvelope => ({
  email: email(overrides),
  recipients: ['support@helpdock.test'],
});

describe('toEmailInboundMessage (M2-01)', () => {
  const at = new Date('2026-09-15T10:01:00Z');

  it('produces the channel-neutral message and the email facts beside it', () => {
    const message = toEmailInboundMessage(envelope(), at);

    expect(message).toMatchObject({
      channel: 'email',
      externalId: 'reply@example.com',
      from: { kind: 'email', value: 'mona@example.com', name: 'Mona' },
      subject: 'Re: [HD-1042] Refund',
      bodyHtml: '<p>Thanks</p>',
      receivedAt: at,
      hints: {
        messageIds: ['sent@helpdock.test', 'root@helpdock.test'],
        ticketNumbers: [{ prefix: 'HD', number: 1042 }],
      },
    });
    expect(message.cc.map((cc) => cc.value)).toEqual([
      'support@helpdock.test',
      'karim@example.com',
    ]);
    expect(message.email.authFailed).toBe(true);
    expect(message.email.automated).toBeNull();
    expect(message.email.body.remoteImages).toHaveLength(1);
    expect(message.email.recipients).toEqual(['support@helpdock.test']);
  });

  it('refuses a message with no sender', () => {
    expect(() => toEmailInboundMessage(envelope({ from: null }), at)).toThrow(MissingSenderError);
  });

  it('falls back to the text of a body too nested to sanitise', () => {
    const message = toEmailInboundMessage(
      envelope({ html: '<b>'.repeat(MAX_TAGS + 1), text: 'Plain words' }),
      at,
    );

    expect(message.bodyHtml).toBe('<p>Plain words</p>');
  });
});

describe('EmailChannelAdapter', () => {
  it('normalises through handleInbound, stamped with its clock', async () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const adapter = new EmailChannelAdapter({ now: () => at });

    await adapter.init();
    expect(adapter.kind).toBe('email');
    expect((await adapter.handleInbound(envelope())).receivedAt).toBe(at);
    expect(await adapter.health()).toEqual({ state: 'healthy', detail: null });
  });

  it('refuses to send until M2-05 wires the outbound half', async () => {
    await expect(new EmailChannelAdapter().send()).rejects.toBeInstanceOf(ChannelCapabilityError);
  });
});
