import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import { MOCK_TICKET_ARABIC, MOCK_TICKET_REFUND } from '../../tickets/mock-api.js';
import { offersBlock } from './mark-spam-dialog.tsx';

/**
 * "Mark as spam" and "Not spam" in the ticket workspace (M1-11), against the
 * fixture pair `createApis` builds — so a block made here is the block the
 * Spam tab lists.
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
  prepare: (apis: Awaited<ReturnType<typeof signedInMockApis>>) => Promise<unknown> = () =>
    Promise.resolve(),
) => {
  const apis = await signedInMockApis();
  await prepare(apis);
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    contactsApi: apis.contacts,
    ticketingApi: apis.ticketing,
    ticketsApi: apis.tickets,
    uploader: apis.uploader,
    initialEntries: [`/tickets/${ticketId}?view=all`],
  });

  await screen.findByRole('region', { name: 'Ticket header' });

  return { ...rendered, apis };
};

describe('the ticket header menu', () => {
  beforeEach(wideViewport);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks a ticket as spam and blocks its sender in one step', async () => {
    const { user, apis } = await openTicket(MOCK_TICKET_REFUND);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Mark as spam' }));

    const dialog = await screen.findByRole('dialog', { name: 'Mark HD-1042 as spam?' });
    const block = await within(dialog).findByRole('checkbox', { name: /Block mona@example.com/ });
    expect(block).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Mark as spam' }));

    expect(
      await screen.findByText('Marked as spam and blocked mona@example.com'),
    ).toBeInTheDocument();
    expect((await apis.tickets.ticket('brand', MOCK_TICKET_REFUND)).ticket.status.isSpam).toBe(
      true,
    );
    const listed = (await apis.ticketing.blockedSenders('brand')).senders;
    expect(listed.find((row) => row.value === 'mona@example.com')).toMatchObject({
      kind: 'email',
      sourceTicketId: MOCK_TICKET_REFUND,
    });
  });

  it('marks without blocking when the box is unticked', async () => {
    const { user, apis } = await openTicket(MOCK_TICKET_REFUND);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Mark as spam' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Mark as spam' }));

    expect(await screen.findByText('Marked as spam')).toBeInTheDocument();
    const listed = (await apis.ticketing.blockedSenders('brand')).senders;
    expect(listed.some((row) => row.value === 'mona@example.com')).toBe(false);
  });

  it('does not offer to block when the brand has turned it off', async () => {
    const { user } = await openTicket(MOCK_TICKET_ARABIC, (apis) =>
      apis.ticketing.updateSpamSettings('brand', { offerBlockSender: false }),
    );

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Mark as spam' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).queryByRole('checkbox')).toBeNull();
  });

  it('offers "Not spam" on a spam ticket, which reopens it', async () => {
    const { user, apis } = await openTicket(MOCK_TICKET_REFUND, (prepared) =>
      prepared.tickets.markSpam('brand', MOCK_TICKET_REFUND, { blockSender: false }),
    );

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Not spam' }));

    expect(await screen.findByText('Moved back to open')).toBeInTheDocument();
    expect((await apis.tickets.ticket('brand', MOCK_TICKET_REFUND)).ticket.status.isDefault).toBe(
      true,
    );
  });
});

describe('offersBlock', () => {
  const answer = {
    sender: { kind: 'email' as const, value: 'spam@promo-deals.biz' },
    offered: true,
    blockable: true,
    blocked: false,
  };

  it('offers the box only when all four answers allow it', () => {
    expect(offersBlock(answer)).toBe(true);
    expect(offersBlock(undefined)).toBe(false);
    expect(offersBlock({ ...answer, sender: null })).toBe(false);
    expect(offersBlock({ ...answer, offered: false })).toBe(false);
    expect(offersBlock({ ...answer, blockable: false })).toBe(false);
    expect(offersBlock({ ...answer, blocked: true })).toBe(false);
  });
});
