import type { DbTransaction } from '@helpdock/db';
import { HC_SLUG_MAX, slugify } from '@helpdock/schemas';
import type { HelpCenterRepository } from './help-center.repository.js';
import { HelpCenterFailure } from './help-center-failure.js';

type Kind = 'categories' | 'sections' | 'articles';

/** How many suffixes an automatic slug tries before giving up on the readable form. */
const MAX_SUFFIX = 50;

/**
 * The slug a row is stored under. One the person typed must be free, or the
 * change is refused (`slug-taken`); one derived from a name or title is made
 * free by a numeric suffix, because nobody chose it and a refusal would only
 * make them invent one.
 */
export const resolveSlug = async (
  tx: DbTransaction,
  repository: HelpCenterRepository,
  kind: Kind,
  {
    chosen,
    from,
    fallback,
    exceptId,
  }: {
    readonly chosen: string | undefined;
    readonly from: string;
    readonly fallback: string;
    readonly exceptId?: string;
  },
): Promise<string> => {
  if (chosen !== undefined) {
    if (await repository.slugTaken(tx, kind, chosen, exceptId)) {
      throw new HelpCenterFailure('slug-taken');
    }
    return chosen;
  }

  const base = slugify(from, fallback);
  for (let attempt = 1; attempt <= MAX_SUFFIX; attempt += 1) {
    const suffix = attempt === 1 ? '' : `-${attempt}`;
    const candidate = `${base.slice(0, HC_SLUG_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!(await repository.slugTaken(tx, kind, candidate, exceptId))) {
      return candidate;
    }
  }
  throw new HelpCenterFailure('slug-taken');
};
