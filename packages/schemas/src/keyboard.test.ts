import { describe, expect, it } from 'vitest';
import { keyboardPreferencesSchema } from './keyboard.js';

describe('keyboardPreferencesSchema', () => {
  it('takes the single-key switch as a boolean', () => {
    expect(keyboardPreferencesSchema.parse({ singleKeyShortcuts: false })).toEqual({
      singleKeyShortcuts: false,
    });
  });

  it('refuses a missing or non-boolean switch', () => {
    expect(keyboardPreferencesSchema.safeParse({}).success).toBe(false);
    expect(keyboardPreferencesSchema.safeParse({ singleKeyShortcuts: 'off' }).success).toBe(false);
  });

  it('drops any other field a client sends', () => {
    expect(
      keyboardPreferencesSchema.parse({ singleKeyShortcuts: true, userId: 'someone-else' }),
    ).toEqual({ singleKeyShortcuts: true });
  });
});
