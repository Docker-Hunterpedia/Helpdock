import { z } from 'zod';
import { ConnectorError } from '../errors.js';
import type { ZohoDeskClient } from './client.js';
import { zohoIdSchema } from './contracts.js';

const exportPermission = z.object({ view: z.boolean(), export: z.boolean() });
const profileSchema = z.object({
  type: z.string(),
  permissions: z.object({
    tickets: exportPermission,
    contacts: exportPermission,
    accounts: exportPermission,
    kbCategory: exportPermission,
    setup: z.object({ fetchAcrossDepartment: z.boolean(), recycleBin: z.boolean() }),
    agents: z.object({ viewAllFields: z.boolean() }),
  }),
});
const idPage = z.object({ data: z.array(z.object({ id: zohoIdSchema })).max(1) });

/** A permission-profile ID is not an agent ID, and an organization token alone cannot prove complete export access. */
export async function probeZohoExport(client: ZohoDeskClient): Promise<void> {
  const profile = await client.json('/api/v1/myProfile', profileSchema);
  if (
    profile.type !== 'Administrator' ||
    !profile.permissions.setup.fetchAcrossDepartment ||
    !profile.permissions.setup.recycleBin ||
    !profile.permissions.agents.viewAllFields ||
    [
      profile.permissions.tickets,
      profile.permissions.contacts,
      profile.permissions.accounts,
      profile.permissions.kbCategory,
    ].some((permission) => !permission.view || !permission.export)
  )
    throw new ConnectorError('credentials-refused');
  for (const collection of ['tickets', 'contacts', 'accounts'])
    await client.list(`/api/v1/${collection}`, idPage, {
      from: '0',
      limit: '1',
      sortBy: 'createdTime',
    });
  await client.list('/api/v1/agents', idPage, {
    from: '0',
    limit: '1',
    status: 'ACTIVE',
    include: 'profile,role',
    sortOrder: 'asc',
  });
  const departments = await client.list('/api/v1/departments', idPage, {
    from: '0',
    limit: '1',
    isEnabled: 'true',
  });
  const department = departments.data[0];
  if (department)
    await client.list('/api/v1/tickets/archivedTickets', idPage, {
      from: '0',
      limit: '1',
      departmentId: department.id,
      viewType: '1',
    });
  for (const module of ['tickets', 'contacts', 'accounts'])
    await client.list(
      '/api/v1/fields',
      z.object({ data: z.array(z.object({ id: zohoIdSchema })).max(10000) }),
      { module },
    );
  const now = new Date().toISOString();
  await client.list('/api/v1/tickets/search', idPage, {
    from: '0',
    limit: '1',
    sortBy: 'modifiedTime',
    modifiedTimeRange: `${now},${now}`,
  });
  await client.list('/api/v1/kbRootCategories', idPage, {
    from: '1',
    limit: '1',
    sortBy: 'order',
    status: 'SHOW_IN_HELPCENTER',
    isTrashed: 'false',
  });
  await client.list('/api/v1/articles', idPage, {
    limit: '1',
    sortBy: 'createdTime',
    status: 'Published',
  });
  for (const path of [
    '/api/v1/kbCategory/trashedCategories',
    '/api/v1/articleTranslations/trashedTranslations',
  ])
    await client.list(path, idPage, { from: '1', limit: '1', sortBy: 'deletedTime' });
  await client.list('/api/v1/customerHappiness', idPage, {
    department: 'allDepartment',
    from: '0',
    limit: '1',
    sortBy: 'ratedtime',
    startTime: '0',
    endTime: String(Date.now()),
  });
}
