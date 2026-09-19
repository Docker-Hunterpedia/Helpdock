import { describe, expect, it } from 'vitest';
import { resolveBrandTheme } from './brand.js';
import { createHelpdockTheme } from './theme.js';
import { tokens } from './tokens.js';

const light = createHelpdockTheme({ mode: 'light', direction: 'ltr' });
const dark = createHelpdockTheme({ mode: 'dark', direction: 'ltr' });

describe('palette', () => {
  it('takes its colours from the semantic tokens of the mode', () => {
    expect(light.palette.mode).toBe('light');
    expect(light.palette.primary.main).toBe(tokens.semantic.light['action.primary']);
    expect(light.palette.primary.contrastText).toBe(tokens.semantic.light['action.primary.text']);
    expect(light.palette.background.default).toBe(tokens.semantic.light['bg.canvas']);
    expect(light.palette.background.paper).toBe(tokens.semantic.light['bg.surface']);
    expect(light.palette.divider).toBe(tokens.semantic.light['border.default']);
  });

  it('switches every one of them in dark mode', () => {
    expect(dark.palette.mode).toBe('dark');
    expect(dark.palette.primary.main).toBe(tokens.semantic.dark['action.primary']);
    expect(dark.palette.text.primary).toBe(tokens.semantic.dark['text.primary']);
  });

  it('maps the four status hues onto the MUI intent colours', () => {
    expect(light.palette.success.main).toBe(tokens.semantic.light['status.success']);
    expect(light.palette.warning.main).toBe(tokens.semantic.light['status.warning']);
    expect(light.palette.error.main).toBe(tokens.semantic.light['status.danger']);
    expect(light.palette.info.main).toBe(tokens.semantic.light['status.info']);
  });
});

describe('typography', () => {
  it('maps the MUI variants onto the DESIGN §3.1 scale', () => {
    expect(light.typography.h1).toMatchObject({ fontSize: '24px', lineHeight: '32px' });
    expect(light.typography.h2).toMatchObject({ fontSize: '20px', lineHeight: '28px' });
    expect(light.typography.h3).toMatchObject({ fontSize: '16px', lineHeight: '24px' });
    expect(light.typography.body1).toMatchObject({ fontSize: '16px', lineHeight: '24px' });
    expect(light.typography.body2).toMatchObject({ fontSize: '14px', lineHeight: '20px' });
    expect(light.typography.caption).toMatchObject({ fontSize: '12px', fontWeight: 500 });
  });

  it('adds display, bodyStrong and mono as their own variants', () => {
    expect(light.typography.display).toMatchObject({ fontSize: '32px', lineHeight: '40px' });
    expect(light.typography.bodyStrong).toMatchObject({ fontSize: '14px', fontWeight: 500 });
    expect(light.typography.mono).toMatchObject({
      fontSize: '13px',
      fontFamily: tokens.typography.fontFamily.mono,
    });
  });

  it('never upper-cases a button label', () => {
    expect(light.typography.button.textTransform).toBe('none');
  });
});

describe('shape, spacing and shadows', () => {
  it('uses a 4 px spacing base', () => {
    expect(light.spacing(1)).toBe('4px');
    expect(light.spacing(4)).toBe('16px');
  });

  it('rounds to the md radius', () => {
    expect(light.shape.borderRadius).toBe(tokens.radius.md);
  });

  it('fills MUI’s 25 levels from the four in DESIGN §4', () => {
    expect(light.shadows).toHaveLength(25);
    expect(light.shadows[0]).toBe('none');
    expect(light.shadows[1]).toBe(tokens.elevation.light['1']);
    expect(light.shadows[3]).toBe(tokens.elevation.light['3']);
    expect(light.shadows[24]).toBe(tokens.elevation.light['3']);
  });

  it('drops the shadows in dark mode', () => {
    expect(new Set(dark.shadows)).toEqual(new Set(['none']));
  });
});

describe('direction', () => {
  it('is carried on the theme so MUI mirrors what it can', () => {
    expect(createHelpdockTheme({ mode: 'light', direction: 'rtl' }).direction).toBe('rtl');
    expect(light.direction).toBe('ltr');
  });
});

