import { expect, it } from 'vitest';
import { importSourceLink } from './import-source-link.js';

it.each([
  [
    'https://support.example/agent/tickets/42?token=private#secret',
    'https://support.example/agent/tickets/42',
  ],
  ['http://legacy.example/ticket/0042', 'http://legacy.example/ticket/0042'],
  ['javascript:alert(1)', null],
  ['https://user:password@example.test/ticket/42', null],
  ['//example.test/ticket/42', null],
] as const)('exposes a navigation-only source link for %s', (value, expected) => {
  expect(importSourceLink(value)).toBe(expected);
});
