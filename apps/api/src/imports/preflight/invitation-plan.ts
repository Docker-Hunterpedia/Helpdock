import { type ImportRecord, normaliseEmail } from '@helpdock/schemas';

export type InvitationPlanIssue = {
  externalId: string;
  code: 'invite-source-invalid' | 'invite-email-duplicate';
};

/** Reused identities create no user; only proposed new invitations reserve an email. */
export function validateInvitationPlan(
  entries: readonly {
    user: Pick<
      Extract<ImportRecord, { entity: 'user' }>['payload'],
      'externalId' | 'kind' | 'email'
    >;
    reused: boolean;
  }[],
): InvitationPlanIssue[] {
  const issues: InvitationPlanIssue[] = [];
  const emails = new Map<string, string[]>();
  for (const { user, reused } of entries) {
    const email = user.email ? normaliseEmail(user.email) : null;
    if (user.kind !== 'agent' || !email?.ok) {
      issues.push({ externalId: user.externalId, code: 'invite-source-invalid' });
      continue;
    }
    if (reused) continue;
    const sources = emails.get(email.value) ?? [];
    sources.push(user.externalId);
    emails.set(email.value, sources);
  }
  for (const sources of emails.values())
    if (sources.length > 1)
      for (const externalId of sources) issues.push({ externalId, code: 'invite-email-duplicate' });
  return issues;
}
