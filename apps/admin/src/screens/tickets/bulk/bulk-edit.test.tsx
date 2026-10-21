import type { BulkRequest, BulkResponse, Ticket } from '@helpdock/schemas';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { AuthError } from '../../../auth/api.js';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';
import { TicketLifecycleError } from '../../../tickets/api.js';
import { NOW, testTicket } from '../../../tickets/fixtures.js';
import { MOCK_TICKET_REFUND } from '../../../tickets/mock-api.js';

/**
 * The bulk edit on the ticket workspace (M14-04, `Admin/Tickets-Bulk`), with
 * the api's answers scripted so that each branch of the flow is reached: apply
 * at once, the review that lists refusals, a stale apply, the 429, a failure,
 * the toast's Undo and the palette's. The fixture's own rules are
 * `mock-api.test.ts`; the browser run is `e2e/bulk-edit.spec.ts`.
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

const OPERATION = '0192c3f0-1a2b-7c3d-8e4f-0000000b0001';

const answer = (
  mode: 'preview' | 'apply',
  outcomes: Record<string, 'will_change' | 'unchanged' | 'refused' | 'not_found'>,
  codes: Record<string, string> = {},
): BulkResponse => {
  const results = Object.entries(outcomes).map(([ticketId, outcome]) => ({
    ticketId,
    outcome,
    fields: outcome === 'will_change' ? (['priority'] as const) : [],
    code: outcome === 'refused' ? (codes[ticketId] ?? 'invalid') : null,
  }));
  const count = (outcome: string) => results.filter((result) => result.outcome === outcome).length;
  const changed = count('will_change');

  return {
    mode,
    results: results.map((result) => ({ ...result, fields: [...result.fields] })),
    counts: {
      willChange: changed,
      unchanged: count('unchanged'),
      refused: count('refused'),
      notFound: count('not_found'),
    },
    operationId: mode === 'apply' && changed > 0 ? OPERATION : null,
    undoUntil: mode === 'apply' && changed > 0 ? new Date(Date.now() + 60_000).toISOString() : null,
  };
};

interface Setup {
  readonly viewer?: boolean;
  readonly tickets?: Ticket[];
}

const renderTickets = async ({ viewer = false, tickets }: Setup = {}) => {
  const apis = await signedInMockApis();
  if (viewer) {
    const session = await apis.auth.me();
    vi.spyOn(apis.auth, 'me').mockResolvedValue(
      session === null
        ? null
        : { ...session, user: { ...session.user, role: 'viewer', installAdmin: false } },
    );
  }
  if (tickets !== undefined) {
    vi.spyOn(apis.tickets, 'list').mockResolvedValue({ tickets, nextCursor: null });
  }
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    contactsApi: apis.contacts,
    ticketingApi: apis.ticketing,
    ticketsApi: apis.tickets,
    uploader: apis.uploader,
    initialEntries: ['/tickets?view=all'],
  });
  await screen.findByRole('region', { name: 'Ticket list' });
  await screen.findAllByRole('link', { name: /HD-\d+/ });

  return { ...rendered, apis };
};

const box = (reference: string) => screen.getByRole('checkbox', { name: `Select ${reference}` });
const bar = () => screen.getByRole('toolbar', { name: 'Bulk actions' });

describe('ticking rows', () => {
  beforeEach(wideViewport);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('gives a reader who cannot change tickets the list as it was', async () => {
    await renderTickets({ viewer: true });

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /HD-\d+/ }).length).toBeGreaterThan(1);
  });

  it('opens the bar with a count when a box is ticked, and the header reads mixed', async () => {
    const { user } = await renderTickets();
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();

    await user.click(box('HD-1042'));

    expect(bar()).toHaveTextContent('1 selected');
    const header = screen.getByRole('checkbox', { name: 'Select all loaded tickets' });
    expect(header).toHaveProperty('indeterminate', true);
    expect(header).toHaveAttribute('aria-checked', 'mixed');
    expect(screen.getByText('1 of 9 selected · up to 50 at a time')).toBeVisible();
  });

  it('says the count to a screen reader without moving focus, and says when it is cleared', async () => {
    const { user } = await renderTickets();
    await user.click(box('HD-1042'));
    await user.click(box('HD-1041'));

    await waitFor(() =>
      expect(
        screen.getByText('2 tickets selected', { selector: '[aria-live]' }),
      ).toBeInTheDocument(),
    );
    expect(box('HD-1041')).toHaveFocus();

    await user.click(within(bar()).getByRole('button', { name: 'Clear' }));

    await waitFor(() =>
      expect(
        screen.getByText('Selection cleared', { selector: '[aria-live]' }),
      ).toBeInTheDocument(),
    );
  });

  it('ticks the whole page from the header, and unticks it from the header', async () => {
    const { user } = await renderTickets();
    const header = screen.getByRole('checkbox', { name: 'Select all loaded tickets' });

    await user.click(header);

    expect(bar()).toHaveTextContent('9 selected');
    expect(header).toBeChecked();
    await user.click(header);
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });

  it('ticks a range with Shift-click', async () => {
    const { user } = await renderTickets();
    const rows = screen.getAllByRole('checkbox').slice(1);
    await user.click(rows[1] as HTMLElement);

    await user.keyboard('{Shift>}');
    await user.click(rows[4] as HTMLElement);
    await user.keyboard('{/Shift}');

    expect(bar()).toHaveTextContent('4 selected');
    expect(rows.map((row) => (row as HTMLInputElement).checked)).toEqual([
      false,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it('ticks the open ticket’s row with x, a range with Shift+x, and clears with Esc', async () => {
    const { user } = await renderTickets();
    await user.click(screen.getByRole('link', { name: /HD-1042/ }));
    await screen.findByRole('region', { name: 'Ticket header' });

    await user.keyboard('x');
    expect(box('HD-1042')).toBeChecked();

    await user.keyboard('j');
    await user.keyboard('j');
    await user.keyboard('{Shift>}x{/Shift}');
    expect(bar()).toHaveTextContent('3 selected');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(box('HD-1042')).not.toBeChecked();
  });

  it('takes the row holding focus for x, before the open ticket', async () => {
    const { user } = await renderTickets();
    await user.click(screen.getByRole('link', { name: /HD-1042/ }));
    await screen.findByRole('region', { name: 'Ticket header' });

    box('HD-1035').focus();
    await user.keyboard('x');

    expect(box('HD-1035')).toBeChecked();
    expect(box('HD-1042')).not.toBeChecked();
  });

  it('stops at fifty, takes the first fifty of a longer page and says so', async () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      testTicket({
        id: `0192c3f0-1a2b-7c3d-8e4f-0000000${String(index).padStart(5, '0')}`,
        number: 2000 + index,
        subject: `Ticket ${String(index)}`,
        updatedAt: new Date(NOW - index * 60_000).toISOString(),
      }),
    );
    const { user } = await renderTickets({ tickets: many });

    await user.click(screen.getByRole('checkbox', { name: 'Select all loaded tickets' }));

    expect(bar()).toHaveTextContent('50 selected');
    expect(screen.getByText('50 of 60 selected · the limit is 50 at a time')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Select HD-2055' })).not.toBeChecked();
    // A fifty-first box does not tick.
    await user.click(screen.getByRole('checkbox', { name: 'Select HD-2055' }));
    expect(bar()).toHaveTextContent('50 selected');
  });

  it('forgets the selection when the list changes', async () => {
    const { user } = await renderTickets();
    await user.click(box('HD-1042'));

    await user.type(screen.getByRole('searchbox', { name: 'Search tickets' }), 'VAT');

    await waitFor(() => expect(screen.queryByRole('toolbar')).not.toBeInTheDocument());
  });
});

describe('applying a bulk edit', () => {
  beforeEach(wideViewport);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const chooseClose = async (user: Awaited<ReturnType<typeof renderTickets>>['user']) => {
    await user.click(within(bar()).getByRole('button', { name: 'Close' }));
  };

  /** The ticket id of a row, by its reference. */
  const idOf = (reference: string): string =>
    box(reference).closest<HTMLElement>('li[data-ticket-id]')?.dataset.ticketId ?? '';

  it('previews and applies at once when every ticket would change, then offers Undo', async () => {
    const { user, apis } = await renderTickets();
    const bulk = vi.spyOn(apis.tickets, 'bulk').mockImplementation(async (_brand, request) => {
      const outcomes = Object.fromEntries(
        request.ticketIds.map((id) => [id, 'will_change' as const]),
      );
      return answer(request.mode, outcomes);
    });
    const undo = vi.spyOn(apis.tickets, 'undoBulk').mockResolvedValue({
      operationId: OPERATION,
      results: [
        {
          ticketId: idOf('HD-1042'),
          outcome: 'reverted',
          reverted: ['statusId'],
          kept: [],
          code: null,
        },
        {
          ticketId: idOf('HD-1041'),
          outcome: 'reverted',
          reverted: ['statusId'],
          kept: [],
          code: null,
        },
      ],
      notFound: 0,
    });
    await user.click(box('HD-1042'));
    await user.click(box('HD-1041'));

    await chooseClose(user);

    const toast = await screen.findByText('Closed 2 tickets');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bulk).toHaveBeenCalledTimes(2);
    const [preview, apply] = bulk.mock.calls.map(([, request]) => request as BulkRequest);
    expect(preview).toMatchObject({ mode: 'preview', changes: { close: true } });
    expect(apply).toMatchObject({ mode: 'apply', expect: apply?.ticketIds });
    // The selection is gone and focus is on the list's header.
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'Select all loaded tickets' })).toHaveFocus(),
    );

    await user.click(
      within(toast.closest('[role="status"]') as HTMLElement).getByRole('button', { name: 'Undo' }),
    );

    expect(undo).toHaveBeenCalledWith(expect.any(String), OPERATION);
    expect(await screen.findByText('Undid the change to 2 tickets')).toBeVisible();
  });

  it('lists what cannot change in words and applies only the rest', async () => {
    const { user, apis } = await renderTickets();
    const ids = [idOf('HD-1042'), idOf('HD-1041'), idOf('HD-1039')];
    const bulk = vi
      .spyOn(apis.tickets, 'bulk')
      .mockImplementation(async (_brand, request) =>
        answer(
          request.mode,
          { [ids[0] ?? '']: 'will_change', [ids[1] ?? '']: 'unchanged', [ids[2] ?? '']: 'refused' },
          { [ids[2] ?? '']: 'ticket-closed' },
        ),
      );
    await user.click(box('HD-1042'));
    await user.click(box('HD-1041'));
    await user.click(box('HD-1039'));

    await chooseClose(user);

    const dialog = await screen.findByRole('dialog', { name: 'Close 3 tickets?' });
    expect(dialog).toHaveTextContent(
      '1 of 3 tickets will be closed. 2 can’t be closed:'.replace('’', "'"),
    );
    const items = within(dialog).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Already closed.');
    expect(items[1]).toHaveTextContent('A closed ticket cannot be snoozed.');
    expect(bulk).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole('button', { name: 'Close 1' }));

    await screen.findByText('Closed 1 ticket');
    const apply = bulk.mock.calls.at(-1)?.[1] as BulkRequest;
    expect(apply).toMatchObject({ mode: 'apply', expect: [ids[0]], ticketIds: ids });
  });

  it('leaves out the primary when nothing would change', async () => {
    const { user, apis } = await renderTickets();
    vi.spyOn(apis.tickets, 'bulk').mockImplementation(async (_brand, request) =>
      answer(
        request.mode,
        Object.fromEntries(request.ticketIds.map((id) => [id, 'unchanged' as const])),
      ),
    );
    await user.click(box('HD-1042'));

    await chooseClose(user);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent("This ticket can't be closed:");
    expect(within(dialog).queryByRole('button', { name: /^Close \d/ })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Nothing was done, so the selection stays for the next try.
    expect(bar()).toHaveTextContent('1 selected');
  });

  it('previews again and says so when the api answers that something changed', async () => {
    const { user, apis } = await renderTickets();
    const [first, second] = [idOf('HD-1042'), idOf('HD-1041')] as [string, string];
    let previews = 0;
    vi.spyOn(apis.tickets, 'bulk').mockImplementation(async (_brand, request) => {
      if (request.mode === 'apply') {
        throw new TicketLifecycleError('bulk-changed');
      }
      previews += 1;
      return previews === 1
        ? answer('preview', { [first]: 'will_change', [second]: 'will_change' })
        : answer('preview', { [first]: 'will_change', [second]: 'unchanged' });
    });
    await user.click(box('HD-1042'));
    await user.click(box('HD-1041'));

    await chooseClose(user);

    const dialog = await screen.findByRole('dialog', { name: 'Close 2 tickets?' });
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      'Something changed while you were looking.',
    );
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(1);
    expect(previews).toBe(2);
  });

  it('tells the wait when the api answers 429, and keeps the selection', async () => {
    const { user, apis } = await renderTickets();
    vi.spyOn(apis.tickets, 'bulk').mockImplementation(async (_brand, request) => {
      if (request.mode === 'apply') {
        throw new AuthError('rate-limited', { retryAfter: 30, status: 429 });
      }
      return answer(
        'preview',
        Object.fromEntries(request.ticketIds.map((id) => [id, 'will_change' as const])),
      );
    });
    await user.click(box('HD-1042'));

    await chooseClose(user);

    expect(
      await screen.findByText('Too many bulk changes. Try again in 30 seconds.'),
    ).toBeVisible();
    expect(bar()).toHaveTextContent('1 selected');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says it could not check, and says nothing was changed when an apply fails', async () => {
    const { user, apis } = await renderTickets();
    const bulk = vi.spyOn(apis.tickets, 'bulk');
    bulk.mockRejectedValueOnce(new Error('down'));
    await user.click(box('HD-1042'));

    await chooseClose(user);
    expect(await screen.findByText('The change could not be checked. Try again.')).toBeVisible();

    bulk.mockImplementation(async (_brand, request) => {
      if (request.mode === 'apply') {
        throw new Error('down');
      }
      return answer(
        'preview',
        Object.fromEntries(request.ticketIds.map((id) => [id, 'will_change' as const])),
      );
    });
    await chooseClose(user);
    expect(
      await screen.findByText('The change could not be made. Nothing was changed.'),
    ).toBeVisible();
    expect(bar()).toHaveTextContent('1 selected');
  });

  it('applies a priority picked from its menu, with the toast wording of a plain change', async () => {
    const { user, apis } = await renderTickets();
    const bulk = vi
      .spyOn(apis.tickets, 'bulk')
      .mockImplementation(async (_brand, request) =>
        answer(
          request.mode,
          Object.fromEntries(request.ticketIds.map((id) => [id, 'will_change' as const])),
        ),
      );
    await user.click(box('HD-1042'));

    await user.click(within(bar()).getByRole('button', { name: 'Priority' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Low' }));

    expect(await screen.findByText('Updated 1 ticket')).toBeVisible();
    expect(bulk.mock.calls[0]?.[1]).toMatchObject({ changes: { priority: 'low' } });
  });

  it('offers Undo last bulk change in the palette while the api accepts it', async () => {
    const { user, apis } = await renderTickets();
    vi.spyOn(apis.tickets, 'bulk').mockImplementation(async (_brand, request) =>
      answer(
        request.mode,
        Object.fromEntries(request.ticketIds.map((id) => [id, 'will_change' as const])),
      ),
    );
    const undo = vi.spyOn(apis.tickets, 'undoBulk').mockResolvedValue({
      operationId: OPERATION,
      results: [
        {
          ticketId: MOCK_TICKET_REFUND,
          outcome: 'partly_reverted',
          reverted: ['priority'],
          kept: ['statusId'],
          code: null,
        },
      ],
      notFound: 0,
    });
    await user.click(box('HD-1042'));
    await chooseClose(user);
    await screen.findByText('Closed 1 ticket');

    await user.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    await user.click(await within(palette).findByRole('option', { name: 'Undo last bulk change' }));

    await waitFor(() => expect(undo).toHaveBeenCalledOnce());
    expect(
      await screen.findByText('Undone, but 1 ticket had changed since and was left as it is.'),
    ).toBeVisible();
  });

  it('has no Undo entry in the palette before anything was applied', async () => {
    const { user } = await renderTickets();

    await user.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });

    expect(
      within(palette).queryByRole('option', { name: 'Undo last bulk change' }),
    ).not.toBeInTheDocument();
  });

  it('says why an undo was refused', async () => {
    const { user, apis } = await renderTickets();
    vi.spyOn(apis.tickets, 'bulk').mockImplementation(async (_brand, request) =>
      answer(
        request.mode,
        Object.fromEntries(request.ticketIds.map((id) => [id, 'will_change' as const])),
      ),
    );
    vi.spyOn(apis.tickets, 'undoBulk').mockRejectedValue(
      new TicketLifecycleError('bulk-undo-expired'),
    );
    await user.click(box('HD-1042'));
    await chooseClose(user);
    const toast = await screen.findByText('Closed 1 ticket');

    await user.click(
      within(toast.closest('[role="status"]') as HTMLElement).getByRole('button', { name: 'Undo' }),
    );

    expect(
      await screen.findByText('A bulk change can be undone for 60 seconds, and those have passed.'),
    ).toBeVisible();
  });
});

