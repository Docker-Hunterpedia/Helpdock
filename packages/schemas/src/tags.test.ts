import { describe, expect, it } from 'vitest';
import {
  tagColorSchema,
  tagCreateRequestSchema,
  tagReorderRequestSchema,
  tagSchema,
  tagUpdateRequestSchema,
  ticketTagsRequestSchema,
} from './tags.js';

const TAG_ID = '01937f5e-7e53-7000-8000-000000000001';

describe('tagColorSchema', () => {
  it('is the eight tints of DESIGN §6.2', () => {
    expect(tagColorSchema.options).toEqual([
      'info',
      'success',
      'warning',
      'escalated',
      'sand',
      'stone',
      'clay',
      'bark',
    ]);
  });

  it('refuses danger, which means breached or destructive on this desk', () => {
    // §6.2: "never the danger tint". A tag a brand invents must not be able to
    // claim the hue an SLA breach uses.
    expect(tagColorSchema.safeParse('danger').success).toBe(false);
  });

  it('refuses a hex value, so a theme change never has to rewrite rows', () => {
    expect(tagColorSchema.safeParse('#0F766E').success).toBe(false);
  });
});

describe('tagCreateRequestSchema', () => {
  it('defaults to the quietest of the eight', () => {
    expect(tagCreateRequestSchema.parse({ name: 'Refund' })).toMatchObject({
      name: 'Refund',
      color: 'sand',
    });
  });

  it('trims the name, so a tag of spaces is not a tag', () => {
    expect(tagCreateRequestSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('takes an Arabic name and keeps null meaning "not translated"', () => {
    expect(tagCreateRequestSchema.parse({ name: 'Refund', nameAr: 'استرداد' }).nameAr).toBe(
      'استرداد',
    );
    expect(tagCreateRequestSchema.parse({ name: 'Refund', nameAr: null }).nameAr).toBeNull();
  });
});

describe('tagUpdateRequestSchema', () => {
  it('refuses a body that changes nothing', () => {
    expect(tagUpdateRequestSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a colour change alone', () => {
    expect(tagUpdateRequestSchema.parse({ color: 'info' })).toEqual({ color: 'info' });
  });
});

describe('tagReorderRequestSchema', () => {
  it('refuses an empty order, which would say nothing', () => {
    expect(tagReorderRequestSchema.safeParse({ tagIds: [] }).success).toBe(false);
  });
});

describe('ticketTagsRequestSchema', () => {
  it('accepts an empty set, which is how every tag is taken off', () => {
    expect(ticketTagsRequestSchema.parse({ tagIds: [] })).toEqual({ tagIds: [] });
  });
});

describe('tagSchema', () => {
  it('carries only what a chip draws', () => {
    // A ticket list of fifty rows embeds these; a ticket count per chip per row
    // is what the settings list is for.
    expect(Object.keys(tagSchema.shape).sort()).toEqual(['color', 'id', 'name', 'nameAr']);
    expect(tagSchema.parse({ id: TAG_ID, name: 'Refund', nameAr: null, color: 'info' })).toEqual({
      id: TAG_ID,
      name: 'Refund',
      nameAr: null,
      color: 'info',
    });
  });
});
