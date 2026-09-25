import { describe, expect, it } from 'vitest';
import { editsSharedView, managesViews, seesSharedView, type ViewActor } from './view-rules.js';

const SUPPORT = '01937f5e-7e53-7000-8000-000000000011';
const BILLING = '01937f5e-7e53-7000-8000-000000000012';

const actor = (role: ViewActor['role'], departmentIds: ViewActor['departmentIds']): ViewActor => ({
  userId: '01937f5e-7e53-7000-8000-000000000001',
  role,
  departmentIds,
});

describe('managesViews', () => {
  it.each([
    ['admin', true],
    ['team_leader', true],
    ['agent', false],
    ['viewer', false],
  ] as const)('%s → %s', (role, expected) => {
    expect(managesViews(actor(role, 'all'))).toBe(expected);
  });
});

describe('seesSharedView', () => {
  it('shows a brand-wide view to everybody', () => {
    expect(seesSharedView(actor('agent', [SUPPORT]), null)).toBe(true);
  });

  it('shows a department view to staff whose scope reaches one of its departments', () => {
    expect(seesSharedView(actor('agent', [SUPPORT]), [SUPPORT, BILLING])).toBe(true);
  });

  it('keeps a department view out of another department’s sidebar', () => {
    expect(seesSharedView(actor('agent', [SUPPORT]), [BILLING])).toBe(false);
  });

  it('shows every view to somebody with every department', () => {
    expect(seesSharedView(actor('viewer', 'all'), [BILLING])).toBe(true);
  });
});

describe('editsSharedView', () => {
  it('lets an Admin change any shared view', () => {
    expect(editsSharedView(actor('admin', 'all'), null)).toBe(true);
  });

  it('lets a Team Leader change a view of the departments they lead', () => {
    expect(editsSharedView(actor('team_leader', [SUPPORT, BILLING]), [SUPPORT])).toBe(true);
  });

  it('refuses a Team Leader a view that reaches a department they do not lead', () => {
    expect(editsSharedView(actor('team_leader', [SUPPORT]), [SUPPORT, BILLING])).toBe(false);
  });

  it('refuses a restricted Team Leader a brand-wide view', () => {
    expect(editsSharedView(actor('team_leader', [SUPPORT]), null)).toBe(false);
  });

  it('lets an unrestricted Team Leader change a brand-wide view', () => {
    expect(editsSharedView(actor('team_leader', 'all'), null)).toBe(true);
  });

  it('refuses an Agent even a view of their own department', () => {
    expect(editsSharedView(actor('agent', [SUPPORT]), [SUPPORT])).toBe(false);
  });
});
