import type {
  InstallAuthenticationSettings,
  InstallAuthenticationSettingsUpdate,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControlLabel,
  Link,
  Paper,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LockKeyhole, Settings2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { ROUTES } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { SETTINGS_AUTHENTICATION_QUERY_KEY } from '../../../settings/api.js';
import { useSettingsApi } from '../../../settings/context.tsx';
import { EmptyState } from '../../../shell/empty-state.js';
import { PageHeader } from '../../../shell/page-header.js';
import { Field, fieldDescribedBy } from '../../../ui/field.tsx';
import { SecretField } from '../../../ui/secret-field.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import { SectionCard } from '../channels/section-card.tsx';

const MASKED_SECRET = '••••••••••••';

export function SettingsPage(): ReactNode {
  const t = useT();
  const api = useSettingsApi();
  const query = useQuery({
    queryKey: SETTINGS_AUTHENTICATION_QUERY_KEY,
    queryFn: () => api.authentication(),
  });

  return (
    <>
      <PageHeader title={t('settings:title')} caption={t('settings:scope')} />
      <Tabs value="authentication" sx={{ marginBlockStart: -5, marginBlockEnd: 6 }}>
        <Tab value="authentication" label={t('settings:tabs.authentication')} />
      </Tabs>

      {query.isPending ? (
        <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <CircularProgress size={20} aria-hidden="true" />
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('common:loading')}
          </Typography>
        </Box>
      ) : query.error || query.data === undefined ? (
        <EmptyState
          icon={Settings2}
          heading={t('settings:error.title')}
          body={t('settings:error.body')}
        />
      ) : (
        <AuthenticationSettingsForm key={JSON.stringify(query.data)} settings={query.data} />
      )}
    </>
  );
}

