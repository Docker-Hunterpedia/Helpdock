import type { MentionCandidate, PresenceMap } from '@helpdock/schemas';
import { MENTION_CANDIDATES_MAX } from '@helpdock/schemas';
import { canSeeDepartment, mentionHandles, resolveMention, type StaffFacts } from './recipients.js';

/**
 * Who the `@` picker offers on a ticket (M14-15), as pure functions over what
 * the repository has read.
 *
 * **Only people who can see the ticket's department.** `canSeeDepartment` is the
 * rule the notification fan-out applies to a mention, so a person the picker
 * offers is a person who will be told, and a person outside the department is
 * never listed (DOMAIN-RULES §1.2). Deactivated staff and the writer are left
 * out.
 *
 * **The handle is one that resolves back to that person.** The notification
 * path reads `@handle` with `resolveMention` over the brand's staff; the picker
 * offers the first spelling it would resolve to this person (email name, full
 * name, first name), and omits anybody none of them names alone, since text that
 * tells the wrong colleague, or nobody, is worse than a missing row.
 */

const fold = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('en');

const spellings = (member: StaffFacts): readonly string[] => [
  member.email.split('@')[0] ?? '',
  member.name.replace(/\s+/gu, ''),
  member.name.trim().split(/\s+/u)[0] ?? '',
];

/** The handle to write for `member`, or undefined when no spelling names them alone. */
export const handleFor = (
  member: StaffFacts,
  everyone: readonly StaffFacts[],
): string | undefined =>
  spellings(member).find((spelling) => {
    // It has to survive the same parsing a note goes through, not just resolve.
    const [parsed] = mentionHandles(`@${spelling}`);

    return (
      parsed !== undefined &&
      parsed === fold(spelling) &&
      resolveMention(spelling, everyone)?.userId === member.userId
    );
  });

const PRESENCE_ORDER = { online: 0, away: 1, offline: 2 } as const;

export const mentionCandidates = ({
  members,
  departmentId,
  actorId,
  presence,
  query,
}: {
  readonly members: readonly StaffFacts[];
  readonly departmentId: string;
  readonly actorId: string;
  readonly presence: PresenceMap;
  readonly query: string;
}): MentionCandidate[] => {
  const needle = fold(query.trim().replace(/^@/u, ''));

  return members
    .filter((member) => member.userId !== actorId && canSeeDepartment(member, departmentId))
    .flatMap((member) => {
      const handle = handleFor(member, members);
      if (handle === undefined) {
        return [];
      }
      if (needle !== '' && !fold(`${member.name} ${handle}`).includes(needle)) {
        return [];
      }

      return [
        {
          userId: member.userId,
          name: member.name,
          handle,
          presence: presence[member.userId] ?? ('offline' as const),
        },
      ];
    })
    .sort(
      (a, b) =>
        PRESENCE_ORDER[a.presence] - PRESENCE_ORDER[b.presence] || a.name.localeCompare(b.name),
    )
    .slice(0, MENTION_CANDIDATES_MAX);
};
