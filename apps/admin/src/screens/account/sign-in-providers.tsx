import {
  isLastSignInMethod,
  OAUTH_PROVIDERS,
  type OauthIdentityList,
  type OauthProvider,
  type OauthStepUpRequest,
  oauthProviderSchema,
} from '@helpdock/schemas';
import { Box, Button, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';
import { isAuthError } from '../../auth/api.js';
import { PROVIDER_NAME_KEYS } from '../../auth/provider-names.js';
import { useAuthApi } from '../../auth/session.tsx';
import { AlertBanner } from '../../ui/alert-banner.tsx';
import { ConfirmDialog } from '../../ui/confirm-dialog.tsx';
import { formatDay } from '../../ui/format.js';
import { ProviderMark } from '../../ui/provider-marks.tsx';
import { useToast } from '../../ui/toasts.tsx';
import { Pill } from '../tickets/badges.tsx';
import { AccountCard } from './account-card.tsx';

/**
 * Sign-in methods on `/me/security` (M18-07, artboard
 * `Admin/Profile-Security-SignInMethods`, which supersedes the 1.0.2
 * `Admin/Me-SignInProviders`): one row per provider the install has
 * configured, with its link state and a Connect or Disconnect that asks for the
 * password or a live code first (ADR 0051). Connecting goes to the provider,
 * which sends the browser back here with `?connected=<provider>`, or to the
 * callback screens of `Admin/Login-Providers` with the refusal. When a
 * provider is the account's only way in, its Disconnect is disabled and a note
 * under the list says what to add first. With no provider configured the card
 * is not drawn.
 */

type StepUp = { readonly action: 'connect' | 'disconnect'; readonly provider: OauthProvider };

/**
 * The step-up field takes either credential. A password is at least twelve
 * characters, so six digits can only be an authenticator code.
 */
const stepUpProof = (value: string): OauthStepUpRequest =>
  /^\d{6}$/.test(value) ? { code: value } : { currentPassword: value };

const IDENTITIES_KEY = ['me', 'oauth-identities'] as const;

export function SignInProvidersCard(): ReactNode {
  const t = useT();
  const api = useAuthApi();
  const methods = useQuery({ queryKey: ['auth', 'methods'], queryFn: () => api.authMethods() });
  const identities = useQuery({ queryKey: IDENTITIES_KEY, queryFn: () => api.oauthIdentities() });
  const [stepUp, setStepUp] = useState<StepUp | null>(null);
  const lastWayInId = useId();

  useConnectedToast();

  const configured = OAUTH_PROVIDERS.filter((provider) => methods.data?.oauth[provider] === true);
  if (configured.length === 0 || identities.data === undefined) {
    return null;
  }
  const list = identities.data;
  const onlyWayIn = configured.find((provider) => isLastSignInMethod(list, provider));

  return (
    <AccountCard title={t('me:signInProviders.title')} caption={t('me:signInProviders.caption')}>
      {list.identities.length === 0 ? (
        <AlertBanner tone="warning">{t('me:signInProviders.notice')}</AlertBanner>
      ) : null}
      <Box component="ul" sx={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {configured.map((provider) => (
          <ProviderRow
            key={provider}
            provider={provider}
            list={list}
            lastWayInId={lastWayInId}
            onAction={(action) => {
              setStepUp({ action, provider });
            }}
          />
        ))}
      </Box>
      {onlyWayIn === undefined ? null : (
        <Typography
          id={lastWayInId}
          variant="caption"
          sx={{ color: 'text.secondary', display: 'flex', alignItems: 'center', gap: 2 }}
        >
          <Info size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
          {t('me:signInProviders.lastWayIn', { provider: t(PROVIDER_NAME_KEYS[onlyWayIn]) })}
        </Typography>
      )}
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t('me:signInProviders.footer')}
      </Typography>
      <StepUpDialog
        stepUp={stepUp}
        onClose={() => {
          setStepUp(null);
        }}
      />
    </AccountCard>
  );
}

/** The toast for the provider's redirect back, once, then the parameter is dropped. */
function useConnectedToast(): void {
  const t = useT();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const shown = useRef(false);
  const connected = oauthProviderSchema.safeParse(params.get('connected'));

  useEffect(() => {
    if (!connected.success) {
      shown.current = false;
      return;
    }
    if (shown.current) {
      return;
    }
    shown.current = true;
    toast({
      tone: 'success',
      message: t('me:signInProviders.connectedToast', {
        provider: t(PROVIDER_NAME_KEYS[connected.data]),
      }),
    });
    setParams(
      (current) => {
        current.delete('connected');
        return current;
      },
      { replace: true },
    );
  }, [connected.success, connected.data, toast, t, setParams]);
}

function ProviderRow({
  provider,
  list,
  lastWayInId,
  onAction,
}: {
  readonly provider: OauthProvider;
  readonly list: OauthIdentityList;
  /** The note under the list that says why a Disconnect is disabled. */
  readonly lastWayInId: string;
  onAction(action: StepUp['action']): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const name = t(PROVIDER_NAME_KEYS[provider]);
  const linked = list.identities.find((identity) => identity.provider === provider);
  const lastWayIn = isLastSignInMethod(list, provider);

  return (
    <Box
      component="li"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        minHeight: 56,
        paddingBlock: 2,
        borderBlockStart: `1px solid ${tokens['bg.muted']}`,
      }}
    >
      <Box
        component="span"
        sx={{
          width: 32,
          height: 32,
          flexShrink: 0,
          borderRadius: '6px',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: tokens['bg.muted'],
          color: tokens['text.primary'],
        }}
      >
        <ProviderMark name={provider} />
      </Box>
      <Box sx={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <Typography
          variant="bodyStrong"
          component="span"
          sx={{ display: 'flex', alignItems: 'center', gap: 2 }}
        >
          {name}
          {linked === undefined ? null : (
            <Pill tone="success" dot>
              {t('me:signInProviders.connected')}
            </Pill>
          )}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {linked === undefined ? (
            t('me:signInProviders.notConnected', { provider: name })
          ) : (
            <>
              <bdi dir="ltr">{linked.email}</bdi>
              {' · '}
              {t('me:signInProviders.connectedOn', {
                date: formatDay(linked.connectedAt, locale),
              })}
              {' · '}
              {linked.lastUsedAt === null
                ? t('me:signInProviders.neverUsed')
                : t('me:signInProviders.lastUsed', {
                    date: formatDay(linked.lastUsedAt, locale),
                  })}
            </>
          )}
        </Typography>
      </Box>
      {linked === undefined ? (
        <Button
          variant="contained"
          sx={{ flexShrink: 0 }}
          onClick={() => {
            onAction('connect');
          }}
        >
          {t('me:signInProviders.connect', { provider: name })}
        </Button>
      ) : (
        <Button
          variant="outlined"
          disabled={lastWayIn}
          aria-describedby={lastWayIn ? lastWayInId : undefined}
          sx={{ flexShrink: 0 }}
          onClick={() => {
            onAction('disconnect');
          }}
        >
          {t('me:signInProviders.disconnect', { provider: name })}
        </Button>
      )}
    </Box>
  );
}

/**
 * "Confirm it's you": the password or a live code in one field, then the
 * connect redirect or the disconnect. A wrong credential is said in the field;
 * anything else is a toast and closes the dialog.
 */
function StepUpDialog({
  stepUp,
  onClose,
}: {
  readonly stepUp: StepUp | null;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const api = useAuthApi();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fieldId = useId();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const name = stepUp === null ? '' : t(PROVIDER_NAME_KEYS[stepUp.provider]);

  const close = (): void => {
    setValue('');
    setError(null);
    onClose();
  };

  const submit = useMutation({
    mutationFn: async ({ action, provider }: StepUp): Promise<void> => {
      if (action === 'disconnect') {
        await api.disconnectOauth(provider, stepUpProof(value));
        return;
      }
      const url = await api.connectOauth(provider, stepUpProof(value));
      // An app path stays in the router; a provider's address is a page load.
      if (url.startsWith('/')) {
        void navigate(url);
      } else {
        window.location.assign(url);
      }
    },
    onSuccess: async (_nothing, { action, provider }) => {
      close();
      await queryClient.invalidateQueries({ queryKey: IDENTITIES_KEY });
      if (action === 'disconnect') {
        toast({
          tone: 'success',
          message: t('me:signInProviders.disconnectedToast', {
            provider: t(PROVIDER_NAME_KEYS[provider]),
          }),
        });
      }
    },
    onError: (failure) => {
      if (
        isAuthError(failure) &&
        (failure.code === 'invalid-credentials' || failure.code === 'totp-mismatch')
      ) {
        setError(t('me:signInProviders.proofWrong'));
        return;
      }
      close();
      toast({
        tone: 'danger',
        message:
          isAuthError(failure) && failure.code === 'oauth-last-sign-in'
            ? t('me:signInProviders.lastWayIn', { provider: name })
            : isAuthError(failure) && failure.code === 'oauth-identity-conflict'
              ? t('auth:oauth.errors.oauth-identity-conflict')
              : t('me:security.failed'),
      });
    },
  });

  return (
    <ConfirmDialog
      open={stepUp !== null}
      busy={submit.isPending}
      title={t('me:signInProviders.stepUpTitle')}
      body={
        stepUp?.action === 'disconnect'
          ? t('me:signInProviders.stepUpDisconnect', { provider: name })
          : t('me:signInProviders.stepUpConnect', { provider: name })
      }
      confirmLabel={t('me:signInProviders.continue')}
      onClose={close}
      onConfirm={() => {
        if (stepUp === null) {
          return;
        }
        if (value === '') {
          setError(t('me:signInProviders.proofRequired'));
          return;
        }
        setError(null);
        submit.mutate(stepUp);
      }}
    >
      <TextField
        id={fieldId}
        type="password"
        label={t('me:signInProviders.proofLabel')}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
        }}
        error={error !== null}
        helperText={error ?? ' '}
        fullWidth
        slotProps={{ htmlInput: { autoComplete: 'current-password' } }}
      />
    </ConfirmDialog>
  );
}
