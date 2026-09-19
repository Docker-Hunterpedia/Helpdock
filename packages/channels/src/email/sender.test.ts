import { describe, expect, it, vi } from 'vitest';
import { type EmailMessage, LoggingEmailSender } from './sender.js';

const message = (subject: string): EmailMessage => ({
  to: { address: 'lina@helpdock.com', name: 'Lina' },
  subject,
  text: 'Sign in: https://support.example.com/api/auth/magic-link/SECRET-TOKEN',
  html: '<a href="https://support.example.com/api/auth/magic-link/SECRET-TOKEN">Sign in</a>',
  locale: 'en',
});

describe('LoggingEmailSender', () => {
  it('records what it was asked to send', async () => {
    const sender = new LoggingEmailSender({ log: vi.fn() });

    await sender.send(message('Your sign-in link'));

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.subject).toBe('Your sign-in link');
  });

  it('logs the envelope and never the body, which carries a working credential', async () => {
    const log = vi.fn();
    const sender = new LoggingEmailSender({ log });

    await sender.send(message('Your sign-in link'));

    const [fields, line] = log.mock.calls[0] ?? [];
    expect(fields).toEqual({
      to: 'lina@helpdock.com',
      subject: 'Your sign-in link',
      locale: 'en',
    });
    expect(JSON.stringify([fields, line])).not.toContain('SECRET-TOKEN');
  });

  it('keeps only the most recent messages, so a long run does not grow without bound', async () => {
    const sender = new LoggingEmailSender({ log: vi.fn(), keep: 2 });

    for (const subject of ['first', 'second', 'third']) {
      await sender.send(message(subject));
    }

    expect(sender.sent.map((sent) => sent.subject)).toEqual(['second', 'third']);
  });
});
