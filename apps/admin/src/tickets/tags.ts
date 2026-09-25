import type { Tag, TagSummary } from '@helpdock/schemas';

/**
 * The client half of `PUT /tickets/:id/tags` (M1-06, M1-15): the api takes the
 * whole set a ticket should carry afterwards, so every chip the details panel
 * adds or removes is turned into that set here, and the chips drawn before the
 * answer arrives are worked out from it.
 */

/** The set after one pick: on if it was off, off if it was on. */
export const toggleTag = (current: readonly string[], tagId: string): string[] =>
  current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId];

/** Whether two sets name the same tags, whatever their order. A no-op is not sent. */
export const sameTagSet = (a: readonly string[], b: readonly string[]): boolean => {
  const held = new Set(a);

  return held.size === new Set(b).size && b.every((id) => held.has(id));
};

/**
 * The chips to draw for `tagIds` until the api answers, in the brand's own tag
 * order because that is the order the answer will come back in.
 *
 * A tag is looked up on the ticket first and in the brand's list second. The
 * ticket's copy is what was drawn a moment ago; the list is where a tag just
 * picked comes from. An id found in neither is dropped rather than drawn as a
 * blank chip: the api would refuse it anyway.
 */
export const tagsForIds = (
  tagIds: readonly string[],
  onTicket: readonly Tag[],
  brandTags: readonly TagSummary[],
): Tag[] => {
  const rank = new Map(brandTags.map((tag, index) => [tag.id, index]));
  const found: Tag[] = [];

  for (const id of tagIds) {
    const tag = onTicket.find((held) => held.id === id) ?? brandTags.find((row) => row.id === id);
    if (tag !== undefined) {
      found.push({ id: tag.id, name: tag.name, nameAr: tag.nameAr, color: tag.color });
    }
  }

  // A tag the list no longer has sorts last, where a stale chip is least in the way.
  const order = (tag: Tag): number => rank.get(tag.id) ?? brandTags.length;

  return found.sort((a, b) => order(a) - order(b));
};

/** The name a desk in `locale` draws: the Arabic one when there is one. */
export const tagLabel = (tag: Pick<Tag, 'name' | 'nameAr'>, locale: string): string =>
  locale === 'ar' && tag.nameAr !== null ? tag.nameAr : tag.name;

/** The picker's search: either name, case-insensitive, anywhere in it. */
export const tagMatches = (tag: Pick<Tag, 'name' | 'nameAr'>, term: string): boolean => {
  const needle = term.trim().toLocaleLowerCase();

  return (
    needle === '' ||
    tag.name.toLocaleLowerCase().includes(needle) ||
    (tag.nameAr?.toLocaleLowerCase().includes(needle) ?? false)
  );
};

/** A ticket read with its chips replaced: what the cache holds while a save is out, and after. */
export const withTicketTags = <
  T extends { readonly ticket: { readonly tags?: Tag[] | undefined } },
>(
  detail: T,
  tags: Tag[],
): T => ({ ...detail, ticket: { ...detail.ticket, tags } });