function AuthenticationSettingsForm({
  settings,
}: {
  readonly settings: InstallAuthenticationSettings;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const api = useSettingsApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const id = useId();
  const [requireTwoFactor, setRequireTwoFactor] = useState(settings.requireTwoFactor);
  const [magicLinkValidity, setMagicLinkValidity] = useState(
    String(settings.magicLinkValidityMinutes),
  );
  const [googleClientId, setGoogleClientId] = useState(settings.google.clientId);
  const [githubClientId, setGithubClientId] = useState(settings.github.clientId);
  const [googleSecret, setGoogleSecret] = useState<string | null>(
    settings.google.clientSecretConfigured ? null : '',
  );
  const [githubSecret, setGithubSecret] = useState<string | null>(
    settings.github.clientSecretConfigured ? null : '',
  );
  const [magicLinkError, setMagicLinkError] = useState<string | undefined>();

  const save = useMutation({
    mutationFn: (request: InstallAuthenticationSettingsUpdate) => api.saveAuthentication(request),
    onSuccess: async (updated) => {
      queryClient.setQueryData(SETTINGS_AUTHENTICATION_QUERY_KEY, updated);
      toast({ tone: 'success', message: t('settings:saved') });
    },
    onError: () => {
      toast({ tone: 'danger', message: t('settings:error.save') });
    },
  });

  const reset = (): void => {
    setRequireTwoFactor(settings.requireTwoFactor);
    setMagicLinkValidity(String(settings.magicLinkValidityMinutes));
    setGoogleClientId(settings.google.clientId);
    setGithubClientId(settings.github.clientId);
    setGoogleSecret(settings.google.clientSecretConfigured ? null : '');
    setGithubSecret(settings.github.clientSecretConfigured ? null : '');
    setMagicLinkError(undefined);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const minutes = Number(magicLinkValidity);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
      setMagicLinkError(t('settings:signInMethods.magicLinkRange'));
      return;
    }

    setMagicLinkError(undefined);
    save.mutate({
      requireTwoFactor,
      magicLinkValidityMinutes: minutes,
      google: {
        clientId: googleClientId.trim(),
        ...(googleSecret === null || googleSecret === '' ? {} : { clientSecret: googleSecret }),
      },
      github: {
        clientId: githubClientId.trim(),
        ...(githubSecret === null || githubSecret === '' ? {} : { clientSecret: githubSecret }),
      },
    });
  };

  const dirty =
    requireTwoFactor !== settings.requireTwoFactor ||
    magicLinkValidity !== String(settings.magicLinkValidityMinutes) ||
    googleClientId !== settings.google.clientId ||
    githubClientId !== settings.github.clientId ||
    (googleSecret !== null && googleSecret !== '') ||
    (githubSecret !== null && githubSecret !== '');

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 720px) 300px' },
        gap: 8,
        alignItems: 'start',
      }}
    >
      <SectionCard
        id={`${id}-sign-in`}
        heading={t('settings:signInMethods.title')}
        caption={t('settings:signInMethods.description')}
        onSubmit={submit}
        footer={
          <>
            <Button variant="text" disabled={!dirty || save.isPending} onClick={reset}>
              {t('common:actions.discard')}
            </Button>
            <Button type="submit" variant="contained" disabled={!dirty || save.isPending}>
              {save.isPending ? <CircularProgress size={14} aria-hidden="true" /> : null}
              {t('common:actions.save')}
            </Button>
          </>
        }
      >
        <FormControlLabel
          control={
            <Checkbox
              checked={requireTwoFactor}
              disabled={settings.requireTwoFactorLocked}
              onChange={(event) => {
                setRequireTwoFactor(event.target.checked);
              }}
            />
          }
          label={
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <Typography variant="bodyStrong">
                {t('settings:signInMethods.requireTwoFactor')}
              </Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {settings.requireTwoFactorLocked
                  ? t('settings:lock.hint', {
                      envKey: 'HD_AUTH_REQUIRE2FA',
                      envFile: '.env',
                    })
                  : t('settings:signInMethods.requireTwoFactorHint')}
              </Typography>
            </Box>
          }
          sx={{ alignItems: 'flex-start', margin: 0 }}
        />

        <Box sx={{ maxWidth: 340 }}>
          <Field
            id={`${id}-magic-link`}
            label={t('settings:signInMethods.magicLinkValidity')}
            hint={
              settings.magicLinkValidityLocked
                ? t('settings:lock.hint', {
                    envKey: 'HD_AUTH_MAGIC_LINK_TTL_MINUTES',
                    envFile: '.env',
                  })
                : undefined
            }
            error={magicLinkError}
          >
            <TextField
              id={`${id}-magic-link`}
              type="number"
              value={magicLinkValidity}
              disabled={settings.magicLinkValidityLocked}
              error={magicLinkError !== undefined}
              onChange={(event) => {
                setMagicLinkValidity(event.target.value);
              }}
              slotProps={{
                htmlInput: {
                  min: 1,
                  max: 60,
                  inputMode: 'numeric',
                  'aria-describedby': fieldDescribedBy(`${id}-magic-link`, {
                    hint: settings.magicLinkValidityLocked ? 'locked' : undefined,
                    error: magicLinkError,
                  }),
                },
              }}
            />
          </Field>
        </Box>

        <Box sx={{ height: '1px', backgroundColor: tokens['border.default'] }} />

        <OAuthProviderFields
          id={`${id}-google`}
          provider="google"
          settings={settings.google}
          clientId={googleClientId}
          secret={googleSecret}
          onClientIdChange={setGoogleClientId}
          onSecretChange={setGoogleSecret}
        />
        <OAuthProviderFields
          id={`${id}-github`}
          provider="github"
          settings={settings.github}
          clientId={githubClientId}
          secret={githubSecret}
          onClientIdChange={setGithubClientId}
          onSecretChange={setGithubSecret}
        />
      </SectionCard>

      <Box component="aside" sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <AsideCard title={t('settings:aside.redirectUrls.title')}>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('settings:aside.redirectUrls.body')}
          </Typography>
          {[settings.redirectUrls.google, settings.redirectUrls.github].map((url) => (
            <Typography
              key={url}
              variant="mono"
              dir="ltr"
              sx={{ fontSize: 12, overflowWrap: 'anywhere' }}
            >
              {url}
            </Typography>
          ))}
        </AsideCard>
        <AsideCard title={t('settings:aside.live.title')}>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('settings:aside.live.body', { envFile: '.env' })}
          </Typography>
        </AsideCard>
        <AsideCard title={t('settings:aside.recent.title')}>
          <Link component={RouterLink} to={ROUTES.systemAuditLog} variant="caption">
            {t('settings:aside.recent.openAuditLog')}
          </Link>
        </AsideCard>
      </Box>
    </Box>
  );
}

