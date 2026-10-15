import {
  type ImportMapping,
  importMappingSchema,
  MAX_CUSTOM_FIELDS_PER_TARGET,
} from '@helpdock/schemas';
import { expect, it } from 'vitest';
import { validateFieldCreationPlan } from './field-creation-plan.js';

const field = (externalId: string, key: string, target = 'ticket'): ImportMapping =>
  importMappingSchema.parse({
    kind: 'field',
    externalValue: externalId,
    target: { kind: 'create', definition: { target, key, label: key, type: 'text' } },
  });
it('rejects two individually valid mappings that would create the same destination key', () => {
  expect(
    validateFieldCreationPlan([field('first', 'shared'), field('second', 'shared')], [], new Map()),
  ).toEqual([
    { externalId: 'first', code: 'field-key-conflict' },
    { externalId: 'second', code: 'field-key-conflict' },
  ]);
});
it('evaluates capacity for the whole batch before any field is provisioned', () => {
  const existing = Array.from({ length: MAX_CUSTOM_FIELDS_PER_TARGET - 1 }, (_, index) => ({
    id: `field-${index}`,
    target: 'ticket' as const,
    key: `existing_${index}`,
  }));
  expect(
    validateFieldCreationPlan([field('first', 'one'), field('second', 'two')], existing, new Map()),
  ).toEqual([
    { externalId: 'first', code: 'field-capacity' },
    { externalId: 'second', code: 'field-capacity' },
  ]);
});
it('does not count repeated source bindings as new fields or mix target namespaces', () => {
  const existing = [{ id: 'known', target: 'ticket' as const, key: 'shared' }];
  expect(
    validateFieldCreationPlan(
      [field('repeated', 'shared'), field('contact', 'shared', 'contact')],
      existing,
      new Map([['repeated', 'known']]),
    ),
  ).toEqual([]);
});
it('blocks a deleted or wrong-entity binding instead of silently recreating it', () => {
  expect(
    validateFieldCreationPlan(
      [field('repeated', 'shared')],
      [{ id: 'known', target: 'contact', key: 'shared' }],
      new Map([['repeated', 'known']]),
    ),
  ).toEqual([{ externalId: 'repeated', code: 'field-binding-missing' }]);
});

it('blocks two source fields mapped to the same existing destination', () => {
  const id = '01900000-0000-7000-8000-000000000001';
  const mappings = ['one', 'two'].map((externalValue) =>
    importMappingSchema.parse({
      kind: 'field',
      externalValue,
      target: { kind: 'existing', fieldId: id },
    }),
  );
  expect(
    validateFieldCreationPlan(mappings, [{ id, target: 'ticket', key: 'shared' }], new Map()),
  ).toEqual([
    { externalId: 'one', code: 'field-key-conflict' },
    { externalId: 'two', code: 'field-key-conflict' },
  ]);
});

it('refuses redirecting a previously imported source field to another existing field', () => {
  const first = '01900000-0000-7000-8000-000000000001';
  const second = '01900000-0000-7000-8000-000000000002';
  const mapping = importMappingSchema.parse({
    kind: 'field',
    externalValue: 'source',
    target: { kind: 'existing', fieldId: second },
  });
  expect(
    validateFieldCreationPlan(
      [mapping],
      [
        { id: first, target: 'ticket', key: 'first' },
        { id: second, target: 'ticket', key: 'second' },
      ],
      new Map([['source', first]]),
    ),
  ).toEqual([{ externalId: 'source', code: 'field-binding-conflict' }]);
});
