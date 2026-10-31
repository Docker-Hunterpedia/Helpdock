import type { Macro } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  actionOf,
  cleanShortcut,
  draftOf,
  draftPlaceholderProblems,
  duplicateOf,
  emptyDraft,
  insertAt,
  type MacroDraft,
  problemOf,
  requestOf,
} from './macro-draft.js';

const USER = '0192c3f0-1a2b-7c3d-8e4f-0000000000a1';
const TEAM = '0192c3f0-1a2b-7c3d-8e4f-0000000000a2';
const BILLING = '0192c3f0-1a2b-7c3d-8e4f-0000000000d2';

const macro: Macro = {
  id: '0192c3f0-1a2b-7c3d-8e4f-000000000701',
  kind: 'macro',
  name: 'Refund issued',
  scope: 'shared',
  departmentId: BILLING,
  bodies: { en: 'Hi {{contact.first_name}}', ar: '' },
  shortcut: 'refund',
  actions: [
    { type: 'set_priority', priority: 'high' },
    { type: 'assign', assignee: { kind: 'user', userId: USER } },
    { type: 'assign', assignee: { kind: 'team', teamId: TEAM } },
    { type: 'assign', assignee: { kind: 'self' } },
  ],
  lastUsedAt: null,
  useCount: 0,
  updatedAt: '2026-09-24T10:00:00.000Z',
  updatedById: null,
  canEdit: true,
};

const draft = (overrides: Partial<MacroDraft> = {}): MacroDraft => ({
  ...emptyDraft('macro', 'shared'),
  name: 'Refund',
  en: 'Hi',
  ...overrides,
});

describe('draftOf and requestOf', () => {
  it('round-trip a saved macro, assignees included', () => {
    const { kind, name, scope, departmentId, bodies, shortcut, actions } = macro;

    expect(requestOf(draftOf(macro))).toEqual({
      kind,
      name,
      scope,
      departmentId,
      bodies,
      shortcut,
      actions,
    });
  });

  it('shares with every department when none is chosen, and never files a personal one', () => {
    expect(requestOf(draft()).departmentId).toBeNull();
    expect(requestOf(draft({ scope: 'personal', departmentId: BILLING })).departmentId).toBeNull();
  });

  it('drops the actions of a canned response', () => {
    expect(
      requestOf(draft({ kind: 'canned', actions: [{ type: 'set_priority', value: 'low' }] }))
        .actions,
    ).toEqual([]);
  });
});

describe('actionOf', () => {
  it('is null while the second select is empty or holds nonsense', () => {
    expect(actionOf({ type: 'set_status', value: '' })).toBeNull();
    expect(actionOf({ type: 'set_priority', value: 'soon' })).toBeNull();
    expect(actionOf({ type: 'assign', value: 'robot:1' })).toBeNull();
  });

  it('reads each assignee spelling', () => {
    expect(actionOf({ type: 'assign', value: 'unassigned' })).toEqual({
      type: 'assign',
      assignee: { kind: 'unassigned' },
    });
    expect(actionOf({ type: 'remove_tag', value: 'tag-1' })).toEqual({
      type: 'remove_tag',
      tagId: 'tag-1',
    });
  });
});

describe('problemOf', () => {
  it.each([
    ['nameRequired', { name: ' ' }],
    ['englishRequired', { kind: 'canned' as const, en: '' }],
    ['actionIncomplete', { actions: [{ type: 'set_status' as const, value: '' }] }],
    ['nothingToDo', { en: '' }],
    [
      'arabicWithoutEnglish',
      { en: '', ar: 'مرحباً', actions: [{ type: 'set_priority' as const, value: 'low' }] },
    ],
  ])('says %s', (problem, overrides) => {
    expect(problemOf(draft(overrides))).toBe(problem);
  });

  it('has nothing to say about a complete draft', () => {
    expect(problemOf(draft())).toBeNull();
  });
});

describe('duplicateOf', () => {
  it('keeps everything but the name', () => {
    expect(duplicateOf(draftOf(macro), 'Refund issued (copy)')).toMatchObject({
      name: 'Refund issued (copy)',
      departmentId: BILLING,
    });
  });
});

describe('insertAt', () => {
  it('puts the token where the caret was, replacing a selection', () => {
    expect(insertAt('Hi , thanks', '{{a.b}}', { start: 3, end: 3 })).toEqual({
      text: 'Hi {{a.b}}, thanks',
      caret: 10,
    });
    expect(insertAt('Hi NAME', '{{a.b}}', { start: 3, end: 7 }).text).toBe('Hi {{a.b}}');
  });

  it('appends when the caret is unknown', () => {
    expect(insertAt('Hi ', '{{a.b}}', null).text).toBe('Hi {{a.b}}');
  });
});

describe('the shortcut (M14-14)', () => {
  it('is held without the slash and sent lower-case, or as null when blank', () => {
    expect(cleanShortcut(' /Refund ')).toBe('Refund');
    expect(requestOf(draft({ shortcut: '/Refund' })).shortcut).toBe('refund');
    expect(requestOf(draft({ shortcut: '  ' })).shortcut).toBeNull();
    expect(draftOf({ ...macro, shortcut: null }).shortcut).toBe('');
  });

  it('refuses a shortcut with a space in it', () => {
    expect(problemOf(draft({ shortcut: 'two words' }))).toBe('shortcutInvalid');
    expect(problemOf(draft({ shortcut: 'fine-1' }))).toBeNull();
  });
});

describe('the save-time placeholder check (M14-14)', () => {
  it('does not re-check a reply left as it was, so an old item can be renamed', () => {
    const old = { bodies: { en: 'Hi {{agent.nmae}}', ar: '' } };

    expect(problemOf(draft({ en: 'Hi {{agent.nmae}}', name: 'Renamed' }), old)).toBeNull();
    expect(problemOf(draft({ en: 'Hi {{agent.nmae}}!' }), old)).toBe('placeholders');
  });

  it('refuses a fallback the renderer would not read', () => {
    expect(problemOf(draft({ en: '{{contact.first_name|Sir|Madam}}' }))).toBe('placeholders');
  });

  it('refuses an unknown placeholder or an unclosed {{, in either language', () => {
    expect(problemOf(draft({ en: 'Hi {{agent.nmae}}' }))).toBe('placeholders');
    expect(problemOf(draft({ en: 'Hi', ar: 'مرحبا {{' }))).toBe('placeholders');
  });

  it('accepts a fallback', () => {
    expect(problemOf(draft({ en: 'Hi {{contact.first_name|there}}' }))).toBeNull();
  });

  it('names each problem with its language', () => {
    expect(draftPlaceholderProblems(draft({ en: '{{x.y}}', ar: '{{' }))).toEqual([
      { locale: 'en', problem: { kind: 'unknown', text: '{{x.y}}', suggestion: null } },
      { locale: 'ar', problem: { kind: 'unclosed', text: '{{' } },
    ]);
  });
});
