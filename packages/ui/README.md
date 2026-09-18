# @helpdock/ui

The design system in code: the tokens from [DESIGN.md](../../DESIGN.md) §2–§4, the
MUI theme built from them, the two Emotion caches that make RTL work, the brand
resolver from §8, and the self-hosted fonts.

When this package and DESIGN.md disagree, DESIGN.md wins until it is changed by
a pull request. No React components live here yet; they arrive with the admin
shell and are added to DESIGN §6 in the same PR.

```ts
import {
  createHelpdockTheme,
  createRtlCache,
  createLtrCache,
  resolveBrandTheme,
  validateBrandTheme,
  tokens,
  tokensCssBundle,
  contrastRatio,
} from '@helpdock/ui';
```

## tokens.json

`tokens.json` at the package root is the single source of truth. Everything else
in this package reads it, and `src/tokens.ts` re-exports it typed, so a token
removed from the JSON fails the build rather than the browser.

| Group | Holds |
|---|---|
| `palette.surfaceTone` | The three neutral ramps a brand chooses between: `warm` (the default), `neutral`, `cool`. |
| `palette.teal` | The accent ramp, teal50 to teal900. |
| `palette.status` | The five status hues, each with `solid`, `tint` and `text`. |
| `palette.chart` | The categorical, sequential and diverging series from DESIGN §9. |
| `semantic.light` / `semantic.dark` | Every token in DESIGN §2.2, as a flat map of dotted names. Components read these, never a palette value. |
| `typography` | Families, the three weights, the two base sizes and the nine styles of DESIGN §3.1. |
| `spacing`, `radius`, `elevation`, `motion`, `focus` | DESIGN §4. |

Two things in the file are derived rather than drawn, because DESIGN.md gives a
rule instead of a value:

- **The `neutral` and `cool` ramps.** Each keeps the warm ramp's OKLCH lightness
  at every step, takes its hue from the ground DESIGN §8 names (`#F5F5F4` and
  `#F4F6F8`), and scales the warm ramp's chroma by the ratio between that
  ground's chroma and the warm ground's. `n0` is white and `n50` is the exact
  ground from DESIGN §8.
- **The dark status colours.** DESIGN §2.2 says "solid lightened one step". That
  is spelled here as **+0.20 OKLCH lightness**, the smallest round lift that
  keeps every `status.<name>.text` at or above 4.5:1 on its tint. The dark tint
  is the lifted solid at 12 % over `bg.surface`, and the dark text is the lifted
  solid itself.

`src/tokens.schema.ts` is the Zod schema for the file, and `src/tokens.test.ts`
validates it and checks the token list against an independent copy of DESIGN
§2.2, so a rename in one place fails the other.

## Contrast

`contrastRatio(a, b)` and `relativeLuminance(hex)` implement WCAG 2.1.
`src/contrast.test.ts` asserts every pair DESIGN §2.2 claims to have checked,
**in both light and dark**, plus `text.inverse` on `bg.inverse`. Changing a
colour token without running this suite is how an install ships an unreadable
badge.

`src/color.ts` carries the sRGB ↔ OKLCH conversion the brand resolver needs. It
is hand-written and dependency-free so the widget can use it too, and it is
tested against the reference values published with OKLab.

## The theme

```tsx
import { CacheProvider } from '@emotion/react';
import { ThemeProvider, CssBaseline } from '@mui/material';
import { createHelpdockTheme, createRtlCache, createLtrCache } from '@helpdock/ui';
import { dir } from '@helpdock/i18n';

const direction = dir(locale);              // 'ltr' | 'rtl'
const cache = direction === 'rtl' ? createRtlCache() : createLtrCache();
const theme = createHelpdockTheme({ mode, direction, brand });

<CacheProvider value={cache}>
  <ThemeProvider theme={theme}>
    <CssBaseline />
    {children}
  </ThemeProvider>
</CacheProvider>
```

Set `dir` on `<html>` from the same `dir(locale)`. The caches use different keys
(`hd` and `hdrtl`), so switching language at runtime swaps the cache without
leaving stale class names behind.

`createHelpdockTheme` takes `{ mode, direction, brand? }`. `brand` is the output
of `resolveBrandTheme`; leaving it out gives the stock Helpdock accent.

### Button variants

DESIGN §6.1 names four button variants. MUI has `variant` and `color`, so they
map like this:

| DESIGN | MUI props |
|---|---|
| primary | `<Button variant="contained" color="primary">` |
| secondary (outlined) | `<Button variant="outlined" color="secondary">` |
| ghost | `<Button variant="text" color="secondary">` |
| danger (outlined) | `<Button variant="outlined" color="error">` |
| danger (solid, confirmation dialogs only) | `<Button variant="contained" color="error">` |

Sizes are `small` 28 px, `medium` 36 px and `large` 44 px — the widget's touch
target. `color="secondary"` is the neutral text colour, not a second accent:
Helpdock has one accent.

### Typography variants

