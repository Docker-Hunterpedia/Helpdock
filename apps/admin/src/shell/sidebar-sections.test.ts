import { describe, expect, it } from 'vitest';
import { ROUTES } from '../app/route-paths.js';
import { sectionAt, sectionsFor } from './sidebar-sections.js';

const keys = (role: 'admin' | 'teamLeader' | 'agent' | 'viewer', installAdmin = false) =>
  sectionsFor({ role, installAdmin }).map((section) => section.key);

describe('sectionsFor', () => {
  it('offers the five sections to an admin, and Reports not to an agent', () => {
    expect(keys('admin', true)).toEqual([
      'tickets',
      'contacts',
      'helpCenter',
      'reports',
      'settings',
    ]);
    expect(keys('agent')).toEqual(['tickets', 'contacts', 'helpCenter', 'settings']);
  });

  it('gives Reports no children, Contacts People and Accounts, and Tickets its views', () => {
    const sections = sectionsFor({ role: 'admin', installAdmin: true });
    const by = (key: string) => sections.find((section) => section.key === key);
    expect(by('reports')?.kind).toBe('link');
    expect(by('tickets')?.kind).toBe('views');
    expect(by('contacts')?.leaves.map((leaf) => leaf.path)).toEqual([
      ROUTES.contacts,
      ROUTES.contactsAccounts,
    ]);
  });

  it('keeps the help center’s visibility rules per role', () => {
    const pages = (role: 'admin' | 'agent' | 'viewer') =>
      sectionsFor({ role, installAdmin: false })
        .find((section) => section.key === 'helpCenter')
        ?.leaves.map((leaf) => leaf.id);
    expect(pages('admin')).toEqual(['articles', 'proposals', 'settings', 'insights']);
    expect(pages('agent')).toEqual(['articles']);
    expect(pages('viewer')).toEqual(['articles', 'settings', 'insights']);
  });

  it('gives every page of the sections an icon, unique within its list', () => {
    for (const section of sectionsFor({ role: 'admin', installAdmin: true })) {
      expect(section.icon).toBeDefined();
      const lists = [section.leaves, ...section.groups.map((group) => group.leaves)];
      for (const leaves of lists) {
        expect(new Set(leaves.map((leaf) => leaf.icon)).size).toBe(leaves.length);
      }
    }
  });

  it('keeps People current on a contact and Accounts on an account', () => {
    const contacts = sectionsFor({ role: 'admin', installAdmin: false }).find(
      (section) => section.key === 'contacts',
    );
    const [people, accounts] = contacts?.leaves ?? [];
    expect(people?.isCurrent('/contacts/abc')).toBe(true);
    expect(people?.isCurrent('/contacts/accounts')).toBe(false);
    expect(accounts?.isCurrent('/contacts/accounts/abc')).toBe(true);
  });
});

describe('sectionAt', () => {
  it.each([
    ['/tickets/abc', 'tickets'],
    ['/contacts/accounts', 'contacts'],
    ['/help-center/articles/1', 'helpCenter'],
    ['/reports', 'reports'],
    ['/settings/inbox/slas', 'settings'],
    ['/nowhere', null],
  ])('puts %s in %s', (path, expected) => {
    expect(sectionAt(path)).toBe(expected);
  });
});
