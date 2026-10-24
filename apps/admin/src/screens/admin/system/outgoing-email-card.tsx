import {
  SMTP_TLS_MODES,
  type SmtpSettings,
  type SmtpSettingsUpdate,
  type SmtpTestResult,
  type SmtpTlsMode,
} from '@helpdock/schemas';
import { Box, Button, Chip, CircularProgress, Select, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { Field, fieldDescribedBy } from '../../../ui/field.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import { SectionCard } from '../channels/section-card.tsx';
import { SMTP_SETTINGS_QUERY_KEY, type SystemApi, SystemApiError } from './system-api.js';

/**
 * Admin › System › Outgoing email (#369): the install's system sender, the
 * `smtp.*` settings the first-run wizard can only set once. Everything the
 * wizard's step 3 offers is here — the server, the port, the TLS mode, the
 * credentials, the From address and name, and "Send a test email" showing the
 * server's answer — so an operator who skipped the step never has to edit
 * `.env` and restart to get password resets working.
 *
 * The password is write-only: the api says whether one is stored and never
 * what, so an untouched field keeps it (the wizard had it easy — the operator
 * had just typed it). Fields an `HD_SMTP_*` variable pins are drawn locked,
 * as the pinned OAuth keys are on the Settings page: the environment wins,
 * and editing here would store a value nothing reads.
 *
 * Built from the artboard `Admin/System-OutgoingEmail`: the stored password is
 * reused only while the server, port and username are unchanged, so changing
 * one asks for it again (the api answers `smtp-password-required`).
 */

const MASKED_SECRET = '••••••••••••';

const DEFAULT_PORT_BY_TLS: Readonly<Record<SmtpTlsMode, number>> = {
  starttls: 587,
  tls: 465,
  none: 25,
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PORT = 1;
const MAX_PORT = 65_535;

interface SmtpFormErrors {
  host?: 'required';
  port?: 'invalid';
  fromAddress?: 'required' | 'invalid';
  fromName?: 'required';
}

export const validateSmtpForm = (draft: {
  host: string;
  port: string;
  fromAddress: string;
  fromName: string;
}): SmtpFormErrors => {
  const errors: SmtpFormErrors = {};

  if (draft.host.trim() === '') {
    errors.host = 'required';
  }

  const parsedPort = Number(draft.port);
  if (!Number.isInteger(parsedPort) || parsedPort < MIN_PORT || parsedPort > MAX_PORT) {
    errors.port = 'invalid';
  }

  if (draft.fromAddress.trim() === '') {
    errors.fromAddress = 'required';
  } else if (!EMAIL.test(draft.fromAddress.trim())) {
    errors.fromAddress = 'invalid';
  }

  if (draft.fromName.trim() === '') {
    errors.fromName = 'required';
  }

  return errors;
};

export function OutgoingEmailCard({ api }: { readonly api: SystemApi }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: SMTP_SETTINGS_QUERY_KEY,
    queryFn: () => api.smtpSettings(),
    retry: false,
  });

  if (query.isPending) {
    return (
      <Box role="status" aria-live="polite" sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <CircularProgress size={20} aria-hidden="true" />
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('common:loading')}
        </Typography>
      </Box>
    );
  }

  if (query.error || query.data === undefined) {
    return (
      <Box
        role="alert"
        sx={{
          borderRadius: '10px',
          border: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.surface'],
          padding: 5,
        }}
      >
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('system:smtp.loadFailed')}
        </Typography>
      </Box>
    );
  }

  return (
    <SmtpSettingsForm
      key={JSON.stringify(query.data)}
      api={api}
      settings={query.data}
      onSaved={(saved) => {
        queryClient.setQueryData(SMTP_SETTINGS_QUERY_KEY, saved);
      }}
    />
  );
}

type TestOutcome =
  | { readonly kind: 'result'; readonly result: SmtpTestResult; readonly port: number }
  | { readonly kind: 'wait'; readonly seconds: number };

const DEFAULT_WAIT_SECONDS = 60;
const ENV_KEY = /HD_SMTP_[A-Z_]+/;

