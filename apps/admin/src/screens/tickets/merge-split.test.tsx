import type { TicketMergeRequest, TicketMergeResult } from '@helpdock/schemas';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import { TicketLifecycleError } from '../../tickets/api.js';
import { MOCK_TICKET_REFUND, MOCK_TICKET_VAT, MockTicketsApi } from '../../tickets/mock-api.js';
import { isolate } from './format.js';

/**
 * M1-09 in the workspace, against the fixture: the ⋯ menu, the two dialogs and
 * what the thread draws afterwards on both tickets (`AdminTicketDialogs`
 * panels 1, 2, 4 and 7). The rules themselves are the api's and are proved in
 * `apps/api/src/tickets/merge/`; this is about what a person sees and does.
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

const openTicket = async (ticketId: string, ticketsApi?: MockTicketsApi) => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    contactsApi: apis.contacts,
    ticketingApi: apis.ticketing,
    ticketsApi: ticketsApi ?? apis.tickets,
    uploader: apis.uploader,
    initialEntries: [`/tickets/${ticketId}?view=all`],
  });

  await screen.findByRole('region', { name: 'Ticket header' });

  return rendered;
};

/**
 * A merge and a split each end on another ticket: a route change, a fresh read
 * and a remount, which is longer than `findBy`'s one-second default on a busy
 * machine.
 */
const NAVIGATION = { timeout: 5_000 };

const thread = (): HTMLElement => screen.getByRole('list', { name: 'Conversation' });

/** A fixture whose merges are refused, for the failure path. */
class RefusingTicketsApi extends MockTicketsApi {
  override async merge(
    _brandId: string,
    _ticketId: string,
    _request: TicketMergeRequest,
  ): Promise<TicketMergeResult> {
    await Promise.resolve();
    throw new TicketLifecycleError('merge-into-merged');
  }
}

