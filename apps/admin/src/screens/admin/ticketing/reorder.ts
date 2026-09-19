/**
 * Moving one item of an ordered list, which is what both the drag handle and
 * the "Move up" / "Move down" row actions do.
 *
 * It is a pure function on ids rather than a method on the table, because the
 * api takes the whole order (`POST …/departments/reorder`) and because the two
 * ways of asking for a move must produce the same list — a keyboard alternative
 * that drifts from the drag is worse than no keyboard alternative at all.
 */

/** Where an id is, or `-1`. */
export const positionOf = (ids: readonly string[], id: string): number => ids.indexOf(id);

/**
 * `ids` with `id` moved to `to`, clamped to the ends of the list. An id the
 * list does not contain, or a move that changes nothing, returns the same
 * array, so a caller can compare by identity and skip the request.
 */
export const moveTo = (ids: readonly string[], id: string, to: number): readonly string[] => {
  const from = positionOf(ids, id);
  const target = Math.min(Math.max(to, 0), ids.length - 1);
  if (from === -1 || from === target) {
    return ids;
  }

  const moved = [...ids];
  moved.splice(from, 1);
  moved.splice(target, 0, id);

  return moved;
};

/** `ids` with `id` moved `offset` places, negative for earlier in the list. */
export const moveBy = (ids: readonly string[], id: string, offset: number): readonly string[] => {
  const from = positionOf(ids, id);

  return from === -1 ? ids : moveTo(ids, id, from + offset);
};
