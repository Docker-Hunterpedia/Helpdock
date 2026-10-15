import { expect, it } from 'vitest';
import { extractionCheckpointsSchema } from './extract-page.js';

it.each([
  { cursor: null, done: false },
  { cursor: { after: 'next-page' }, done: true },
  { cursor: { after: 'next-page' }, done: false, deltaCursor: { after: 'premature' } },
])('refuses an inconsistent persisted checkpoint %j', (checkpoint) => {
  expect(extractionCheckpointsSchema.safeParse({ ticket: checkpoint }).success).toBe(false);
});
