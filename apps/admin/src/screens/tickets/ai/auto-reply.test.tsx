import type { AiCallView, TicketAiState, TicketDetail, TicketMessage } from '@helpdock/schemas';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';
import { MOCK_TICKET_REFUND, MockTicketsApi } from '../../../tickets/mock-api.js';

/**
 * The auto-reply parts of `Admin/Ticket-AI` in the real ticket view (M7-06):
 * the answer with its badge, sources and AI log, the handoff System event,
 * the AIPausedStrip and "Return to assistant", and "AI on this ticket".
 */

const CALL = '0192c3f0-1a2b-7c3d-8e4f-0000000ca111';
const AT = '2026-10-05T09:12:00.000Z';

const aiMessage = (seq: number, fields: Partial<TicketMessage>): TicketMessage => ({
  id: `0192c3f0-1a2b-7c3d-8e4f-00000000a${String(seq).padStart(3, '0')}`,
  ticketId: MOCK_TICKET_REFUND,
  seq,
  clientId: null,
  kind: 'ai',
  authorType: 'ai',
  authorId: 'ai:auto_reply',
  bodyHtml: '',
  bodyText: '',
  channel: 'chat',
  attachments: [],
  createdAt: AT,
  ...fields,
});

const answer = aiMessage(100, {
  bodyText: 'Card refunds take 3 to 5 days [1].\n\nSources\n[1] Refund timelines',
  ai: {
    kind: 'answer',
    answer: 'Card refunds take 3 to 5 days [1].',
    callId: CALL,
    model: 'claude-haiku-4-5',
    confidence: 0.86,
    threshold: 0.7,
    citations: [
      {
        marker: 1,
        title: 'Refund timelines',
        url: 'https://help.example.com/r',
        visibility: 'public',
      },
    ],
    reason: null,
    feedback: 'helpful',
  },
});
const paused = aiMessage(101, {
  kind: 'system',
  authorType: 'system',
  bodyText: 'Handed off to a person · confidence 0.42 below 0.70',
  ai: {
    kind: 'paused',
    answer: null,
    callId: null,
    model: null,
    confidence: 0.42,
    threshold: 0.7,
    citations: [],
    reason: 'low_confidence',
    feedback: null,
  },
});

const call: AiCallView = {
  id: CALL,
  feature: 'auto_reply',
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  status: 'ok',
  tokensIn: 1842,
  tokensOut: 236,
  costUsd: 0.0031,
  latencyMs: 900,
  createdAt: AT,
  prompt: null,
  response: null,
  redactions: [{ placeholder: '[PHONE_1]', kind: 'phone', original: '079 123 4567' }],
  sources: ['a', 'b', 'c', 'd'],
  error: null,
  bodiesPurgedAt: null,
};

/** The fixture with the refund ticket answered by the assistant and then handed off. */
class AssistedTickets extends MockTicketsApi {
  state: TicketAiState = { pausedAt: AT, pausedUntil: null, reason: 'low_confidence' };
  readonly resumed = vi.fn();

  override async ticket(brandId: string, ticketId: string): Promise<TicketDetail> {
    const detail = await super.ticket(brandId, ticketId);
    if (ticketId !== MOCK_TICKET_REFUND) {
      return detail;
    }
    return {
      ...detail,
      ticket: { ...detail.ticket, ai: this.state },
      messages: {
        ...detail.messages,
        messages: [...detail.messages.messages, answer, paused],
      },
    };
  }

  override async resumeAssistant(brandId: string, ticketId: string): Promise<TicketAiState> {
    this.resumed(ticketId);
    this.state = await super.resumeAssistant(brandId, ticketId);
    return this.state;
  }
}

const open = async (tickets: AssistedTickets) => {
  tickets.seedAiCalls(MOCK_TICKET_REFUND, [call]);
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    contactsApi: apis.contacts,
    ticketingApi: apis.ticketing,
    ticketsApi: tickets,
    initialEntries: [`/tickets/${MOCK_TICKET_REFUND}?view=all`],
  });
  await screen.findByRole('heading', { name: /Refund for order 42/ });
  return rendered;
};

describe('auto-reply in the ticket view (M7-06, Admin/Ticket-AI)', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('draws the answer named and badged, with its cited source and its AI log', async () => {
    await open(new AssistedTickets());
    const thread = screen.getByRole('list', { name: 'Conversation' });

    expect(within(thread).getByText(/Assistant · auto-reply/)).toBeVisible();
    expect(within(thread).getAllByText('AI').length).toBeGreaterThan(0);
    expect(within(thread).getByRole('link', { name: 'Source 1, Refund timelines' })).toBeVisible();
    const sources = within(thread).getByRole('list', { name: 'Sources' });
    expect(within(sources).getByText('Public')).toBeVisible();
    await waitFor(() =>
      expect(within(thread).getByText(/claude-haiku-4-5 · \$0\.0031 · 0\.86/)).toBeVisible(),
    );
    expect(within(thread).getByText('1842 in · 236 out')).toBeInTheDocument();
    expect(within(thread).getByText('0.86 · threshold 0.70')).toBeInTheDocument();
  });

  it('says why the assistant handed off as a System event', async () => {
    await open(new AssistedTickets());
    const thread = screen.getByRole('list', { name: 'Conversation' });

    expect(
      within(thread).getByText('Handed off to a person · confidence 0.42 below 0.70'),
    ).toBeVisible();
  });

  it('shows the paused strip, and "Return to assistant" ends the pause', async () => {
    const tickets = new AssistedTickets();
    const { user } = await open(tickets);
    const strip = screen.getByText('Assistant paused').closest('[role="status"]') as HTMLElement;
    expect(within(strip).getByText('Assistant paused')).toBeVisible();

    await user.click(within(strip).getByRole('button', { name: 'Return to assistant' }));

    expect(tickets.resumed).toHaveBeenCalledWith(MOCK_TICKET_REFUND);
    await waitFor(() => expect(screen.queryByText('Assistant paused')).toBeNull());
  });

  it('totals the AI log in "AI on this ticket"', async () => {
    await open(new AssistedTickets());
    const card = await screen.findByRole('region', { name: 'AI on this ticket' });

    expect(within(card).getByText('2,078')).toBeVisible();
    expect(within(card).getByText('$0.0031')).toBeVisible();
  });
});