describe('the changes the bar offers', () => {
  beforeEach(wideViewport);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Ticks one row and records the first change the bar sends, answering that all would change. */
  const choose = async (
    open: (user: Awaited<ReturnType<typeof renderTickets>>['user']) => Promise<void>,
  ) => {
    const { user, apis } = await renderTickets();
    const bulk = vi
      .spyOn(apis.tickets, 'bulk')
      .mockImplementation(async (_brand, request) =>
        answer(
          request.mode,
          Object.fromEntries(request.ticketIds.map((id) => [id, 'will_change' as const])),
        ),
      );
    await user.click(box('HD-1042'));
    await open(user);
    await waitFor(() => expect(bulk).toHaveBeenCalled());

    const [request] = bulk.mock.calls.map(([, sent]) => sent as BulkRequest);

    return request?.changes;
  };

  const barButton = (name: string) => within(bar()).getByRole('button', { name });

  it('assigns to me', async () => {
    const changes = await choose(async (user) => {
      await user.click(barButton('Assign'));
      await user.click(await screen.findByRole('option', { name: 'Assign to me' }));
    });

    expect(changes).toEqual({ assigneeId: 'me' });
  });

  it('assigns to nobody', async () => {
    const changes = await choose(async (user) => {
      await user.click(barButton('Assign'));
      await user.click(await screen.findByRole('option', { name: 'Unassigned' }));
    });

    expect(changes).toEqual({ assigneeId: null });
  });

  it('assigns to a person the tickets’ departments can offer', async () => {
    const changes = await choose(async (user) => {
      await user.click(barButton('Assign'));
      const options = await screen.findAllByRole('option');
      const named = await waitFor(() => {
        const found = screen
          .getAllByRole('option')
          .find((option) => !/Assign to me|Unassigned/.test(option.textContent ?? ''));
        if (found === undefined) {
          throw new Error('no person on offer yet');
        }
        return found;
      });
      expect(options.length).toBeGreaterThan(0);
      await user.click(named);
    });

    expect(changes).toEqual({ assigneeId: expect.any(String) });
  });

  it('adds a tag', async () => {
    const changes = await choose(async (user) => {
      await user.click(barButton('Tags'));
      await user.click((await screen.findAllByRole('menuitem', { name: 'VIP' }))[0] as HTMLElement);
    });

    expect(changes).toEqual({ addTagIds: [expect.any(String)] });
  });

  it('removes a tag', async () => {
    const changes = await choose(async (user) => {
      await user.click(barButton('Tags'));
      await user.click((await screen.findAllByRole('menuitem', { name: 'VIP' }))[1] as HTMLElement);
    });

    expect(changes).toEqual({ removeTagIds: [expect.any(String)] });
  });

  it('moves to a department', async () => {
    const changes = await choose(async (user) => {
      await user.click(barButton('Department'));
      await user.click((await screen.findAllByRole('menuitem'))[0] as HTMLElement);
    });

    expect(changes).toEqual({ departmentId: expect.any(String) });
  });

  it('changes the status', async () => {
    const changes = await choose(async (user) => {
      await user.click(barButton('Status'));
      await user.click(await screen.findByRole('menuitem', { name: 'Escalated' }));
    });

    expect(changes).toEqual({ statusId: expect.any(String) });
  });

  it('clears the team', async () => {
    const changes = await choose(async (user) => {
      await user.click(barButton('Team'));
      await user.click(await screen.findByRole('menuitem', { name: 'No team' }));
    });

    expect(changes).toEqual({ teamId: null });
  });

  it('never offers Snoozed as a status, because it needs a time', async () => {
    const { user } = await renderTickets();
    await user.click(box('HD-1042'));

    await user.click(barButton('Status'));

    const menu = await screen.findByRole('menu', { name: 'Change status to' });
    expect(within(menu).queryByRole('menuitem', { name: 'Snoozed' })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Closed' })).toBeVisible();
  });

  it('snoozes until a preset time', async () => {
    const changes = await choose(async (user) => {
      await user.click(barButton('Snooze'));
      await user.click(await screen.findByRole('menuitem', { name: /In 4 hours/ }));
    });

    expect(changes).toEqual({ snoozedUntil: expect.any(String) });
  });

  it('wakes snoozed tickets from More', async () => {
    const changes = await choose(async (user) => {
      await user.click(barButton('More'));
      await user.click(await screen.findByRole('menuitem', { name: 'Wake snoozed tickets' }));
    });

    expect(changes).toEqual({ snoozedUntil: null });
  });

  it('marks as spam from More', async () => {
    const changes = await choose(async (user) => {
      await user.click(barButton('More'));
      await user.click(await screen.findByRole('menuitem', { name: 'Mark as spam' }));
    });

    expect(changes).toEqual({ spam: true });
  });

  it('sets a custom field with the editor of its type', async () => {
    const changes = await choose(async (user) => {
      await user.click(barButton('More'));
      await user.click(await screen.findByRole('menuitem', { name: 'Set a field…' }));
      const dialog = await screen.findByRole('dialog', { name: 'Set a field' });
      await user.click(await within(dialog).findByRole('combobox', { name: 'Plan tier' }));
      await user.click(await screen.findByRole('option', { name: 'gold' }));
      await user.click(within(dialog).getByRole('button', { name: 'Review the change' }));
    });

    expect(changes).toEqual({ customField: { key: 'tier', value: 'gold' } });
  });
});
