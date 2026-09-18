import { z } from 'zod';
import { formatHex, mixOver, parseHex, shiftLightness } from './color.js';
import { AA_LARGE_TEXT, AA_TEXT, contrastRatio } from './contrast.js';
import { tokens } from './tokens.js';
import type { NeutralRamp, SurfaceTone, ThemeMode } from './tokens.schema.js';
import { SURFACE_TONES } from './tokens.schema.js';

/** DESIGN §8: hover and active are the accent moved down the OKLCH L axis. */
const HOVER_LIGHTNESS_DELTA = -0.06;
const ACTIVE_LIGHTNESS_DELTA = -0.12;

/**
 * Dark mode uses a lighter accent: DESIGN §2.2 pairs light `action.primary`
 * teal500 with dark teal300, which is +0.21 OKLCH lightness. Applying the same
 * lift to a brand accent keeps a custom brand readable on `bg.surface` dark,
 * where the unlifted teal500 only reaches 3.02:1.
 */
const DARK_LIGHTNESS_DELTA = 0.21;

/** DESIGN §8: the tint is the accent at 10 % over the surface. */
const TINT_ALPHA = 0.1;

/** DESIGN §4: `md` is 6 by default and a brand may set it anywhere in 0–12. */
const DEFAULT_RADIUS = tokens.radius.md;

/**
 * DESIGN §8: a curated list of self-hosted pairs, each with an Arabic
 * companion. No arbitrary font URLs. Only `ibm-plex` ships in
 * `packages/ui/fonts` today; the other two arrive with their own deliverable,
 * and until then they fall back to the system stack.
 */