MUI `h1`, `h2` and `h3` are DESIGN's `h1`, `h2` and `h3`; `h4`, `h5` and `h6`
repeat `h3` so nothing can render at a size outside the scale. `body1` is
`body-lg` (16/24), `body2` is `body` (14/20), `caption` is `caption` (12/16) and
`button` is `body-strong` with no upper-casing. Three variants are added:
`display`, `bodyStrong` and `mono`, usable as `<Typography variant="mono">`.

Other overrides follow DESIGN §6: `MuiOutlinedInput` 36 px, `MuiChip` 22 px,
`MuiDialog` radius lg with elevation 3, `MuiTooltip` on `bg.inverse` after a
200 ms delay, `MuiSnackbarContent` on `bg.inverse`, `MuiTab` 32 px with a 2 px
underline, `MuiTableCell` 44 px rows with the header on `bg.muted`.
`theme.spacing(1)` is 4 px, matching the DESIGN §4 scale.

## CSS custom properties

The widget and the help center do not load MUI. They read the same tokens as
`--hd-*` custom properties:

```ts
import { tokensCssBundle, tokensToCss } from '@helpdock/ui';

tokensCssBundle();                              // a whole stylesheet
tokensToCss({ mode: 'dark', include: 'mode' }); // just the declarations
```

`tokensCssBundle()` emits light on `:root`, dark inside
`@media (prefers-color-scheme: dark)` for documents that have not opted into
light, and dark again for `:root[data-theme="dark"]`. Names follow the token
names with dots and camel case turned into dashes: `bg.canvas` becomes
`--hd-bg-canvas`, `bodyLg` becomes `--hd-type-body-lg-size`. The snapshot in
`src/__snapshots__/css.test.ts.snap` is the published stylesheet; a diff there
is a deliberate token change.

## The brand resolver

```ts
const problems = validateBrandTheme(input); // [] means it can be saved
const brand = resolveBrandTheme(input);     // the final token set
```

`resolveBrandTheme` implements DESIGN §8:

- **accent** — hover is the accent at −0.06 OKLCH lightness, active at −0.12,
  gamut-mapped by reducing chroma so a dark accent keeps its hue.
- **dark accent** — lifted by +0.21 lightness, which is the step between the
  teal500 and teal300 that DESIGN §2.2 pairs across the two modes. Without it a
  mid-tone accent reaches only 3.02:1 on the dark surface.
- **`action.primary.text`** — white when it reaches 4.5:1 on the accent,
  otherwise the chosen ramp's n900.
- **tint** — the accent at 10 % over that mode's `bg.surface`.
- **surfaceTone** — picks one of the three ramps. It moves the light ground,
  text and border tokens; the dark neutrals in DESIGN §2.2 are drawn values
  rather than steps of a ramp, so they stay as they are.
- **radius** — 0 to 12, applied to `md`, with `lg` scaled in proportion. `sm`,
  `xl` and `full` are fixed.
- **font** — one of the curated pairs. Only `ibm-plex` is self-hosted today.

`validateBrandTheme` returns a typed list rather than throwing, so the admin can
show every problem at once next to the live preview. An accent below 3:1 against
the surface is an `error` and the admin blocks it; text below 4.5:1 on the accent
is a `warning`, because the resolver has already picked the better of white and
n900. `resolveBrandTheme` throws `BrandThemeError` only when the input does not
match the schema.

Status hues, spacing, the type scale and component anatomy are not brand
configurable and never pass through the resolver.

## Fonts

`fonts/` holds the woff2 files Helpdock serves, and `fonts/fonts.css` the
`@font-face` rules with `font-display: swap` and the unicode ranges each subset
covers:

```ts
import '@helpdock/ui/fonts.css';
```

Sixteen faces, 361 KiB of woff2 (369 KiB for the directory, stylesheet included): IBM Plex Sans 400/500/600 in latin and latin-ext, IBM
Plex Sans Arabic 400/500/600 in arabic and latin, IBM Plex Mono 400/500 in latin
and latin-ext. DESIGN §3.2 loads three weights and no italics, and the budget for
the directory is 1.5 MB; `src/fonts.test.ts` enforces both.

The files are copied out of the `@fontsource/*` packages by
`pnpm --filter @helpdock/ui sync:fonts` and committed, so a clone builds without
a font download. Re-run that script after a `@fontsource` upgrade. The directory
is excluded from Biome because it is generated.

All three families are **IBM Plex**, licensed under the
[SIL Open Font License 1.1](https://openfontlicense.org), Copyright 2019 IBM
Corp. The licence text travels with the fonts in the `@fontsource` packages and
the attribution is repeated at the top of `fonts.css`. The widget loads them from
the Helpdock origin, never from a third party (DESIGN §3).

## Dependencies

`zod` for the token and brand schemas, and `stylis` plus
`@mui/stylis-plugin-rtl` for the RTL cache. `react`, `@mui/material`,
`@emotion/react`, `@emotion/styled` and `@emotion/cache` are peers: the app owns
those versions, and Emotion has to be one instance.
