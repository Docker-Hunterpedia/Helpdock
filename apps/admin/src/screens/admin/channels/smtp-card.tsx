import type { Locale } from '@helpdock/i18n';
import {
  type EmailOutgoingSettings,
  type OutgoingSmtpTestResult,
  type OutgoingSmtpUpdate,
  SMTP_TLS_MODES,
  type SmtpTlsMode,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  CircularProgress,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { CircleCheck, Send, TriangleAlert } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { useEmailApi } from '../../../auth/session.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { Field } from '../../../ui/field.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import { addedOn } from '../ticketing/spam-format.js';
import { SectionCard, useEmailAction } from './section-card.tsx';

/**
 * "Outgoing mail (SMTP)" of `Admin/Channels · Outgoing email`: the brand's own
 * server, "Test SMTP" with its three states, and Save.
 *
 * The stored password is never sent to the browser (AGENTS.md, secrets): the
 * field shows that one is stored and is read-only until "Replace" is pressed.
 * A save or a test without a replacement keeps the stored one.
 */

interface SmtpDraft {
  host: string;
  port: string;
  tls: SmtpTlsMode;
  user: string;
  /** Null while the stored password is kept. */
  password: string | null;
}

const draftOf = (settings: EmailOutgoingSettings): SmtpDraft => ({
  host: settings.smtp?.host ?? '',
  port: String(settings.smtp?.port ?? 587),
  tls: settings.smtp?.tls ?? 'starttls',
  user: settings.smtp?.user ?? '',
  password: settings.smtp?.passwordSet === true ? null : '',
});

const MASKED = '••••••••••••';

/** The request a draft makes, or the field that stops it. */
export const smtpRequestOf = (
  draft: SmtpDraft,
): { ok: true; request: OutgoingSmtpUpdate } | { ok: false; problem: 'host' | 'port' } => {
  const port = Number(draft.port);
  if (draft.host.trim() === '') {
    return { ok: false, problem: 'host' };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { ok: false, problem: 'port' };
  }
  return {
    ok: true,
    request: {
      host: draft.host.trim(),
      port,
      tls: draft.tls,
      user: draft.user.trim(),
      ...(draft.password === null ? {} : { password: draft.password }),
    },
  };
};

export function SmtpCard({
  brandId,
  settings,
  onSaved,
}: {
  readonly brandId: string;
  readonly settings: EmailOutgoingSettings;
  onSaved(settings: EmailOutgoingSettings): void;
}): ReactNode {
  const t = useT();
  const api = useEmailApi();
  const toast = useToast();
  const { locale } = usePreferences();
  const id = useId();
  const [draft, setDraft] = useState<SmtpDraft>(() => draftOf(settings));
  const [problem, setProblem] = useState<'host' | 'port' | null>(null);
  const [result, setResult] = useState<OutgoingSmtpTestResult | null>(null);

  useEffect(() => {
    setDraft(draftOf(settings));
  }, [settings]);

  const save = useEmailAction(
    (request: OutgoingSmtpUpdate) => api.saveSmtp(brandId, request),
    t('channels:smtp.saved'),
    onSaved,
  );

  const test = useMutation({
    mutationFn: (request: OutgoingSmtpUpdate) => api.testSmtp(brandId, request),
    onMutate: () => {
      setResult(null);
    },
    onSuccess: setResult,
    onError: () => {
      toast({ tone: 'danger', message: t('channels:actionFailed') });
    },
  });

  const validated = (): OutgoingSmtpUpdate | null => {
    const outcome = smtpRequestOf(draft);
    setProblem(outcome.ok ? null : outcome.problem);
    return outcome.ok ? outcome.request : null;
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const request = validated();
    if (request !== null) {
      save.mutate(request);
    }
  };

  const set = (patch: Partial<SmtpDraft>): void => {
    setDraft((held) => ({ ...held, ...patch }));
  };

  const stored = settings.smtp;

  return (
    <SectionCard
      id={`${id}-smtp`}
      heading={t('channels:smtp.heading')}
      caption={t('channels:smtp.caption')}
      onSubmit={submit}
      footer={
        <>
          <Button
            variant="text"
            disabled={save.isPending}
            onClick={() => {
              setDraft(draftOf(settings));
              setProblem(null);
            }}
          >
            {t('channels:discard')}
          </Button>
          <Button type="submit" variant="contained" disabled={save.isPending}>
            {t('channels:smtp.save')}
          </Button>
        </>
      }
    >
      {stored === null ? (
        <AlertBanner tone="info">
          {t(
            settings.installSmtpConfigured
              ? 'channels:smtp.installFallback'
              : 'channels:smtp.noServer',
          )}
        </AlertBanner>
      ) : null}

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) 96px 136px' },
          gap: 3,
        }}
      >
        <Field
          id={`${id}-host`}
          label={t('channels:smtp.host')}
          error={problem === 'host' ? t('channels:smtp.hostRequired') : undefined}
        >
          <TextField
            id={`${id}-host`}
            size="small"
            value={draft.host}
            error={problem === 'host'}
            onChange={(event) => {
              set({ host: event.target.value });
            }}
            slotProps={{ htmlInput: { maxLength: 253, spellCheck: false } }}
          />
        </Field>
        <Field
          id={`${id}-port`}
          label={t('channels:smtp.port')}
          error={problem === 'port' ? t('channels:smtp.portInvalid') : undefined}
        >
          <TextField
            id={`${id}-port`}
            size="small"
            type="number"
            value={draft.port}
            error={problem === 'port'}
            onChange={(event) => {
              set({ port: event.target.value });
            }}
            slotProps={{ htmlInput: { min: 1, max: 65_535 } }}
          />
        </Field>
        <Field id={`${id}-tls`} label={t('channels:smtp.security')}>
          <Select
            id={`${id}-tls`}
            size="small"
            value={draft.tls}
            onChange={(event) => {
              set({ tls: event.target.value as SmtpTlsMode });
            }}
            inputProps={{ 'aria-label': t('channels:smtp.security') }}
          >
            {SMTP_TLS_MODES.map((mode) => (
              <MenuItem key={mode} value={mode}>
                {t(`channels:smtp.tls.${mode}`)}
              </MenuItem>
            ))}
          </Select>
        </Field>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) minmax(0, 1fr)' },
          gap: 3,
        }}
      >
        <Field id={`${id}-user`} label={t('channels:smtp.user')}>
          <TextField
            id={`${id}-user`}
            size="small"
            value={draft.user}
            onChange={(event) => {
              set({ user: event.target.value });
            }}
            slotProps={{ htmlInput: { maxLength: 320, autoComplete: 'off', spellCheck: false } }}
          />
        </Field>
        <Field
          id={`${id}-password`}
          label={t('channels:smtp.password')}
          hint={savedLine(stored, locale, t)}
        >
          <Box sx={{ display: 'flex', gap: 2 }}>
            <TextField
              id={`${id}-password`}
              size="small"
              type="password"
              value={draft.password ?? MASKED}
              sx={{ flex: 1 }}
              onChange={(event) => {
                set({ password: event.target.value });
              }}
              slotProps={{
                htmlInput: {
                  readOnly: draft.password === null,
                  maxLength: 512,
                  autoComplete: 'new-password',
                },
              }}
            />
            {draft.password === null ? (
              <Button
                variant="outlined"
                onClick={() => {
                  set({ password: '' });
                }}
              >
                {t('channels:smtp.replace')}
              </Button>
            ) : null}
          </Box>
        </Field>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
        <Button
          variant="outlined"
          disabled={test.isPending}
          aria-busy={test.isPending}
          startIcon={
            test.isPending ? (
              <CircularProgress size={14} aria-hidden="true" />
            ) : (
              <Send size={14} aria-hidden="true" />
            )
          }
          onClick={() => {
            const request = validated();
            if (request !== null) {
              test.mutate(request);
            }
          }}
        >
          {t('channels:smtp.test')}
        </Button>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {test.isPending ? t('channels:smtp.testing') : t('channels:smtp.testHint')}
        </Typography>
      </Box>

      {result === null ? null : <TestOutcome result={result} host={draft.host} port={draft.port} />}
    </SectionCard>
  );
}

