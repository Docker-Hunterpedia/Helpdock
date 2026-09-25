import type { TicketView } from '@helpdock/schemas';
import { ticketViewFiltersSchema } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { EMPTY_FILTERS, LIVE_STATES } from '../../../tickets/views.js';
import {
  assigneeChoice,
  createRequestOf,
  draftComplete,
  draftOf,
  priorityChoice,
  SAVED,
  sortChoice,
  stateChoice,
  updateRequestOf,
  withAssigneeChoice,
  withPriorityChoice,
  withSortChoice,
  withStateChoice,
} from './view-draft.js';

const DEPARTMENT = '0192c3f0-1a2b-7c3d-8e4f-0000000000d2';
const PERSON = '0192c3f0-1a2b-7c3d-8e4f-00000000000b';

const view = (overrides: Partial<TicketView> = {}): TicketView => ({
  id: '0192c3f0-1a2b-7c3d-8e4f-0000000000e5',
  name: 'VIP refunds',
  nameAr: null,
  visibility: { kind: 'departments', departmentIds: [DEPARTMENT] },
  builtIn: null,
  departmentId: null,
  filters: ticketViewFiltersSchema.parse({ priority: ['urgent'], systemState: LIVE_STATES }),
  hidden: false,
  sortOrder: 0,
  editable: true,
  ...overrides,
});

describe('the draft', () => {
  it('starts a new view as every live ticket, seen by the whole brand', () => {
    expect(draftOf(null)).toMatchObject({
      name: '',
      audience: 'brand',
      filters: { systemState: LIVE_STATES },
    });
  });

  it('reads a view shared with departments', () => {
    expect(draftOf(view())).toMatchObject({
      audience: 'departments',
      departmentIds: [DEPARTMENT],
      filters: { priority: ['urgent'] },
    });
  });

  it('needs a name, and a department when shared with some', () => {
    const draft = draftOf(view());

    expect(draftComplete(draft)).toBe(true);
    expect(draftComplete({ ...draft, name: '  ' })).toBe(false);
    expect(draftComplete({ ...draft, departmentIds: [] })).toBe(false);
    expect(draftComplete({ ...draft, audience: 'brand', departmentIds: [] })).toBe(true);
  });

  it('sends an empty Arabic name as none, and trims both', () => {
    const request = createRequestOf({ ...draftOf(view()), name: ' Late ', nameAr: ' ' });

    expect(request).toMatchObject({ name: 'Late', nameAr: null });
    expect(request.visibility).toEqual({ kind: 'departments', departmentIds: [DEPARTMENT] });
  });

  it('sends a built-in view its names and nothing else', () => {
    const builtIn = view({ builtIn: 'overdue', visibility: { kind: 'brand' } });

    expect(updateRequestOf(builtIn, { ...draftOf(builtIn), name: 'Late' })).toEqual({
      name: 'Late',
      nameAr: null,
    });
    expect(updateRequestOf(view(), draftOf(view()))).toHaveProperty('filters');
  });
});

describe('the selects', () => {
  it('names the live states as one choice, and one state as itself', () => {
    expect(stateChoice({ ...EMPTY_FILTERS, systemState: LIVE_STATES })).toBe('live');
    expect(stateChoice({ ...EMPTY_FILTERS, systemState: ['closed'] })).toBe('closed');
    expect(stateChoice(EMPTY_FILTERS)).toBe('any');
  });

  it('keeps what it cannot draw as saved, and leaves it untouched', () => {
    const filters = { ...EMPTY_FILTERS, systemState: ['open', 'closed'] as const };

    expect(stateChoice({ ...filters, systemState: [...filters.systemState] })).toBe(SAVED);
    expect(stateChoice({ ...EMPTY_FILTERS, statusId: [DEPARTMENT] })).toBe(SAVED);
    expect(withStateChoice(EMPTY_FILTERS, SAVED)).toBe(EMPTY_FILTERS);
    expect(assigneeChoice({ ...EMPTY_FILTERS, assigneeId: [PERSON] })).toBe(SAVED);
    expect(priorityChoice({ ...EMPTY_FILTERS, priority: ['low', 'high'] })).toBe(SAVED);
  });

  it('writes a state choice over any status the view named', () => {
    expect(
      withStateChoice({ ...EMPTY_FILTERS, statusId: [DEPARTMENT] }, 'escalated'),
    ).toMatchObject({ statusId: [], systemState: ['escalated'] });
    expect(withStateChoice(EMPTY_FILTERS, 'live').systemState).toEqual(LIVE_STATES);
  });

  it('writes assignee and priority as one value or none', () => {
    expect(withAssigneeChoice(EMPTY_FILTERS, 'me').assigneeId).toEqual(['me']);
    expect(withAssigneeChoice({ ...EMPTY_FILTERS, assigneeId: ['me'] }, 'any').assigneeId).toEqual(
      [],
    );
    expect(withPriorityChoice(EMPTY_FILTERS, 'urgent').priority).toEqual(['urgent']);
    expect(withPriorityChoice(EMPTY_FILTERS, 'any').priority).toEqual([]);
  });

  it('reads and writes the order as sort and direction together', () => {
    const oldest = withSortChoice(EMPTY_FILTERS, 'createdAt:asc');

    expect(oldest).toMatchObject({ sort: 'createdAt', direction: 'asc' });
    expect(sortChoice(oldest)).toBe('createdAt:asc');
  });
});
