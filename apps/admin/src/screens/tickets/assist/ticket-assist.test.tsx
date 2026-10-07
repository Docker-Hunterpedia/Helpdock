import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { MockAssistApi } from '../../../assist/mock-api.js';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';
import {
  MOCK_TICKET_ARABIC,
  MOCK_TICKET_CLOSED,
  MOCK_TICKET_SIGN_IN,
  MockTicketsApi,
} from '../../../tickets/mock-api.js';

/**
 * M7-05, M7-08, M7-09 in the ticket view (`Admin/Ticket-AI`), against the
 * assist fixture: the Assist menu and what each item leaves above the
 * composer, the Suggested fields card, "Show redacted", the voice note's
 * transcript, the draft article dialog and the budget's hard stop.
 */

const wideViewport = (): void => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
};

const openTicket = async (
  ticketId: string,
  configure: (assist: MockAssistApi) => void = () => undefined,
) => {
  const apis = await signedInMockApis();
  const tickets = new MockTicketsApi();
  const assistApi = new MockAssistApi({ tickets, helpCenter: apis.helpCenter });
  configure(assistApi);
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    contactsApi: apis.contacts,
    ticketingApi: apis.ticketing,
    ticketsApi: tickets,
    uploader: apis.uploader,
    assistApi,
    initialEntries: [`/tickets/${ticketId}?view=all`],
  });
  await screen.findByRole('region', { name: 'Ticket header' });
  return { ...rendered, assistApi };
};

const openMenu = async (user: Awaited<ReturnType<typeof openTicket>>['user']) => {
  await user.click(await screen.findByRole('button', { name: 'Assist' }));
  return screen.findByRole('menu');
};

const composer = (): HTMLElement => screen.getByRole('form', { name: 'Reply or internal note' });

describe('agent assist in the ticket view', () => {
  beforeEach(wideViewport);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('suggests a reply with its sources, and Insert leaves the internal one out', async () => {
    const { user } = await openTicket(MOCK_TICKET_SIGN_IN);

    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Suggest reply' }));
    const card = await screen.findByRole('region', { name: 'Suggested reply' });

    expect(within(card).getByText('Internal')).toBeVisible();
    expect(within(card).getByText('removed on Insert')).toBeVisible();
    expect(within(card).getByText('AI log')).toBeVisible();
    await user.click(within(card).getByRole('button', { name: 'Insert' }));

    const body = within(composer()).getByRole('textbox', { name: 'Message' });
    await waitFor(() => {
      expect((body as HTMLTextAreaElement).value).toContain('[1] Refund timelines');
    });
    expect((body as HTMLTextAreaElement).value).not.toContain('[2]');
    expect(screen.queryByRole('region', { name: 'Suggested reply' })).toBeNull();
  });

  it('rewrites the draft in a tone, and replaces it only on "Replace text"', async () => {
    const { user } = await openTicket(MOCK_TICKET_SIGN_IN);
    const body = within(composer()).getByRole('textbox', { name: 'Message' });
    await user.type(body, 'refund went out on the 4th');

    const menu = await openMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: 'Rewrite tone' }));
    await user.click(await screen.findByRole('menuitem', { name: 'More formal' }));
    const card = await screen.findByRole('region', { name: 'Rewritten' });
    expect((body as HTMLTextAreaElement).value).toBe('refund went out on the 4th');

    await user.click(within(card).getByRole('button', { name: 'Replace text' }));
    expect((body as HTMLTextAreaElement).value).toBe(
      'Dear customer, refund went out on the 4th Thank you for your patience.',
    );
  });

  it('suggests fields on the details panel and takes one off when dismissed', async () => {
    const { user, assistApi } = await openTicket(MOCK_TICKET_SIGN_IN);

    await user.click(
      within(await openMenu(user)).getByRole('menuitem', {
        name: 'Suggest tags, priority, department',
      }),
    );
    const card = await screen.findByRole('region', { name: 'Suggested fields' });
    await user.click(within(card).getByRole('button', { name: 'Dismiss Department Billing' }));

    await waitFor(() => {
      expect(within(card).queryByRole('button', { name: /Department Billing/ })).toBeNull();
    });
    expect(assistApi.calls.at(-1)).toMatchObject({
      name: 'dismissSuggestion',
      args: { field: 'department' },
    });
  });

  it('shows what the model received when "Show redacted" is pressed', async () => {
    const { user } = await openTicket(MOCK_TICKET_SIGN_IN);

    const toggle = await screen.findByRole('button', { name: 'Show redacted' });
    expect(screen.getByText('2 items redacted before AI')).toBeVisible();
    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByText('[EMAIL_1]')).toBeVisible();
    expect(screen.getByText('[PHONE_1]')).toBeVisible();
  });

  it('shows a voice note’s transcript to staff', async () => {
    const { user } = await openTicket(MOCK_TICKET_ARABIC);

    await user.click(await screen.findByRole('button', { name: 'Transcript' }));

    expect(await screen.findByText(/Transcript · AI · Arabic · staff only/)).toBeVisible();
    expect(screen.getByText('وهل يجب أن أدفع رسوم جمارك عند الاستلام في برلين؟')).toBeVisible();
  });

  it('drafts an article from a closed ticket and sends it for approval', async () => {
    const { user, assistApi } = await openTicket(MOCK_TICKET_CLOSED);

    await user.click(
      within(await openMenu(user)).getByRole('menuitem', { name: /Draft article from ticket/ }),
    );
    const dialog = await screen.findByRole('dialog', { name: /Draft an article from/ });
    expect(await within(dialog).findByDisplayValue(/Customs and VAT/)).toBeVisible();
    await user.type(within(dialog).getByLabelText('Note for the reviewer (optional)'), 'VAT again');
    await user.click(within(dialog).getByRole('button', { name: 'Send for approval' }));

    expect(
      await screen.findByText('Sent for approval. Team Leaders will review it.'),
    ).toBeVisible();
    expect(assistApi.calls.at(-1)).toMatchObject({ name: 'propose', args: { note: 'VAT again' } });
  });

  it('keeps "Draft article" for a closed ticket and says why', async () => {
    const { user } = await openTicket(MOCK_TICKET_SIGN_IN);

    const item = within(await openMenu(user)).getByRole('menuitem', {
      name: /Draft article from ticket/,
    });

    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(within(item).getByText('Available once the ticket is closed')).toBeVisible();
  });

  it('says why a model call failed', async () => {
    const { user } = await openTicket(MOCK_TICKET_SIGN_IN, (assist) => {
      assist.failWith = 'provider-failed';
    });

    await user.click(
      within(await openMenu(user)).getByRole('menuitem', { name: 'Summarize ticket' }),
    );

    expect(
      await screen.findByText(
        'The AI provider did not answer. Try again; the attempt is in the AI log.',
      ),
    ).toBeVisible();
  });

  it('opens on the hard stop with every item disabled', async () => {
    const { user } = await openTicket(MOCK_TICKET_SIGN_IN, (assist) => {
      assist.budget = 'exceeded';
    });

    const menu = await openMenu(user);

    expect(within(menu).getByRole('alert')).toHaveTextContent(/AI budget reached/);
    expect(within(menu).getByRole('menuitem', { name: 'Suggest reply' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('draws no Assist button while the brand has assist off', async () => {
    await openTicket(MOCK_TICKET_SIGN_IN, (assist) => {
      assist.enabled = false;
    });

    await screen.findByRole('textbox', { name: 'Message' });
    expect(screen.queryByRole('button', { name: 'Assist' })).toBeNull();
  });
});
