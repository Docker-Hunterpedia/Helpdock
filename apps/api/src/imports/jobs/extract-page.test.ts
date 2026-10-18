import { expect, it } from 'vitest';
import { extractionCheckpointsSchema } from './extract-page.js';

it.each([
  { cursor: null, done: false },
  { cursor: { after: 'next-page' }, done: true },
  { cursor: { after: 'next-page' }, done: false, deltaCursor: { after: 'premature' } },
  { cursor: null, done: true, cycle: { anchor: 'a'.repeat(64), power: 2, distance: 0 } },
])('refuses an inconsistent persisted checkpoint %j', (checkpoint) => {
  expect(extractionCheckpointsSchema.safeParse({ ticket: checkpoint }).success).toBe(false);
});
