import type { ContactSummary, StaffMember } from '@helpdock/schemas';

/**
 * Who the ids on a ticket belong to.
 *
 * A ticket carries `assigneeId` and `contactId` and no names, so a screen has
 * to resolve them. Two things make that awkward, and both are recorded here
 * rather than in a component:
 *
 * 1. **`GET /brands/:id/staff` declares `staff:manage`**, which an Agent does
 *    not hold — so the one screen that most needs a list of colleagues is the
 *    one least able to read it. The picker degrades to the people it can name:
 *    nobody, the viewer themselves, and whoever the read did return for an
 *    Admin or Team Leader. M1-07 owns assignment and is where an
 *    "assignable agents" read belongs.
 * 2. **Contacts are a page, not a map.** The contact list answers the first
 *    page for the brand, so a row whose contact is further down is left without
 *    a name rather than given a wrong one. The real fix is the ticket list
 *    embedding its contact, which is a change to M1-02's response.
 *
 * Both gaps are visible rather than papered over: an unresolved id is drawn as
 * a shortened id, never as "Unknown" and never as somebody else.
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

export const contactNamesOf = (contacts: readonly ContactSummary[]): ReadonlyMap<string, string> =>
  new Map(contacts.map((contact) => [contact.id, contact.name]));

export const contactAddressesOf = (
  contacts: readonly ContactSummary[],
): ReadonlyMap<string, string> =>
  new Map(
    contacts
      .filter((contact) => contact.primaryIdentity !== null)
      .map((contact) => [contact.id, contact.primaryIdentity?.value ?? '']),
  );
