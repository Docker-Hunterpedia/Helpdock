import { describe, expect, it } from 'vitest';
import { AgentCards } from './agent-cards.js';
import type { StaffIdentityRow } from './widget.repository.js';

const LINA = '01937f5e-7e53-7000-8000-000000000001';
const KARIM = '01937f5e-7e53-7000-8000-000000000002';

const row = (id: string, overrides: Partial<StaffIdentityRow>): StaffIdentityRow => ({
  id,
  fullName: 'Someone Else',
  publicName: null,
  jobTitleEn: null,
  jobTitleAr: null,
  photoKey: null,
  ...overrides,
});

const cards = new AgentCards({
  smallUrl: async (folder) => (folder === null ? null : `https://bucket.test/${folder}64.webp`),
});

describe('AgentCards', () => {
  it('builds the name, the title in the conversation language and the photo a visitor may see', async () => {
    const rows = new Map([
      [
        LINA,
        row(LINA, {
          fullName: 'Lina Haddad',
          publicName: 'Lina',
          jobTitleEn: 'Billing specialist',
          jobTitleAr: 'أخصائية الفوترة',
          photoKey: 'install/users/lina/p1/',
        }),
      ],
    ]);

    expect((await cards.of(rows, 'en')).get(LINA)).toEqual({
      name: 'Lina',
      title: 'Billing specialist',
      avatarUrl: 'https://bucket.test/install/users/lina/p1/64.webp',
    });
    expect((await cards.of(rows, 'ar')).get(LINA)?.title).toBe('أخصائية الفوترة');
  });

  it('shows the first name, never the surname, and no photo or title when there is none', async () => {
    const card = (
      await cards.of(new Map([[KARIM, row(KARIM, { fullName: 'Karim Nasser' })]]), 'en')
    ).get(KARIM);

    expect(card).toEqual({ name: 'Karim', title: null, avatarUrl: null });
  });

  it('carries nothing but those three fields, so no email or id can reach a visitor', async () => {
    const rows = new Map([
      [LINA, { ...row(LINA, { fullName: 'Lina Haddad' }), email: 'lina@helpdock.com' }],
    ]);

    const card = (await cards.of(rows, 'en')).get(LINA);

    expect(Object.keys(card ?? {}).sort()).toEqual(['avatarUrl', 'name', 'title']);
    expect(JSON.stringify(card)).not.toContain('lina@helpdock.com');
  });
});
