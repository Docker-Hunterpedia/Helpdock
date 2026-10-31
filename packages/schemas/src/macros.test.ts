import { describe, expect, it } from 'vitest';
import {
  CANNED_PLACEHOLDERS,
  macroCreateRequestSchema,
  macroRunRequestSchema,
  macroShapeProblem,
  macroShortcutSchema,
  macroUpdateRequestSchema,
  placeholderProblemSentence,
  placeholderProblems,
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
    expect(CANNED_PLACEHOLDERS).toEqual(
      expect.arrayContaining([
        'agent.first_name',
        'agent.name',
        'agent.full_name',
        'agent.title',
        'agent.phone',
        'department.name',
      ]),
    );
    expect(
      CANNED_PLACEHOLDERS.some((name) => name.includes('email') && name.startsWith('agent')),
    ).toBe(false);
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

describe('macroShortcutSchema (M14-14)', () => {
  it('lower-cases and trims', () => {
    expect(macroShortcutSchema.parse('  Refund ')).toBe('refund');
  });

  it('accepts digits, - and _ and a word in Arabic', () => {
    expect(macroShortcutSchema.parse('q3-refund_2')).toBe('q3-refund_2');
    expect(macroShortcutSchema.parse('استرجاع')).toBe('استرجاع');
  });

  it.each(['', '/refund', 'two words', '-lead', 'a'.repeat(33)])('refuses %j', (value) => {
    expect(macroShortcutSchema.safeParse(value).success).toBe(false);
  });

  it('is optional and nullable on the requests', () => {
    expect(macroCreateRequestSchema.parse(canned).shortcut).toBeNull();
    expect(macroCreateRequestSchema.parse({ ...canned, shortcut: 'Fees' }).shortcut).toBe('fees');
    expect(macroUpdateRequestSchema.safeParse({ shortcut: null }).success).toBe(true);
  });
});

describe('placeholderProblems (M14-14)', () => {
  it('accepts every allow-listed name, with spaces, any case and a fallback', () => {
    expect(
      placeholderProblems('{{contact.first_name|there}} {{ Ticket.Number }} {{agent.name | us}}'),
    ).toEqual([]);
  });

  it('names an unknown placeholder and offers the nearest real one', () => {
    expect(placeholderProblems('Thanks, {{agent.nmae}}')).toEqual([
      { kind: 'unknown', text: '{{agent.nmae}}', suggestion: 'agent.name' },
    ]);
  });

  it('gives no suggestion when nothing is close', () => {
    expect(placeholderProblems('{{zzzzzzzzzz}}')).toEqual([
      { kind: 'unknown', text: '{{zzzzzzzzzz}}', suggestion: null },
    ]);
  });

  it('finds an unclosed opening, at the end and before another placeholder', () => {
    expect(placeholderProblems('Hi {{contact.name')).toEqual([
      { kind: 'unclosed', text: '{{contact.name' },
    ]);
    expect(placeholderProblems('Hi {{contact.first {{ticket.number}}')).toEqual([
      { kind: 'unclosed', text: '{{contact.first ' },
    ]);
  });

  it('reports a repeated problem once and every different one', () => {
    expect(placeholderProblems('{{x.y}} {{x.y}} {{a.b}} {{')).toHaveLength(3);
  });

  it('treats text that is not a name as unknown', () => {
    expect(placeholderProblems('{{ not a name }}')).toMatchObject([{ kind: 'unknown' }]);
  });

  it('says where each one is', () => {
    expect(placeholderProblemSentence({ en: '{{agent.nmae}}', ar: 'مرحبا {{' })).toBe(
      'Unknown placeholder {{agent.nmae}} in the en reply; Unclosed {{ in the ar reply',
    );
    expect(placeholderProblemSentence({ en: 'fine', ar: '' })).toBeNull();
  });

  it('is enforced on create and on a patch that sends bodies', () => {
    expect(
      macroCreateRequestSchema.safeParse({
        ...canned,
        bodies: { en: 'Hi {{contcat.name}}', ar: '' },
      }).success,
    ).toBe(false);
    expect(macroUpdateRequestSchema.safeParse({ bodies: { en: '{{', ar: '' } }).success).toBe(
      false,
    );
    expect(macroUpdateRequestSchema.safeParse({ name: 'Renamed' }).success).toBe(true);
  });
});