describe('merge', () => {
  beforeEach(wideViewport);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers Merge and Split first in the ⋯ menu, with Mark as spam last behind a divider', async () => {
    const { user } = await openTicket(MOCK_TICKET_REFUND);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    const menu = await screen.findByRole('menu', { name: 'Ticket actions' });

    // The artboard's order (panel 2); Log time joins between them when the
    // brand tracks time, which the fixture does not.
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Merge into another ticket…', 'Split messages…', 'Mark as spam']);
    expect(within(menu).getAllByRole('separator')).toHaveLength(1);
  });

  it('closes this ticket into the one picked, and opens that one with the messages inline', async () => {
    const { user } = await openTicket(MOCK_TICKET_REFUND);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Merge into another ticket…' }));
    const dialog = await screen.findByRole('dialog', { name: /Merge tickets/ });
    expect(within(dialog).getByText(`What happens to ${isolate('HD-1042')}`)).toBeVisible();

    await user.type(within(dialog).getByRole('searchbox', { name: 'Merge HD-1042 into' }), 'VAT');
    await user.click(await within(dialog).findByRole('radio'));
    expect(
      within(dialog).getByText(
        `Its messages stay where they are and show inline, read-only, in ${isolate('HD-1035')}.`,
      ),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Merge into HD-1035' }));

    expect(await screen.findByText('Merged into HD-1035')).toBeVisible();
    await screen.findByRole(
      'heading',
      { name: 'Invoice 2291 shows the wrong VAT', level: 1 },
      NAVIGATION,
    );
    const banner = await within(thread()).findByText(
      new RegExp(`${isolate('HD-1042')} was merged into this ticket by Lina Haddad`),
    );
    expect(banner).toBeVisible();
    expect(within(thread()).getByText(`From ${isolate('HD-1042')} · read only`)).toBeVisible();
    expect(within(thread()).getByText(/I returned order 42 three weeks ago/)).toBeVisible();
    expect(within(thread()).getByRole('button', { name: /Unmerge · 24 h left/ })).toBeVisible();
  });

  it('undoes the merge from the primary’s banner', async () => {
    const api = new MockTicketsApi();
    await api.merge('brand', MOCK_TICKET_REFUND, { primaryTicketId: MOCK_TICKET_VAT });
    const { user } = await openTicket(MOCK_TICKET_VAT, api);

    await user.click(await within(thread()).findByRole('button', { name: /Unmerge/ }));

    expect(await screen.findByText('HD-1042 unmerged')).toBeVisible();
    await waitFor(() => {
      expect(within(thread()).queryByText(/read only/)).toBeNull();
    });
  });

  it('shows the secondary as merged, with no composer under it', async () => {
    const api = new MockTicketsApi();
    await api.merge('brand', MOCK_TICKET_REFUND, { primaryTicketId: MOCK_TICKET_VAT });
    const { user } = await openTicket(MOCK_TICKET_REFUND, api);

    expect(
      await screen.findByText(new RegExp(`Merged into ${isolate('HD-1035')} by Lina Haddad`)),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: `Open ${isolate('HD-1035')}` })).toBeVisible();
    expect(screen.queryByRole('form', { name: 'Reply or internal note' })).toBeNull();

    // Its state belongs to the primary, so the menu has nothing to offer.
    expect(screen.getByRole('button', { name: 'More actions' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Unmerge/ }));
    expect(await screen.findByText('HD-1042 unmerged')).toBeVisible();
  });

  it('says why a merged ticket’s status cannot be changed', async () => {
    const api = new MockTicketsApi();
    await api.merge('brand', MOCK_TICKET_REFUND, { primaryTicketId: MOCK_TICKET_VAT });
    const { user } = await openTicket(MOCK_TICKET_REFUND, api);

    await user.click(await screen.findByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Open' }));

    expect(
      await screen.findByText('This ticket was merged into another one. Work on that one instead.'),
    ).toBeVisible();
  });

  it('asks for a ticket before merging, and says when the search finds none', async () => {
    const { user } = await openTicket(MOCK_TICKET_REFUND);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Merge into another ticket…' }));
    const dialog = await screen.findByRole('dialog', { name: /Merge tickets/ });

    await user.click(within(dialog).getByRole('button', { name: 'Merge' }));
    expect(await within(dialog).findByText('Pick the ticket to merge into.')).toBeVisible();

    await user.type(within(dialog).getByRole('searchbox'), 'zzzz');
    expect(await within(dialog).findByText('No ticket matches that search.')).toBeVisible();
  });

  it('says which rule refused a merge, and keeps the dialog open', async () => {
    const { user } = await openTicket(MOCK_TICKET_REFUND, new RefusingTicketsApi());

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Merge into another ticket…' }));
    const dialog = await screen.findByRole('dialog', { name: /Merge tickets/ });
    await user.type(within(dialog).getByRole('searchbox'), 'VAT');
    await user.click(await within(dialog).findByRole('radio'));
    await user.click(within(dialog).getByRole('button', { name: 'Merge into HD-1035' }));

    expect(
      await screen.findByText('That ticket was itself merged. Merge into the ticket it went to.'),
    ).toBeVisible();
    expect(screen.getByRole('dialog', { name: /Merge tickets/ })).toBeVisible();
  });
});

describe('split', () => {
  beforeEach(wideViewport);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('copies the ticked messages onto a new ticket and opens it', async () => {
    const { user } = await openTicket(MOCK_TICKET_REFUND);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Split messages…' }));
    const dialog = await screen.findByRole('dialog', { name: /Split into a new ticket/ });

    await user.click(within(dialog).getByRole('button', { name: 'Create ticket' }));
    expect(await within(dialog).findByText('Tick at least one message.')).toBeVisible();
    expect(within(dialog).getByText('A subject is required.')).toBeVisible();

    const [first] = within(dialog).getAllByRole('checkbox');
    if (first === undefined) {
      throw new Error('the fixture ticket has messages');
    }
    await user.click(first);
    expect(within(dialog).getByText('Messages to copy · selected: 1')).toBeVisible();
    await user.type(within(dialog).getByRole('textbox', { name: 'Subject' }), 'The return label');
    await user.click(within(dialog).getByRole('button', { name: 'Create ticket' }));

    expect(await screen.findByText('HD-1043 created')).toBeVisible();
    await screen.findByRole('heading', { name: 'The return label', level: 1 }, NAVIGATION);
    const back = await within(thread()).findByRole('link', { name: 'HD-1042' });
    expect(back).toHaveAttribute('href', `/tickets/${MOCK_TICKET_REFUND}`);
    expect(within(thread()).getByText(/I returned order 42 three weeks ago/)).toBeVisible();
  });
});
