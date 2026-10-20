/**
 * What the palette remembers (M14-05): the last things this person opened,
 * kept in this browser as ids and nothing else. No subject, name or title is
 * stored; the palette re-reads each one through the api when it opens, so a
 * ticket the person can no longer see simply drops out, and a rename shows.
 *
 * Per person and brand, so two people sharing a browser, or one in two
 * brands, keep their own. Storage can be missing or refuse (a private window,
 * blocked site data), so every access is wrapped and the palette works
 * without it.
 */

export type RecentKind = 'ticket' | 'contact' | 'page';

export interface Recent {
  readonly kind: RecentKind;
  readonly id: string;
}

export const RECENTS_LIMIT = 8;

const KINDS: readonly RecentKind[] = ['ticket', 'contact', 'page'];

export const recentsKey = (userId: string, brandId: string): string =>
  `helpdock.palette.recents.${userId}.${brandId}`;

const isRecent = (value: unknown): value is Recent => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { kind, id } = value as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 200 &&
    KINDS.includes(kind as RecentKind)
  );
};

export function readRecents(userId: string, brandId: string): readonly Recent[] {
  try {
    const raw = globalThis.localStorage?.getItem(recentsKey(userId, brandId));
    const parsed: unknown = raw === null || raw === undefined ? [] : JSON.parse(raw);
    // Only the two fields are read back, so nothing else a tampered value
    // carries reaches the palette.
    return Array.isArray(parsed)
      ? parsed
          .filter(isRecent)
          .map(({ kind, id }) => ({ kind, id }))
          .slice(0, RECENTS_LIMIT)
      : [];
  } catch {
    return [];
  }
}

const write = (userId: string, brandId: string, recents: readonly Recent[]): void => {
  try {
    globalThis.localStorage?.setItem(recentsKey(userId, brandId), JSON.stringify(recents));
  } catch {
    // The list is a convenience; a full or blocked store loses it, nothing else.
  }
};

/** Puts `recent` first, once, and keeps the newest {@link RECENTS_LIMIT}. */
export function remember(userId: string, brandId: string, recent: Recent): readonly Recent[] {
  const next = [
    recent,
    ...readRecents(userId, brandId).filter(
      (candidate) => candidate.kind !== recent.kind || candidate.id !== recent.id,
    ),
  ].slice(0, RECENTS_LIMIT);
  write(userId, brandId, next);
  return next;
}

/** Drops what the api no longer shows this person. */
export function forget(userId: string, brandId: string, gone: readonly Recent[]): void {
  if (gone.length === 0) {
    return;
  }
  write(
    userId,
    brandId,
    readRecents(userId, brandId).filter(
      (candidate) => !gone.some(({ kind, id }) => kind === candidate.kind && id === candidate.id),
    ),
  );
}
