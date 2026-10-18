import { expect, it } from 'vitest';
import { occurrenceKeys } from './occurrence-keys.js';

it('keeps duplicate source issues distinct without remounting them after an unrelated insertion', () => {
  const issues = [
    { code: 'missing', id: '42' },
    { code: 'missing', id: '42' },
  ];
  const identify = (issue: (typeof issues)[number]) => JSON.stringify(issue);
  const before = occurrenceKeys(issues, identify);
  expect(new Set(before.map((row) => row.key)).size).toBe(2);
  expect(occurrenceKeys([{ code: 'invalid', id: '43' }, ...issues], identify).slice(1)).toEqual(
    before,
  );
});
