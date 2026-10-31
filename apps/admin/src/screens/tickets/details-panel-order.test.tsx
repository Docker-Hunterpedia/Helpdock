import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import { MOCK_TICKET_REFUND } from '../../tickets/mock-api.js';

/**
 * The details panel in the order of `Admin/Ticket-Details-Order` (M14-20): the
 * contact card, the four selects with their labels above, the SLA, tags and
 * custom fields, and the participants collapsed to one line.
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

const renderPanel = async () => {
  const apis = await signedInMockApis();
  const { user } = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    contactsApi: apis.contacts,
    ticketingApi: apis.ticketing,
    ticketsApi: apis.tickets,
    uploader: apis.uploader,
    initialEntries: [`/tickets/${MOCK_TICKET_REFUND}?view=all`],
  });

  const panel = await screen.findByRole('complementary', { name: 'Ticket details' });
  await within(panel).findByRole('button', { name: /participants? · Add CC$/ });

  return { panel, user };
};

const follows = (earlier: Element, later: Element): boolean =>
  (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('the details panel (M14-20)', () => {
  beforeEach(wideViewport);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs contact, assignee, status, priority, department, SLA, tags, custom fields, participants', async () => {
    const { panel } = await renderPanel();

    const anchors = [
      within(panel).getByRole('heading', { name: 'Contact' }),
      within(panel).getByText('Assignee'),
      within(panel).getByText('Status'),
      within(panel).getByText('Priority'),
      within(panel).getByText('Department'),
      within(panel).getByRole('region', { name: /SLA/ }),
      within(panel).getByText('Tags'),
      within(panel).getByRole('heading', { name: 'Custom fields' }),
      within(panel).getByRole('region', { name: 'Participants' }),
    ];

    for (const [index, anchor] of anchors.slice(1).entries()) {
      expect(follows(anchors[index] as Element, anchor), `${anchor.textContent} follows`).toBe(
        true,
      );
    }
  });

  it('puts every select’s label above it, not notched into its border', async () => {
    const { panel } = await renderPanel();

    for (const name of ['Status', 'Priority', 'Department']) {
      const select = within(panel).getByRole('combobox', { name: new RegExp(`^${name}`) });
      const caption = within(panel).getByText(name);

      expect(follows(caption, select)).toBe(true);
    }
    expect(panel.querySelectorAll('legend span:not(.notranslate)')).toHaveLength(0);
  });

  it('keeps the selects working: choosing a priority changes the ticket', async () => {
    const { panel, user } = await renderPanel();

    await user.click(within(panel).getByRole('combobox', { name: /^Priority/ }));
    await user.click(await screen.findByRole('option', { name: 'Low' }));

    await waitFor(() => {
      expect(within(panel).getByRole('combobox', { name: /^Priority/ })).toHaveTextContent('Low');
    });
  });
});
