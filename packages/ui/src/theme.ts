import { createTheme, type Theme, type ThemeOptions } from '@mui/material/styles';
import type { CSSProperties } from 'react';
import type { ResolvedBrandTheme } from './brand.js';
import { resolveSemanticTokens } from './semantic.js';
import { tokens } from './tokens.js';
import type { SemanticTokens, ThemeMode } from './tokens.schema.js';

declare module '@mui/material/styles' {
  interface TypographyVariants {
    display: CSSProperties;
    bodyStrong: CSSProperties;
    mono: CSSProperties;
  }
  interface TypographyVariantsOptions {
    display?: CSSProperties;
    bodyStrong?: CSSProperties;
    mono?: CSSProperties;
  }
}

declare module '@mui/material/Typography' {
  interface TypographyPropsVariantOverrides {
    display: true;
    bodyStrong: true;
    mono: true;
  }
}

export type Direction = 'ltr' | 'rtl';

export interface CreateHelpdockThemeOptions {
  readonly mode: ThemeMode;
  readonly direction: Direction;
  /** From `resolveBrandTheme`. Omitted means the stock Helpdock accent. */
  readonly brand?: ResolvedBrandTheme;
}

/**
 * Component heights from DESIGN §6. They are not tokens: §6 fixes component
 * anatomy and a brand cannot change it.
 */
const SIZE = {
  buttonSmall: 28,
  buttonMedium: 36,
  buttonLarge: 44,
  input: 36,
  badge: 22,
  tab: 32,
  tableRow: 44,
} as const;

const px = (value: number): string => `${value}px`;

const typeStyle = (style: keyof typeof tokens.typography.scale) => {
  const { size, lineHeight, weight } = tokens.typography.scale[style];

  return {
    fontSize: px(size),
    lineHeight: px(lineHeight),
    fontWeight: weight,
  };
};

const focusRing = (semantic: SemanticTokens) => ({
  outline: `${px(tokens.focus.width)} ${tokens.focus.style} ${semantic['border.focus']}`,
  outlineOffset: px(tokens.focus.offset),
});

/**
 * MUI keeps 25 elevation levels; DESIGN §4 has four. Everything above a dialog
 * reuses level 3 rather than inventing a shadow.
 */
function buildShadows(mode: ThemeMode): ThemeOptions['shadows'] {
  const { 0: none, 1: one, 2: two, 3: three } = tokens.elevation[mode];
  const rest = Array.from({ length: 21 }, () => three);

  return [none, one, two, three, ...rest] as ThemeOptions['shadows'];
}

function buildPalette(mode: ThemeMode, semantic: SemanticTokens): ThemeOptions['palette'] {
  return {
    mode,
    primary: {
      main: semantic['action.primary'],
      dark: semantic['action.primary.active'],
      light: semantic['action.primary.tint'],
      contrastText: semantic['action.primary.text'],
    },
    secondary: {
      main: semantic['text.primary'],
      contrastText: semantic['text.inverse'],
    },
    success: { main: semantic['status.success'], contrastText: semantic['text.inverse'] },
    warning: { main: semantic['status.warning'], contrastText: semantic['text.inverse'] },
    error: { main: semantic['status.danger'], contrastText: semantic['text.inverse'] },
    info: { main: semantic['status.info'], contrastText: semantic['text.inverse'] },
    background: { default: semantic['bg.canvas'], paper: semantic['bg.surface'] },
    text: {
      primary: semantic['text.primary'],
      secondary: semantic['text.secondary'],
      disabled: semantic['text.disabled'],
    },
    divider: semantic['border.default'],
  };
}

function buildTypography(fonts: ResolvedBrandTheme['fontFamily']): ThemeOptions['typography'] {
  return {
    fontFamily: fonts.sans,
    fontSize: tokens.typography.baseSize.admin,
    fontWeightRegular: tokens.typography.fontWeight.regular,
    fontWeightMedium: tokens.typography.fontWeight.medium,
    fontWeightBold: tokens.typography.fontWeight.semibold,
    display: typeStyle('display'),
    h1: typeStyle('h1'),
    h2: typeStyle('h2'),
    h3: typeStyle('h3'),
    // DESIGN §3.1 stops at h3; the remaining MUI headings reuse it so nothing
    // can render at a size outside the scale.
    h4: typeStyle('h3'),
    h5: typeStyle('h3'),
    h6: typeStyle('h3'),
    subtitle1: typeStyle('bodyStrong'),
    subtitle2: typeStyle('caption'),
    body1: typeStyle('bodyLg'),
    body2: typeStyle('body'),
    bodyStrong: typeStyle('bodyStrong'),
    caption: typeStyle('caption'),
    mono: { ...typeStyle('mono'), fontFamily: fonts.mono },
    button: { ...typeStyle('bodyStrong'), textTransform: 'none' },
    overline: {
      ...typeStyle('caption'),
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
    },
  };
}

