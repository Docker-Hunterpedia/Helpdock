import type { Locale } from '@helpdock/i18n';
import type {
  SetupAdminRequest,
  SetupBrandRequest,
  SetupSmtpRequest,
  SmtpCredentials,
  SmtpTestResult,
} from '@helpdock/schemas';
import { readinessSchema } from '@helpdock/schemas';
import { Box, Link } from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactNode, useMemo, useReducer, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { DEFAULT_SIGNED_IN_ROUTE, ROUTES } from '../../app/route-paths.js';
import { readPublicInstallInfo } from '../../install/public-info.js';
import { AlertBanner } from '../../ui/alert-banner.tsx';
import { AccountStep } from './account-step.tsx';
import { BrandStep } from './brand-step.tsx';
import { DoneStep } from './done-step.tsx';
import { EmailStep } from './email-step.tsx';
import {
  HttpSetupApi,
  type SetupApi,
  SetupClosedError,
  SetupThrottledError,
  SetupValidationError,
} from './setup-api.js';
import { SetupLayout } from './setup-layout.tsx';
import { initialSetupState, setupReducer } from './setup-state.js';

/**
 * The first-run wizard (M0-08), from the artboard `Admin/Wizard`.
 *
 * Step data lives in this component and nowhere else: not in storage, not in a
 * URL. A wizard takes minutes, the password on step 1 has no business surviving
 * a reload, and a half-finished one is finished by starting it again — which is
 * exactly what a reload does, because the install is still `fresh` until step 1
 * succeeds.
 *
 * Finishing navigates the browser rather than the router. The install state is
 * a meta tag in the document that is already loaded, so only a fresh document
 * knows the wizard is over; the reload also picks the session up from the
 * refresh cookie step 2 set.
 */

export const READY_QUERY_KEY = ['install', 'ready'] as const;

/** `/ready` is served by the api next to `/api`, not under it (ARCHITECTURE §14). */
const readReadiness = async (): Promise<boolean> => {
  const response = await fetch('/ready', { headers: { accept: 'application/json' } });
  const parsed = readinessSchema.safeParse(await response.json());

  return parsed.success && parsed.data.status === 'ready';
};

export interface SetupPageProps {
  /** Tests pass their own; the browser gets the real one. */
  readonly api?: SetupApi;
  /** Where "Open Helpdock" sends the browser. Replaced in tests. */
  readonly onFinished?: (path: string) => void;
}

const leaveTo = (path: string): void => {
  globalThis.location.assign(path);
};

export function SetupPage({ api, onFinished = leaveTo }: SetupPageProps): ReactNode {
  const t = useT();
  const { locale, setLocale } = usePreferences();
  const install = useMemo(() => readPublicInstallInfo(), []);
  const client = useMemo(() => api ?? new HttpSetupApi(), [api]);

  const [state, dispatch] = useReducer(setupReducer, locale, initialSetupState);
  const [failure, setFailure] = useState<'closed' | 'throttled' | 'failed' | null>(null);
  const [prefixTaken, setPrefixTaken] = useState(false);
  const [testResult, setTestResult] = useState<SmtpTestResult | null>(null);
  const [require2fa, setRequire2fa] = useState(false);

  const ready = useQuery({ queryKey: READY_QUERY_KEY, queryFn: readReadiness, retry: false });

  const fail = (error: unknown): void => {
    if (error instanceof SetupClosedError) {
      setFailure('closed');
      return;
    }
    if (error instanceof SetupThrottledError) {
      setFailure('throttled');
      return;
    }
    setFailure('failed');
  };

  const complete = useMutation({
    mutationFn: () => client.complete(),
    onSuccess: (response) => {
      setRequire2fa(response.require2fa);
    },
    onError: fail,
  });

  const createAdmin = useMutation({
    mutationFn: (request: SetupAdminRequest) => client.createAdmin(request),
    onMutate: () => {
      setFailure(null);
    },
    onSuccess: (response) => {
      dispatch({
        type: 'adminCreated',
        name: response.admin.name,
        email: response.admin.email,
      });
    },
    onError: fail,
  });

  const createBrand = useMutation({
    mutationFn: (request: SetupBrandRequest) => client.createBrand(request),
    onMutate: () => {
      setFailure(null);
      setPrefixTaken(false);
    },
    onSuccess: (response) => {
      dispatch({
        type: 'brandCreated',
        name: response.brand.name,
        prefix: response.brand.prefix,
      });
    },
    onError: (error: unknown) => {
      // Only the api can know a prefix is taken, so it comes back as a field
      // error on `prefix` rather than as a rule the screen could have applied.
      if (error instanceof SetupValidationError && error.paths.some((p) => p.includes('prefix'))) {
        setPrefixTaken(true);
        return;
      }
      fail(error);
    },
  });

  const testSmtp = useMutation({
    mutationFn: (request: SmtpCredentials) => client.testSmtp(request),
    onMutate: () => {
      setFailure(null);
      setTestResult(null);
    },
    onSuccess: (result) => {
      setTestResult(result);
    },
    onError: fail,
  });

  const saveSmtp = useMutation({
    mutationFn: (request: SetupSmtpRequest) => client.saveSmtp(request),
    onMutate: () => {
      setFailure(null);
    },
    onSuccess: (_response, request) => {
      dispatch({ type: 'smtpDecided', host: request.skip ? null : request.host });
      // The wizard is over the moment the last decision is taken, so the token
      // is spent here rather than on the button below: the summary has to know
      // whether this install requires a second factor before it is drawn.
      complete.mutate();
    },
    onError: fail,
  });

  const chooseLocale = (next: Locale): void => {
    setLocale(next);
    dispatch({ type: 'locale', locale: next });
  };

  const back = (): void => {
    setFailure(null);
    dispatch({ type: 'back' });
  };

  const version = install.version;
  const systemStatus = ready.isPending
    ? t('wizard:systemStatusUnknown', { version })
    : ready.data === true
      ? t('wizard:systemStatus', { version })
      : t('wizard:systemStatusDown', { version });

  return (
    <SetupLayout step={state.step} systemStatus={systemStatus}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {failure === null ? null : (
          <AlertBanner tone="danger">
            {t(`wizard:${failure}`)}
            {failure === 'closed' ? (
              <>
                {' '}
                <Link href={ROUTES.signIn}>{t('auth:backToSignIn')}</Link>
              </>
            ) : null}
          </AlertBanner>
        )}

        {state.step === 'account' ? (
          <AccountStep
            locale={state.locale}
            onLocaleChange={chooseLocale}
            onSubmit={createAdmin.mutate}
            pending={createAdmin.isPending}
          />
        ) : null}

        {state.step === 'brand' ? (
          <BrandStep
            onSubmit={createBrand.mutate}
            onBack={back}
            pending={createBrand.isPending}
            prefixTaken={prefixTaken}
          />
        ) : null}

        {state.step === 'email' ? (
          <EmailStep
            onSubmit={saveSmtp.mutate}
            onTest={testSmtp.mutate}
            onBack={back}
            pending={saveSmtp.isPending}
            testPending={testSmtp.isPending}
            testResult={testResult}
            adminEmail={state.summary.adminEmail}
          />
        ) : null}

        {state.step === 'done' ? (
          <DoneStep
            summary={state.summary}
            require2fa={require2fa}
            onOpen={() => {
              onFinished(require2fa ? ROUTES.totpEnrolment : DEFAULT_SIGNED_IN_ROUTE);
            }}
            pending={complete.isPending}
          />
        ) : null}
      </Box>
    </SetupLayout>
  );
}
