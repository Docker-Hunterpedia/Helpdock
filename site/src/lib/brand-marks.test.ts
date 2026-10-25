import { describe, expect, it } from 'vitest';
import { brandMark, lettermark } from './brand-marks.ts';

describe('brandMark', () => {
  it('gives the Simple Icons path for a product the set carries', () => {
    expect(brandMark('zendesk')?.path).toMatch(/^M/);
    expect(brandMark('whatsapp')?.hex).toBe('25D366');
  });

  it('gives nothing for a product the set lacks, so the page draws a lettermark', () => {
    expect(brandMark('freescout')).toBeUndefined();
  });
});

describe('lettermark', () => {
  it.each([
    ['osTicket', 'O'],
    ['Zoho Desk', 'Z'],
    ['', '?'],
  ])('marks %s with %s', (name, letter) => {
    expect(lettermark(name)).toBe(letter);
  });
});
