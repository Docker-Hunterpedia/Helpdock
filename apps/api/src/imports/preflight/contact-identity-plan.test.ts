import { expect, it } from 'vitest';
import { validateContactIdentityPlan } from './contact-identity-plan.js';

const entry = (externalId: string, values: string[]) => ({
  externalId,
  action: 'create' as const,
  contactId: null,
  identifiers: values.map((value) => ({ kind: 'email' as const, value })),
});
it('blocks newly proposed contacts sharing an identifier without exposing that identifier', () => {
  expect(
    validateContactIdentityPlan([
      entry('first', ['person@example.test']),
      entry('second', ['person@example.test']),
    ]),
  ).toEqual([
    { externalId: 'first', code: 'contact-plan-ambiguous' },
    { externalId: 'second', code: 'contact-plan-ambiguous' },
  ]);
});
it('permits two source aliases already linked to the same local person', () => {
  const entries = [
    entry('first', ['person@example.test']),
    entry('second', ['person@example.test']),
  ].map((item) => ({
    ...item,
    action: 'link' as const,
    contactId: '01900000-0000-7000-8000-000000000001',
  }));
  expect(validateContactIdentityPlan(entries)).toEqual([]);
});
it('does not reserve historical identifiers for an unchanged receipt', () => {
  expect(
    validateContactIdentityPlan([
      {
        ...entry('old', ['person@example.test']),
        action: 'unchanged',
        contactId: '01900000-0000-7000-8000-000000000001',
      },
      entry('new', ['person@example.test']),
    ]),
  ).toEqual([]);
});
it('marks every participant in overlapping identities once', () => {
  expect(
    validateContactIdentityPlan([
      entry('first', ['one@example.test']),
      entry('middle', ['one@example.test', 'two@example.test']),
      entry('last', ['two@example.test']),
    ]),
  ).toEqual([
    { externalId: 'first', code: 'contact-plan-ambiguous' },
    { externalId: 'middle', code: 'contact-plan-ambiguous' },
    { externalId: 'last', code: 'contact-plan-ambiguous' },
  ]);
});
