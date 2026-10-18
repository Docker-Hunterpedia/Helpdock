import { expect, it } from 'vitest';
import { advanceImportTokenCycle, initialImportTokenCycle } from './pagination-token.js';

it.each([
  { tokens: ['a'] },
  { tokens: ['a', 'b'] },
  { tokens: ['a', 'b', 'c'] },
  { tokens: ['a', 'b', 'c', 'd', 'e'] },
])(
  'detects a repeating continuation cycle with constant checkpoint space: $tokens',
  ({ tokens: cycle }) => {
    let state = initialImportTokenCycle();
    let refused = false;
    for (let i = 0; i < 100; i++) {
      try {
        state = advanceImportTokenCycle(
          JSON.parse(JSON.stringify(state)),
          cycle[i % cycle.length] ?? '',
        );
      } catch (error) {
        expect(error).toMatchObject({ code: 'invalid-response' });
        refused = true;
        break;
      }
    }
    expect(refused).toBe(true);
  },
);

it('allows a long changing stream without accumulating source tokens in its checkpoint', () => {
  let state = initialImportTokenCycle();
  for (let i = 0; i < 10000; i++) state = advanceImportTokenCycle(state, `source-token-${i}`);
  expect(Object.keys(state).sort()).toEqual(['anchor', 'distance', 'power']);
  expect(JSON.stringify(state).length).toBeLessThan(150);
  expect(JSON.stringify(state)).not.toContain('source-token-');
});

it('continues beyond the old two-million-page counter ceiling without expanding checkpoint space', () => {
  const state = { anchor: 'a'.repeat(64), power: 2097152, distance: 2097151 };
  const next = advanceImportTokenCycle(state, 'new-source-page');
  expect(next).toMatchObject({ power: 4194304, distance: 0 });
  expect(JSON.stringify(next).length).toBeLessThan(150);
});
