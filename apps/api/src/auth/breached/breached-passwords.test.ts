import { describe, expect, it } from 'vitest';
import { assertNotBreached, isBreachedPassword } from './breached-passwords.js';

describe('the bundled breached-password list (ASVS 2.1.7)', () => {
  it('knows the long passwords people actually reuse, whatever their case', () => {
    expect(isBreachedPassword('qwertyuiop123')).toBe(true);
    expect(isBreachedPassword('QwertyUIOP123')).toBe(true);
    expect(isBreachedPassword('passwordpassword')).toBe(true);
  });

  it('lets an ordinary long phrase through', () => {
    expect(isBreachedPassword('correct horse battery ledger')).toBe(false);
  });

  it('refuses a breached one as a password-breached auth failure', () => {
    expect(() => assertNotBreached('iloveyou1234')).toThrow(
      expect.objectContaining({ auth: { code: 'password-breached' } }),
    );
    expect(() => assertNotBreached('correct horse battery ledger')).not.toThrow();
  });
});
