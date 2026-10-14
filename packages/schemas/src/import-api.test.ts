import { expect, it } from 'vitest';
import { importConnectionRequestSchema, importRunCreateSchema } from './import-api.js';

it.each([
  { source: 'zendesk', mode: 'delta' },
  { source: 'zendesk', mode: 'full', parentRunId: '01900000-0000-7000-8000-000000000001' },
])('refuses an import mode with the wrong parent shape: $mode', (input) => {
  expect(importRunCreateSchema.safeParse(input).success).toBe(false);
});
it.each([
  '*.zendesk.com',
  'https://cdn.example.com',
  'cdn.example.com:443',
  'user:secret@cdn.example.com',
])('refuses non-host attachment destination %s', (host) => {
  expect(
    importConnectionRequestSchema.safeParse({
      credentials: { auth: 'oauth', subdomain: 'demo', accessToken: 'synthetic' },
      downloadHosts: [host],
    }).success,
  ).toBe(false);
});
it('accepts exact destinations and refuses credential injection into the account hostname', () => {
  const input = {
    credentials: { auth: 'oauth', subdomain: 'demo', accessToken: 'synthetic' },
    downloadHosts: ['cdn.example.com'],
  };
  expect(importConnectionRequestSchema.parse(input)).toEqual(input);
  expect(
    importConnectionRequestSchema.safeParse({
      ...input,
      credentials: { ...input.credentials, subdomain: 'demo.zendesk.com@other.example' },
    }).success,
  ).toBe(false);
});
