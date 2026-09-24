import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as client from './client.js';
import * as index from './index.js';
import * as migrate from './migrate.js';
import * as rls from './rls.js';
import * as roles from './roles.js';
import * as schema from './schema/index.js';
import * as settingsStore from './settings-store.js';
import * as tenant from './tenant.js';
import * as ticketNumbers from './ticket-numbers.js';
import * as ticketStatuses from './ticket-statuses.js';
import * as uuid from './uuid.js';

const modules: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'client.ts': client,
  'migrate.ts': migrate,
  'rls.ts': rls,
  'roles.ts': roles,
  'settings-store.ts': settingsStore,
  'tenant.ts': tenant,
  'ticket-numbers.ts': ticketNumbers,
  'ticket-statuses.ts': ticketStatuses,
  'uuid.ts': uuid,
};

const sourceFilesIn = (directory: URL): string[] =>
  readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.includes('.test.') &&
        entry.name !== 'index.ts',
    )
    .map((entry) => entry.name)
    .sort();

describe('@helpdock/db', () => {
  it('has an entry point that knows about every module in the package', () => {
    expect(sourceFilesIn(new URL('.', import.meta.url))).toEqual(Object.keys(modules).sort());
  });

  it('re-exports every public name, so consumers import from @helpdock/db alone', () => {
    for (const [file, module] of Object.entries({ ...modules, 'schema/index.ts': schema })) {
      for (const name of Object.keys(module)) {
        expect(index, `${file} exports ${name}`).toHaveProperty(name);
      }
    }
  });

  it('has a schema barrel that knows about every table file', () => {
    expect(sourceFilesIn(new URL('schema/', import.meta.url))).toEqual([
      'accounts.ts',
      'assignment.ts',
      'attachments.ts',
      'audit-log.ts',
      'blocked-senders.ts',
      'brand-domains.ts',
      'brands.ts',
      'contact-duplicate-suggestions.ts',
      'contact-identities.ts',
      'contact-notes.ts',
      'contacts.ts',
      'custom-field-defs.ts',
      'departments.ts',
      'enums.ts',
      'job-receipts.ts',
      'outbox.ts',
      'settings.ts',
      'tags.ts',
      'team-members.ts',
      'teams.ts',
      'ticket-activity.ts',
      'ticket-messages.ts',
      'ticket-statuses.ts',
      'ticket-templates.ts',
      'tickets.ts',
      'tsvector.ts',
      'user-brand-roles.ts',
      'users.ts',
    ]);
  });
});
