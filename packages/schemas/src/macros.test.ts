import { describe, expect, it } from 'vitest';
import {
  CANNED_PLACEHOLDERS,
  macroCreateRequestSchema,
  macroRunRequestSchema,
  macroShapeProblem,
  macroUpdateRequestSchema,
} from './macros.js';

const STATUS = '01937f5e-7e53-7000-8000-0000000000a1';

const canned = {
  kind: 'canned',
  name: 'Shipping fees explained',
  scope: 'shared',
  bodies: { en: 'Hi {{contact.first_name}}', ar: '' },
};

describe('CANNED_PLACEHOLDERS', () => {
  it('is M1’s template list plus the sender', () => {
    expect(CANNED_PLACEHOLDERS).toContain('ticket.number');
    expect(CANNED_PLACEHOLDERS.at(-1)).toBe('agent.first_name');
  });
});

describe('macroCreateRequestSchema', () => {
  it('defaults a shared item to every department and no actions', () => {
    expect(macroCreateRequestSchema.parse(canned)).toMatchObject({
      departmentId: null,
      actions: [],
    });
  });

  it('accepts a macro with actions and no reply', () => {
    expect(
      macroCreateRequestSchema.safeParse({
        ...canned,
        kind: 'macro',
        bodies: { en: '', ar: '' },
        actions: [{ type: 'set_status', statusId: STATUS }],
      }).success,
    ).toBe(true);
  });

  it('refuses an action of a kind it does not know', () => {
    expect(
      macroCreateRequestSchema.safeParse({
        ...canned,
        kind: 'macro',
        actions: [{ type: 'call_webhook', url: 'https://example.com' }],
      }).success,
    ).toBe(false);
  });
});

describe('macroShapeProblem', () => {
  const shape = {
    kind: 'canned' as const,
    scope: 'shared' as const,
    departmentId: null,
    bodies: { en: 'Hi', ar: '' },
    actions: [],
  };

  it('accepts a canned response with its English text', () => {
    expect(macroShapeProblem(shape)).toBeNull();
  });

  it.each([
    ['a canned response with actions', { actions: [{ type: 'set_priority', priority: 'high' }] }],
    ['a canned response with no English', { bodies: { en: ' ', ar: '' } }],
    ['a macro with nothing to do', { kind: 'macro', bodies: { en: '', ar: '' } }],
    ['a personal item in a department', { scope: 'personal', departmentId: STATUS }],
    [
      'an Arabic variant with no English one',
      {
        kind: 'macro',
        bodies: { en: '', ar: 'مرحباً' },
        actions: [{ type: 'set_priority', priority: 'high' }],
      },
    ],
  ])('refuses %s', (_label, overrides) => {
    expect(
      macroShapeProblem({ ...shape, ...overrides } as Parameters<typeof macroShapeProblem>[0]),
    ).not.toBeNull();
  });
});

describe('macroUpdateRequestSchema', () => {
  it('refuses a patch that changes nothing', () => {
    expect(macroUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(macroUpdateRequestSchema.safeParse({ name: 'Renamed' }).success).toBe(true);
  });
});

describe('macroRunRequestSchema', () => {
  it('defaults to no staged actions, which is a canned response sent', () => {
    expect(macroRunRequestSchema.parse({ macroId: STATUS }).actions).toEqual([]);
  });
});
