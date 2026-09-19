import type { SetupSmtpRequest, SmtpCredentials, SmtpTestResult } from '@helpdock/schemas';
import { SMTP_TLS_MODES, type SmtpTlsMode } from '@helpdock/schemas';
import { Box, Button, OutlinedInput, Select } from '@mui/material';
import { Send } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { AlertBanner } from '../../ui/alert-banner.tsx';
import { Field, fieldDescribedBy } from '../../ui/field.tsx';
import { StepFrame } from './setup-layout.tsx';

/**
 * Step 3 of the artboard `Admin/Wizard`: outgoing email.
 *
 * "Send a test email" is the point of the step. Anyone can type an SMTP host;
 * what an operator needs to know before they go any further is whether a
 * message actually leaves this machine, so the test sends one to their own
 * address and draws the answer — the relay's reply, or a sentence per failure —
 * without leaving the step.
 *
 * Skipping is allowed and recorded. An install without email still works; one
 * that silently believes it has email does not.
 */

const DEFAULT_PORT_BY_TLS: Readonly<Record<SmtpTlsMode, number>> = {
  starttls: 587,
  tls: 465,
  none: 25,
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PORT = 1;
const MAX_PORT = 65_535;

export interface EmailStepErrors {
  host?: 'required';
  port?: 'invalid';
  fromAddress?: 'required' | 'invalid';
  fromName?: 'required';
}

export interface EmailDraft {
  readonly host: string;
  readonly port: string;
  readonly fromAddress: string;
  readonly fromName: string;
}

export function validateEmail({ host, port, fromAddress, fromName }: EmailDraft): EmailStepErrors {
  const errors: EmailStepErrors = {};

  if (host.trim() === '') {
    errors.host = 'required';
  }

  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort < MIN_PORT || parsedPort > MAX_PORT) {
    errors.port = 'invalid';
  }

  if (fromAddress.trim() === '') {
    errors.fromAddress = 'required';
  } else if (!EMAIL.test(fromAddress.trim())) {
    errors.fromAddress = 'invalid';
  }

  if (fromName.trim() === '') {
    errors.fromName = 'required';
  }

  return errors;
}

export interface EmailStepProps {
  readonly onSubmit: (request: SetupSmtpRequest) => void;
  readonly onTest: (credentials: SmtpCredentials) => void;
  readonly onBack: () => void;
  readonly pending: boolean;
  readonly testPending: boolean;
  /** The last test's outcome, or null when none has been run since a change. */
  readonly testResult: SmtpTestResult | null;
  /** Where the test message went, for the success line. */
  readonly adminEmail: string;
}

