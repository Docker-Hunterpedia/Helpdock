import { describe, expect, it } from 'vitest';
import {
  headerState,
  keepListed,
  NO_SELECTION,
  range,
  SELECTION_CAP,
  type Selection,
  toggle,
  togglePage,
} from './selection.js';

const rows = Array.from({ length: 80 }, (_, index) => `t${index + 1}`);
const held = (ids: readonly string[], anchor: string | null = ids.at(-1) ?? null): Selection => ({
  ids,
  anchor,
});

describe('toggle', () => {
  it('ticks a row and makes it the anchor', () => {
    expect(toggle(NO_SELECTION, 't3')).toEqual({ selection: held(['t3']), capped: false });
  });

  it('unticks a ticked row and keeps it as the anchor', () => {
    expect(toggle(held(['t3', 't5']), 't3')).toEqual({
      selection: { ids: ['t5'], anchor: 't3' },
      capped: false,
    });
  });

  it('refuses a fifty-first row and says it was capped', () => {
    const full = held(rows.slice(0, SELECTION_CAP));

    expect(toggle(full, 't51')).toEqual({ selection: full, capped: true });
  });

  it('still unticks at the cap', () => {
    const full = held(rows.slice(0, SELECTION_CAP));

    expect(toggle(full, 't1').selection.ids).toHaveLength(SELECTION_CAP - 1);
  });
});

describe('range', () => {
  it('ticks from the anchor down to the row, both included', () => {
    const { selection } = range(held(['t2']), 't5', rows);

    expect(selection.ids).toEqual(['t2', 't3', 't4', 't5']);
    expect(selection.anchor).toBe('t5');
  });

  it('ticks upwards from the anchor too', () => {
    const { selection } = range(held(['t5']), 't3', rows);

    expect(selection.ids).toEqual(['t5', 't4', 't3']);
  });

  it('adds to rows already ticked and never unticks one', () => {
    const { selection } = range(held(['t9', 't2'], 't2'), 't4', rows);

    expect(selection.ids).toEqual(['t9', 't2', 't3', 't4']);
  });

  it('ticks the row alone when there is no anchor', () => {
    expect(range(NO_SELECTION, 't7', rows)).toEqual({ selection: held(['t7']), capped: false });
  });

  it('ticks the row alone when the anchor has left the list', () => {
    const { selection } = range(held(['gone'], 'gone'), 't7', rows);

    expect(selection.ids).toEqual(['gone', 't7']);
  });

  it('leaves the selection alone for a row that is not listed', () => {
    const start = held(['t1']);

    expect(range(start, 'nowhere', rows)).toEqual({ selection: start, capped: false });
  });

  it('keeps the rows nearest the anchor when the range is longer than the cap', () => {
    const { selection, capped } = range(held(['t1']), 't80', rows);

    expect(capped).toBe(true);
    expect(selection.ids).toHaveLength(SELECTION_CAP);
    expect(selection.ids.at(-1)).toBe('t50');
  });

  it('takes the nearest rows going upwards as well', () => {
    const { selection, capped } = range(held(['t80']), 't1', rows);

    expect(capped).toBe(true);
    expect(selection.ids.at(-1)).toBe('t31');
  });
});

describe('togglePage', () => {
  it('ticks every loaded row when the page fits', () => {
    const page = rows.slice(0, 25);
    const { selection, capped } = togglePage(NO_SELECTION, page);

    expect(selection.ids).toEqual(page);
    expect(capped).toBe(false);
  });

  it('completes a partial selection', () => {
    const page = rows.slice(0, 5);

    expect(togglePage(held(['t2']), page).selection.ids).toEqual(page);
  });

  it('clears when every loaded row is already ticked', () => {
    const page = rows.slice(0, 5);

    expect(togglePage(held(page), page).selection).toEqual(NO_SELECTION);
  });

  it('takes the first fifty of a longer page and says so', () => {
    const { selection, capped } = togglePage(NO_SELECTION, rows);

    expect(selection.ids).toEqual(rows.slice(0, SELECTION_CAP));
    expect(capped).toBe(true);
  });

  it('clears again from the capped state instead of re-ticking', () => {
    const capped = togglePage(NO_SELECTION, rows).selection;

    expect(togglePage(capped, rows).selection).toEqual(NO_SELECTION);
  });

  it('does nothing for an empty page', () => {
    expect(togglePage(NO_SELECTION, [])).toEqual({ selection: NO_SELECTION, capped: false });
  });
});

describe('headerState', () => {
  it.each([
    [[], 'none'],
    [['t1'], 'some'],
    [['t1', 't2', 't3'], 'all'],
  ] as const)('is %j -> %s on a page of three', (ids, expected) => {
    expect(headerState(held([...ids]), rows.slice(0, 3))).toBe(expected);
  });

  it('is all at the cap on a page longer than it', () => {
    expect(headerState(held(rows.slice(0, SELECTION_CAP)), rows)).toBe('all');
  });
});

describe('keepListed', () => {
  it('drops ids that left the list and the anchor with them', () => {
    expect(keepListed(held(['t1', 'gone'], 'gone'), rows)).toEqual({ ids: ['t1'], anchor: null });
  });

  it('returns the same object when nothing left, so state does not churn', () => {
    const same = held(['t1', 't2']);

    expect(keepListed(same, rows)).toBe(same);
  });
});
