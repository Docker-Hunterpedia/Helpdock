import { uuidv7 } from '@helpdock/db';
import { expect, it } from 'vitest';
import { fieldLoadSchema } from './field-contracts.js';

const base = {
  brandId: uuidv7(),
  runId: uuidv7(),
  source: 'zendesk',
  record: {
    externalId: 'field',
    target: 'organization',
    key: 'vendor-field',
    label: 'Field',
    type: 'textarea',
  },
};

it('maps organization fields to account definitions and leaves source vocabulary intact', () => {
  const parsed = fieldLoadSchema.parse({
    ...base,
    mapping: {
      kind: 'create',
      definition: { target: 'account', key: 'historical_field', label: 'Field', type: 'text' },
    },
  });
  expect(parsed.record).toEqual(base.record);
  expect(parsed.mapping.kind).toBe('create');
});

it.each([
  ['wrong target', { target: 'contact', key: 'field', label: 'Field', type: 'text' }],
  ['unsafe key', { target: 'account', key: '__proto__', label: 'Field', type: 'text' }],
  [
    'duplicate choices',
    { target: 'account', key: 'field', label: 'Field', type: 'select', options: ['same', 'same'] },
  ],
  ['oversized label', { target: 'account', key: 'field', label: 'x'.repeat(121), type: 'text' }],
])('refuses a confirmed definition with %s', (_scenario, definition) => {
  expect(
    fieldLoadSchema.safeParse({ ...base, mapping: { kind: 'create', definition } }).success,
  ).toBe(false);
});
