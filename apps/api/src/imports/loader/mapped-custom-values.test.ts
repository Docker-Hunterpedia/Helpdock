import type { CustomFieldRule } from '@helpdock/schemas';
import { expect, it } from 'vitest';
import { type ImportedFieldBinding, mappedImportedCustom } from './mapped-custom-values.js';

const number: CustomFieldRule = { key: 'amount', type: 'number', required: true, options: [] };
const binding: ImportedFieldBinding = {
  source: {
    externalId: 'ticket:801',
    target: 'ticket',
    key: '801',
    label: 'Amount',
    type: 'number',
  },
  destination: number,
};
const request = { bindings: [binding], definitions: [number], operation: 'create' as const };

it('maps native numeric IDs to destination keys using normal coercion while preserving explicit clears on patch', () => {
  expect(mappedImportedCustom({ ...request, custom: { '801': '12.5' } })).toEqual({ amount: 12.5 });
  expect(mappedImportedCustom({ ...request, operation: 'patch', custom: { '801': null } })).toEqual(
    { amount: null },
  );
});

it('drops only explicitly skipped values and rejects unknown source keys', () => {
  const skip = { ...binding, destination: null };
  expect(
    mappedImportedCustom({
      bindings: [skip],
      definitions: [],
      operation: 'create',
      custom: { '801': { nested: 'Original value' } },
    }),
  ).toEqual({});
  expect(() => mappedImportedCustom({ ...request, custom: { unknown: 12 } })).toThrow(
    'mapping-invalid',
  );
});

it.each(['source', 'destination'] as const)(
  'rejects ambiguous %s mappings even when a source value is absent',
  (kind) => {
    const duplicate = {
      ...binding,
      source: {
        ...binding.source,
        externalId: 'ticket:802',
        key: kind === 'source' ? '801' : '802',
      },
    };
    expect(() =>
      mappedImportedCustom({
        ...request,
        bindings: [binding, duplicate],
        operation: 'patch',
        custom: {},
      }),
    ).toThrow('mapping-invalid');
  },
);

it('blocks required values missing after mapping and values outside destination choices', () => {
  expect(() => mappedImportedCustom({ ...request, custom: {} })).toThrow();
  const choice: CustomFieldRule = {
    key: 'region',
    type: 'select',
    required: false,
    options: ['north'],
  };
  expect(() =>
    mappedImportedCustom({
      bindings: [{ ...binding, destination: choice }],
      definitions: [choice],
      operation: 'create',
      custom: { '801': 'south' },
    }),
  ).toThrow();
});
