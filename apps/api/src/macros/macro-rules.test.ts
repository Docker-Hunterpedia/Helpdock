import { describe, expect, it } from 'vitest';
import { editsMacro, type MacroActor, seesMacro, usableIn } from './macro-rules.js';

const SUPPORT = '01937f5e-7e53-7000-8000-000000000011';
const BILLING = '01937f5e-7e53-7000-8000-000000000012';

const actor = (overrides: Partial<MacroActor> = {}): MacroActor => ({
  userId: 'me',
  role: 'agent',
  departmentIds: [SUPPORT],
  ...overrides,
});

const personal = (ownerId: string) => ({ ownerId, departmentId: null });
const shared = (departmentId: string | null) => ({ ownerId: null, departmentId });

describe('seesMacro', () => {
  it('shows a personal item to its owner only', () => {
    expect(seesMacro(actor(), personal('me'))).toBe(true);
    expect(seesMacro(actor({ role: 'admin', departmentIds: 'all' }), personal('you'))).toBe(false);
  });

  it('shows an item shared with every department to everybody', () => {
    expect(seesMacro(actor(), shared(null))).toBe(true);
  });

  it('shows an item shared with one department to the staff who reach it', () => {
    expect(seesMacro(actor(), shared(SUPPORT))).toBe(true);
    expect(seesMacro(actor(), shared(BILLING))).toBe(false);
    expect(seesMacro(actor({ departmentIds: 'all' }), shared(BILLING))).toBe(true);
  });
});

describe('editsMacro', () => {
  it('lets anybody change their own personal item, and nobody else’s', () => {
    expect(editsMacro(actor(), personal('me'))).toBe(true);
    expect(editsMacro(actor({ role: 'admin' }), personal('you'))).toBe(false);
  });

  it('keeps an Agent and a Viewer out of every shared item', () => {
    expect(editsMacro(actor(), shared(SUPPORT))).toBe(false);
    expect(editsMacro(actor({ role: 'viewer', departmentIds: 'all' }), shared(null))).toBe(false);
  });

  it('lets an Admin change any shared item', () => {
    expect(editsMacro(actor({ role: 'admin', departmentIds: 'all' }), shared(BILLING))).toBe(true);
    expect(editsMacro(actor({ role: 'admin', departmentIds: 'all' }), shared(null))).toBe(true);
  });

  it('lets a Team Leader change what is shared with a department they lead, and no more', () => {
    const leader = actor({ role: 'team_leader' });

    expect(editsMacro(leader, shared(SUPPORT))).toBe(true);
    expect(editsMacro(leader, shared(BILLING))).toBe(false);
    // Shared with every department is a whole-brand item.
    expect(editsMacro(leader, shared(null))).toBe(false);
    expect(editsMacro(actor({ role: 'team_leader', departmentIds: 'all' }), shared(null))).toBe(
      true,
    );
  });
});

describe('usableIn', () => {
  it('offers the ticket’s department, every department, and the reader’s own', () => {
    expect(usableIn(shared(SUPPORT), SUPPORT)).toBe(true);
    expect(usableIn(shared(null), SUPPORT)).toBe(true);
    expect(usableIn(personal('me'), SUPPORT)).toBe(true);
    expect(usableIn(shared(BILLING), SUPPORT)).toBe(false);
  });
});
