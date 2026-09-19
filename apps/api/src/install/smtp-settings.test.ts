import { settingDefinitions, settingsSchema } from '@helpdock/config';
import { SMTP_TLS_MODES, smtpCredentialsSchema } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';

/**
 * `packages/config` sits below `@helpdock/schemas`, so the three TLS modes are
 * spelled in both. This is the seam that holds them together: the api imports
 * both packages, so a value the wizard accepts and the registry refuses is
 * caught here rather than at the moment somebody saves it.
 */
describe('the smtp settings the wizard writes', () => {
  it('agrees with the wizard about what a TLS mode is', () => {
    for (const mode of SMTP_TLS_MODES) {
      expect(settingsSchema['smtp.tls'].safeParse(mode).success, mode).toBe(true);
      expect(smtpCredentialsSchema.shape.tls.safeParse(mode).success, mode).toBe(true);
    }

    expect(settingsSchema['smtp.tls'].safeParse('ssl').success).toBe(false);
  });

  it('keeps the password a secret and everything else not', () => {
    expect(settingDefinitions['smtp.password'].secret).toBe(true);

    for (const key of [
      'smtp.host',
      'smtp.port',
      'smtp.tls',
      'smtp.from',
      'smtp.fromName',
    ] as const) {
      expect(settingDefinitions[key].secret, key).toBe(false);
    }
  });

  it('agrees with the wizard about which ports exist', () => {
    for (const port of [1, 25, 465, 587, 2525, 65_535]) {
      expect(settingsSchema['smtp.port'].safeParse(port).success, String(port)).toBe(true);
      expect(smtpCredentialsSchema.shape.port.safeParse(port).success, String(port)).toBe(true);
    }

    for (const port of [0, 65_536]) {
      expect(settingsSchema['smtp.port'].safeParse(port).success, String(port)).toBe(false);
      expect(smtpCredentialsSchema.shape.port.safeParse(port).success, String(port)).toBe(false);
    }
  });
});
