import { CacheProvider } from '@emotion/react';
import { createI18n, dir, type Locale } from '@helpdock/i18n';
import { createHelpdockTheme, createLtrCache, createRtlCache } from '@helpdock/ui';
import '@helpdock/ui/fonts.css';
import { CssBaseline, ThemeProvider, useMediaQuery } from '@mui/material';
import { createTheme, type Theme } from '@mui/material/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { BrowserRouter } from 'react-router';
import type { AuthApi } from '../auth/api.js';
import { createApis } from '../auth/select-api.js';
import { AuthApiProvider } from '../auth/session.tsx';
import type { ContactsApi } from '../contacts/api.js';
import type { StaffApi } from '../staff/api.js';
import { ToastProvider } from '../ui/toasts.tsx';
import {
  resolveInitialLocale,
  resolveInitialThemePreference,
  storeLocale,
  storeThemePreference,
  type ThemePreference,
} from './preferences.js';

export interface Preferences {
  readonly locale: Locale;
  setLocale(locale: Locale): void;
  /** What the user picked, including `auto`. */
  readonly themePreference: ThemePreference;
  setThemePreference(preference: ThemePreference): void;
  /** What `auto` resolved to, and what the theme is actually built with. */
  readonly mode: 'light' | 'dark';
}

const PreferencesContext = createContext<Preferences | null>(null);

export function usePreferences(): Preferences {
  const preferences = useContext(PreferencesContext);
  if (!preferences) {
    throw new Error('usePreferences needs <AppProviders> above it');
  }

  return preferences;
}

/**
 * DESIGN §4: everything honours `prefers-reduced-motion: reduce` by dropping to
 * 0 ms. Zeroing MUI's durations covers the components that ask the theme; the
 * global rule covers the transitions written directly into the style overrides.
 */
function withoutMotion(theme: Theme): Theme {
  const instant = {
    shortest: 0,
    shorter: 0,
    short: 0,
    standard: 0,
    complex: 0,
    enteringScreen: 0,
    leavingScreen: 0,
  };

  return createTheme(theme, {
    transitions: { duration: instant },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          '*, *::before, *::after': {
            animationDuration: '0ms !important',
            animationIterationCount: '1 !important',
            transitionDuration: '0ms !important',
            scrollBehavior: 'auto !important',
          },
        },
      },
    },
  });
}

export interface AppProvidersProps {
  readonly children: ReactNode;
  /** Defaults to the adapter `VITE_AUTH_API` names. Tests pass their own. */
  readonly authApi?: AuthApi;
  /** Defaults to the matching adapter; a test passing one passes both. */
  readonly staffApi?: StaffApi;
  /** Defaults to the matching adapter. The contact screens need it. */
  readonly contactsApi?: ContactsApi;
  readonly queryClient?: QueryClient;
  /** Tests swap in `MemoryRouter`. */
  readonly router?: (props: { children: ReactNode }) => ReactNode;
}

export function createAdminQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Everything the admin reads is either session state or, from M1,
        // invalidated explicitly; background refetching would only add noise.
        refetchOnWindowFocus: false,
        retry: false,
      },
    },
  });
}

export function AppProviders({
  children,
  authApi,
  staffApi,
  contactsApi,
  queryClient,
  router: Router = BrowserRouter,
}: AppProvidersProps): ReactNode {
  const [locale, setLocaleState] = useState<Locale>(resolveInitialLocale);
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(
    resolveInitialThemePreference,
  );

  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)', { noSsr: true });
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)', { noSsr: true });

  // One pair: the http adapters share a transport and the mocks share a
  // fixture, so building them apart would break both of those guarantees.
  const [fallback] = useState(createApis);
  const api = authApi ?? fallback.auth;
  const staff = staffApi ?? fallback.staff;
  const contacts = contactsApi ?? fallback.contacts;
  const client = useMemo(() => queryClient ?? createAdminQueryClient(), [queryClient]);
  // One instance for the life of the app; a locale change goes through
  // `changeLanguage` below so `react-i18next` re-renders what it has to.
  const [i18n] = useState(() => createI18n({ lng: locale }));

  const direction = dir(locale);
  const mode = themePreference === 'auto' ? (prefersDark ? 'dark' : 'light') : themePreference;

  const cache = useMemo(
    () => (direction === 'rtl' ? createRtlCache() : createLtrCache()),
    [direction],
  );

  const theme = useMemo(() => {
    const base = createHelpdockTheme({ mode, direction });

    return prefersReducedMotion ? withoutMotion(base) : base;
  }, [mode, direction, prefersReducedMotion]);

  useEffect(() => {
    void i18n.changeLanguage(locale);
  }, [i18n, locale]);

  useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    root.dir = direction;
    root.style.colorScheme = mode;
  }, [locale, direction, mode]);

  const preferences = useMemo<Preferences>(
    () => ({
      locale,
      mode,
      themePreference,
      setLocale: (next) => {
        storeLocale(next);
        setLocaleState(next);
      },
      setThemePreference: (next) => {
        storeThemePreference(next);
        setThemePreferenceState(next);
      },
    }),
    [locale, mode, themePreference],
  );

  return (
    <PreferencesContext.Provider value={preferences}>
      <CacheProvider value={cache}>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          <I18nextProvider i18n={i18n}>
            <QueryClientProvider client={client}>
              <AuthApiProvider api={api} staffApi={staff} contactsApi={contacts}>
                <ToastProvider>
                  <Router>{children}</Router>
                </ToastProvider>
              </AuthApiProvider>
            </QueryClientProvider>
          </I18nextProvider>
        </ThemeProvider>
      </CacheProvider>
    </PreferencesContext.Provider>
  );
}
