import { describe, expect, it } from 'vitest';
import { brandSettingsSchema, parseBrandSettings } from './brand.js';
import {
  compactPriorityLabels,
  DEFAULT_PRIORITY_NAMES,
  effectivePriorityName,
  normalisePriorityName,
  PRIORITY_KEYS,
  priorityLabelConflicts,
  priorityLabelNameSchema,
  priorityLabelsSchema,
  priorityLabelsUpdateRequestSchema,
} from './priority-labels.js';
import { ticketPrioritySchema } from './ticket.js';

describe('PRIORITY_KEYS', () => {
  it('are the ticket priorities, in order', () => {
    expect(PRIORITY_KEYS).toEqual(ticketPrioritySchema.options);
  });
});

describe('priorityLabelNameSchema', () => {
  it('trims and accepts 1 to 24 characters', () => {
    expect(priorityLabelNameSchema.safeParse('  P1  ').success).toBe(true);
    expect(normalisePriorityName('  P1  ')).toBe('P1');
    expect(priorityLabelNameSchema.parse('a'.repeat(24))).toHaveLength(24);
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['too long', 'a'.repeat(25)],
    ['a line break', 'P\n1'],
    ['a tab', 'P\t1'],
    ['a line separator', 'P 1'],
  ])('refuses %s', (_name, value) => {
    expect(priorityLabelNameSchema.safeParse(value).success).toBe(false);
  });
});

describe('priorityLabelConflicts', () => {
  it('finds nothing when no names are set', () => {
    expect(priorityLabelConflicts({})).toEqual([]);
    expect(priorityLabelConflicts(undefined)).toEqual([]);
  });

  it('refuses two overrides with the same name, ignoring case', () => {
    expect(priorityLabelConflicts({ high: { en: 'P1' }, urgent: { en: 'p1' } })).toEqual([
      { priority: 'urgent', locale: 'en', takenBy: 'high' },
    ]);
  });

  it('refuses an override equal to the default of a row left empty', () => {
    expect(priorityLabelConflicts({ high: { en: 'urgent' } })).toEqual([
      { priority: 'high', locale: 'en', takenBy: 'urgent' },
    ]);
  });

  it('allows swapping two defaults', () => {
    expect(priorityLabelConflicts({ high: { en: 'Urgent' }, urgent: { en: 'High' } })).toEqual([]);
  });

  it('checks each language on its own', () => {
    expect(priorityLabelConflicts({ high: { ar: DEFAULT_PRIORITY_NAMES.ar.urgent } })).toEqual([
      { priority: 'high', locale: 'ar', takenBy: 'urgent' },
    ]);
    expect(priorityLabelConflicts({ high: { en: 'Same' }, urgent: { ar: 'Same' } })).toEqual([]);
  });
});

describe('names that look alike (M1-02 review)', () => {
  it('normalises to NFC, so a decomposed and a composed spelling are one name', () => {
    const decomposed = 'E\u0301leve\u0301';
    const composed = '\u00c9lev\u00e9';

    expect(compactPriorityLabels({ low: { en: decomposed } })).toEqual({ low: { en: composed } });
    expect(priorityLabelConflicts({ low: { en: decomposed }, medium: { en: composed } })).toEqual([
      { priority: 'medium', locale: 'en', takenBy: 'low' },
    ]);
  });

  it('counts tatweel and vowel marks as the same Arabic name as the default', () => {
    expect(priorityLabelConflicts({ low: { ar: 'عــاجلة' } })).toEqual([
      { priority: 'low', locale: 'ar', takenBy: 'urgent' },
    ]);
    expect(priorityLabelConflicts({ low: { ar: 'عَاجِلَةٌ' } })).toHaveLength(1);
  });

  it('compares compatibility forms and case together', () => {
    expect(priorityLabelConflicts({ low: { en: 'ＨＩＧＨ' } })).toHaveLength(1);
  });

  it('refuses an invisible name in a request, at its field', () => {
    const result = priorityLabelsUpdateRequestSchema.safeParse({ low: { en: 'High\u200b' } });

    expect(result.error?.issues[0]?.path).toEqual(['low', 'en']);
  });
});

describe('parseBrandSettings with names that stopped being valid', () => {
  it('keeps the other settings and drops only the names', () => {
    const settings = parseBrandSettings({
      reopenPolicy: { kind: 'never' },
      priorityLabels: { high: { en: 'Low' } },
    });

    expect(settings.reopenPolicy).toEqual({ kind: 'never' });
    expect(settings.priorityLabels).toEqual({});
  });
});

describe('priorityLabelsSchema', () => {
  it('addresses a duplicate by priority and language', () => {
    const result = priorityLabelsSchema.safeParse({ low: { en: 'Medium' } });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['low', 'en']);
  });

  it('defaults to nothing on the brand settings, and an invalid stored value becomes the defaults', () => {
    expect(brandSettingsSchema.parse({}).priorityLabels).toEqual({});
    expect(
      parseBrandSettings({ priorityLabels: { low: { en: 'x'.repeat(40) } } }).priorityLabels,
    ).toEqual({});
  });
});

describe('priorityLabelsUpdateRequestSchema', () => {
  it('accepts the four rows and trims', () => {
    const parsed = priorityLabelsUpdateRequestSchema.parse({
      low: { en: '', ar: '' },
      high: { en: ' P2 ', ar: 'عالية جدًا' },
    });

    expect(compactPriorityLabels(parsed)).toEqual({ high: { en: 'P2', ar: 'عالية جدًا' } });
  });

  it('refuses a name over 24 characters at its field', () => {
    const result = priorityLabelsUpdateRequestSchema.safeParse({ low: { en: 'a'.repeat(25) } });

    expect(result.error?.issues[0]?.path).toEqual(['low', 'en']);
  });

  it('refuses a line break at its field', () => {
    const result = priorityLabelsUpdateRequestSchema.safeParse({ low: { en: 'a\nb' } });

    expect(result.error?.issues[0]?.path).toEqual(['low', 'en']);
  });

  it('refuses a duplicate at the renamed field', () => {
    const result = priorityLabelsUpdateRequestSchema.safeParse({
      high: { en: 'P1' },
      urgent: { en: 'P1' },
    });

    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['urgent', 'en']]);
  });
});

describe('effectivePriorityName', () => {
  it('prefers the override and falls back to the default of that language', () => {
    expect(effectivePriorityName({ high: { en: 'P2' } }, 'high', 'en')).toBe('P2');
    expect(effectivePriorityName({ high: { en: 'P2' } }, 'high', 'ar')).toBe('عالية');
    expect(effectivePriorityName(undefined, 'low', 'en')).toBe('Low');
  });
});
