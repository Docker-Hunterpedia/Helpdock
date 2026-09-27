import { describe, expect, it } from 'vitest';
import {
  layoutFromUpdate,
  resolveFields,
  type WebFormFieldDef,
  WebFormLayoutError,
} from './layout.js';

const def = (key: string, overrides: Partial<WebFormFieldDef> = {}): WebFormFieldDef => ({
  key,
  label: key,
  labelAr: null,
  type: 'text',
  options: [],
  webForm: false,
  ...overrides,
});

const summary = (fields: ReturnType<typeof resolveFields>) =>
  fields.map((field) => [field.field, field.shown, field.required]);

describe('resolveFields', () => {
  it('gives a brand that never saved the four built-in fields, then its custom fields hidden', () => {
    expect(summary(resolveFields([], [def('order_number')]))).toEqual([
      ['name', true, false],
      ['email', true, true],
      ['subject', true, false],
      ['message', true, true],
      ['custom:order_number', false, false],
    ]);
  });

  it('follows the stored order, and takes "shown" for a custom field from its own flag', () => {
    const fields = resolveFields(
      [
        { field: 'custom:product', shown: false, required: true },
        { field: 'message', shown: true, required: true },
        { field: 'email', shown: true, required: true },
        { field: 'name', shown: false, required: true },
        { field: 'subject', shown: true, required: true },
      ],
      [def('product', { webForm: true, type: 'select', options: ['A'] })],
    );

    expect(summary(fields)).toEqual([
      ['custom:product', true, true],
      ['message', true, true],
      ['email', true, true],
      // Hidden, so not required, whatever was stored.
      ['name', false, false],
      ['subject', true, true],
    ]);
    expect(fields[0]).toMatchObject({ kind: 'custom', type: 'select', label: 'product' });
  });

  it('drops a deleted custom field and a repeated entry, and puts back a missing built-in one', () => {
    const fields = resolveFields(
      [
        { field: 'custom:gone', shown: true, required: true },
        { field: 'name', shown: true, required: false },
        { field: 'name', shown: false, required: false },
        { field: 'message', shown: true, required: true },
      ],
      [],
    );

    expect(fields.map((field) => field.field)).toEqual(['name', 'email', 'subject', 'message']);
  });

  it('never lets Email or Message be hidden or optional', () => {
    const fields = resolveFields(
      [
        { field: 'email', shown: false, required: false },
        { field: 'message', shown: false, required: false },
      ],
      [],
    );

    expect(
      fields.filter((field) => field.locked).map((field) => [field.shown, field.required]),
    ).toEqual([
      [true, true],
      [true, true],
    ]);
  });
});

describe('layoutFromUpdate', () => {
  const builtins = ['name', 'email', 'subject', 'message'].map((field) => ({
    field,
    shown: true,
    required: false,
  }));

  it('keeps the order sent and returns the custom fields to flag', () => {
    const result = layoutFromUpdate(
      [{ field: 'custom:plan', shown: true, required: true }, ...builtins],
      [def('plan'), def('country')],
    );

    expect(result.shownKeys).toEqual(['plan']);
    expect(result.layout[0]).toEqual({ field: 'custom:plan', shown: true, required: true });
    expect(result.layout.find((entry) => entry.field === 'email')).toEqual({
      field: 'email',
      shown: true,
      required: true,
    });
  });

  it('drops "required" from a hidden field', () => {
    const result = layoutFromUpdate(
      [...builtins, { field: 'custom:plan', shown: false, required: true }],
      [def('plan')],
    );

    expect(result.layout.at(-1)).toEqual({ field: 'custom:plan', shown: false, required: false });
    expect(result.shownKeys).toEqual([]);
  });

  it.each([
    ['a missing built-in field', builtins.slice(1), 'The name field is missing'],
    ['a repeated field', [...builtins, builtins[0]], 'name is listed twice'],
    [
      'a custom field nobody defined',
      [...builtins, { field: 'custom:nobody', shown: true, required: false }],
      'No ticket custom field has the key nobody',
    ],
  ])('refuses %s', (_label, update, message) => {
    expect(() => layoutFromUpdate(update as typeof builtins, [])).toThrow(
      new WebFormLayoutError(message),
    );
  });
});
