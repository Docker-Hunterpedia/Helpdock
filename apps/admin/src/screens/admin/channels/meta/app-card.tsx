import type { MetaApp } from '@helpdock/schemas';
import { Box, Button, CircularProgress, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Info, Network } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { metaKeys } from '../../../../meta/api.js';
import { useMetaApi } from '../../../../meta/context.tsx';
import { ConfirmDialog } from '../../../../ui/confirm-dialog.tsx';
import { EnvChip, EnvLockedField } from '../../../../ui/env-locked-field.tsx';
import { Field } from '../../../../ui/field.tsx';
import { useToast } from '../../../../ui/toasts.tsx';
import { SecretReveal } from '../../developers/secret-reveal.tsx';
import { clockTime } from '../format.js';
import { HealthStateDot } from '../health.tsx';
import { CodeText } from './code-text.tsx';

/** The settings an `HD_META_*` variable can take over, by the name the api reports them in. */
const APP_SECRET = 'meta.appSecret';
const INSTAGRAM_APP_SECRET = 'meta.instagramAppSecret';

/** Query for the install's Meta app. Only an install admin may ask. */
export function useMetaApp(enabled: boolean) {
  const api = useMetaApi();

  return useQuery({
    queryKey: metaKeys.app(),
    queryFn: () => api.app(),
    enabled,
  });
}

/**
 * Connecting needs the app's id and a verify token. The secrets are not told
 * to the screen unless the environment holds them, so the api's
 * `app-not-configured` is what says a secret is missing.
 */
export const appIsConfigured = (app: MetaApp): boolean =>
  app.appIdSet && app.verifyTokenHint !== '';

/**
 * DESIGN §6.3 MetaAppCard (M10-07, `Admin/Channels-Meta` panel 1), install
 * admins only: the one Meta developer app of the install — the callback URL to
 * paste into Meta's dashboard, the verify token (made here, shown once), and
 * what the app id and the two secrets are. The secrets are install settings
 * and never travel to the browser; the card says which ones the environment
 * has locked.
 */