function OAuthProviderFields({
  id,
  provider,
  settings,
  clientId,
  secret,
  onClientIdChange,
  onSecretChange,
}: {
  readonly id: string;
  readonly provider: 'google' | 'github';
  readonly settings: InstallAuthenticationSettings['google'];
  readonly clientId: string;
  readonly secret: string | null;
  onClientIdChange(value: string): void;
  onSecretChange(value: string | null): void;
}): ReactNode {
  const t = useT();
  const providerName = t(`settings:oauth.${provider}`);
  const clientIdHint = settings.clientIdLocked
    ? t('settings:lock.hint', {
        envKey: `HD_OAUTH_${provider.toUpperCase()}_CLIENT_ID`,
        envFile: '.env',
      })
    : undefined;
  const secretHint = settings.clientSecretLocked
    ? t('settings:lock.hint', {
        envKey: `HD_OAUTH_${provider.toUpperCase()}_CLIENT_SECRET`,
        envFile: '.env',
      })
    : settings.clientSecretConfigured
      ? t('settings:oauth.secretKept')
      : undefined;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Typography variant="bodyStrong">{providerName}</Typography>
        <Chip
          size="small"
          color={settings.enabled ? 'success' : 'default'}
          label={
            settings.enabled ? t('settings:status.enabled') : t('settings:status.notConfigured')
          }
        />
      </Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
          gap: 4,
        }}
      >
        <Field
          id={`${id}-client-id`}
          label={t('settings:oauth.clientId')}
          hint={clientIdHint}
          action={settings.clientIdLocked ? <EnvironmentLock /> : undefined}
        >
          <TextField
            id={`${id}-client-id`}
            value={clientId}
            placeholder={
              provider === 'github' ? t('settings:oauth.clientIdPlaceholder') : undefined
            }
            onChange={(event) => {
              onClientIdChange(event.target.value);
            }}
            slotProps={{
              htmlInput: {
                readOnly: settings.clientIdLocked,
                dir: 'ltr',
                maxLength: 2_048,
                'aria-describedby': fieldDescribedBy(`${id}-client-id`, {
                  hint: clientIdHint,
                }),
              },
            }}
          />
        </Field>

        {settings.clientSecretLocked ? (
          <Field
            id={`${id}-client-secret`}
            label={t('settings:oauth.clientSecret')}
            hint={secretHint}
            action={<EnvironmentLock />}
          >
            <TextField
              id={`${id}-client-secret`}
              type="password"
              value={MASKED_SECRET}
              slotProps={{
                htmlInput: {
                  readOnly: true,
                  dir: 'ltr',
                  'aria-describedby': fieldDescribedBy(`${id}-client-secret`, {
                    hint: secretHint,
                  }),
                },
              }}
            />
          </Field>
        ) : (
          <SecretField
            id={`${id}-client-secret`}
            label={t('settings:oauth.clientSecret')}
            stored={settings.clientSecretConfigured}
            value={secret}
            hint={secretHint}
            replaceLabel={t('settings:oauth.replaceLabel', { provider: providerName })}
            onChange={onSecretChange}
          />
        )}
      </Box>
    </Box>
  );
}

function EnvironmentLock(): ReactNode {
  const t = useT();
  return (
    <Chip
      size="small"
      icon={<LockKeyhole size={12} aria-hidden="true" />}
      label={t('settings:lock.badge')}
    />
  );
}

function AsideCard({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const tokens = useSemanticTokens();
  return (
    <Paper
      elevation={0}
      sx={{
        padding: 4,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <Typography variant="bodyStrong">{title}</Typography>
      {children}
    </Paper>
  );
}
