import type { AccountPortal, AccountPortalUpdate, PortalVisibility } from '@helpdock/schemas';

/**
 * The small decisions the portal sections of the account and contact pages make
 * about what to print and what to send (M21-06). In a module of their own so
 * they are read, and tested, without rendering anything.
 */

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60],
  ['month', 30 * 24 * 60 * 60],
  ['week', 7 * 24 * 60 * 60],
  ['day', 24 * 60 * 60],
  ['hour', 60 * 60],
  ['minute', 60],
];

/**
 * "2 days ago", "today", "قبل يومين". Latin digits in both languages, as the
 * artboard draws them (DESIGN §7); `now` is passed so the result is a function
 * of its inputs.
 */
export const relativeWhen = (iso: string, now: number, locale: string): string => {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const formatter = new Intl.RelativeTimeFormat(`${locale}-u-nu-latn`, { numeric: 'auto' });
  const absolute = Math.abs(seconds);
  for (const [unit, size] of UNITS) {
    if (absolute >= size) {
      return formatter.format(Math.round(seconds / size), unit);
    }
  }

  return formatter.format(0, 'day');
};

/** The members' draft: the chosen setting and who is ticked as a company manager. */
export interface AccountPortalDraft {
  readonly visibility: PortalVisibility;
  readonly managerIds: readonly string[];
}

export const accountDraftOf = (portal: AccountPortal): AccountPortalDraft => ({
  visibility: portal.visibility,
  managerIds: portal.members.filter((member) => member.role === 'manager').map((m) => m.contactId),
});

export const accountDraftChanged = (draft: AccountPortalDraft, stored: AccountPortal): boolean => {
  const base = accountDraftOf(stored);

  return (
    draft.visibility !== base.visibility ||
    draft.managerIds.length !== base.managerIds.length ||
    draft.managerIds.some((id) => !base.managerIds.includes(id))
  );
};

/** Choosing Managers or All members is what shows the coworkers' support history to each other. */
export const sharesHistory = (visibility: PortalVisibility): boolean => visibility !== 'own';

export const accountRequestOf = (draft: AccountPortalDraft): AccountPortalUpdate => ({
  visibility: draft.visibility,
  managerContactIds: [...draft.managerIds],
});
