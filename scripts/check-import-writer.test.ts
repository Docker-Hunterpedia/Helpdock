import { expect, it } from 'vitest';
import { findImportWriterViolations } from './check-import-writer.ts';

it.each([
  "import { TicketsService as Hidden } from '../../tickets/tickets.service.js';",
  "export { Helper } from '../side-effect.js';",
  "import { sendMail } from '@helpdock/channels';",
  "import * as channels from '@helpdock/channels';",
  "const hook = await import('../hooks.js');",
  'globalThis.fetch(url);',
  'enqueueContactCreated(tx, person);',
])('refuses a live side-effect path even when it is aliased: %s', (source) => {
  expect(findImportWriterViolations(source).length).toBeGreaterThan(0);
});
it('allows reviewed pure dependencies and does not mistake historical text or comments for calls', () => {
  expect(
    findImportWriterViolations(
      "import { sanitizeMessageBody } from '@helpdock/channels'; import { tickets } from '@helpdock/db'; // TicketsService is never called\nconst body = 'fetch';",
    ),
  ).toEqual([]);
});
