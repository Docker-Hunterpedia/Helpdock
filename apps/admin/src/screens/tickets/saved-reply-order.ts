import type { Macro } from '@helpdock/schemas';

/**
 * The order and the match of the saved replies and macros the composer offers
 * after `/` and in the picker (M14-14).
 *
 * **Most used first, yours before the brand's.** A person's own items come
 * before the shared ones, because they put them there; within each, the one
 * used most recently, then the one used most often, then by name. An item never
 * used sorts after one that has been.
 */

const time = (macro: Macro): number =>
  macro.lastUsedAt === null ? 0 : Date.parse(macro.lastUsedAt);

export const sortByUse = (macros: readonly Macro[]): Macro[] =>
  [...macros].sort(
    (a, b) =>
      Number(b.scope === 'personal') - Number(a.scope === 'personal') ||
      time(b) - time(a) ||
      b.useCount - a.useCount ||
      a.name.localeCompare(b.name),
  );

const rank = (macro: Macro, needle: string): number => {
  if (needle === '') {
    return 0;
  }
  const shortcut = macro.shortcut ?? '';
  if (shortcut === needle) {
    return 0;
  }
  if (shortcut.startsWith(needle)) {
    return 1;
  }

  return macro.name.toLowerCase().includes(needle) ? 2 : -1;
};

/**
 * What `/query` offers: the exact shortcut first, then shortcuts that start with
 * it, then names that contain it, each group in {@link sortByUse} order.
 */
export const matchSavedReplies = (macros: readonly Macro[], query: string): Macro[] => {
  const needle = query.trim().toLowerCase();
  const ranked = sortByUse(macros)
    .map((macro) => ({ macro, rank: rank(macro, needle) }))
    .filter((entry) => entry.rank >= 0);

  // Array.prototype.sort is stable, so the use order survives within a rank.
  return ranked.sort((a, b) => a.rank - b.rank).map((entry) => entry.macro);
};

/** The item `/word` names exactly, if any; a personal one wins over a shared one. */
export const byShortcut = (macros: readonly Macro[], word: string): Macro | undefined => {
  const needle = word.trim().toLowerCase();

  return needle === '' ? undefined : sortByUse(macros).find((macro) => macro.shortcut === needle);
};
