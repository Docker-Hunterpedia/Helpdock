import { describe, expect, it } from 'vitest';
import {
  brandIdParamSchema,
  brandSchema,
  brandSettingsSchema,
  brandUpdateRequestSchema,
  defaultBrandSettings,
  parseBrandSettings,
} from './brand.js';
import { DEFAULT_CONTENT_POLICY } from './media.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';

const settings = {
  autoAwaitOnAgentReply: true,
  reopenPolicy: { kind: 'within_days', days: 7 },
  // M1-10 nested the brand's content policy in here rather than adding a column
  // of its own; it fills itself in the same way every other key does.
  contentPolicy: DEFAULT_CONTENT_POLICY,
  offerBlockSender: true,
};

const row = {
  id: BRAND,
  name: 'Helpdock',
  prefix: 'HD',
  defaultLocale: 'en',
  timezone: 'UTC',
  status: 'active',
  settings,
};

describe('brandSchema', () => {
  it('drops a column the response must not carry', () => {
    const parsed = brandSchema.parse({ ...row, deletedAt: null, createdAt: new Date() });

    expect(parsed).toEqual(row);
  });

  it('rejects a locale outside en and ar', () => {
    expect(brandSchema.safeParse({ ...row, defaultLocale: 'fr' }).success).toBe(false);
  });
});

describe('brandIdParamSchema', () => {
  it('rejects a path parameter that is not a uuid', () => {
    expect(brandIdParamSchema.safeParse({ brandId: 'not-a-uuid' }).success).toBe(false);
    expect(brandIdParamSchema.safeParse({ brandId: BRAND }).success).toBe(true);
  });
});

describe('brandSettingsSchema', () => {
  it('fills a brand that was created before a key existed', () => {
    expect(brandSettingsSchema.parse({})).toEqual({
      autoAwaitOnAgentReply: true,
      reopenPolicy: { kind: 'within_days', days: 7 },
      contentPolicy: DEFAULT_CONTENT_POLICY,
      // M1-11: the "Mark as spam" dialog offers "Block sender" unless told not to.
      offerBlockSender: true,
    });
  });

  it('starts every brand on the DOMAIN-RULES §2.3 default', () => {
    expect(defaultBrandSettings().reopenPolicy).toEqual({ kind: 'within_days', days: 7 });
  });

  it('accepts the two policies that carry no day count', () => {
    for (const kind of ['always', 'never'] as const) {
      expect(brandSettingsSchema.parse({ reopenPolicy: { kind } }).reopenPolicy).toEqual({ kind });
    }
  });

  it('refuses a day count on a policy that has none', () => {
    const parsed = brandSettingsSchema.safeParse({
      reopenPolicy: { kind: 'never', days: 7 },
    });

    // `days` is not a key of that member, so it is stripped rather than stored
    // under a policy nothing would read it for.
    expect(parsed.success && parsed.data.reopenPolicy).toEqual({ kind: 'never' });
  });

  it('refuses a reopen window outside one day to a year', () => {
    for (const days of [0, -1, 366]) {
      expect(
        brandSettingsSchema.safeParse({ reopenPolicy: { kind: 'within_days', days } }).success,
      ).toBe(false);
    }
  });

  it('refuses a policy kind nobody implements', () => {
    expect(brandSettingsSchema.safeParse({ reopenPolicy: { kind: 'sometimes' } }).success).toBe(
      false,
    );
  });
});

describe('parseBrandSettings', () => {
  it('keeps what a brand actually chose', () => {
    expect(
      parseBrandSettings({ autoAwaitOnAgentReply: false, reopenPolicy: { kind: 'never' } }),
    ).toEqual({
      autoAwaitOnAgentReply: false,
      reopenPolicy: { kind: 'never' },
      contentPolicy: DEFAULT_CONTENT_POLICY,
      offerBlockSender: true,
    });
  });

  it('keeps a content policy a brand narrowed, and fills the rest of it', () => {
    const narrowed = parseBrandSettings({
      contentPolicy: { video: { enabled: false, maxBytes: 1_000, allowedMime: ['video/mp4'] } },
    });

    expect(narrowed.contentPolicy.video.enabled).toBe(false);
    expect(narrowed.contentPolicy.image).toEqual(DEFAULT_CONTENT_POLICY.image);
  });

  it('falls back to the defaults rather than throwing on a column edited by hand', () => {
    expect(parseBrandSettings({ reopenPolicy: 'whenever' })).toEqual(defaultBrandSettings());
    expect(parseBrandSettings(null)).toEqual(defaultBrandSettings());
  });
});

describe('brandUpdateRequestSchema', () => {
  it('accepts one field on its own', () => {
    expect(brandUpdateRequestSchema.safeParse({ name: 'Acme Support' }).success).toBe(true);
  });

  it('refuses a body that changes nothing', () => {
    expect(brandUpdateRequestSchema.safeParse({}).success).toBe(false);
  });

  it('never lets the prefix through, because a ticket number is forever', () => {
    const parsed = brandUpdateRequestSchema.parse({ name: 'Acme', prefix: 'NEW' });

    expect(parsed).not.toHaveProperty('prefix');
  });

  it('trims a name so two brands cannot differ by a space', () => {
    expect(brandUpdateRequestSchema.parse({ name: '  Acme  ' }).name).toBe('Acme');
  });
});
