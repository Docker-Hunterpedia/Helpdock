import { describe, expect, it } from 'vitest';
import { COMPETITORS } from '../data/competitors.ts';
import { type Competitor, CompetitorSchema, CompetitorsSchema } from './competitor-schema.ts';

const zammad = COMPETITORS.find((item) => item.slug === 'zammad') as Competitor;
const zendesk = COMPETITORS.find((item) => item.slug === 'zendesk') as Competitor;

// competitors.ts parses its own list at import, so a schema failure fails this file outright.
describe('the competitor data', () => {
  it('presents an importer only for Zendesk, Freshdesk and Zoho Desk', () => {
    expect(COMPETITORS.filter((item) => item.importer).map((item) => item.slug)).toEqual([
      'zendesk',
      'freshdesk',
      'zoho-desk',
    ]);
  });

  it('sources every fact about another product over https', () => {
    for (const item of COMPETITORS) {
      expect(item.hostingSource.url).toMatch(/^https:\/\//);
      expect(item.licenceSource.url).toMatch(/^https:\/\//);
    }
  });
});

describe('CompetitorSchema', () => {
  it('refuses an importer for a source that only has a deferred connector', () => {
    const result = CompetitorSchema.safeParse({ ...zammad, importer: true });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/no built-in importer/);
  });

  it('refuses an importer source without its Arabic page or migration guide', () => {
    const { ar: _ar, ...withoutArabic } = zendesk;
    expect(CompetitorSchema.safeParse(withoutArabic).success).toBe(false);
  });

  it('refuses a fact without a source link', () => {
    const result = CompetitorSchema.safeParse({
      ...zammad,
      licenceSource: { label: 'LICENSE', url: 'not a url' },
    });
    expect(result.success).toBe(false);
  });

  it('refuses two pages with the same slug', () => {
    expect(CompetitorsSchema.safeParse([zammad, zammad]).success).toBe(false);
  });
});
