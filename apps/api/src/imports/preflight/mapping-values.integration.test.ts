import {
  brands,
  createDb,
  customFieldDefs,
  type DbHandle,
  departments,
  importMappings,
  importRecords,
  importRuns,
  runMigrations,
  teams,
  ticketStatuses,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import type { ImportMappingTargetsQuery, ImportMappingValuesQuery } from '@helpdock/schemas';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDocker, startPostgres } from '../../testing/meta-install.js';
import { importMappingTargetChoices } from './mapping-target-choices.js';
import { importMappingValues } from './mapping-values.js';

const BRAND = uuidv7();
const OTHER_BRAND = uuidv7();
const USER = uuidv7();
const RUN = uuidv7();
const CLOSED = uuidv7();
const FOREIGN_STATUS = uuidv7();
const DEPARTMENT = uuidv7();
const TEAM = uuidv7();
const REGION = uuidv7();

describe.skipIf(!hasDocker)('M11 mapping values destination labels', () => {
  let postgres: StartedPostgreSqlContainer;
  let owner: DbHandle;
  let app: DbHandle;

  const scope = { brandId: BRAND, runId: RUN };
  const values = (query: ImportMappingValuesQuery) =>
    withSystem(app.db, BRAND, (tx) => importMappingValues(tx, scope, query));
  const targets = (query: ImportMappingTargetsQuery) =>
    withSystem(app.db, BRAND, (tx) => importMappingTargetChoices(tx, scope, query));

  beforeAll(async () => {
    postgres = await startPostgres();
    await runMigrations({
      migrationUrl: postgres.getConnectionUri(),
      appRolePassword: 'mapping-values-tests',
      log: () => {},
    });
    owner = createDb({ url: postgres.getConnectionUri(), max: 1 });
    const runtimeUrl = new URL(postgres.getConnectionUri());
    runtimeUrl.username = 'helpdock_app';
    runtimeUrl.password = 'mapping-values-tests';
    app = createDb({ url: runtimeUrl.toString(), max: 1 });
    await owner.db
      .insert(users)
      .values({ id: USER, email: 'mapper@example.test', name: 'Mapper', status: 'active' });
    await owner.db.insert(brands).values([
      { id: BRAND, name: 'Mapping', prefix: 'MAP' },
      { id: OTHER_BRAND, name: 'Other', prefix: 'OTH' },
    ]);
    await owner.db.insert(ticketStatuses).values([
      {
        id: CLOSED,
        brandId: BRAND,
        name: 'Closed',
        nameAr: 'مغلقة',
        systemState: 'closed',
        color: 'success',
      },
      {
        id: FOREIGN_STATUS,
        brandId: OTHER_BRAND,
        name: 'Foreign closed',
        systemState: 'closed',
        color: 'success',
      },
    ]);
    await owner.db.insert(departments).values({ id: DEPARTMENT, brandId: BRAND, name: 'Support' });
    await owner.db
      .insert(teams)
      .values({ id: TEAM, brandId: BRAND, departmentId: DEPARTMENT, name: 'Billing' });
    await owner.db.insert(importRuns).values({
      id: RUN,
      brandId: BRAND,
      source: 'zendesk',
      status: 'awaiting_mapping',
      startedBy: USER,
    });
    const tickets = [
      { externalId: '1', status: 'closed', priority: 'urgent', groupExternalId: 'billing' },
      { externalId: '2', status: 'foreign', priority: 'urgent', groupExternalId: 'billing' },
    ];
    const field = { externalId: 'ticket-region', target: 'ticket', type: 'textarea' };
    await owner.db.insert(importRecords).values([
      ...tickets.map((payload) => ({
        brandId: BRAND,
        runId: RUN,
        entity: 'ticket' as const,
        externalId: payload.externalId,
        payload,
        payloadHash: hashImportValue(payload),
      })),
      {
        brandId: BRAND,
        runId: RUN,
        entity: 'field' as const,
        externalId: field.externalId,
        payload: field,
        payloadHash: hashImportValue(field),
      },
    ]);
    await owner.db.insert(customFieldDefs).values([
      {
        id: REGION,
        brandId: BRAND,
        target: 'ticket',
        key: 'region',
        label: 'Region',
        type: 'text',
      },
      { brandId: BRAND, target: 'contact', key: 'region', label: 'Region', type: 'text' },
    ]);
    // Written by the owner to model a stale row naming another brand's status.
    await owner.db.insert(importMappings).values([
      {
        brandId: BRAND,
        runId: RUN,
        kind: 'status',
        externalValue: 'closed',
        target: { statusId: CLOSED },
      },
      {
        brandId: BRAND,
        runId: RUN,
        kind: 'status',
        externalValue: 'foreign',
        target: { statusId: FOREIGN_STATUS },
      },
      {
        brandId: BRAND,
        runId: RUN,
        kind: 'group',
        externalValue: 'billing',
        target: { departmentId: DEPARTMENT, teamId: TEAM },
      },
    ]);
  }, 300000);

  afterAll(async () => {
    await app?.close();
    await owner?.close();
    await postgres?.stop();
  });

  it('names confirmed destinations of this brand only, with their Arabic names', async () => {
    const page = await values({ kind: 'status', limit: 50 });
    expect(page.values.map((row) => [row.externalValue, row.confirmedChoice])).toEqual([
      [
        'closed',
        {
          id: CLOSED,
          label: 'Closed',
          nameAr: 'مغلقة',
          detail: null,
          selection: { kind: 'status', externalValue: 'closed', target: { statusId: CLOSED } },
        },
      ],
      ['foreign', null],
    ]);
  });

  it('names a confirmed team with its department as detail', async () => {
    const group = await values({ kind: 'group', limit: 50 });
    expect(group.values[0]?.confirmedChoice).toMatchObject({
      id: `team:${TEAM}`,
      label: 'Billing',
      detail: 'Support',
    });
  });

  it('names a proposed destination when nothing is confirmed', async () => {
    const priority = await values({ kind: 'priority', limit: 50 });
    expect(priority.values[0]).toMatchObject({
      confirmedChoice: null,
      proposedChoice: {
        id: 'urgent',
        label: 'urgent',
        selection: { kind: 'priority', externalValue: 'urgent', target: { priority: 'urgent' } },
      },
    });
  });

  it('finds a destination by searching its id', async () => {
    const byId = await targets({
      kind: 'status',
      externalValue: 'closed',
      search: CLOSED,
      limit: 50,
    });
    expect(byId.choices.map((choice) => choice.label)).toEqual(['Closed']);
  });

  it('offers only custom fields compatible with the staged source field', async () => {
    const fields = await targets({
      kind: 'field',
      externalValue: 'ticket-region',
      search: '',
      limit: 50,
    });
    expect(fields.choices.map((choice) => choice.selection)).toEqual([
      {
        kind: 'field',
        externalValue: 'ticket-region',
        target: { kind: 'existing', fieldId: REGION },
      },
    ]);
  });
});
