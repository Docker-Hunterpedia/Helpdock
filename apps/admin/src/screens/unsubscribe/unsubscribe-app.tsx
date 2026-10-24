import { CacheProvider } from '@emotion/react';
import { createI18n, dir, type Locale, SUPPORTED_LNGS } from '@helpdock/i18n';
import type { UnsubscribeView } from '@helpdock/schemas';
import {
  createHelpdockTheme,
  createLtrCache,
  createRtlCache,
  resolveSemanticTokens,
} from '@helpdock/ui';
import '@helpdock/ui/fonts.css';
import { CssBaseline, ThemeProvider, useMediaQuery } from '@mui/material';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { readCspNonce } from '../../app/csp-nonce.js';
import type { UnsubscribeApi, UnsubscribeLinkProblem } from '../../unsubscribe/api.js';
import { isUnsubscribeLinkError } from '../../unsubscribe/api.js';
import { createUnsubscribeApi } from '../../unsubscribe/select-api.js';
import { UnsubscribePage } from './unsubscribe-page.tsx';

/**
 * The public unsubscribe page (`Public/Unsubscribe`; M14-11), mounted on its
 * own by `main.tsx` for `/unsubscribe/<token>`, as the rating page is
 * (ADR 0010): the person here followed a link in an email, so none of the staff
 * providers (the session, the saved language and theme) may be in play.
 *
 * Opening the page only reads: it asks the api what the token is for and draws
 * the confirmation. Nothing is unsubscribed until the button is pressed, so a
 * mail scanner or link preview that follows the link unsubscribes nobody.
 *
 * The language is the account's once the token is known (the email was written
 * in it); before that, and for a token that is no good, `?lang=` (which the
 * email's link carries) and then English.
 */

export type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly view: UnsubscribeView }
  | { readonly kind: 'failed'; readonly problem: UnsubscribeLinkProblem };

const requestedLocale = (search: string): Locale | undefined => {
  const lang = new URLSearchParams(search).get('lang');

  return SUPPORTED_LNGS.find((candidate) => candidate === lang);
};

export function UnsubscribeApp({
  token,
  search = '',
  api: given,
}: {
  readonly token: string;
  /** `location.search`, for `?lang=`. */
  readonly search?: string;
  readonly api?: UnsubscribeApi;
}): ReactNode {
  const [i18n] = useState(() => createI18n({ lng: requestedLocale(search) ?? 'en' }));
  const [api] = useState(() => given ?? createUnsubscribeApi());
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)', { noSsr: true });

  // Declared by `attempt` so "Try again" reads the link again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger.
  useEffect(() => {
    let current = true;
    setState({ kind: 'loading' });
    api.view(token).then(
      (view) => {
        if (current) {
          setState({ kind: 'ready', view });
        }
      },
      (error: unknown) => {
        if (current) {
          setState({
            kind: 'failed',
            problem: isUnsubscribeLinkError(error) ? error.problem : 'unavailable',
          });
        }
      },
    );

    return () => {
      current = false;
    };
  }, [api, token, attempt]);

  const retry = useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);

  const locale = (state.kind === 'ready' ? state.view.locale : requestedLocale(search)) ?? 'en';
  const direction = dir(locale);
  const mode = prefersDark ? 'dark' : 'light';
  const [cspNonce] = useState(readCspNonce);

  const cache = useMemo(
    () =>
      direction === 'rtl' ? createRtlCache('hdrtl', cspNonce) : createLtrCache('hd', cspNonce),
    [direction, cspNonce],
  );
  const theme = useMemo(() => createHelpdockTheme({ mode, direction }), [mode, direction]);
  const tokens = useMemo(() => resolveSemanticTokens(mode), [mode]);

  useEffect(() => {
    void i18n.changeLanguage(locale);
    const root = document.documentElement;
    root.lang = locale;
    root.dir = direction;
    root.style.colorScheme = mode;
    document.title = i18n.t('unsubscribe:title', { lng: locale });
  }, [i18n, locale, direction, mode]);

  return (
    <CacheProvider value={cache}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <I18nextProvider i18n={i18n}>
          <UnsubscribePage
            tokens={tokens}
            state={state}
            onUnsubscribe={() => api.unsubscribe(token)}
            onRetry={retry}
          />
        </I18nextProvider>
      </ThemeProvider>
    </CacheProvider>
  );
}