/** A field a pinned `HD_SMTP_*` variable sets: read-only, with a caption naming the variable. */
const lockedProps = (locked: boolean) => ({ readOnly: locked });

function SmtpSettingsForm({
  api,
  settings,
  onSaved,
}: {
  readonly api: SystemApi;
  readonly settings: SmtpSettings;
  readonly onSaved: (saved: SmtpSettings) => void;
}): ReactNode {
  const t = useT();
  const toast = useToast();

  const [host, setHost] = useState(settings.host);
  const [tls, setTls] = useState<SmtpTlsMode>(settings.tls);
  const [port, setPort] = useState(String(settings.port));
  const [user, setUser] = useState(settings.user);
  /** Empty keeps the stored password; the api never sends it back. */
  const [password, setPassword] = useState('');
  const [fromAddress, setFromAddress] = useState(settings.fromAddress);
  const [fromName, setFromName] = useState(settings.fromName);
  const [errors, setErrors] = useState<SmtpFormErrors>({});
  const [passwordError, setPasswordError] = useState<string | undefined>(undefined);
  /** The last test's outcome, or null when none has been run since a change. */
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);

  const draft = (): SmtpSettingsUpdate => ({
    host: host.trim(),
    port: Number(port),
    tls,
    user: user.trim(),
    ...(password === '' ? {} : { password }),
    fromAddress: fromAddress.trim(),
    fromName: fromName.trim(),
  });

  const check = (): boolean => {
    const found = validateSmtpForm({ host, port, fromAddress, fromName });
    setErrors(found);
    setPasswordError(undefined);

    return Object.keys(found).length === 0;
  };

  /** The api asks for the password again when the server changed: a field error, not a toast. */
  const passwordRequired = (error: unknown): boolean => {
    if (error instanceof SystemApiError && error.reason === 'smtp-password-required') {
      setPasswordError(t('system:smtp.errors.passwordRequired'));

      return true;
    }

    return false;
  };

  const save = useMutation({
    mutationFn: () => api.saveSmtpSettings(draft()),
    onSuccess: (saved) => {
      onSaved(saved);
      setPassword('');
      setOutcome(null);
      toast({ tone: 'success', message: t('system:smtp.saved') });
    },
    onError: (error) => {
      if (passwordRequired(error)) {
        return;
      }
      const envKey =
        error instanceof SystemApiError && error.status === 409
          ? ENV_KEY.exec(error.detail ?? '')?.[0]
          : undefined;
      toast({
        tone: 'danger',
        message:
          envKey === undefined
            ? t('system:smtp.saveFailed')
            : t('system:smtp.pinnedSaveFailed', { envKey }),
      });
    },
  });

  const test = useMutation({
    mutationFn: () => api.testSmtpSettings(draft()),
    onSuccess: (result) => {
      setOutcome({ kind: 'result', result, port: Number(port) });
    },
    onError: (error) => {
      if (error instanceof SystemApiError && error.status === 429) {
        setOutcome({ kind: 'wait', seconds: error.retryAfter ?? DEFAULT_WAIT_SECONDS });
      } else if (!passwordRequired(error)) {
        setOutcome({ kind: 'result', result: { delivered: false, error: 'unknown' }, port: 0 });
      }
    },
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setOutcome(null);
    if (check()) {
      save.mutate();
    }
  };

  const sendTest = (): void => {
    if (check()) {
      test.mutate();
    }
  };

  const dirty =
    host !== settings.host ||
    tls !== settings.tls ||
    port !== String(settings.port) ||
    user !== settings.user ||
    fromAddress !== settings.fromAddress ||
    fromName !== settings.fromName ||
    password !== '';

  const hostError = errors.host ? t('system:smtp.errors.hostRequired') : undefined;
  const portError = errors.port ? t('system:smtp.errors.portInvalid') : undefined;
  const fromAddressError =
    errors.fromAddress === 'required'
      ? t('system:smtp.errors.fromAddressRequired')
      : errors.fromAddress === 'invalid'
        ? t('system:smtp.errors.fromAddressInvalid')
        : undefined;
  const fromNameError = errors.fromName ? t('system:smtp.errors.fromNameRequired') : undefined;

  const lockHint = (locked: boolean, envKey: string): string | undefined =>
    locked ? t('system:smtp.lockHint', { envKey }) : undefined;

  return (
    <SectionCard
      id="outgoing-email"
      heading={t('system:smtp.title')}
      regionName={t('system:smtp.regionName')}
      caption={t('system:smtp.caption')}
      aside={
        <Chip
          size="small"
          color={settings.configured ? 'success' : 'warning'}
          label={
            settings.configured ? t('system:smtp.statusConfigured') : t('system:smtp.statusMissing')
          }
        />
      }
      onSubmit={submit}
      footer={
        <>
          <Button
            type="button"
            variant="outlined"
            color="secondary"
            onClick={sendTest}
            loading={test.isPending}
            loadingPosition="start"
            startIcon={<Send size={16} aria-hidden="true" />}
            disabled={save.isPending}
          >
            {t('system:smtp.test')}
          </Button>
          <Button type="submit" variant="contained" disabled={!dirty} loading={save.isPending}>
            {t('system:smtp.save')}
          </Button>
        </>
      }
    >
      {settings.configured ? null : (
        <AlertBanner tone="warning">{t('system:smtp.notSetWarning')}</AlertBanner>
      )}
      {outcome === null ? null : outcome.kind === 'wait' ? (
        <AlertBanner tone="warning">
          {t('system:smtp.testRateLimited', { seconds: outcome.seconds })}
        </AlertBanner>
      ) : outcome.result.delivered ? (
        <AlertBanner tone="success">
          {outcome.result.response === undefined
            ? t('system:smtp.testDelivered', { recipient: outcome.result.recipient ?? '' })
            : t('system:smtp.testDeliveredWithResponse', {
                recipient: outcome.result.recipient ?? '',
                response: outcome.result.response,
              })}
        </AlertBanner>
      ) : (
        <AlertBanner tone="danger">
          {t(`system:smtp.errors.${outcome.result.error ?? 'unknown'}`, { port: outcome.port })}
        </AlertBanner>
      )}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '2fr 1fr' }, gap: 4 }}>
        <Field
          id="smtp-host"
          label={t('system:smtp.host')}
          error={hostError}
          hint={lockHint(settings.locked.host, 'HD_SMTP_HOST')}
        >
          <TextField
            id="smtp-host"
            size="small"
            value={host}
            placeholder={t('system:smtp.hostPlaceholder')}
            onChange={(event) => {
              setHost(event.target.value);
            }}
            error={hostError !== undefined}
            fullWidth
            slotProps={{
              htmlInput: {
                ...lockedProps(settings.locked.host),
                dir: 'ltr',
                autoComplete: 'off',
                spellCheck: false,
                'aria-describedby': fieldDescribedBy('smtp-host', {
                  error: hostError,
                  hint: settings.locked.host ? 'locked' : undefined,
                }),
              },
            }}
          />
        </Field>

        <Field
          id="smtp-port"
          label={t('system:smtp.port')}
          error={portError}
          hint={lockHint(settings.locked.port, 'HD_SMTP_PORT')}
        >
          <TextField
            id="smtp-port"
            size="small"
            type="number"
            value={port}
            onChange={(event) => {
              setPort(event.target.value);
            }}
            error={portError !== undefined}
            fullWidth
            slotProps={{
              htmlInput: {
                ...lockedProps(settings.locked.port),
                dir: 'ltr',
                min: MIN_PORT,
                max: MAX_PORT,
                inputMode: 'numeric',
                'aria-describedby': fieldDescribedBy('smtp-port', {
                  error: portError,
                  hint: settings.locked.port ? 'locked' : undefined,
                }),
              },
            }}
          />
        </Field>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 4 }}>
        <Field
          id="smtp-user"
          label={t('system:smtp.user')}
          hint={lockHint(settings.locked.user, 'HD_SMTP_USER') ?? t('system:smtp.userOptional')}
        >
          <TextField
            id="smtp-user"
            size="small"
            value={user}
            onChange={(event) => {
              setUser(event.target.value);
            }}
            fullWidth
            slotProps={{
              htmlInput: {
                ...lockedProps(settings.locked.user),
                dir: 'ltr',
                autoComplete: 'off',
                'aria-describedby': fieldDescribedBy('smtp-user', {
                  hint: settings.locked.user ? 'locked' : 'optional',
                }),
              },
            }}
          />
        </Field>

        <Field
          id="smtp-password"
          label={t('system:smtp.password')}
          error={passwordError}
          hint={
            settings.locked.password
              ? t('system:smtp.lockHint', { envKey: 'HD_SMTP_PASSWORD' })
              : settings.passwordConfigured
                ? t('system:smtp.passwordAsksAgain')
                : t('system:smtp.passwordHint')
          }
        >
          <TextField
            id="smtp-password"
            size="small"
            type="password"
            value={settings.locked.password ? MASKED_SECRET : password}
            placeholder={
              settings.passwordConfigured && !settings.locked.password
                ? t('system:smtp.passwordPlaceholder')
                : undefined
            }
            onChange={(event) => {
              setPassword(event.target.value);
              setPasswordError(undefined);
            }}
            error={passwordError !== undefined}
            fullWidth
            slotProps={{
              htmlInput: {
                ...lockedProps(settings.locked.password),
                maxLength: 512,
                dir: 'ltr',
                autoComplete: 'new-password',
                'aria-describedby': fieldDescribedBy('smtp-password', {
                  error: passwordError,
                  hint: 'password',
                }),
              },
            }}
          />
        </Field>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 4 }}>
        <Field
          id="smtp-from"
          label={t('system:smtp.fromAddress')}
          error={fromAddressError}
          hint={lockHint(settings.locked.fromAddress, 'HD_SMTP_FROM')}
        >
          <TextField
            id="smtp-from"
            size="small"
            type="email"
            value={fromAddress}
            onChange={(event) => {
              setFromAddress(event.target.value);
            }}
            error={fromAddressError !== undefined}
            fullWidth
            slotProps={{
              htmlInput: {
                ...lockedProps(settings.locked.fromAddress),
                dir: 'ltr',
                autoComplete: 'off',
                'aria-describedby': fieldDescribedBy('smtp-from', {
                  error: fromAddressError,
                  hint: settings.locked.fromAddress ? 'locked' : undefined,
                }),
              },
            }}
          />
        </Field>

        <Field
          id="smtp-from-name"
          label={t('system:smtp.fromName')}
          error={fromNameError}
          hint={lockHint(settings.locked.fromName, 'HD_SMTP_FROM_NAME')}
        >
          <TextField
            id="smtp-from-name"
            size="small"
            value={fromName}
            onChange={(event) => {
              setFromName(event.target.value);
            }}
            error={fromNameError !== undefined}
            fullWidth
            slotProps={{
              htmlInput: {
                ...lockedProps(settings.locked.fromName),
                'aria-describedby': fieldDescribedBy('smtp-from-name', {
                  error: fromNameError,
                  hint: settings.locked.fromName ? 'locked' : undefined,
                }),
              },
            }}
          />
        </Field>
      </Box>

      <Field
        id="smtp-tls"
        label={t('system:smtp.tls')}
        hint={lockHint(settings.locked.tls, 'HD_SMTP_TLS')}
      >
        {/* Native, as the wizard step's is: the label names it, and no
            hidden input for a screen reader to trip over. */}
        <Select
          native
          id="smtp-tls"
          value={tls}
          disabled={settings.locked.tls}
          onChange={(event) => {
            const next = event.target.value as SmtpTlsMode;
            setTls(next);
            // The port follows the mode until somebody types their own, as on
            // the wizard step: the two fields make one choice together.
            if (!settings.locked.port) {
              setPort(String(DEFAULT_PORT_BY_TLS[next]));
            }
          }}
          fullWidth
        >
          {SMTP_TLS_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t(`system:smtp.tlsModes.${mode}`)}
            </option>
          ))}
        </Select>
      </Field>
    </SectionCard>
  );
}
