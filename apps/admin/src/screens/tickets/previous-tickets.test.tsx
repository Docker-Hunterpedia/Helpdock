import type { ContactTimelineItem, TicketStatus } from '@helpdock/schemas';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../app/preferences.js';
import { renderApp } from '../../test/render.tsx';
import { MOCK_STATUS_CLOSED, MOCK_STATUS_OPEN, MockTicketsApi } from '../../tickets/mock-api.js';
import { type ContactHistoryState, PreviousTickets } from './previous-tickets.tsx';

/**
 * The contact card's Previous tickets (`Admin/Ticket-ContactHistory`): the
 * contact's other tickets as links, the hidden count, and the states around
 * them.
 */

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const MONA = { id: '0192c3f0-1a2b-7c3d-8e4f-0000000000c1', name: 'Mona Khalil' };

const statuses = async (): Promise<readonly TicketStatus[]> =>
  (await new MockTicketsApi().statuses('brand')).statuses;

const item = (
  id: string,
  subject: string,
  statusId: string,
  createdAt: string,
): ContactTimelineItem => ({
  id,
  reference: `HD-${id}`,
  subject,
  status: 'ignored: the badge reads the status by id',
  statusId,
  channel: 'email',
  departmentName: 'Support',
  assigneeName: null,
  createdAt,
});

const CHARGER = item('1031', 'Charger stopped working', MOCK_STATUS_OPEN, '2026-10-12T09:00:00Z');
const RETURN = item('0988', 'سؤال سابق عن الإرجاع', MOCK_STATUS_CLOSED, '2026-09-02T09:00:00Z');

const renderSection = async (history: ContactHistoryState) =>
  renderApp(
    <PreviousTickets contact={MONA} history={history} statuses={await statuses()} now={NOW} />,
  );

describe('PreviousTickets', () => {
  it('links each previous ticket by subject, reference, date and status', async () => {
    await renderSection({ shown: [CHARGER, RETURN], count: 5, hiddenCount: 0 });

    const section = screen.getByRole('region', { name: 'Previous tickets · 5' });
    const rows = within(section).getAllByRole('listitem');
    expect(rows).toHaveLength(2);

    const charger = within(rows[0] as HTMLElement).getByRole('link');
    expect(charger).toHaveAttribute('href', '/tickets/1031');
    expect(charger).toHaveTextContent('Charger stopped working');
    expect(charger).toHaveTextContent('HD-1031 · 12 Oct');
    expect(charger).toHaveTextContent('Open');
    expect(within(charger).getByText('HD-1031').tagName).toBe('BDI');

    // A subject keeps its own direction, whichever language the panel is in.
    expect(within(rows[1] as HTMLElement).getByText('سؤال سابق عن الإرجاع')).toHaveAttribute(
      'dir',
      'auto',
    );
    expect(within(rows[1] as HTMLElement).getByRole('link')).toHaveTextContent('Closed');
  });

  it('names the contact page after the contact, under the hidden count', async () => {
    await renderSection({ shown: [CHARGER], count: 1, hiddenCount: 2 });

    expect(screen.getByText('2 hidden (other departments)')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /View all on .*Mona Khalil.*’s page/ }),
    ).toHaveAttribute('href', `/contacts/${MONA.id}`);
  });

  it('says it is their first ticket when there is nothing before it', async () => {
    await renderSection({ shown: [], count: 0, hiddenCount: 0 });

    expect(screen.getByRole('heading', { name: 'Previous tickets' })).toBeInTheDocument();
    expect(screen.getByText('This is their first ticket.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('says only the hidden count when every earlier ticket is hidden', async () => {
    await renderSection({ shown: [], count: 0, hiddenCount: 1 });

    expect(screen.getByText('1 hidden (another department)')).toBeInTheDocument();
    expect(screen.queryByText('This is their first ticket.')).toBeNull();
  });

  it('holds three skeleton rows while the timeline loads', async () => {
    const { container } = await renderSection('loading');

    expect(screen.getByRole('heading', { name: 'Previous tickets' })).toBeInTheDocument();
    expect(container.querySelectorAll('.MuiSkeleton-root')).toHaveLength(3);
    expect(screen.queryByText('This is their first ticket.')).toBeNull();
  });

  it('draws nothing when the timeline could not be read', async () => {
    const { container } = await renderSection('failed');

    expect(container).toBeEmptyDOMElement();
  });

  it('reads in Arabic', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    await renderSection({ shown: [CHARGER], count: 6, hiddenCount: 0 });

    expect(screen.getByRole('region', { name: 'التذاكر السابقة · 6' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /عرض الكل في صفحة .*Mona Khalil/ })).toBeVisible();
    expect(screen.getByRole('link', { name: /Charger stopped working/ })).toHaveTextContent(
      'مفتوحة',
    );
  });
});
