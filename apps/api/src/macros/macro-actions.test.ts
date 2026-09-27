import type { MacroAction } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { actionsBelongTo, planMacro, referencesOf, tagsAfter } from './macro-actions.js';

const STATUS = '01937f5e-7e53-7000-8000-0000000000a1';
const TAG = '01937f5e-7e53-7000-8000-0000000000a2';
const OTHER_TAG = '01937f5e-7e53-7000-8000-0000000000a3';
const USER = '01937f5e-7e53-7000-8000-0000000000a4';
const TEAM = '01937f5e-7e53-7000-8000-0000000000a5';

describe('planMacro', () => {
  it('turns the artboard’s "Refund issued" into one update and one tag operation', () => {
    const plan = planMacro(
      [
        { type: 'set_status', statusId: STATUS },
        { type: 'add_tag', tagId: TAG },
        { type: 'assign', assignee: { kind: 'self' } },
      ],
      'me',
    );

    expect(plan).toEqual({
      fields: { statusId: STATUS, assigneeId: 'me' },
      tagOps: [{ tagId: TAG, add: true }],
      routeToTeam: false,
    });
  });

  it('lets a later action on the same field win, because they run in order', () => {
    const plan = planMacro(
      [
        { type: 'set_priority', priority: 'low' },
        { type: 'assign', assignee: { kind: 'team', teamId: TEAM } },
        { type: 'set_priority', priority: 'urgent' },
        { type: 'assign', assignee: { kind: 'user', userId: USER } },
      ],
      'me',
    );

    expect(plan.fields).toEqual({ priority: 'urgent', teamId: TEAM, assigneeId: USER });
    expect(plan.routeToTeam).toBe(false);
  });

  it('hands a team assignment to the rotation, with nobody holding the ticket yet', () => {
    const plan = planMacro([{ type: 'assign', assignee: { kind: 'team', teamId: TEAM } }], 'me');

    expect(plan.fields).toEqual({ teamId: TEAM, assigneeId: null });
    expect(plan.routeToTeam).toBe(true);
  });

  it('unassigns', () => {
    expect(planMacro([{ type: 'assign', assignee: { kind: 'unassigned' } }], 'me').fields).toEqual({
      assigneeId: null,
    });
  });
});

describe('tagsAfter', () => {
  it('adds a tag the ticket lacks and ignores one it has', () => {
    expect(
      tagsAfter(
        [TAG],
        [
          { tagId: TAG, add: true },
          { tagId: OTHER_TAG, add: true },
        ],
      ),
    ).toEqual([TAG, OTHER_TAG]);
  });

  it('applies an add then a remove of one tag in order, leaving it off', () => {
    expect(
      tagsAfter(
        [],
        [
          { tagId: TAG, add: true },
          { tagId: TAG, add: false },
        ],
      ),
    ).toEqual([]);
  });

  it('removes a tag, and ignores removing one that is not there', () => {
    expect(
      tagsAfter(
        [TAG, OTHER_TAG],
        [
          { tagId: TAG, add: false },
          { tagId: USER, add: false },
        ],
      ),
    ).toEqual([OTHER_TAG]);
  });
});

describe('actionsBelongTo', () => {
  const own: MacroAction[] = [
    { type: 'set_status', statusId: STATUS },
    { type: 'assign', assignee: { kind: 'user', userId: USER } },
  ];

  it('accepts any subset of the macro’s own actions, however the keys are ordered', () => {
    expect(actionsBelongTo([], own)).toBe(true);
    expect(
      actionsBelongTo([{ assignee: { userId: USER, kind: 'user' }, type: 'assign' }], own),
    ).toBe(true);
  });

  it('refuses an action the macro does not have', () => {
    expect(actionsBelongTo([{ type: 'set_status', statusId: TAG }], own)).toBe(false);
  });
});

describe('referencesOf', () => {
  it('collects every id an action names, by kind', () => {
    expect(
      referencesOf([
        { type: 'set_status', statusId: STATUS },
        { type: 'set_priority', priority: 'high' },
        { type: 'remove_tag', tagId: TAG },
        { type: 'assign', assignee: { kind: 'user', userId: USER } },
        { type: 'assign', assignee: { kind: 'team', teamId: TEAM } },
        { type: 'assign', assignee: { kind: 'self' } },
      ]),
    ).toEqual({ statusIds: [STATUS], tagIds: [TAG], userIds: [USER], teamIds: [TEAM] });
  });
});
