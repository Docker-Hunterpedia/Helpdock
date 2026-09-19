import { describe, expect, it } from 'vitest';
import { departmentIdsFor, departmentScopeOf, toBrandRole } from './roles.js';

const SUPPORT = '0199f4b2-6a91-7c27-9a1f-0000000000a1';

describe('toBrandRole', () => {
  it('maps the admin app spelling onto the database one', () => {
    expect(toBrandRole('teamLeader')).toBe('team_leader');
    expect(toBrandRole('admin')).toBe('admin');
    expect(toBrandRole('agent')).toBe('agent');
    expect(toBrandRole('viewer')).toBe('viewer');
  });
});

describe('departmentIdsFor', () => {
  it('gives an Admin the whole brand whatever was chosen', () => {
    expect(departmentIdsFor('admin', [SUPPORT])).toBeNull();
    expect(departmentIdsFor('admin', [])).toBeNull();
  });

  it('reads an empty list for a Team Leader or Viewer as unrestricted (§1.1)', () => {
    expect(departmentIdsFor('team_leader', [])).toBeNull();
    expect(departmentIdsFor('viewer', [])).toBeNull();
  });

  /**
   * The one that matters: an Agent with nothing assigned must see nothing. Null
   * here would be "every department", which is the opposite of what an empty
   * picker means.
   */
  it('reads an empty list for an Agent as no departments at all', () => {
    expect(departmentIdsFor('agent', [])).toEqual([]);
  });

  it('keeps an explicit list for every restricted role', () => {
    for (const role of ['team_leader', 'agent', 'viewer'] as const) {
      expect(departmentIdsFor(role, [SUPPORT])).toEqual([SUPPORT]);
    }
  });

  it('copies the list rather than holding the array the caller passed', () => {
    const chosen = [SUPPORT];
    const stored = departmentIdsFor('agent', chosen);
    chosen.push('something else');

    expect(stored).toEqual([SUPPORT]);
  });
});

describe('departmentScopeOf', () => {
  it('reads a null column as every department', () => {
    expect(departmentScopeOf(null)).toBe('all');
  });

  it('reads an empty column as no departments', () => {
    expect(departmentScopeOf([])).toEqual([]);
  });

  it('passes an explicit list through', () => {
    expect(departmentScopeOf([SUPPORT])).toEqual([SUPPORT]);
  });
});