const savedLine = (
  stored: EmailOutgoingSettings['smtp'],
  locale: Locale,
  t: ReturnType<typeof useT>,
): string | undefined => {
  if (stored?.updatedAt == null) {
    return undefined;
  }
  const date = addedOn(stored.updatedAt, locale);
  return stored.updatedByName === null
    ? t('channels:smtp.savedAt', { date })
    : t('channels:smtp.savedBy', { date, name: stored.updatedByName });
};

/** The two drawn outcomes of a test: accepted, with the relay's reply; or refused. */
function TestOutcome({
  result,
  host,
  port,
}: {
  readonly result: OutgoingSmtpTestResult;
  readonly host: string;
  readonly port: string;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const delivered = result.delivered;
  const Icon = delivered ? CircleCheck : TriangleAlert;
  const tone = delivered ? 'success' : 'danger';

  return (
    <Box
      role={delivered ? 'status' : 'alert'}
      sx={{
        display: 'flex',
        gap: 2,
        alignItems: 'flex-start',
        paddingBlock: 3,
        paddingInline: 4,
        borderRadius: '6px',
        border: `1px solid ${tokens[`status.${tone}`]}`,
        backgroundColor: tokens[`status.${tone}.tint`],
        color: tokens[`status.${tone}.text`],
      }}
    >
      <Icon size={16} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 2 }} />
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {delivered
            ? t('channels:smtp.testOk')
            : t(`channels:smtp.testFailed.${result.error ?? 'unknown'}`)}
        </Typography>
        {delivered ? (
          <Typography variant="mono" component="bdi" sx={{ fontSize: 12 }}>
            {t('channels:smtp.testOkDetail', {
              host,
              port,
              response: result.response ?? '250',
              seconds: (result.durationMs / 1000).toFixed(1),
            })}
          </Typography>
        ) : result.detail === undefined ? null : (
          <Typography
            variant="mono"
            component="code"
            sx={{ fontSize: 12, overflowWrap: 'anywhere' }}
          >
            {result.detail}
          </Typography>
        )}
      </Box>
    </Box>
  );
}
