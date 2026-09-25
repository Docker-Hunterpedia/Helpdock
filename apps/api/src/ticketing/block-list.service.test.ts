import type { Settings } from '@helpdock/config';
import type { BlockedSender as BlockedSenderRow, DbTransaction } from '@helpdock/db';
import { type BrandSettings, defaultBrandSettings } from '@helpdock/schemas';
import { describe, expect, it, vi } from 'vitest';
import type { BlockedSenderWithAuthor, BlockListRepository } from './block-list.repository.js';
import { BlockListService } from './block-list.service.js';
import type { SenderKey } from './block-rules.js';
import { BRAND, contextFor, fakeTransaction } from './service-fakes.js';

/**
 * The block list's rules with the repository faked: what is refused, what is
 * normalised, what is audited. `ticketing.integration.test.ts` proves the rows
 * commit under the brand's policy.
 */

const NOW = new Date('2026-09-24T10:00:00.000Z');

const fakeSettings = (values: Record<string, string> = {}): Settings =>
  ({
    get: vi.fn(async (key: string) => values[key] ?? ''),
  }) as unknown as Settings;

const harness = ({
  settings = fakeSettings({ 'smtp.from': 'Support@Helpdock.com' }),
  domains = ['help.acme.test'],
  brand = defaultBrandSettings(),
}: {
  readonly settings?: Settings;
  readonly domains?: readonly string[];
  readonly brand?: BrandSettings;
} = {}) => {
  const rows: BlockedSenderRow[] = [];
  const saved: BrandSettings[] = [];

  const withAuthor = (sender: BlockedSenderRow): BlockedSenderWithAuthor => ({
    sender,
    createdByName: 'Lina',
  });

  const repository = {
    list: vi.fn(async () => rows.map(withAuthor)),
    find: vi.fn(async (_tx: DbTransaction, id: string) => {
      const found = rows.find((row) => row.id === id);
      return found === undefined ? undefined : withAuthor(found);
    }),
    matching: vi.fn(async (_tx: DbTransaction, _brand: string, keys: readonly SenderKey[]) =>
      rows.filter((row) => keys.some((key) => key.kind === row.kind && key.value === row.value)),
    ),
    insert: vi.fn(async (_tx: DbTransaction, values: Partial<BlockedSenderRow>) => {
      if (rows.some((row) => row.kind === values.kind && row.value === values.value)) {
        return undefined;
      }
      const row = {
        id: `0199f4b2-0000-7000-8000-00000000000${rows.length}`,
        brandId: BRAND,
        createdBy: null,
        sourceTicketId: null,
        droppedCount: 0,
        lastDroppedAt: null,
        createdAt: NOW,
        ...values,
      } as BlockedSenderRow;
      rows.push(row);
      return row;
    }),
    delete: vi.fn(async (_tx: DbTransaction, id: string) => {
      rows.splice(
        rows.findIndex((row) => row.id === id),
        1,
      );
    }),
    brandDomains: vi.fn(async () => [...domains]),
    brandSettings: vi.fn(async () => brand),
    updateBrandSettings: vi.fn(async (_tx: DbTransaction, _brand: string, next: BrandSettings) => {
      saved.push(next);
    }),
  };

  const { tx, audit } = fakeTransaction();
  const service = new BlockListService(repository as unknown as BlockListRepository, settings);

  return { service, context: contextFor(tx), tx, audit, rows, saved, repository };
};

