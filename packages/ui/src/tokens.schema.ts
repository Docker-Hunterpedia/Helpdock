import { z } from 'zod';

/** Upper-case six-digit hex. Keeping one spelling makes the tokens diffable. */
const hexColor = z.string().regex(/^#[0-9A-F]{6}$/, 'expected an upper-case #RRGGBB colour');

/** A CSS `box-shadow` value, or `none` where borders do the work. */
const boxShadow = z.string().min(1);

/** DESIGN §3.2: three weights only, bold is not loaded. */
export const FONT_WEIGHTS = [400, 500, 600] as const;
const fontWeight = z
  .number()
  .refine((weight) => (FONT_WEIGHTS as readonly number[]).includes(weight), {
    message: `expected one of ${FONT_WEIGHTS.join(', ')}`,
  });

export const NEUTRAL_STEPS = [
  'n0',
  'n50',
  'n100',
  'n200',
  'n300',
  'n400',
  'n500',
  'n600',
  'n700',
  'n800',
  'n900',
] as const;
export type NeutralStep = (typeof NEUTRAL_STEPS)[number];

export const TEAL_STEPS = [
  'teal50',
  'teal100',
  'teal200',
  'teal300',
  'teal400',
  'teal500',
  'teal600',
  'teal700',
  'teal800',
  'teal900',
] as const;
export type TealStep = (typeof TEAL_STEPS)[number];

/** DESIGN §8: the three pre-built neutral ramps a brand can choose between. */
export const SURFACE_TONES = ['warm', 'neutral', 'cool'] as const;
export type SurfaceTone = (typeof SURFACE_TONES)[number];

/** DESIGN §2.1. A hue never carries two meanings, so this list is closed. */
export const STATUS_NAMES = ['success', 'warning', 'danger', 'info', 'escalated'] as const;
export type StatusName = (typeof STATUS_NAMES)[number];

export const TYPE_STYLES = [
  'display',
  'h1',
  'h2',
  'h3',
  'bodyLg',
  'body',
  'bodyStrong',
  'caption',
  'mono',
] as const;
export type TypeStyle = (typeof TYPE_STYLES)[number];

export const ELEVATION_LEVELS = ['0', '1', '2', '3'] as const;
export type ElevationLevel = (typeof ELEVATION_LEVELS)[number];

const statusSemanticNames = STATUS_NAMES.flatMap(
  (name) => [`status.${name}`, `status.${name}.tint`, `status.${name}.text`] as const,
);

/**
 * Every semantic token in DESIGN §2.2, in the order the table lists them.
 * Components reference these names, never a palette value.
 */
export const SEMANTIC_TOKEN_NAMES = [
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
  ...statusSemanticNames,
] as const;
export type SemanticTokenName = (typeof SEMANTIC_TOKEN_NAMES)[number];

const neutralRampSchema = z.record(z.enum(NEUTRAL_STEPS), hexColor);
const semanticModeSchema = z.record(z.enum(SEMANTIC_TOKEN_NAMES), hexColor);
const typeStyleSchema = z.object({
  size: z.number().positive(),
  lineHeight: z.number().positive(),
  weight: fontWeight,
});

export const designTokensSchema = z.object({
  $comment: z.string(),
  palette: z.object({
    surfaceTone: z.record(z.enum(SURFACE_TONES), neutralRampSchema),
    teal: z.record(z.enum(TEAL_STEPS), hexColor),
    status: z.record(
      z.enum(STATUS_NAMES),
      z.object({ solid: hexColor, tint: hexColor, text: hexColor }),
    ),
    chart: z.object({
      categorical: z.array(hexColor).length(6),
      sequential: z.array(hexColor).length(2),
      diverging: z.array(hexColor).length(3),
    }),
  }),
  semantic: z.object({ light: semanticModeSchema, dark: semanticModeSchema }),
  typography: z.object({
    fontFamily: z.object({ sans: z.string(), arabic: z.string(), mono: z.string() }),
    fontWeight: z.object({ regular: fontWeight, medium: fontWeight, semibold: fontWeight }),
    baseSize: z.object({ admin: z.number().positive(), content: z.number().positive() }),
    scale: z.record(z.enum(TYPE_STYLES), typeStyleSchema),
  }),
  spacing: z.object({
    base: z.number().positive(),
    // DESIGN §4: "Never a value outside the scale."
    scale: z.array(z.number().positive()).nonempty(),
  }),
  radius: z.object({
    sm: z.number().nonnegative(),
    md: z.number().nonnegative(),
    lg: z.number().nonnegative(),
    xl: z.number().nonnegative(),
    full: z.number().nonnegative(),
  }),
  elevation: z.object({
    light: z.record(z.enum(ELEVATION_LEVELS), boxShadow),
    dark: z.record(z.enum(ELEVATION_LEVELS), boxShadow),
  }),
  motion: z.object({
    duration: z.object({
      fast: z.number().positive(),
      base: z.number().positive(),
      slow: z.number().positive(),
    }),
    easing: z.object({ out: z.string().min(1), emphasized: z.string().min(1) }),
  }),
  focus: z.object({
    width: z.number().positive(),
    offset: z.number().nonnegative(),
    style: z.string().min(1),
  }),
});

export type DesignTokens = z.infer<typeof designTokensSchema>;
export type SemanticTokens = DesignTokens['semantic']['light'];
export type NeutralRamp = z.infer<typeof neutralRampSchema>;
export type ThemeMode = keyof DesignTokens['semantic'];
