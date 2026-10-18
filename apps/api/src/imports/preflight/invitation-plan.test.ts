import { importUserSchema } from '@helpdock/schemas';
import { expect, it } from 'vitest';
import { validateInvitationPlan } from './invitation-plan.js';

const user = (externalId: string, email: string) =>
  importUserSchema.parse({ externalId, email, kind: 'agent', name: externalId, active: true });
it('blocks case-insensitive duplicate new invitations before either user is created', () => {
  expect(
    validateInvitationPlan([
      { user: user('first', 'PERSON@example.com'), reused: false },
      { user: user('second', 'person@EXAMPLE.COM'), reused: false },
    ]),
  ).toEqual([
    { externalId: 'first', code: 'invite-email-duplicate' },
    { externalId: 'second', code: 'invite-email-duplicate' },
  ]);
});
it('does not reserve changed source emails for identities that are already bound', () => {
  expect(
    validateInvitationPlan([
      { user: user('reused', 'person@example.com'), reused: true },
      { user: user('new', 'person@example.com'), reused: false },
    ]),
  ).toEqual([]);
});
it('refuses a non-agent or missing invitation email even for a reused source', () => {
  const missing = importUserSchema.parse({
    externalId: 'missing',
    kind: 'agent',
    name: 'Missing',
    active: true,
  });
  expect(
    validateInvitationPlan([
      { user: missing, reused: true },
      { user: { ...user('customer', 'customer@example.com'), kind: 'customer' }, reused: false },
    ]),
  ).toEqual([
    { externalId: 'missing', code: 'invite-source-invalid' },
    { externalId: 'customer', code: 'invite-source-invalid' },
  ]);
});
