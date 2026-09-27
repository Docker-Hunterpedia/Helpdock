import {
  NOTIFICATION_PREFERENCE_DEFAULTS,
  type NotificationChannels,
  type NotificationKind,
  type NotificationPreferences,
} from '@helpdock/schemas';

/**
 * Who is told about what (M3-07), as pure functions over facts the repository
 * has already read, so every rule here is provable without a database.
 *
 * Three rules hold for every kind:
 *
 * - **Only about tickets they can see.** A recipient must hold a role in the
 *   brand whose department scope covers the ticket's department — the same
 *   scope the ticket's row policy applies (DOMAIN-RULES §1.2). A mention of
 *   somebody outside that scope tells them nothing, which is §1.2's own
 *   example.
 * - **Deactivated staff get nothing** (DOMAIN-RULES §12).
 * - **Nobody is told about what they did themselves.** Assigning a ticket to
 *   yourself, or mentioning yourself, is not news.
 */

export interface StaffFacts {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly departmentIds: readonly string[] | 'all';
  readonly deactivated: boolean;
}

/** Whether a member of the brand may see a ticket in `departmentId`. */
export const canSeeDepartment = (staff: StaffFacts, departmentId: string): boolean =>
  !staff.deactivated &&
  (staff.departmentIds === 'all' || staff.departmentIds.includes(departmentId));

/**
 * The people out of `candidateIds` who should hear about a ticket in
 * `departmentId`: members of the brand, active, able to see it, and not the
 * actor. Order is kept and duplicates are dropped, so a person who is both the
 * assignee and on the escalated team is told once.
 */
export const eligibleRecipients = ({
  candidateIds,
  members,
  departmentId,
  actorId,
}: {
  readonly candidateIds: readonly string[];
  readonly members: readonly StaffFacts[];
  readonly departmentId: string;
  readonly actorId: string | null;
}): readonly StaffFacts[] => {
  const byId = new Map(members.map((member) => [member.userId, member]));
  const seen = new Set<string>();
  const out: StaffFacts[] = [];

  for (const id of candidateIds) {
    const member = byId.get(id);
    if (
      member === undefined ||
      seen.has(id) ||
      id === actorId ||
      !canSeeDepartment(member, departmentId)
    ) {
      continue;
    }
    seen.add(id);
    out.push(member);
  }

  return out;
};

// ---------------------------------------------------------------- mentions

/**
 * `@` followed by letters, digits, `.`, `_` or `-`, in any script — `@Lina`,
 * `@لينا`, `@lina.haddad`. The `@` must not follow a word character, so an
 * email address in a note is not a mention of its local part.
 */
const MENTION = /(?<![\p{L}\p{N}_.])@([\p{L}\p{N}][\p{L}\p{N}._-]*)/gu;

const fold = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('en');

/** The handles written in `text`, folded, in order of first appearance, trailing dots trimmed. */
export const mentionHandles = (text: string): readonly string[] => {
  const handles = new Set<string>();
  for (const match of text.matchAll(MENTION)) {
    const handle = fold((match[1] ?? '').replace(/[._-]+$/u, ''));
    if (handle !== '') {
      handles.add(handle);
    }
  }

  return [...handles];
};

/**
 * Who `@handle` names, among the brand's staff. Three spellings are accepted,
 * most specific first, and the first that names somebody wins:
 *
 * 1. the part of their email before the `@` (`@lina.haddad`);
 * 2. their whole name without spaces (`@LinaHaddad`);
 * 3. their first name (`@Lina`), **only when exactly one person has it** — a
 *    note that says `@Omar` in a brand with two Omars tells neither, rather
 *    than telling the wrong one about a conversation they are not in.
 *
 * There is no autocomplete in the composer (no artboard draws one), so this is
 * the whole contract; `docs/guides/notifications.md` states it.
 */
export const resolveMention = (
  handle: string,
  staff: readonly StaffFacts[],
): StaffFacts | undefined => {
  const folded = fold(handle);
  const byEmail = staff.filter((member) => fold(member.email.split('@')[0] ?? '') === folded);
  if (byEmail.length === 1) {
    return byEmail[0];
  }

  const byFullName = staff.filter((member) => fold(member.name.replace(/\s+/gu, '')) === folded);
  if (byFullName.length === 1) {
    return byFullName[0];
  }

  const byFirstName = staff.filter(
    (member) => fold(member.name.trim().split(/\s+/u)[0] ?? '') === folded,
  );

  return byFirstName.length === 1 ? byFirstName[0] : undefined;
};

/** Every staff member `text` mentions, resolved, in order of first mention. */
export const mentionedStaff = (
  text: string,
  staff: readonly StaffFacts[],
): readonly StaffFacts[] => {
  const found = new Map<string, StaffFacts>();
  for (const handle of mentionHandles(text)) {
    const member = resolveMention(handle, staff);
    if (member !== undefined && !found.has(member.userId)) {
      found.set(member.userId, member);
    }
  }

  return [...found.values()];
};

// ------------------------------------------------------------- channels

export interface ChannelChoice extends NotificationChannels {
  /** True when at least one channel is on, i.e. a row is worth writing. */
  readonly any: boolean;
}

/**
 * What a person's preferences say for this kind, narrowed by what the install
 * can do: push is off when no VAPID key pair is configured, whatever the
 * preference says, so no job is queued that could only fail.
 */
export const channelsFor = (
  preferences: NotificationPreferences | undefined,
  kind: NotificationKind,
  { pushConfigured }: { readonly pushConfigured: boolean },
): ChannelChoice => {
  const chosen = (preferences ?? NOTIFICATION_PREFERENCE_DEFAULTS)[kind];
  const push = chosen.push && pushConfigured;

  return { ...chosen, push, any: chosen.inApp || chosen.email || push };
};