export function MetaAppCard({
  app,
  lastEventAt,
}: {
  readonly app: MetaApp;
  /** The newest signed event across the brand's accounts, or null when none yet. */
  readonly lastEventAt: string | null;
}): ReactNode {
  const t = useT();
  const api = useMetaApi();
  const tokens = useSemanticTokens();
  const toast = useToast();
  const { locale } = usePreferences();
  const queryClient = useQueryClient();
  const headingId = useId();
  const callbackId = useId();
  const appIdId = useId();
  const verifyId = useId();
  const secretId = useId();
  const instagramId = useId();
  const [confirming, setConfirming] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);

  const rotate = useMutation({
    mutationFn: () => api.rotateVerifyToken(),
    onSuccess: async (reveal) => {
      setConfirming(false);
      setRevealed(reveal.verifyToken);
      await queryClient.invalidateQueries({ queryKey: metaKeys.app() });
    },
    onError: () => {
      setConfirming(false);
      toast({ tone: 'danger', message: t('channels:toast.failed') });
    },
  });

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(app.callbackUrl);
      toast({ tone: 'success', message: t('channels:meta.toast.copied') });
    } catch {
      toast({ tone: 'danger', message: t('channels:toast.failed') });
    }
  };

  const hasVerifyToken = app.verifyTokenHint !== '';
  const verifyHint = t(
    hasVerifyToken ? 'channels:meta.app.verify.hint' : 'channels:meta.app.verify.hintNone',
  );
  const locked = (key: string): boolean => app.secretsLockedByEnv.includes(key);

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      sx={{
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          paddingBlock: 3,
          paddingInline: 4,
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          flexWrap: 'wrap',
        }}
      >
        <Box
          aria-hidden="true"
          sx={{
            width: 32,
            height: 32,
            borderRadius: '6px',
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
            backgroundColor: tokens['bg.muted'],
          }}
        >
          <Network size={16} />
        </Box>
        <Box sx={{ display: 'flex', flexDirection: 'column', flex: '1 1 280px', minWidth: 0 }}>
          <Typography id={headingId} variant="h3" component="h2" sx={{ fontSize: 16 }}>
            {t('channels:meta.app.heading')}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 13 }}>
            {t('channels:meta.app.caption')}
          </Typography>
        </Box>
        <Box
          component="span"
          sx={{
            paddingInline: 2,
            height: 20,
            display: 'inline-flex',
            alignItems: 'center',
            borderRadius: '6px',
            fontSize: 12,
            color: 'text.secondary',
            backgroundColor: tokens['bg.muted'],
          }}
        >
          {t('channels:meta.app.installAdmins')}
        </Box>
        <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <HealthStateDot state={lastEventAt === null ? 'waiting' : 'healthy'} />
          <Typography component="span" sx={{ fontSize: 13 }}>
            {lastEventAt === null
              ? t('channels:meta.app.notSigned')
              : t('channels:meta.app.signed', { time: clockTime(lastEventAt, locale) })}
          </Typography>
        </Box>
      </Box>

      <Box
        sx={{
          paddingBlock: 4,
          paddingInline: 5,
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
          gap: '16px 24px',
          alignItems: 'start',
          borderBlockStart: `1px solid ${tokens['border.default']}`,
        }}
      >
        <Field
          id={callbackId}
          label={t('channels:meta.app.callback.label')}
          hint={t('channels:meta.app.callback.hint')}
        >
          <Box sx={{ display: 'flex', gap: 2 }}>
            <TextField
              id={callbackId}
              size="small"
              value={app.callbackUrl}
              fullWidth
              slotProps={{
                htmlInput: {
                  readOnly: true,
                  dir: 'ltr',
                  spellCheck: false,
                  'aria-describedby': `${callbackId}-hint`,
                },
              }}
              sx={{ '& input': (theme) => ({ ...theme.typography.mono, fontSize: 13 }) }}
            />
            <Button
              variant="outlined"
              aria-label={t('channels:meta.app.callback.copyLabel')}
              startIcon={<Copy size={16} aria-hidden="true" />}
              onClick={() => {
                void copy();
              }}
              sx={{ flexShrink: 0 }}
            >
              {t('channels:meta.app.callback.copy')}
            </Button>
          </Box>
        </Field>

        <Field
          id={appIdId}
          label={t('channels:meta.app.appId.label')}
          hint={<CodeText text={t('channels:meta.app.appId.hint')} />}
        >
          <TextField
            id={appIdId}
            size="small"
            value={t(
              app.appIdSet ? 'channels:meta.app.appId.set' : 'channels:meta.app.appId.notSet',
            )}
            fullWidth
            slotProps={{ htmlInput: { readOnly: true, 'aria-describedby': `${appIdId}-hint` } }}
          />
        </Field>

        <Field id={verifyId} label={t('channels:meta.app.verify.label')} hint={verifyHint}>
          <Box sx={{ display: 'flex', gap: 2 }}>
            <TextField
              id={verifyId}
              size="small"
              value={
                hasVerifyToken ? `•••• ${app.verifyTokenHint}` : t('channels:meta.app.verify.none')
              }
              fullWidth
              slotProps={{
                htmlInput: {
                  readOnly: true,
                  dir: 'ltr',
                  'aria-describedby': `${verifyId}-hint`,
                  ...(hasVerifyToken
                    ? {
                        'aria-label': t('channels:meta.app.verify.masked', {
                          hint: app.verifyTokenHint,
                        }),
                      }
                    : {}),
                },
              }}
              sx={{ '& input': (theme) => ({ ...theme.typography.mono, fontSize: 13 }) }}
            />
            <Button
              variant="outlined"
              disabled={rotate.isPending}
              aria-busy={rotate.isPending}
              aria-haspopup={hasVerifyToken ? 'dialog' : undefined}
              startIcon={
                rotate.isPending ? <CircularProgress size={14} aria-hidden="true" /> : undefined
              }
              onClick={() => {
                if (hasVerifyToken) {
                  setConfirming(true);
                } else {
                  rotate.mutate();
                }
              }}
              sx={{ flexShrink: 0 }}
            >
              {t(
                hasVerifyToken
                  ? 'channels:meta.app.verify.replace'
                  : 'channels:meta.app.verify.generate',
              )}
            </Button>
          </Box>
        </Field>

        <SecretSetting
          id={secretId}
          label={t('channels:meta.app.secret.label')}
          hint={t('channels:meta.app.secret.hint')}
          variable="HD_META_APP_SECRET"
          locked={locked(APP_SECRET)}
        />
        <SecretSetting
          id={instagramId}
          label={t('channels:meta.app.instagramSecret.label')}
          hint={t('channels:meta.app.instagramSecret.hint')}
          variable="HD_META_INSTAGRAM_APP_SECRET"
          locked={locked(INSTAGRAM_APP_SECRET)}
        />
      </Box>

      <Box
        sx={{
          paddingBlock: 3,
          paddingInline: 4,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 2,
          fontSize: 12,
          lineHeight: '18px',
          color: 'text.secondary',
          borderBlockStart: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.canvas'],
        }}
      >
        <Info size={14} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 2 }} />
        <Typography variant="caption" sx={{ fontSize: 12, lineHeight: '18px' }}>
          <CodeText text={t('channels:meta.app.footer')} />
        </Typography>
      </Box>

      <ConfirmDialog
        open={confirming}
        title={t('channels:meta.app.verify.confirm.title')}
        body={t('channels:meta.app.verify.confirm.body')}
        confirmLabel={t('channels:meta.app.verify.confirm.action')}
        busy={rotate.isPending}
        onConfirm={() => {
          rotate.mutate();
        }}
        onClose={() => {
          setConfirming(false);
        }}
      />
      <SecretReveal
        open={revealed !== null}
        title={t('channels:meta.app.verify.reveal.title')}
        warningStrong={t('channels:meta.app.verify.reveal.strong')}
        warning={t('channels:meta.app.verify.reveal.warning')}
        label={t('channels:meta.app.verify.reveal.label')}
        secret={revealed ?? ''}
        onDone={() => {
          setRevealed(null);
        }}
      >
        <Box
          component="dl"
          sx={{
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'max-content minmax(0, 1fr)',
            columnGap: 4,
            rowGap: 2,
            fontSize: 13,
            '& dt': { color: 'text.secondary', fontWeight: 500 },
            '& dd': { margin: 0 },
          }}
        >
          <dt>{t('channels:meta.app.verify.reveal.whereLabel')}</dt>
          <dd>{t('channels:meta.app.verify.reveal.where')}</dd>
          <dt>{t('channels:meta.app.verify.reveal.thenLabel')}</dt>
          <dd>{t('channels:meta.app.verify.reveal.then')}</dd>
          <dt>{t('channels:meta.app.verify.reveal.meanwhileLabel')}</dt>
          <dd>{t('channels:meta.app.verify.reveal.meanwhile')}</dd>
        </Box>
      </SecretReveal>
    </Box>
  );
}

/**
 * An install secret the screen never holds. When the environment has taken it
 * over it is an EnvLockedField with the "Set by environment" chip; otherwise
 * the field says so and the hint names the variable that sets it.
 */
function SecretSetting({
  id,
  label,
  hint,
  variable,
  locked,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly variable: string;
  readonly locked: boolean;
}): ReactNode {
  const t = useT();

  if (locked) {
    return (
      <Box sx={{ position: 'relative' }}>
        <Box sx={{ position: 'absolute', insetBlockStart: 0, insetInlineEnd: 0 }}>
          <EnvChip />
        </Box>
        <EnvLockedField id={id} label={label} value="••••••••••••" variable={variable} />
      </Box>
    );
  }

  return (
    <Field id={id} label={label} hint={<CodeText text={hint} />}>
      <TextField
        id={id}
        size="small"
        value={t('channels:meta.app.notLocked')}
        fullWidth
        slotProps={{ htmlInput: { readOnly: true, 'aria-describedby': `${id}-hint` } }}
      />
    </Field>
  );
}