function buildComponents(
  mode: ThemeMode,
  semantic: SemanticTokens,
  radius: ResolvedBrandTheme['radius'],
): ThemeOptions['components'] {
  const ring = focusRing(semantic);
  const elevation = tokens.elevation[mode];

  return {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          borderRadius: px(radius.md),
          textTransform: 'none',
          fontWeight: tokens.typography.fontWeight.medium,
          boxShadow: 'none',
          transition: `background-color ${tokens.motion.duration.fast}ms ${tokens.motion.easing.out}, border-color ${tokens.motion.duration.fast}ms ${tokens.motion.easing.out}`,
          '&:focus-visible': ring,
          '&.Mui-disabled': { color: semantic['text.disabled'] },
        },
        sizeSmall: { height: px(SIZE.buttonSmall), paddingInline: px(10) },
        sizeMedium: { height: px(SIZE.buttonMedium), paddingInline: px(14) },
        sizeLarge: { height: px(SIZE.buttonLarge), paddingInline: px(16) },
      },
      variants: [
        {
          props: { variant: 'contained', color: 'primary' },
          style: {
            backgroundColor: semantic['action.primary'],
            color: semantic['action.primary.text'],
            '&:hover': { backgroundColor: semantic['action.primary.hover'] },
            '&:active': { backgroundColor: semantic['action.primary.active'] },
          },
        },
        {
          props: { variant: 'outlined', color: 'secondary' },
          style: {
            borderColor: semantic['border.strong'],
            color: semantic['text.primary'],
            backgroundColor: semantic['bg.surface'],
            '&:hover': {
              borderColor: semantic['border.strong'],
              backgroundColor: semantic['bg.muted'],
            },
          },
        },
        {
          props: { variant: 'text', color: 'secondary' },
          style: {
            color: semantic['text.primary'],
            '&:hover': { backgroundColor: semantic['bg.muted'] },
          },
        },
        {
          props: { variant: 'outlined', color: 'error' },
          style: {
            borderColor: semantic['status.danger'],
            color: semantic['status.danger.text'],
            '&:hover': {
              borderColor: semantic['status.danger'],
              backgroundColor: semantic['status.danger.tint'],
            },
          },
        },
        {
          props: { variant: 'contained', color: 'error' },
          style: {
            backgroundColor: semantic['status.danger'],
            color: semantic['text.inverse'],
          },
        },
      ],
    },

    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          height: px(SIZE.input),
          borderRadius: px(radius.md),
          backgroundColor: semantic['bg.surface'],
          ...typeStyle('body'),
          '& .MuiOutlinedInput-notchedOutline': { borderColor: semantic['border.strong'] },
          '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: semantic['border.strong'] },
          '&.Mui-focused': ring,
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
            borderWidth: '1px',
            borderColor: semantic['border.focus'],
          },
          '&.Mui-error .MuiOutlinedInput-notchedOutline': {
            borderColor: semantic['status.danger'],
          },
        },
        input: { paddingBlock: 0, paddingInline: px(10) },
      },
    },

    MuiChip: {
      styleOverrides: {
        root: {
          height: px(SIZE.badge),
          borderRadius: px(radius.md),
          ...typeStyle('caption'),
        },
        label: { paddingInline: px(8) },
      },
    },

    MuiDialog: {
      styleOverrides: {
        paper: {
          borderRadius: px(radius.lg),
          border: `1px solid ${semantic['border.default']}`,
          backgroundColor: semantic['bg.surface'],
          boxShadow: elevation['3'],
          backgroundImage: 'none',
        },
      },
    },

    MuiTooltip: {
      defaultProps: { enterDelay: tokens.motion.duration.base },
      styleOverrides: {
        tooltip: {
          backgroundColor: semantic['bg.inverse'],
          color: semantic['text.inverse'],
          borderRadius: px(radius.sm),
          ...typeStyle('caption'),
          paddingBlock: px(4),
          paddingInline: px(8),
        },
        arrow: { color: semantic['bg.inverse'] },
      },
    },

    MuiSnackbarContent: {
      styleOverrides: {
        root: {
          backgroundColor: semantic['bg.inverse'],
          color: semantic['text.inverse'],
          borderRadius: px(radius.md),
          boxShadow: elevation['2'],
          ...typeStyle('body'),
        },
      },
    },

    MuiTab: {
      styleOverrides: {
        root: {
          minHeight: px(SIZE.tab),
          height: px(SIZE.tab),
          textTransform: 'none',
          fontSize: px(13),
          fontWeight: tokens.typography.fontWeight.medium,
          color: semantic['text.secondary'],
          paddingInline: px(12),
          '&.Mui-selected': { color: semantic['action.primary'] },
          '&:focus-visible': ring,
        },
      },
    },

    MuiTabs: {
      styleOverrides: {
        root: { minHeight: px(SIZE.tab), borderBottom: `1px solid ${semantic['border.default']}` },
        indicator: { height: '2px', backgroundColor: semantic['action.primary'] },
      },
    },

    MuiTableCell: {
      styleOverrides: {
        root: {
          height: px(SIZE.tableRow),
          paddingBlock: 0,
          paddingInline: px(12),
          borderBottom: `1px solid ${semantic['border.default']}`,
          ...typeStyle('body'),
        },
        head: {
          backgroundColor: semantic['bg.muted'],
          color: semantic['text.secondary'],
          ...typeStyle('caption'),
        },
      },
    },
  };
}

/**
 * Builds the MUI theme for one mode and direction (DESIGN §11). Pair it with
 * `createRtlCache()` from `./rtl.js` when `direction` is `rtl`.
 */
export function createHelpdockTheme({ mode, direction, brand }: CreateHelpdockThemeOptions): Theme {
  const semantic = resolveSemanticTokens(mode, brand);
  const radius = brand?.radius ?? tokens.radius;
  const fontFamily = brand?.fontFamily ?? tokens.typography.fontFamily;

  return createTheme({
    direction,
    spacing: tokens.spacing.base,
    shape: { borderRadius: radius.md },
    shadows: buildShadows(mode),
    palette: buildPalette(mode, semantic),
    typography: buildTypography(fontFamily),
    components: buildComponents(mode, semantic, radius),
  });
}