export const BRAND_FONTS = {
  'ibm-plex': {
    label: 'IBM Plex Sans',
    sans: tokens.typography.fontFamily.sans,
    arabic: tokens.typography.fontFamily.arabic,
    mono: tokens.typography.fontFamily.mono,
  },
  'noto-sans': {
    label: 'Noto Sans',
    sans: "'Noto Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
    arabic: "'Noto Sans Arabic', 'Noto Sans', ui-sans-serif, system-ui, sans-serif",
    mono: "'Noto Sans Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
  vazirmatn: {
    label: 'Vazirmatn',
    sans: "'Vazirmatn', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
    arabic: "'Vazirmatn', ui-sans-serif, system-ui, sans-serif",
    mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
} as const;

export type BrandFont = keyof typeof BRAND_FONTS;
export const BRAND_FONT_NAMES = Object.keys(BRAND_FONTS) as [BrandFont, ...BrandFont[]];

export const BRAND_MODES = ['light', 'dark', 'auto'] as const;
export type BrandMode = (typeof BRAND_MODES)[number];

const hexInput = z.string().regex(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'expected a hex colour');

export const brandThemeInputSchema = z.object({
  accent: hexInput.default(tokens.palette.teal.teal500),
  surfaceTone: z.enum(SURFACE_TONES).default('warm'),
  radius: z.number().int().min(0).max(12).default(DEFAULT_RADIUS),
  font: z.enum(BRAND_FONT_NAMES).default('ibm-plex'),
  mode: z.enum(BRAND_MODES).default('auto'),
});

export type BrandThemeInput = z.input<typeof brandThemeInputSchema>;

export interface BrandAccent {
  readonly base: string;
  readonly hover: string;
  readonly active: string;
  /** White when it reaches AA on the accent, otherwise the ramp's n900. */
  readonly text: string;
  readonly tint: string;
  /** The accent against `bg.surface` in this mode. DESIGN §8 blocks below 3. */
  readonly contrastOnSurface: number;
  /** The computed `text` against the accent. */
  readonly contrastOnAccent: number;
}

export interface ResolvedBrandTheme {
  readonly accent: Readonly<Record<ThemeMode, BrandAccent>>;
  readonly surfaceTone: SurfaceTone;
  readonly neutral: NeutralRamp;
  readonly radius: {
    readonly sm: number;
    readonly md: number;
    readonly lg: number;
    readonly xl: number;
    readonly full: number;
  };
  readonly fontFamily: { readonly sans: string; readonly arabic: string; readonly mono: string };
  readonly font: BrandFont;
  readonly mode: BrandMode;
}

export type BrandThemeProblemCode =
  | 'accent.invalid'
  | 'accent.contrast-below-minimum'
  | 'accent.text-contrast-below-aa'
  | 'radius.out-of-range'
  | 'surfaceTone.unknown'
  | 'font.unknown'
  | 'mode.unknown'
  | 'input.malformed';

export interface BrandThemeProblem {
  readonly field: 'accent' | 'surfaceTone' | 'radius' | 'font' | 'mode' | 'input';
  readonly code: BrandThemeProblemCode;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  /** The mode the problem was measured in, when it is mode-specific. */
  readonly mode?: ThemeMode;
  /** The measured contrast ratio, for the two contrast problems. */
  readonly ratio?: number;
}

export class BrandThemeError extends Error {
  readonly problems: readonly BrandThemeProblem[];

  constructor(problems: readonly BrandThemeProblem[]) {
    super(`Invalid brand theme: ${problems.map((problem) => problem.message).join('; ')}`);
    this.name = 'BrandThemeError';
    this.problems = problems;
  }
}

const ISSUE_CODES: Record<
  string,
  { field: BrandThemeProblem['field']; code: BrandThemeProblemCode }
> = {
  accent: { field: 'accent', code: 'accent.invalid' },
  surfaceTone: { field: 'surfaceTone', code: 'surfaceTone.unknown' },
  radius: { field: 'radius', code: 'radius.out-of-range' },
  font: { field: 'font', code: 'font.unknown' },
  mode: { field: 'mode', code: 'mode.unknown' },
};

/** Expands `#abc` to `#AABBCC` so every stored accent has one spelling. */
const normalizeHex = (hex: string): string => formatHex(parseHex(hex));

const accentForMode = (accent: string, mode: ThemeMode): string =>
  mode === 'dark' ? shiftLightness(accent, DARK_LIGHTNESS_DELTA) : accent;

function resolveAccent(accent: string, mode: ThemeMode, ramp: NeutralRamp): BrandAccent {
  const base = accentForMode(accent, mode);
  const surface = tokens.semantic[mode]['bg.surface'];
  const white = ramp.n0;
  const onWhite = contrastRatio(white, base);
  const text = onWhite >= AA_TEXT ? white : ramp.n900;

  return {
    base,
    hover: shiftLightness(base, HOVER_LIGHTNESS_DELTA),
    active: shiftLightness(base, ACTIVE_LIGHTNESS_DELTA),
    text,
    tint: mixOver(base, surface, TINT_ALPHA),
    contrastOnSurface: contrastRatio(base, surface),
    contrastOnAccent: contrastRatio(text, base),
  };
}

/** The modes a brand's accent has to work in. `auto` has to work in both. */
const modesToCheck = (mode: BrandMode): readonly ThemeMode[] =>
  mode === 'auto' ? (['light', 'dark'] as const) : ([mode] as const);

/**
 * Turns a brand's stored choices into the final token set (DESIGN §8).
 * Throws `BrandThemeError` when the input does not match the schema; a low
 * contrast ratio is reported on the result and by `validateBrandTheme` instead,
 * so the admin preview can still render what the brand asked for.
 */
export function resolveBrandTheme(input: BrandThemeInput = {}): ResolvedBrandTheme {
  const parsed = brandThemeInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new BrandThemeError(problemsFromIssues(parsed.error.issues));
  }

  const { surfaceTone, radius, font, mode } = parsed.data;
  const accent = normalizeHex(parsed.data.accent);
  const ramp = tokens.palette.surfaceTone[surfaceTone];
  const scale = radius / DEFAULT_RADIUS;

  return {
    accent: {
      light: resolveAccent(accent, 'light', ramp),
      dark: resolveAccent(accent, 'dark', ramp),
    },
    surfaceTone,
    neutral: ramp,
    radius: {
      // DESIGN §4: a brand moves `md` and `lg`; `sm`, `xl` and `full` are fixed.
      sm: tokens.radius.sm,
      md: radius,
      lg: Math.round(tokens.radius.lg * scale),
      xl: tokens.radius.xl,
      full: tokens.radius.full,
    },
    fontFamily: {
      sans: BRAND_FONTS[font].sans,
      arabic: BRAND_FONTS[font].arabic,
      mono: BRAND_FONTS[font].mono,
    },
    font,
    mode,
  };
}

function problemsFromIssues(issues: readonly z.core.$ZodIssue[]): BrandThemeProblem[] {
  return issues.map((issue) => {
    const key = typeof issue.path[0] === 'string' ? issue.path[0] : '';
    const mapped = ISSUE_CODES[key] ?? {
      field: 'input' as const,
      code: 'input.malformed' as const,
    };

    return {
      field: mapped.field,
      code: mapped.code,
      severity: 'error' as const,
      message: `${key || 'input'}: ${issue.message}`,
    };
  });
}

/**
 * Every problem with a brand's choices, worst first. An empty array means the
 * brand can be saved. DESIGN §8: an accent below 3:1 against `bg.surface` is an
 * error and the admin blocks it; text below AA on the accent is a warning,
 * because the resolver already picked the better of white and n900.
 */
export function validateBrandTheme(input: unknown): BrandThemeProblem[] {
  const parsed = brandThemeInputSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return problemsFromIssues(parsed.error.issues);
  }

  const resolved = resolveBrandTheme(parsed.data);
  const problems: BrandThemeProblem[] = [];

  for (const mode of modesToCheck(resolved.mode)) {
    const accent = resolved.accent[mode];

    if (accent.contrastOnSurface < AA_LARGE_TEXT) {
      problems.push({
        field: 'accent',
        code: 'accent.contrast-below-minimum',
        severity: 'error',
        mode,
        ratio: accent.contrastOnSurface,
        message: `accent ${accent.base} reaches only ${accent.contrastOnSurface.toFixed(2)}:1 against the ${mode} surface, below the ${AA_LARGE_TEXT}:1 minimum`,
      });
    }

    if (accent.contrastOnAccent < AA_TEXT) {
      problems.push({
        field: 'accent',
        code: 'accent.text-contrast-below-aa',
        severity: 'warning',
        mode,
        ratio: accent.contrastOnAccent,
        message: `text on the ${mode} accent reaches only ${accent.contrastOnAccent.toFixed(2)}:1, below the ${AA_TEXT}:1 minimum`,
      });
    }
  }

  return problems.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}
