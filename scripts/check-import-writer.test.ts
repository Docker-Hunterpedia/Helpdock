import { expect, it } from 'vitest';
import {
  findImportLifecycleViolations,
  findImportWriterViolations,
} from './check-import-writer.ts';

it.each([
  "import { TicketsService as Hidden } from '../tickets/tickets.service.js';",
  'ReplyDeliveryHook.onReply(context);',
  'globalThis.fetch(url);',
  'enqueueContactCreated(tx, profile);',
  "const hidden = await import('../tickets/tickets.service.js');",
])('refuses forbidden hooks outside the writer, including jobs/connectors: %s', (source) => {
  expect(findImportLifecycleViolations(source).length).toBeGreaterThan(0);
});

it('permits the reviewed outbox scheduling mechanism and safe HTTP client outside the writer', () => {
  expect(
    findImportLifecycleViolations(
      "await enqueueOutbox(tx, event); await safeFetch(url); // TicketsService\nconst body = 'fetch';",
    ),
  ).toEqual([]);
  expect(findImportWriterViolations('enqueueOutbox(tx, event);').length).toBeGreaterThan(0);
});

it.each([
  "import { TicketsService as Hidden } from '../../tickets/tickets.service.js';",
  "export { Helper } from '../side-effect.js';",
  "import { sendMail } from '@helpdock/channels';",
  "import * as channels from '@helpdock/channels';",
  "import { ImportHttp as HiddenHttp } from '@helpdock/importers';",
  "export * from '@helpdock/importers';",
  "import { publishVersion } from '../../help-center/help-center.repository.js';",
  "import { ObjectStorage } from '../../media/keys.js';",
  "import { registerObjectPurgeHandler } from '../../media/object-purge.js';",
  "import * as purge from '../../media/object-purge.js';",
  "const hook = await import('../hooks.js');",
  'globalThis.fetch(url);',
  'enqueueContactCreated(tx, person);',
])('refuses a live side-effect path even when it is aliased: %s', (source) => {
  expect(findImportWriterViolations(source).length).toBeGreaterThan(0);
});
it('allows reviewed pure dependencies and does not mistake historical text or comments for calls', () => {
  expect(
    findImportWriterViolations(
      "import { sanitizeMessageBody } from '@helpdock/channels'; import { hashImportValue as hash } from '@helpdock/importers'; import { HelpCenterRepository } from '../../help-center/help-center.repository.js'; import { resolveSlug } from '../../help-center/slugs.js'; import { attachmentKey } from '../../media/keys.js'; import { tickets } from '@helpdock/db'; // TicketsService is never called\nconst body = 'fetch';",
    ),
  ).toEqual([]);
});

it('allows only the reviewed transactional file cleanup helper within the writer', () => {
  expect(
    findImportWriterViolations(
      "import { enqueueObjectPurge as cleanup } from '../../media/object-purge.js'; await cleanup(tx, brandId, removed);",
    ),
  ).toEqual([]);
  expect(
    findImportWriterViolations("import { enqueueOutbox } from '@helpdock/jobs';").length,
  ).toBeGreaterThan(0);
});
