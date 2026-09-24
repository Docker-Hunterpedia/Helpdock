import type { StaffMember } from '@helpdock/schemas';

/**
 * Who the staff ids on a ticket belong to.
 *
 * A ticket carries `assigneeId` and no name, so a screen has to resolve it,
 * and **`GET /brands/:id/staff` declares `staff:manage`**, which an Agent does
 * not hold. The assignee picker therefore reads M1-07's
 * `GET /brands/:id/assignment/:departmentId/assignable` (`ticket:write`)
 * instead; the staff read is still what names the people on list rows, and for
 * an Agent it may come back empty.
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
 * The name the assignee picker's button shows. The picker's own read (M1-07's
 * `assignable`) names everybody who can work the department; somebody outside
 * it — assigned before a move, or before their scope narrowed — is named from
 * the staff read if it has them, and otherwise drawn as a shortened id, so the
 * button shows what the ticket actually says instead of reading as unassigned.
 */
export const assigneeName = (
  assigneeId: string | null,
  sources: {
    readonly agents: readonly { readonly userId: string; readonly name: string }[];
    readonly staff: readonly StaffMember[];
    readonly viewer: { readonly id: string; readonly name: string };
  },
): string | null => {
  if (assigneeId === null) {
    return null;
  }
  if (assigneeId === sources.viewer.id) {
    return sources.viewer.name;
  }

  return (
    sources.agents.find((agent) => agent.userId === assigneeId)?.name ??
    sources.staff.find((member) => member.userId === assigneeId)?.name ??
    shortId(assigneeId)
  );
};
