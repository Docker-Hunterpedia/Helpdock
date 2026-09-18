import { describe, expect, it } from 'vitest';
import rawTokens from '../tokens.json' with { type: 'json' };
import { designTokensSchema, tokens } from './tokens.js';

/**
 * Restated from DESIGN §2.2 rather than imported from the schema: the point is
 * to fail when the tokens drift away from the document, which sharing one list
 * would hide.
 */
const DESIGN_SEMANTIC_TOKENS = [
  'bg.canvas',
  'bg.surface',
  'bg.muted',
  'bg.inverse',
  'text.primary',
  'text.secondary',
  'text.disabled',
  'text.inverse',
  'text.link',
  'border.default',
  'border.strong',
  'border.focus',
  'action.primary',
  'action.primary.hover',
  'action.primary.active',
  'action.primary.text',
  'action.primary.tint',
  'status.success',
  'status.success.tint',
  'status.success.text',
  'status.warning',
  'status.warning.tint',
  'status.warning.text',
  'status.danger',
  'status.danger.tint',
  'status.danger.text',
  'status.info',
  'status.info.tint',
  'status.info.text',
  'status.escalated',
  'status.escalated.tint',
  'status.escalated.text',
];

describe('tokens.json', () => {
  it('validates against the token schema', () => {
    expect(designTokensSchema.safeParse(rawTokens).success).toBe(true);
  });

  it('rejects a palette value that is not an upper-case hex', () => {
    const broken = structuredClone(rawTokens) as Record<string, unknown> & {
      semantic: { light: Record<string, string> };
    };
    broken.semantic.light['bg.canvas'] = '#f7f5f0';

    const result = designTokensSchema.safeParse(broken);

    expect(result.success).toBe(false);
  });
});

describe('semantic tokens', () => {
  it.each(['light', 'dark'] as const)('defines every DESIGN §2.2 token in %s', (mode) => {
    expect(Object.keys(tokens.semantic[mode]).sort()).toEqual([...DESIGN_SEMANTIC_TOKENS].sort());
  });

  it('gives light and dark the same token names', () => {
    expect(Object.keys(tokens.semantic.light)).toEqual(Object.keys(tokens.semantic.dark));
  });

  it('maps the light tokens onto the warm ramp and the teal ramp', () => {
    const { warm } = tokens.palette.surfaceTone;

    expect(tokens.semantic.light['bg.canvas']).toBe(warm.n50);
    expect(tokens.semantic.light['bg.surface']).toBe(warm.n0);
    expect(tokens.semantic.light['bg.muted']).toBe(warm.n100);
    expect(tokens.semantic.light['text.primary']).toBe(warm.n900);
    expect(tokens.semantic.light['text.secondary']).toBe(warm.n600);
    expect(tokens.semantic.light['border.default']).toBe(warm.n200);
    expect(tokens.semantic.light['border.strong']).toBe(warm.n300);
    expect(tokens.semantic.light['action.primary']).toBe(tokens.palette.teal.teal500);
    expect(tokens.semantic.light['action.primary.tint']).toBe(tokens.palette.teal.teal50);
  });

  it('takes the dark accent from teal300 and its text from n900', () => {
    expect(tokens.semantic.dark['action.primary']).toBe(tokens.palette.teal.teal300);
    expect(tokens.semantic.dark['action.primary.text']).toBe(tokens.palette.surfaceTone.warm.n900);
  });
});

describe('the three surface tone ramps', () => {
  it('share the same steps and start from white', () => {
    const steps = Object.keys(tokens.palette.surfaceTone.warm);

    for (const ramp of Object.values(tokens.palette.surfaceTone)) {
      expect(Object.keys(ramp)).toEqual(steps);
      expect(ramp.n0).toBe('#FFFFFF');
    }
  });

  it('uses the grounds DESIGN §8 names', () => {
    expect(tokens.palette.surfaceTone.warm.n50).toBe('#F7F5F0');
    expect(tokens.palette.surfaceTone.neutral.n50).toBe('#F5F5F4');
    expect(tokens.palette.surfaceTone.cool.n50).toBe('#F4F6F8');
  });
});

describe('scales', () => {
  it('uses the spacing scale from DESIGN §4', () => {
    expect(tokens.spacing.scale).toEqual([2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64]);
  });

  it('uses the radius scale from DESIGN §4', () => {
    expect(tokens.radius).toEqual({ sm: 4, md: 6, lg: 10, xl: 14, full: 999 });
  });

  it('uses the durations from DESIGN §4', () => {
    expect(tokens.motion.duration).toEqual({ fast: 120, base: 200, slow: 320 });
  });

  it('keeps every line height a multiple of 4 and every weight in the loaded three', () => {
    for (const style of Object.values(tokens.typography.scale)) {
      expect(style.lineHeight % 4).toBe(0);
      expect([400, 500, 600]).toContain(style.weight);
    }
  });

  it('drops every shadow in dark mode, where borders do the work', () => {
    expect(Object.values(tokens.elevation.dark)).toEqual(['none', 'none', 'none', 'none']);
  });
});
