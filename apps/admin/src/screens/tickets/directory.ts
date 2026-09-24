import type { StaffMember } from '@helpdock/schemas';

/**
 * Who the staff ids on a ticket belong to.
 *
 * A ticket carries `assigneeId` and no name, so a screen has to resolve it,
 * and **`GET /brands/:id/staff` declares `staff:manage`**, which an Agent does
 * not hold — so the one screen that most needs a list of colleagues is the one
 * least able to read it. The picker degrades to the people it can name:
 * nobody, the viewer themselves, and whoever the read did return for an Admin
 * or Team Leader. M1-07 owns assignment and is where an "assignable agents"
 * read belongs.
 *
 * The gap is visible rather than papered over: an unresolved id is drawn as a
 * shortened id, never as "Unknown" and never as somebody else. Contacts no
 * longer pass through here: the ticket embeds its contact's name (M1-15).
 */

/** `0192c3f0…c1`: enough to tell two ids apart, short enough for a row. */
export const shortId = (id: string): string => {
  const compact = id.replaceAll('-', '');

  return compact.length <= 8 ? compact : `${compact.slice(0, 4)}…${compact.slice(-2)}`;
};

/**
 * The people the assignee picker offers: the viewer, then everybody the staff
 * read returned, then — when the ticket is assigned to somebody neither of
 * those name — that person as a shortened id, so the select can show what the
 * ticket actually says instead of silently reading as unassigned.
 */
export const assignableStaff = (
  members: readonly StaffMember[],
  viewer: { readonly id: string; readonly name: string },
  assigneeId: string | null,
): readonly { readonly userId: string; readonly name: string }[] => {
  const offered = members
    .filter((member) => member.status === 'active')
    .map((member) => ({ userId: member.userId, name: member.name }));

  if (!offered.some((member) => member.userId === viewer.id)) {
    offered.unshift({ userId: viewer.id, name: viewer.name });
  }

  if (assigneeId !== null && !offered.some((member) => member.userId === assigneeId)) {
    offered.push({ userId: assigneeId, name: shortId(assigneeId) });
  }

  return offered;
};