export function EmailStep({
  onSubmit,
  onTest,
  onBack,
  pending,
  testPending,
  testResult,
  adminEmail,
}: EmailStepProps): ReactNode {
  const t = useT();
  const [host, setHost] = useState('');
  const [tls, setTls] = useState<SmtpTlsMode>('starttls');
  const [port, setPort] = useState(String(DEFAULT_PORT_BY_TLS.starttls));
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [fromAddress, setFromAddress] = useState('');
  const [fromName, setFromName] = useState('');
  const [errors, setErrors] = useState<EmailStepErrors>({});

  const credentials = (): SmtpCredentials => ({
    host: host.trim(),
    port: Number(port),
    tls,
    user: user.trim(),
    password,
    fromAddress: fromAddress.trim(),
    fromName: fromName.trim(),
  });

  const check = (): boolean => {
    const found = validateEmail({ host, port, fromAddress, fromName });
    setErrors(found);

    return Object.keys(found).length === 0;
  };

  const submit = (): void => {
    if (check()) {
      onSubmit({ ...credentials(), skip: false });
    }
  };

  const test = (): void => {
    if (check()) {
      onTest(credentials());
    }
  };

  const hostError = errors.host ? t('wizard:email.hostRequired') : undefined;
  const portError = errors.port ? t('wizard:email.portInvalid') : undefined;
  const fromAddressError =
    errors.fromAddress === 'required'
      ? t('wizard:email.fromAddressRequired')
      : errors.fromAddress === 'invalid'
        ? t('wizard:email.fromAddressInvalid')
        : undefined;
  const fromNameError = errors.fromName ? t('wizard:email.fromNameRequired') : undefined;
  const passwordHint = t('wizard:email.passwordHint');

  return (
    <StepFrame
      title={t('wizard:email.title')}
      description={t('wizard:email.description')}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="text" color="secondary" onClick={onBack}>
            {t('wizard:back')}
          </Button>
          <Button
            type="button"
            variant="text"
            color="secondary"
            onClick={() => {
              onSubmit({ skip: true });
            }}
            disabled={pending || testPending}
          >
            {t('wizard:email.skip')}
          </Button>
          <Button type="submit" variant="contained" color="primary" loading={pending}>
            {t('wizard:email.submit')}
          </Button>
        </>
      }
    >
      {testResult === null ? null : testResult.delivered ? (
        <AlertBanner tone="info">
          {testResult.response === undefined
            ? t('wizard:email.testDelivered', { email: adminEmail })
            : t('wizard:email.testDeliveredWithResponse', {
                email: adminEmail,
                response: testResult.response,
              })}
        </AlertBanner>
      ) : (
        <AlertBanner tone="danger">
          {t(`wizard:email.errors.${testResult.error ?? 'unknown'}`)}
        </AlertBanner>
      )}

      <Field id="setup-smtp-host" label={t('wizard:email.hostLabel')} error={hostError}>
        <OutlinedInput
          id="setup-smtp-host"
          value={host}
          onChange={(event) => {
            setHost(event.target.value);
          }}
          placeholder={t('wizard:email.hostPlaceholder')}
          error={Boolean(hostError)}
          fullWidth
          slotProps={{
            input: {
              dir: 'ltr',
              autoComplete: 'off',
              spellCheck: false,
              'aria-describedby': fieldDescribedBy('setup-smtp-host', { error: hostError }),
            },
          }}
        />
      </Field>

      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
        <Field id="setup-smtp-tls" label={t('wizard:email.tlsLabel')}>
          <Select
            native
            id="setup-smtp-tls"
            value={tls}
            onChange={(event) => {
              const next = event.target.value as SmtpTlsMode;
              setTls(next);
              // The port follows the mode until somebody types their own, which
              // is the choice the two fields really make together.
              setPort(String(DEFAULT_PORT_BY_TLS[next]));
            }}
            fullWidth
          >
            {SMTP_TLS_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(`wizard:email.tls.${mode}`)}
              </option>
            ))}
          </Select>
        </Field>

        <Field id="setup-smtp-port" label={t('wizard:email.portLabel')} error={portError}>
          <OutlinedInput
            id="setup-smtp-port"
            type="number"
            value={port}
            onChange={(event) => {
              setPort(event.target.value);
            }}
            error={Boolean(portError)}
            fullWidth
            slotProps={{
              input: {
                dir: 'ltr',
                min: MIN_PORT,
                max: MAX_PORT,
                'aria-describedby': fieldDescribedBy('setup-smtp-port', { error: portError }),
              },
            }}
          />
        </Field>
      </Box>

      <Field
        id="setup-smtp-user"
        label={t('wizard:email.userLabel')}
        hint={t('wizard:email.userOptional')}
      >
        <OutlinedInput
          id="setup-smtp-user"
          value={user}
          onChange={(event) => {
            setUser(event.target.value);
          }}
          fullWidth
          slotProps={{
            input: {
              dir: 'ltr',
              autoComplete: 'off',
              'aria-describedby': fieldDescribedBy('setup-smtp-user', {
                hint: t('wizard:email.userOptional'),
              }),
            },
          }}
        />
      </Field>

      <Field id="setup-smtp-password" label={t('wizard:email.passwordLabel')} hint={passwordHint}>
        <OutlinedInput
          id="setup-smtp-password"
          type="password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          fullWidth
          slotProps={{
            input: {
              dir: 'ltr',
              autoComplete: 'new-password',
              'aria-describedby': fieldDescribedBy('setup-smtp-password', { hint: passwordHint }),
            },
          }}
        />
      </Field>

      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
        <Field
          id="setup-smtp-from"
          label={t('wizard:email.fromAddressLabel')}
          error={fromAddressError}
        >
          <OutlinedInput
            id="setup-smtp-from"
            type="email"
            value={fromAddress}
            onChange={(event) => {
              setFromAddress(event.target.value);
            }}
            error={Boolean(fromAddressError)}
            fullWidth
            slotProps={{
              input: {
                dir: 'ltr',
                autoComplete: 'off',
                'aria-describedby': fieldDescribedBy('setup-smtp-from', {
                  error: fromAddressError,
                }),
              },
            }}
          />
        </Field>

        <Field
          id="setup-smtp-from-name"
          label={t('wizard:email.fromNameLabel')}
          error={fromNameError}
        >
          <OutlinedInput
            id="setup-smtp-from-name"
            value={fromName}
            onChange={(event) => {
              setFromName(event.target.value);
            }}
            error={Boolean(fromNameError)}
            fullWidth
            slotProps={{
              input: {
                'aria-describedby': fieldDescribedBy('setup-smtp-from-name', {
                  error: fromNameError,
                }),
              },
            }}
          />
        </Field>
      </Box>

      <Box>
        <Button
          type="button"
          variant="outlined"
          color="secondary"
          onClick={test}
          loading={testPending}
          loadingPosition="start"
          startIcon={<Send size={16} aria-hidden="true" />}
          disabled={pending}
        >
          {t('wizard:email.test')}
        </Button>
      </Box>
    </StepFrame>
  );
}
