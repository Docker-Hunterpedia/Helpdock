import { expect, it } from 'vitest';
import { validatedImportCursor } from './cursor.js';

it('retains absent optional state, explicit nulls and native string IDs across a queue round trip', () => {
  const checkpoint = {
    stage: 'history',
    ticket: { id: '90071992547409931234' },
    scan: null,
    ids: ['0', '1'],
  };
  expect(JSON.parse(JSON.stringify(validatedImportCursor(checkpoint)))).toEqual(checkpoint);
});

it.each([
  ['undefined property', { nested: { missing: undefined } }],
  ['NaN', { count: Number.NaN }],
  ['infinity', { count: Number.POSITIVE_INFINITY }],
  ['undefined array item', { ids: [undefined] }],
  ['bigint', { count: 1n }],
  ['Date object', { date: new Date('2020-01-01T00:00:00Z') }],
])(
  'refuses a checkpoint that would change meaning during JSON serialization: %s',
  (_name, checkpoint) => {
    expect(() => validatedImportCursor(checkpoint)).toThrow(
      expect.objectContaining({ code: 'invalid-response' }),
    );
  },
);
