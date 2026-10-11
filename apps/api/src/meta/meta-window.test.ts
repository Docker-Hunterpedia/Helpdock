import { describe, expect, it } from 'vitest';
import { closedWindowDetails, conversationWindow, windowClosedCode } from './meta-window.js';

const HOUR = 3_600_000;
const customerWrote = new Date('2026-10-10T08:00:00.000Z');
const at = (hours: number): Date => new Date(customerWrote.getTime() + hours * HOUR);

describe('conversationWindow', () => {
  it('reads the anchor from the conversation and the switch from the account', () => {
    const conversation = { lastInboundAt: customerWrote };

    expect(
      conversationWindow({
        conversation,
        account: { platform: 'messenger', humanAgentEnabled: true },
        personAuthored: true,
        now: at(72),
      }),
    ).toEqual({ state: 'human_agent', closesAt: at(168) });
    expect(
      conversationWindow({
        conversation,
        account: { platform: 'messenger', humanAgentEnabled: false },
        personAuthored: true,
        now: at(72),
      }),
    ).toEqual({ state: 'closed', closedAt: at(24) });
  });

  it('gives the assistant the 24 hours only, whatever the account’s switch says', () => {
    expect(
      conversationWindow({
        conversation: { lastInboundAt: customerWrote },
        account: { platform: 'instagram', humanAgentEnabled: true },
        personAuthored: false,
        now: at(25),
      }),
    ).toEqual({ state: 'closed', closedAt: at(24) });
  });

  it('is closed, with no instant, for a customer who never wrote', () => {
    expect(
      conversationWindow({
        conversation: { lastInboundAt: null },
        account: { platform: 'whatsapp', humanAgentEnabled: false },
        personAuthored: true,
        now: at(0),
      }),
    ).toEqual({ state: 'closed', closedAt: null });
  });
});

describe('windowClosedCode', () => {
  it('is WhatsApp’s code on WhatsApp and code 10 with its sub-code on the other two', () => {
    expect(windowClosedCode('whatsapp')).toBe('131047');
    expect(windowClosedCode('messenger')).toBe('10/2018278');
    expect(windowClosedCode('instagram')).toBe('10/2018278');
  });
});

describe('closedWindowDetails', () => {
  it('names the platform, the customer’s last message and when the window closed', () => {
    expect(
      closedWindowDetails(
        'whatsapp',
        { lastInboundAt: customerWrote },
        { state: 'closed', closedAt: at(24) },
      ),
    ).toEqual({
      platform: 'whatsapp',
      anchorAt: '2026-10-10T08:00:00.000Z',
      closedAt: '2026-10-11T08:00:00.000Z',
    });
  });

  it('says null for both instants when there was never a window', () => {
    expect(
      closedWindowDetails(
        'instagram',
        { lastInboundAt: null },
        { state: 'closed', closedAt: null },
      ),
    ).toEqual({ platform: 'instagram', anchorAt: null, closedAt: null });
  });
});