describe('blocking a sender from the Spam tab', () => {
  it('stores the normalised spelling and names who added it', async () => {
    const { service, context, audit } = harness();

    const created = await service.create(context, { kind: 'domain', value: '@Promo-Deals.BIZ' });

    expect(created).toMatchObject({
      kind: 'domain',
      value: 'promo-deals.biz',
      createdByName: 'Lina',
      droppedCount: 0,
      lastDroppedAt: null,
      createdAt: NOW.toISOString(),
    });
    // The kind and never the value: the audit log outlives the block.
    expect(audit).toEqual([
      expect.objectContaining({ action: 'blocked_sender.created', meta: { kind: 'domain' } }),
    ]);
  });

  it('refuses a value that is not what its kind says', async () => {
    const { service, context } = harness();

    await expect(
      service.create(context, { kind: 'email', value: 'not an address' }),
    ).rejects.toMatchObject({ reason: 'sender-invalid', status: 400 });
  });

  it('completes a national phone number with the install’s calling code', async () => {
    const { service, context } = harness({
      settings: fakeSettings({ 'contacts.defaultCallingCode': '963' }),
    });

    const created = await service.create(context, { kind: 'phone', value: '0931 234 567' });

    expect(created.value).toBe('+963931234567');
  });

  it('refuses the domain the brand sends from, as the artboard’s error shows', async () => {
    const { service, context } = harness();

    await expect(
      service.create(context, { kind: 'domain', value: 'helpdock.com' }),
    ).rejects.toMatchObject({ reason: 'sender-is-own', status: 409 });
  });

  it('refuses a brand hostname from brand_domains', async () => {
    const { service, context } = harness();

    await expect(
      service.create(context, { kind: 'domain', value: 'acme.test' }),
    ).rejects.toMatchObject({ reason: 'sender-is-own' });
  });

  it('allows any domain when the install has no From address yet', async () => {
    const { service, context } = harness({ settings: fakeSettings(), domains: [] });

    await expect(
      service.create(context, { kind: 'domain', value: 'helpdock.com' }),
    ).resolves.toMatchObject({ value: 'helpdock.com' });
  });

  it('refuses a sender that is already blocked', async () => {
    const { service, context } = harness();
    await service.create(context, { kind: 'email', value: 'spam@promo-deals.biz' });

    await expect(
      service.create(context, { kind: 'email', value: 'SPAM@promo-deals.biz' }),
    ).rejects.toMatchObject({ reason: 'sender-already-blocked' });
  });
});

describe('blocking a sender from a ticket', () => {
  const TICKET = '0199f4b2-0000-7000-8000-0000000000aa';

  it('records the ticket it came from', async () => {
    const { service, context, rows, audit } = harness();

    await service.blockFromTicket(
      context,
      { kind: 'email', value: 'spam@promo-deals.biz' },
      TICKET,
    );

    expect(rows[0]).toMatchObject({ sourceTicketId: TICKET });
    expect(audit[0]?.meta).toEqual({ kind: 'email', sourceTicketId: TICKET });
  });

  it('answers the existing row rather than refusing a second block of the same sender', async () => {
    const { service, context, rows } = harness();
    const first = await service.blockFromTicket(
      context,
      { kind: 'email', value: 'spam@promo-deals.biz' },
      TICKET,
    );

    const second = await service.blockFromTicket(
      context,
      { kind: 'email', value: 'spam@promo-deals.biz' },
      TICKET,
    );

    expect(second).toBe(first);
    expect(rows).toHaveLength(1);
  });

  it('refuses the brand’s own address', async () => {
    const { service, context } = harness();

    await expect(
      service.blockFromTicket(context, { kind: 'email', value: 'support@helpdock.com' }, TICKET),
    ).rejects.toMatchObject({ reason: 'sender-is-own' });
  });
});

describe('the rest of the tab', () => {
  it('lists every row with its author', async () => {
    const { service, context, tx } = harness();
    await service.create(context, { kind: 'telegram', value: '42' });

    const list = await service.list(tx);

    expect(list.senders.map((row) => [row.kind, row.value, row.createdByName])).toEqual([
      ['telegram', '42', 'Lina'],
    ]);
  });

  it('unblocks, and audits the counter the block had reached', async () => {
    const { service, context, rows, audit } = harness();
    const created = await service.create(context, { kind: 'telegram', value: '42' });
    const stored = rows[0];
    if (stored !== undefined) {
      stored.droppedCount = 9;
    }

    await service.remove(context, created.id);

    expect(rows).toEqual([]);
    expect(audit.at(-1)).toMatchObject({
      action: 'blocked_sender.deleted',
      meta: { kind: 'telegram', droppedCount: 9 },
    });
  });

  it('answers 404 for a row that is not this brand’s', async () => {
    const { service, context } = harness();

    await expect(
      service.remove(context, '0199f4b2-0000-7000-8000-0000000000ff'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('turns the "Offer Block sender" setting off, keeping every other setting', async () => {
    const { service, context, saved, audit } = harness();

    const next = await service.updateSettings(context, { offerBlockSender: false });

    expect(next).toEqual({ ...defaultBrandSettings(), offerBlockSender: false });
    expect(saved).toEqual([next]);
    expect(audit[0]).toMatchObject({ action: 'brand.spam_settings.updated' });
  });

  it('says whether a sender is listed, and whether it is the brand’s own', async () => {
    const { service, context, tx } = harness();
    await service.create(context, { kind: 'email', value: 'spam@promo-deals.biz' });

    expect(
      await service.isListed(tx, BRAND, { kind: 'email', value: 'spam@promo-deals.biz' }),
    ).toBe(true);
    expect(await service.isOwn(tx, { kind: 'email', value: 'lina@helpdock.com' })).toBe(true);
  });
});
