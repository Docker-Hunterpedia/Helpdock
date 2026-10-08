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
import type { AiApi } from '../ai/api.js';
import { AiApiProvider } from '../ai/context.tsx';
import type { AssistApi } from '../assist/api.js';
import { AssistApiProvider } from '../assist/context.tsx';
import type { AuthApi } from '../auth/api.js';
import { createApis } from '../auth/select-api.js';
import { AuthApiProvider } from '../auth/session.tsx';
import type { AutomationApi } from '../automation/api.js';
import { AutomationApiProvider } from '../automation/context.tsx';
import type { ChannelsApi } from '../channels/api.js';
import type { ContactsApi } from '../contacts/api.js';
import type { DevelopersApi } from '../developers/api.js';
import { DevelopersApiProvider } from '../developers/context.tsx';
import type { DomainsApi } from '../domains/api.js';
import { DomainsApiProvider } from '../domains/context.tsx';
import type { EmailApi } from '../email/api.js';
import type { HelpCenterApi } from '../help-center/api.js';
import { HelpCenterApiProvider } from '../help-center/context.tsx';
import type { KnowledgeApi } from '../knowledge/api.js';
import { KnowledgeApiProvider } from '../knowledge/context.tsx';
import type { AttachmentUploader } from '../media/upload.js';
import type { NotificationsApi } from '../notifications/api.js';
import type { BrowserPush } from '../notifications/browser-push.js';
import { NotificationsProvider } from '../notifications/context.tsx';
import type { ReportsApi } from '../reports/api.js';
import { ReportsApiProvider } from '../reports/context.tsx';
import type { SystemApi } from '../screens/admin/system/system-api.js';
import { SystemApiProvider } from '../screens/admin/system/system-api-context.tsx';
import type { SettingsApi } from '../settings/api.js';
import { SettingsApiProvider } from '../settings/context.tsx';
import type { StaffApi } from '../staff/api.js';
import type { TelegramApi } from '../telegram/api.js';
import { TelegramApiProvider } from '../telegram/context.tsx';
import type { TicketingApi } from '../ticketing/api.js';
import type { TicketsApi } from '../tickets/api.js';
import { ToastProvider } from '../ui/toasts.tsx';
import { readCspNonce } from './csp-nonce.js';
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
  /** Defaults to the matching adapter. Only the Ticketing screens read it. */
  readonly ticketingApi?: TicketingApi;
  /** Defaults to the matching adapter. The ticket workspace needs it. */
  readonly ticketsApi?: TicketsApi;
  /** Defaults to the matching adapter. The composer and the thread need it. */
  readonly uploader?: AttachmentUploader;
  /** Defaults to the matching adapter. The outbound email screens need it (M2-05). */
  readonly emailApi?: EmailApi;
  /** Defaults to the matching adapter. Channels › Mailboxes and the email card need it. */
  readonly channelsApi?: ChannelsApi;
  /** Defaults to the matching adapter. Only `Admin/Automation` reads it. */
  readonly automationApi?: AutomationApi;
  /** Defaults to the matching adapter. Only the Help center screens read it (M5). */
  readonly helpCenterApi?: HelpCenterApi;
  /** Defaults to the matching adapter. The bell and the Notifications tab need it. */
  readonly notificationsApi?: NotificationsApi;
  /** Defaults to the matching adapter: this browser's push half. */
  readonly browserPush?: BrowserPush;
  /** Defaults to the matching adapter. Only Brand › Domains reads it (M5-07). */
  readonly domainsApi?: DomainsApi;
  /** Defaults to the matching adapter. Only `Admin/AI` reads it (M7-10). */
  readonly aiApi?: AiApi;
  /** Defaults to the matching adapter. Only AI › Knowledge reads it (M7-10). */
  readonly knowledgeApi?: KnowledgeApi;
  /** Defaults to the matching adapter. Only `Admin/Reports` reads it (M8-04). */
  readonly reportsApi?: ReportsApi;
  /** Defaults to the matching adapter. System and Brand › Danger zone read it. */
  readonly systemApi?: SystemApi;
  /** Defaults to the matching adapter. Only install Settings reads it. */
  readonly settingsApi?: SettingsApi;
  /** Defaults to the matching adapter. Channels › Telegram and a Telegram ticket read it (M6). */
  readonly telegramApi?: TelegramApi;
  /** Defaults to the matching adapter. The ticket view and Help center › Proposals read it (M7). */
  readonly assistApi?: AssistApi;
  /** Defaults to the matching adapter. Only the Developers page reads it (M8-01, M8-03). */
  readonly developersApi?: DevelopersApi;
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
  ticketingApi,
  ticketsApi,
  uploader,
  emailApi,
  channelsApi,
  automationApi,
  helpCenterApi,
  notificationsApi,
  browserPush,
  domainsApi,
  aiApi,
  knowledgeApi,
  reportsApi,
  systemApi,
  settingsApi,
  telegramApi,
  assistApi,
  developersApi,
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
  const ticketing = ticketingApi ?? fallback.ticketing;
  const tickets = ticketsApi ?? fallback.tickets;
  const attachments = uploader ?? fallback.uploader;
  const email = emailApi ?? fallback.email;
  const channels = channelsApi ?? fallback.channels;
  const automation = automationApi ?? fallback.automation;
  const helpCenter = helpCenterApi ?? fallback.helpCenter;
  const notifications = notificationsApi ?? fallback.notifications;
  const push = browserPush ?? fallback.browserPush;
  const domains = domainsApi ?? fallback.domains;
  const ai = aiApi ?? fallback.ai;
  const knowledge = knowledgeApi ?? fallback.knowledge;
  const reports = reportsApi ?? fallback.reports;
  const system = systemApi ?? fallback.system;
  const settings = settingsApi ?? fallback.settings;
  const telegram = telegramApi ?? fallback.telegram;
  const assist = assistApi ?? fallback.assist;
  const developers = developersApi ?? fallback.developers;
  const client = useMemo(() => queryClient ?? createAdminQueryClient(), [queryClient]);
  // One instance for the life of the app; a locale change goes through
  // `changeLanguage` below so `react-i18next` re-renders what it has to.
  const [i18n] = useState(() => createI18n({ lng: locale }));
  const [cspNonce] = useState(readCspNonce);

  const direction = dir(locale);
  const mode = themePreference === 'auto' ? (prefersDark ? 'dark' : 'light') : themePreference;

  const cache = useMemo(
    () =>
      direction === 'rtl' ? createRtlCache('hdrtl', cspNonce) : createLtrCache('hd', cspNonce),
    [direction, cspNonce],
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
              <AuthApiProvider
                api={api}
                staffApi={staff}
                contactsApi={contacts}
                ticketingApi={ticketing}
                ticketsApi={tickets}
                uploader={attachments}
                emailApi={email}
                channelsApi={channels}
              >
                <AutomationApiProvider api={automation}>
                  <DomainsApiProvider api={domains}>
                    <AiApiProvider api={ai}>
                      <KnowledgeApiProvider api={knowledge}>
                        <TelegramApiProvider api={telegram}>
                          <DevelopersApiProvider api={developers}>
                            <HelpCenterApiProvider api={helpCenter}>
                              <AssistApiProvider api={assist}>
                                <ReportsApiProvider api={reports}>
                                  <SystemApiProvider api={system}>
                                    <SettingsApiProvider api={settings}>
                                      <NotificationsProvider api={notifications} push={push}>
                                        <ToastProvider>
                                          <Router>{children}</Router>
                                        </ToastProvider>
                                      </NotificationsProvider>
                                    </SettingsApiProvider>
                                  </SystemApiProvider>
                                </ReportsApiProvider>
                              </AssistApiProvider>
                            </HelpCenterApiProvider>
                          </DevelopersApiProvider>
                        </TelegramApiProvider>
                      </KnowledgeApiProvider>
                    </AiApiProvider>
                  </DomainsApiProvider>
                </AutomationApiProvider>
              </AuthApiProvider>
            </QueryClientProvider>
          </I18nextProvider>
        </ThemeProvider>
      </CacheProvider>
    </PreferencesContext.Provider>
  );
}
