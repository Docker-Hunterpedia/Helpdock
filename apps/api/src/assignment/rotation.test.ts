import { describe, expect, it } from 'vitest';
import {
  canWorkDepartment,
  eligibleCandidates,
  isInRotation,
  mayAssignTo,
  type PickInput,
  pickAssignee,
  type RotationCandidate,
  underCap,
} from './rotation.js';

const billing = '01920000-0000-7000-8000-00000000b111';
const support = '01920000-0000-7000-8000-00000000c222';
const refunds = '01920000-0000-7000-8000-0000000000f1';
const vat = '01920000-0000-7000-8000-0000000000f2';

const agent = (userId: string, overrides: Partial<RotationCandidate> = {}): RotationCandidate => ({
  userId,
  role: 'agent',
  departmentIds: [billing],
  deactivated: false,
  inRotation: null,
  lastAssignedAt: null,
  skillTagIds: [],
  ...overrides,
});

const input = (overrides: Partial<PickInput> = {}): PickInput => ({
  departmentId: billing,
  mode: 'round_robin',
  loadCap: null,
  candidates: [],
  online: new Set(),
  openCounts: new Map(),
  ticketTagIds: [],
  ...overrides,
});

describe('canWorkDepartment', () => {
  it('needs a role that reaches the department', () => {
    expect(canWorkDepartment(agent('a'), billing)).toBe(true);
    expect(canWorkDepartment(agent('a'), support)).toBe(false);
    expect(canWorkDepartment(agent('a', { role: 'admin', departmentIds: 'all' }), support)).toBe(
      true,
    );
  });

  it('refuses a Viewer, who never works tickets, and a deactivated account', () => {
    expect(canWorkDepartment(agent('a', { role: 'viewer' }), billing)).toBe(false);
    expect(canWorkDepartment(agent('a', { deactivated: true }), billing)).toBe(false);
  });
});

describe('isInRotation', () => {
  it('follows the stored choice when there is one', () => {
    expect(isInRotation({ role: 'agent', inRotation: false })).toBe(false);
    expect(isInRotation({ role: 'admin', inRotation: true })).toBe(true);
  });

  it('puts Agents in and everybody above them out when nobody chose', () => {
    expect(isInRotation({ role: 'agent', inRotation: null })).toBe(true);
    expect(isInRotation({ role: 'team_leader', inRotation: null })).toBe(false);
    expect(isInRotation({ role: 'admin', inRotation: null })).toBe(false);
  });
});

describe('mayAssignTo', () => {
  it('lets only an Admin route work to an Admin', () => {
    expect(mayAssignTo('admin', 'admin')).toBe(true);
    expect(mayAssignTo('team_leader', 'admin')).toBe(false);
    expect(mayAssignTo('agent', 'admin')).toBe(false);
    expect(mayAssignTo('agent', 'team_leader')).toBe(true);
  });
});

describe('underCap', () => {
  it('treats a null cap as none, and the cap itself as full', () => {
    expect(underCap(1_000, null)).toBe(true);
    expect(underCap(7, 8)).toBe(true);
    expect(underCap(8, 8)).toBe(false);
  });
});

describe('pickAssignee', () => {
  it('picks nobody when nobody is online', () => {
    expect(pickAssignee(input({ candidates: [agent('a')] }))).toBeNull();
  });

  it('picks the one who waited longest, never-picked first', () => {
    const candidates = [
      agent('recent', { lastAssignedAt: new Date('2026-09-24T10:00:00Z') }),
      agent('earlier', { lastAssignedAt: new Date('2026-09-24T09:00:00Z') }),
    ];
    const online = new Set(['recent', 'earlier']);
    expect(pickAssignee(input({ candidates, online }))).toBe('earlier');

    const fresh = [...candidates, agent('fresh')];
    expect(pickAssignee(input({ candidates: fresh, online: new Set([...online, 'fresh']) }))).toBe(
      'fresh',
    );
  });

  it('breaks a tie by id, so every replica picks the same person', () => {
    const online = new Set(['b', 'a']);
    expect(pickAssignee(input({ candidates: [agent('b'), agent('a')], online }))).toBe('a');
  });

  it('skips an agent at cap rather than queueing for them', () => {
    const online = new Set(['busy', 'free']);
    const openCounts = new Map([['busy', 2]]);
    const candidates = [agent('busy'), agent('free', { lastAssignedAt: new Date() })];

    expect(pickAssignee(input({ candidates, online, openCounts, loadCap: 2 }))).toBe('free');
    expect(
      pickAssignee(input({ candidates: [agent('busy')], online, openCounts, loadCap: 2 })),
    ).toBeNull();
  });

  it('skips anybody out of rotation or unable to work the department', () => {
    const online = new Set(['out', 'elsewhere', 'viewer', 'in']);
    const candidates = [
      agent('out', { inRotation: false }),
      agent('elsewhere', { departmentIds: [support] }),
      agent('viewer', { role: 'viewer', inRotation: true }),
      agent('in', { lastAssignedAt: new Date() }),
    ];

    expect(eligibleCandidates(input({ candidates, online })).map((c) => c.userId)).toEqual(['in']);
  });

  it('prefers a skill match in skill-based mode', () => {
    const online = new Set(['generalist', 'specialist']);
    const candidates = [
      agent('generalist'),
      agent('specialist', { skillTagIds: [vat], lastAssignedAt: new Date() }),
    ];

    expect(
      pickAssignee(
        input({ mode: 'skill_based', candidates, online, ticketTagIds: [refunds, vat] }),
      ),
    ).toBe('specialist');
    // Round-robin ignores skills.
    expect(pickAssignee(input({ candidates, online, ticketTagIds: [vat] }))).toBe('generalist');
  });

  it('falls back to everyone eligible when no eligible skill matches', () => {
    const online = new Set(['generalist']);
    const candidates = [agent('generalist'), agent('specialist', { skillTagIds: [vat] })];

    // The specialist is offline, so the ticket goes to whoever may take it.
    expect(
      pickAssignee(input({ mode: 'skill_based', candidates, online, ticketTagIds: [vat] })),
    ).toBe('generalist');
  });
});
