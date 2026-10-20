import type { DbTransaction } from '@helpdock/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readV1Contact } from '../api-v1/v1-contact-view.js';
import { enqueueWebhookEvent } from '../webhooks/enqueue-webhook-event.js';
import { withContactProfileChange } from './contact-profile-change.js';

vi.mock('../api-v1/v1-contact-view.js', () => ({ readV1Contact: vi.fn() }));
vi.mock('../webhooks/enqueue-webhook-event.js', () => ({ enqueueWebhookEvent: vi.fn() }));
const profile = {
  id: 'contact',
  name: 'Mona',
  externalId: null,
  locale: null,
  timezone: null,
  identities: [],
  createdAt: '2026-10-20T00:00:00Z',
  updatedAt: '2026-10-20T00:00:00Z',
};
const tx = {
  select: () => ({ from: () => ({ where: () => ({ for: async () => [{ brandId: 'brand' }] }) }) }),
} as unknown as DbTransaction;
beforeEach(() => vi.resetAllMocks());
describe('withContactProfileChange', () => {
  it('ignores timestamps and returns the write result', async () => {
    vi.mocked(readV1Contact)
      .mockResolvedValueOnce(profile)
      .mockResolvedValueOnce({ ...profile, updatedAt: '2026-10-21T00:00:00Z' });
    expect(await withContactProfileChange(tx, profile.id, async () => 42)).toBe(42);
    expect(enqueueWebhookEvent).not.toHaveBeenCalled();
  });
  it.each(['name', 'externalId', 'locale', 'timezone', 'identities'] as const)(
    'publishes a changed %s',
    async (field) => {
      const after = {
        ...profile,
        name: field === 'name' ? 'Mona Khalil' : profile.name,
        externalId: field === 'externalId' ? 'customer-42' : null,
        locale: field === 'locale' ? ('ar' as const) : null,
        timezone: field === 'timezone' ? 'Asia/Riyadh' : null,
        identities:
          field === 'identities'
            ? [{ kind: 'email' as const, value: 'mona@example.test', verified: false }]
            : [],
      };
      vi.mocked(readV1Contact).mockResolvedValueOnce(profile).mockResolvedValueOnce(after);
      await withContactProfileChange(tx, profile.id, async () => undefined);
      expect(enqueueWebhookEvent).toHaveBeenCalledExactlyOnceWith(tx, 'brand', 'contact.updated', {
        contactId: profile.id,
        departmentId: null,
      });
    },
  );
  it('does not publish a failed mutation', async () => {
    vi.mocked(readV1Contact).mockResolvedValueOnce(profile);
    await expect(
      withContactProfileChange(tx, profile.id, async () => {
        throw new Error('write failed');
      }),
    ).rejects.toThrow('write failed');
    expect(enqueueWebhookEvent).not.toHaveBeenCalled();
  });
});
