import type { Db, DbTransaction } from '@helpdock/db';
import type { PresenceMap } from '@helpdock/schemas';
import { describe, expect, it, vi } from 'vitest';
import { OnlineAgents } from './online-agents.js';
import { resolveWidgetSettings } from './resolved-settings.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const LINA = '01937f5e-7e53-7000-8000-000000000001';
const KARIM = '01937f5e-7e53-7000-8000-000000000002';
const SARA = '01937f5e-7e53-7000-8000-000000000003';

const names = new Map([
  [LINA, 'Lina Haddad'],
  [KARIM, 'Karim Nasser'],
  [SARA, 'Sara Odeh'],
]);

const tx = {} as DbTransaction;

const reader = (map: PresenceMap) => {
  const staffNames = vi.fn(async (_tx: DbTransaction, ids: readonly string[]) => {
    return new Map(ids.flatMap((id) => (names.has(id) ? [[id, names.get(id) ?? '']] : [])));
  });
  const online = new OnlineAgents({
    db: { transaction: (run: (inner: DbTransaction) => unknown) => run(tx) } as unknown as Db,
    presence: { mapOf: async () => map },
    settings: { row: async () => undefined },
    widget: { staffNames },
  });
  return { online, staffNames };
};

const settings = (showAgentIdentity: boolean) => {
  const defaults = resolveWidgetSettings(undefined);
  return { ...defaults, conversation: { ...defaults.conversation, showAgentIdentity } };
};

describe('OnlineAgents', () => {
  it('names the online agents by first name, sorted, and leaves out the away', async () => {
    const { online } = reader({ [SARA]: 'online', [LINA]: 'online', [KARIM]: 'away' });

    await expect(online.presenceIn(tx, BRAND, settings(true))).resolves.toEqual({
      agentsOnline: true,
      agents: [
        { name: 'Lina', avatarUrl: null },
        { name: 'Sara', avatarUrl: null },
      ],
    });
  });

  it('says somebody is there without saying who, when the brand hides agents', async () => {
    const { online, staffNames } = reader({ [LINA]: 'online' });

    await expect(online.presenceIn(tx, BRAND, settings(false))).resolves.toEqual({
      agentsOnline: true,
      agents: [],
    });
    expect(staffNames).not.toHaveBeenCalled();
  });

  it('opens no transaction for a brand with nobody online', async () => {
    const { online, staffNames } = reader({ [KARIM]: 'away' });

    await expect(online.presence(BRAND)).resolves.toEqual({ agentsOnline: false, agents: [] });
    expect(staffNames).not.toHaveBeenCalled();
  });
});