describe('component overrides', () => {
  const overrides = light.components ?? {};

  it('gives the button the three DESIGN §6.1 heights', () => {
    const button = overrides.MuiButton?.styleOverrides;

    expect(button?.sizeSmall).toMatchObject({ height: '28px' });
    expect(button?.sizeMedium).toMatchObject({ height: '36px' });
    expect(button?.sizeLarge).toMatchObject({ height: '44px' });
  });

  it('maps the four DESIGN button variants onto variant and colour pairs', () => {
    const variants = overrides.MuiButton?.variants ?? [];

    expect(variants.map((variant) => variant.props)).toEqual([
      { variant: 'contained', color: 'primary' },
      { variant: 'outlined', color: 'secondary' },
      { variant: 'text', color: 'secondary' },
      { variant: 'outlined', color: 'error' },
      { variant: 'contained', color: 'error' },
    ]);
  });

  it('sizes the input, badge, tab and table row from DESIGN §6', () => {
    expect(overrides.MuiOutlinedInput?.styleOverrides?.root).toMatchObject({ height: '36px' });
    expect(overrides.MuiChip?.styleOverrides?.root).toMatchObject({ height: '22px' });
    expect(overrides.MuiTab?.styleOverrides?.root).toMatchObject({ height: '32px' });
    expect(overrides.MuiTableCell?.styleOverrides?.root).toMatchObject({ height: '44px' });
  });

  it('gives the segmented control its own text token, not MUI\u2019s translucent black', () => {
    // DESIGN §10: the unselected option has to clear 4.5:1 on the canvas, and
    // MUI's default `rgba(0, 0, 0, 0.54)` does not.
    expect(overrides.MuiToggleButton?.styleOverrides?.root).toMatchObject({
      height: '32px',
      color: tokens.semantic.light['text.secondary'],
    });
  });

  it('underlines the selected tab with 2 px of the accent', () => {
    expect(overrides.MuiTabs?.styleOverrides?.indicator).toMatchObject({
      height: '2px',
      backgroundColor: tokens.semantic.light['action.primary'],
    });
  });

  it('puts the table header on bg.muted', () => {
    expect(overrides.MuiTableCell?.styleOverrides?.head).toMatchObject({
      backgroundColor: tokens.semantic.light['bg.muted'],
    });
  });

  it('gives the dialog the lg radius and elevation 3', () => {
    expect(overrides.MuiDialog?.styleOverrides?.paper).toMatchObject({
      borderRadius: '10px',
      boxShadow: tokens.elevation.light['3'],
    });
  });

  it('puts the tooltip on bg.inverse at caption size, after the 200 ms delay', () => {
    expect(overrides.MuiTooltip?.defaultProps?.enterDelay).toBe(tokens.motion.duration.base);
    expect(overrides.MuiTooltip?.styleOverrides?.tooltip).toMatchObject({
      backgroundColor: tokens.semantic.light['bg.inverse'],
      color: tokens.semantic.light['text.inverse'],
      fontSize: '12px',
    });
  });

  it('puts the toast on bg.inverse too', () => {
    expect(overrides.MuiSnackbarContent?.styleOverrides?.root).toMatchObject({
      backgroundColor: tokens.semantic.light['bg.inverse'],
    });
  });
});

describe('a branded theme', () => {
  const brand = resolveBrandTheme({ accent: '#B45309', surfaceTone: 'cool', radius: 2 });
  const themed = createHelpdockTheme({ mode: 'light', direction: 'ltr', brand });

  it('takes the accent, the ramp and the radius from the brand', () => {
    expect(themed.palette.primary.main).toBe(brand.accent.light.base);
    expect(themed.palette.background.default).toBe(brand.neutral.n50);
    expect(themed.palette.text.primary).toBe(brand.neutral.n900);
    expect(themed.shape.borderRadius).toBe(2);
  });

  it('leaves the status hues and the type scale alone', () => {
    expect(themed.palette.error.main).toBe(tokens.semantic.light['status.danger']);
    expect(themed.typography.h1).toEqual(light.typography.h1);
  });
});
