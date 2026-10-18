import { expect, it } from 'vitest';
import { zohoValueMapping } from './mappings.js';

it.each([
  ['priority', 'Low', 'low'],
  ['priority', 'Medium', 'medium'],
  ['priority', 'High', 'high'],
  ['channel', 'EMAIL', 'email'],
  ['channel', 'Chat', 'chat'],
  ['channel', 'Phone', 'manual'],
  ['channel', 'FACEBOOK', 'manual'],
  ['channel', 'TWITTER', 'manual'],
  ['channel', 'Forums', 'manual'],
] as const)(
  'proposes a reviewed %s mapping for %s without inventing a live source channel account',
  (kind, source, target) => {
    expect(zohoValueMapping(kind, source)).toEqual({
      kind,
      externalValue: source,
      target: { [kind]: target },
    });
  },
);
it.each([
  ['priority', 'Custom escalation'],
  ['channel', 'TEST_WA_CHANNEL_4'],
] as const)('keeps custom %s value %s unmapped for explicit review', (kind, value) => {
  expect(zohoValueMapping(kind, value)).toBeNull();
});
