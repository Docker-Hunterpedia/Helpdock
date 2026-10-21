import { BULK_MAX_TICKETS } from '@helpdock/schemas';

/**
 * Which rows of the list are ticked (M14-04), as pure functions so the range
 * rules are proven without a screen.
 *
 * The selection is a set of ticket ids plus the **anchor**, the row last
 * ticked, which `Shift`+`x` and Shift-click select the range from. At most
 * {@link BULK_MAX_TICKETS} may be ticked, because that is what one bulk request
 * carries; an action that would go over takes what fits, in list order, and
 * says it was capped.
 */

export interface Selection {
  /** In the order they were ticked. */
  readonly ids: readonly string[];
  /** The row last toggled or ranged to, or null before any. */
  readonly anchor: string | null;
}

export interface SelectionChange {
  readonly selection: Selection;
  /** The action wanted more rows than the cap allows and took what fit. */
  readonly capped: boolean;
}

export const NO_SELECTION: Selection = { ids: [], anchor: null };

export const SELECTION_CAP = BULK_MAX_TICKETS;

const take = (current: readonly string[], more: readonly string[]): string[] => {
  const room = SELECTION_CAP - current.length;
  const fresh = more.filter((id) => !current.includes(id));

  return [...current, ...fresh.slice(0, Math.max(0, room))];
};

/** Ticks a row that is off and unticks one that is on. */
export function toggle(selection: Selection, id: string): SelectionChange {
  if (selection.ids.includes(id)) {
    return {
      selection: { ids: selection.ids.filter((held) => held !== id), anchor: id },
      capped: false,
    };
  }
  if (selection.ids.length >= SELECTION_CAP) {
    return { selection, capped: true };
  }

  return { selection: { ids: [...selection.ids, id], anchor: id }, capped: false };
}

/**
 * Ticks every row from the anchor to `id`, both included, in list order. With
 * no anchor, or an anchor that has left the list, it ticks `id` alone. Rows
 * already ticked stay ticked; the range is added, never subtracted.
 */
export function range(
  selection: Selection,
  id: string,
  listed: readonly string[],
): SelectionChange {
  const to = listed.indexOf(id);
  const from = selection.anchor === null ? -1 : listed.indexOf(selection.anchor);
  if (to === -1) {
    return { selection, capped: false };
  }
  if (from === -1) {
    return toggleOn(selection, id);
  }

  const [low, high] = from <= to ? [from, to] : [to, from];
  // Walk away from the anchor, so a range too long for the cap keeps the rows nearest it.
  const slice = listed.slice(low, high + 1);
  const ordered = from <= to ? slice : [...slice].reverse();
  const ids = take(selection.ids, ordered);

  return {
    selection: { ids, anchor: id },
    capped: ordered.some((row) => !ids.includes(row)),
  };
}

const toggleOn = (selection: Selection, id: string): SelectionChange =>
  selection.ids.includes(id)
    ? { selection: { ...selection, anchor: id }, capped: false }
    : toggle(selection, id);

export type HeaderState = 'none' | 'some' | 'all';

export const headerState = (selection: Selection, listed: readonly string[]): HeaderState => {
  const ticked = listed.filter((id) => selection.ids.includes(id)).length;
  if (ticked === 0) {
    return 'none';
  }

  // At the cap the header reads as full: there is nothing more it could tick.
  return ticked === listed.length || ticked >= SELECTION_CAP ? 'all' : 'some';
};

/** The header checkbox: every loaded row up to the cap, or nothing when all of them are ticked. */
export function togglePage(selection: Selection, listed: readonly string[]): SelectionChange {
  if (headerState(selection, listed) === 'all') {
    return { selection: NO_SELECTION, capped: false };
  }
  const ids = take([], listed);

  return {
    selection: { ids, anchor: ids.at(-1) ?? null },
    capped: listed.length > ids.length,
  };
}

/** Drops ids that are no longer in the list, so a count never names a row the person cannot see. */
export function keepListed(selection: Selection, listed: readonly string[]): Selection {
  const ids = selection.ids.filter((id) => listed.includes(id));
  if (ids.length === selection.ids.length) {
    return selection;
  }

  return {
    ids,
    anchor:
      selection.anchor !== null && listed.includes(selection.anchor) ? selection.anchor : null,
  };
}
