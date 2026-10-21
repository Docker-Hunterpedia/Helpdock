import type { Db, DbTransaction } from '@helpdock/db';
import type { PresenceMap } from '@helpdock/schemas';
import { describe, expect, it, vi } from 'vitest';
import { AgentCards } from './agent-cards.js';
import { OnlineAgents } from './online-agents.js';
import { resolveWidgetSettings } from './resolved-settings.js';
import type { StaffIdentityRow } from './widget.repository.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const LINA = '01937f5e-7e53-7000-8000-000000000001';
const KARIM = '01937f5e-7e53-7000-8000-000000000002';
const SARA = '01937f5e-7e53-7000-8000-000000000003';

const row = (
  id: string,
  fullName: string,
  overrides: Partial<StaffIdentityRow> = {},
): StaffIdentityRow => ({
  id,
  fullName,
  publicName: null,
  jobTitleEn: null,
  jobTitleAr: null,
  photoKey: null,
  ...overrides,
});

const rows = new Map<string, StaffIdentityRow>([
  [LINA, row(LINA, 'Lina Haddad', { photoKey: 'install/users/lina/' })],
  [KARIM, row(KARIM, 'Karim Nasser')],
  [SARA, row(SARA, 'Sara Odeh', { publicName: 'Sara O' })],
]);

const tx = {} as DbTransaction;

const cards = new AgentCards({
  smallUrl: async (folder) => (folder === null ? null : `https://bucket.test/${folder}64.webp`),
});

const reader = (map: PresenceMap) => {
  const staffIdentities = vi.fn(async (_tx: DbTransaction, ids: readonly string[]) => {
    return new Map(
      ids.flatMap((id) => {
        const found = rows.get(id);
        return found === undefined ? [] : [[id, found] as const];
      }),
    );
  });
  const online = new OnlineAgents({
    db: { transaction: (run: (inner: DbTransaction) => unknown) => run(tx) } as unknown as Db,
    presence: { mapOf: async () => map },
    settings: { row: async () => undefined },
    widget: { staffIdentities },
    cards,
  });
  return { online, staffIdentities };
};

const settings = (showAgentIdentity: boolean) => {
  const defaults = resolveWidgetSettings(undefined);
  return { ...defaults, conversation: { ...defaults.conversation, showAgentIdentity } };
};

describe('OnlineAgents', () => {
  it('names the online agents by public name with their photo, sorted, and leaves out the away', async () => {
    const { online } = reader({ [SARA]: 'online', [LINA]: 'online', [KARIM]: 'away' });

    await expect(online.presenceIn(tx, BRAND, settings(true))).resolves.toEqual({
      agentsOnline: true,
      agents: [
        { name: 'Lina', avatarUrl: 'https://bucket.test/install/users/lina/64.webp' },
        { name: 'Sara O', avatarUrl: null },
      ],
    });
  });

  it('says somebody is there without saying who, when the brand hides agents', async () => {
    const { online, staffIdentities } = reader({ [LINA]: 'online' });

    await expect(online.presenceIn(tx, BRAND, settings(false))).resolves.toEqual({
      agentsOnline: true,
      agents: [],
    });
    expect(staffIdentities).not.toHaveBeenCalled();
  });

  it('opens no transaction for a brand with nobody online', async () => {
    const { online, staffIdentities } = reader({ [KARIM]: 'away' });

    await expect(online.presence(BRAND)).resolves.toEqual({ agentsOnline: false, agents: [] });
    expect(staffIdentities).not.toHaveBeenCalled();
  });
});
