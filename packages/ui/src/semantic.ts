import type { ResolvedBrandTheme } from './brand.js';
import { tokens } from './tokens.js';
import type { SemanticTokens, ThemeMode } from './tokens.schema.js';

/**
 * The semantic token set for a mode, with a brand's choices applied on top
 * (DESIGN §8). Brands tint; they never restyle: status hues, spacing and the
 * type scale come through untouched.
 *
 * `surfaceTone` only moves the light ramp. The dark neutrals in DESIGN §2.2 are
 * drawn values rather than steps of a ramp, so a brand keeps them as they are.
 */
export function resolveSemanticTokens(mode: ThemeMode, brand?: ResolvedBrandTheme): SemanticTokens {
  const base = tokens.semantic[mode];
  if (!brand) {
    return base;
  }

  const accent = brand.accent[mode];
  const ramp = brand.neutral;
  const ground =
    mode === 'light'
      ? {
          'bg.canvas': ramp.n50,
          'bg.surface': ramp.n0,
          'bg.muted': ramp.n100,
          'bg.inverse': ramp.n900,
          'text.primary': ramp.n900,
          'text.secondary': ramp.n600,
          'text.disabled': ramp.n400,
          'text.inverse': ramp.n0,
          'border.default': ramp.n200,
          'border.strong': ramp.n300,
        }
      : {};

  return {
    ...base,
    ...ground,
    'text.link': accent.base,
    'border.focus': accent.base,
    'action.primary': accent.base,
    'action.primary.hover': accent.hover,
    'action.primary.active': accent.active,
    'action.primary.text': accent.text,
    'action.primary.tint': accent.tint,
  };
}
