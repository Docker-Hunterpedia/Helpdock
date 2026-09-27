import { describe, expect, it } from 'vitest';
import {
  customFieldRef,
  customKeyOfRef,
  isBuiltinField,
  webFormFieldRefSchema,
  webFormSettingsUpdateSchema,
} from './web-form.js';

const BUILTINS = ['name', 'email', 'subject', 'message'].map((field) => ({
  field,
  shown: true,
  required: false,
}));

describe('a field reference', () => {
  it.each(['name', 'email', 'subject', 'message', 'custom:order_number'])('accepts %s', (ref) => {
    expect(webFormFieldRefSchema.safeParse(ref).success).toBe(true);
  });

  it.each(['phone', 'custom:', 'custom:Order', 'custom:a:b', 'order_number'])(
    'refuses %s',
    (ref) => {
      expect(webFormFieldRefSchema.safeParse(ref).success).toBe(false);
    },
  );

  it('goes to and from a custom field key', () => {
    expect(customFieldRef('plan')).toBe('custom:plan');
    expect(customKeyOfRef('custom:plan')).toBe('plan');
    expect(customKeyOfRef('email')).toBeNull();
    expect(isBuiltinField('email')).toBe(true);
    expect(isBuiltinField('custom:email')).toBe(false);
  });
});

describe('webFormSettingsUpdateSchema', () => {
  const valid = {
    enabled: true,
    departmentId: null,
    captchaEnabled: false,
    thankYou: { en: ' Thanks ', ar: 'شكراً' },
    fields: BUILTINS,
  };

  it('trims the thank-you messages', () => {
    expect(webFormSettingsUpdateSchema.parse(valid).thankYou.en).toBe('Thanks');
  });

  it.each([
    ['an empty thank-you message', { thankYou: { en: '  ', ar: 'x' } }],
    ['a thank-you message over 1000 characters', { thankYou: { en: 'x'.repeat(1001), ar: 'x' } }],
    ['fewer fields than the built-in four', { fields: BUILTINS.slice(1) }],
    ['a department that is not an id', { departmentId: 'support' }],
  ])('refuses %s', (_label, change) => {
    expect(webFormSettingsUpdateSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });
});
