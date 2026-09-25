import { CacheProvider } from '@emotion/react';
import { createI18n, dir, type Locale, SUPPORTED_LNGS } from '@helpdock/i18n';
import type { CsatSurveyView } from '@helpdock/schemas';
import {
  createHelpdockTheme,
  createLtrCache,
  createRtlCache,
  resolveBrandTheme,
  resolveSemanticTokens,
} from '@helpdock/ui';
import '@helpdock/ui/fonts.css';
import { CssBaseline, ThemeProvider, useMediaQuery } from '@mui/material';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import type { CsatApi, CsatLinkProblem } from '../../csat/api.js';
import { isCsatLinkError } from '../../csat/api.js';
import { createCsatApi } from '../../csat/select-api.js';
import { CsatPage } from './csat-page.tsx';

/**
 * The public rating page (M1-12, `CsatEN` and `CsatAR`), mounted on its own.
 *
 * `main.tsx` renders this instead of the admin app for `/csat/<token>`: the
 * person here is a customer, so none of the staff providers — the session, the
 * refresh cookie, the staff member's saved language and theme — may be in play.
 * It builds the three things a page needs for itself:
 *
 * - **the language**: `?lang=` when it names one the app ships (a channel can
 *   send the contact's own), otherwise the brand's default;
 * - **the direction**, from that language, with the matching Emotion cache;
 * - **the theme**, from DESIGN §8's brand accent when the brand has one, and
 *   the stock accent otherwise. Only the accent is brand-configurable here, as
 *   §8 allows; spacing, type and status hues are the system's.
 */

export type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly view: CsatSurveyView }
  | { readonly kind: 'failed'; readonly problem: CsatLinkProblem };

const requestedLocale = (search: string): Locale | undefined => {
  const lang = new URLSearchParams(search).get('lang');

  return SUPPORTED_LNGS.find((candidate) => candidate === lang);
};

const brandThemeFor = (accent: string | null) => {
  if (accent === null) {
    return undefined;
  }

  try {
    return resolveBrandTheme({ accent });
  } catch {
    // An accent the admin should have refused is not a reason to fail the page.
    return undefined;
  }
};

export function CsatApp({
  token,
  search = '',
  api: given,
}: {
  readonly token: string;
  /** `location.search`, for `?lang=`. */
  readonly search?: string;
  readonly api?: CsatApi;
}): ReactNode {
  const [api] = useState(() => given ?? createCsatApi());
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)', { noSsr: true });

  useEffect(() => {
    let current = true;
    api.survey(token).then(
      (view) => {
        if (current) {
          setState({ kind: 'ready', view });
        }
      },
      (error: unknown) => {
        if (current) {
          setState({
            kind: 'failed',
            problem: isCsatLinkError(error) ? error.problem : 'unavailable',
          });
        }
      },
    );

    return () => {
      current = false;
    };
  }, [api, token]);

  const brand = state.kind === 'ready' ? state.view.brand : null;
  const locale = requestedLocale(search) ?? brand?.locale ?? 'en';
  const direction = dir(locale);
  const mode = prefersDark ? 'dark' : 'light';
  const accent = brand?.accent ?? null;

  const [i18n] = useState(() => createI18n({ lng: locale }));
  const cache = useMemo(
    () => (direction === 'rtl' ? createRtlCache() : createLtrCache()),
    [direction],
  );
  const brandTheme = useMemo(() => brandThemeFor(accent), [accent]);
  const theme = useMemo(
    () => createHelpdockTheme({ mode, direction, ...(brandTheme ? { brand: brandTheme } : {}) }),
    [mode, direction, brandTheme],
  );
  const tokens = useMemo(() => resolveSemanticTokens(mode, brandTheme), [mode, brandTheme]);

  useEffect(() => {
    void i18n.changeLanguage(locale);
    const root = document.documentElement;
    root.lang = locale;
    root.dir = direction;
    root.style.colorScheme = mode;
    document.title = i18n.t('csat:title', { lng: locale });
  }, [i18n, locale, direction, mode]);

  return (
    <CacheProvider value={cache}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <I18nextProvider i18n={i18n}>
          <CsatPage
            tokens={tokens}
            brandName={brand?.name ?? null}
            state={state}
            onRate={(request) => api.rate(token, request)}
          />
        </I18nextProvider>
      </ThemeProvider>
    </CacheProvider>
  );
}
