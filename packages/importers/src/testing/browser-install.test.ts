import { expect, it } from 'vitest';
import {
  importBrowserInstallSchema,
  importBrowserReadySchema,
  importBrowserSnapshotSchema,
} from './browser-install.js';

const config = {
  databaseUrl: 'postgres://helpdock_app:synthetic@127.0.0.1:5432/test',
  migrationUrl: 'postgres://test:synthetic@localhost:5432/test',
  redisUrl: 'redis://127.0.0.1:6379',
  webOrigin: 'http://localhost:5286',
  apiPort: 3097,
  directory: '/tmp/disposable-import-browser',
  controlKey: 'a'.repeat(64),
};

it('accepts local runtime/owner endpoints without returning unvalidated IPC fields', () => {
  expect(importBrowserInstallSchema.parse(config)).toEqual(config);
  expect(importBrowserInstallSchema.safeParse({ ...config, unexpected: true }).success).toBe(false);
});

it('keeps transport and database evidence explicit without exposing private rows', () => {
  const snapshot = {
    tickets: 1,
    messages: 2,
    files: 1,
    retained_credentials: 0,
    managedBytesMatch: true,
    sourceReadOnly: true,
    unexpectedOutbox: 0,
    sends: { smtp: 0, webhook: 0, telegram: 0, graph: 0 },
    inert: {
      workflow_runs: 0,
      ticket_sla_clocks: 0,
      notifications: 0,
      ai_calls: 0,
      webhook_deliveries: 0,
    },
  };
  expect(importBrowserSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  expect(importBrowserSnapshotSchema.safeParse({ ...snapshot, tickets: -1 }).success).toBe(false);
  expect(
    importBrowserSnapshotSchema.safeParse({ ...snapshot, credentialsEncrypted: 'internal' })
      .success,
  ).toBe(false);
});

it.each([
  { databaseUrl: 'postgres://postgres:synthetic@127.0.0.1/test' },
  { migrationUrl: 'postgres://test:synthetic@db.example.invalid/test' },
  { redisUrl: 'redis://cache.example.invalid' },
  { webOrigin: 'https://app.example.invalid' },
  { apiPort: 0 },
  { controlKey: 'short' },
])('refuses non-local or invalid install configuration: %j', (override) => {
  expect(importBrowserInstallSchema.safeParse({ ...config, ...override }).success).toBe(false);
});

it('refuses a ready message containing unrelated internal configuration', () => {
  const id = '0193b000-0000-7000-8000-000000000901';
  const ready = {
    type: 'ready',
    brandId: id,
    userId: id,
    departmentId: id,
    tagId: id,
    email: 'fixture@example.invalid',
    password: 'synthetic password',
    totpSecret: 'SYNTHETIC',
    controlOrigin: 'http://127.0.0.1:3096',
  };
  expect(importBrowserReadySchema.parse(ready)).toEqual(ready);
  expect(
    importBrowserReadySchema.safeParse({ ...ready, databaseUrl: config.databaseUrl }).success,
  ).toBe(false);
});
