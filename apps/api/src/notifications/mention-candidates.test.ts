import { describe, expect, it } from 'vitest';
import { handleFor, mentionCandidates } from './mention-candidates.js';
import type { StaffFacts } from './recipients.js';

const BILLING = '01937f5e-7e53-7000-8000-000000000012';
const SUPPORT = '01937f5e-7e53-7000-8000-000000000011';

const person = (name: string, email: string, overrides: Partial<StaffFacts> = {}): StaffFacts => ({
  userId: `id-${email}`,
  name,
  email,
  departmentIds: 'all',
  deactivated: false,
  ...overrides,
});

const me = person('Me Writer', 'me@x.test');
const omar = person('Omar Aziz', 'omar.aziz@x.test');
const dana = person('Dana Saleh', 'dana.saleh@x.test', { departmentIds: [BILLING] });
const khateeb = person('عمر الخطيب', 'omar.khateeb@x.test', { departmentIds: [BILLING, SUPPORT] });
const outsider = person('Sam Support', 'sam@x.test', { departmentIds: [SUPPORT] });
const gone = person('Gone Person', 'gone@x.test', { deactivated: true });
const everyone = [me, omar, dana, khateeb, outsider, gone];

const list = (query = '', presence = {}) =>
  mentionCandidates({
    members: everyone,
    departmentId: BILLING,
    actorId: me.userId,
    presence,
    query,
  });

describe('mentionCandidates', () => {
  it('never lists a person outside the ticket’s department, a deactivated one, or the writer', () => {
    const names = list().map((candidate) => candidate.name);

    expect(names).not.toContain('Sam Support');
    expect(names).not.toContain('Gone Person');
    expect(names).not.toContain('Me Writer');
    expect(names).toEqual(expect.arrayContaining(['Omar Aziz', 'Dana Saleh', 'عمر الخطيب']));
  });

  it('writes the email name as the handle, which the resolver maps back to the person', () => {
    expect(list().find((candidate) => candidate.name === 'Omar Aziz')?.handle).toBe('omar.aziz');
    expect(list().find((candidate) => candidate.name === 'عمر الخطيب')?.handle).toBe(
      'omar.khateeb',
    );
  });

  it('filters by name or handle in either script, case-insensitively', () => {
    expect(list('OMAR').map((c) => c.name)).toEqual(['Omar Aziz', 'عمر الخطيب']);
    expect(list('عمر').map((c) => c.handle)).toEqual(['omar.khateeb']);
    expect(list('@dana').map((c) => c.name)).toEqual(['Dana Saleh']);
    expect(list('zzz')).toEqual([]);
  });

  it('puts the online first, then away, then by name, and says offline for the unknown', () => {
    const result = list('', { [dana.userId]: 'online', [omar.userId]: 'away' });

    expect(result.map((c) => [c.name, c.presence])).toEqual([
      ['Dana Saleh', 'online'],
      ['Omar Aziz', 'away'],
      ['عمر الخطيب', 'offline'],
    ]);
  });

  it('offers no one who cannot be mentioned alone', () => {
    const twin = person('Omar Aziz', 'omar.aziz@elsewhere.test');
    const result = mentionCandidates({
      members: [me, omar, twin],
      departmentId: BILLING,
      actorId: me.userId,
      presence: {},
      query: '',
    });

    // The email name is shared, the full name is shared, the first name too.
    expect(result).toEqual([]);
  });
});

describe('handleFor', () => {
  it('falls back to the full name, then the first name, when the email name does not parse', () => {
    const odd = person('Lina Haddad', "li'na+tag@x.test");
    expect(handleFor(odd, [odd])).toBe('LinaHaddad');

    const solo = person('Lina', 'a+b@x.test');
    expect(handleFor(solo, [solo])).toBe('Lina');
  });

  it('is undefined when two people share every spelling', () => {
    const a = person('Ann Lee', 'ann@a.test');
    const b = person('Ann Lee', 'ann@b.test');
    expect(handleFor(a, [a, b])).toBeUndefined();
  });
});
