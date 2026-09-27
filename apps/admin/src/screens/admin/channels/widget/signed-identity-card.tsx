import type { WidgetSettings, WidgetSignedIdentity } from '@helpdock/schemas';
import { Box, Button, Link as MuiLink, TextField, Typography } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { BookOpen, Copy, TriangleAlert } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { useChannelsApi } from '../../../../auth/session.tsx';
import { Field } from '../../../../ui/field.tsx';
import { useToast } from '../../../../ui/toasts.tsx';
import { SectionCard, useEmailAction } from '../section-card.tsx';
import { AdminsOnly } from './access-card.tsx';
import { CheckRow } from './conversation-card.tsx';

export const PROTOCOL_GUIDE_URL =
  'https://github.com/Docker-Hunterpedia/Helpdock/blob/main/docs/guides/widget-protocol.md';

type Signed = NonNullable<WidgetSettings['signedIdentity']>;

/**
 * "Signed identity" (M4-02, DOMAIN-RULES §4.2; artboard `AdminWidget`),
 * Admins only: whether the brand's site may vouch for a visitor, the signing
 * secret as a SecretField, and whether a verified visitor also sees their
 * email and Telegram tickets.
 *
 * Replace makes a new secret and shows it once, inline, as the artboard draws
 * it — the old one stops verifying the moment the api answers, so there is
 * nothing to confirm that the panel does not already say.
 */
export function SignedIdentityCard({
  brandId,
  signed,
  onSaved,
  onReplaced,
}: {
  readonly brandId: string;
  readonly signed: Signed;
  readonly onSaved: (settings: WidgetSettings) => void;
  readonly onReplaced: () => Promise<void>;
}): ReactNode {
  const t = useT();
  const api = useChannelsApi();
  const tokens = useSemanticTokens();
  const toast = useToast();
  const { locale } = usePreferences();
  const id = useId();
  const [draft, setDraft] = useState<WidgetSignedIdentity>({
    enabled: signed.enabled,
    seesAllChannels: signed.seesAllChannels,
  });
  const [revealed, setRevealed] = useState<string | null>(null);

  useEffect(() => {
    setDraft({ enabled: signed.enabled, seesAllChannels: signed.seesAllChannels });
  }, [signed]);

  const save = useEmailAction(
    (request: WidgetSignedIdentity) => api.saveWidgetSignedIdentity(brandId, request),
    t('channels:widget.signed.saved'),
    onSaved,
  );
  const replace = useMutation({
    mutationFn: () => api.replaceWidgetSigningSecret(brandId),
    onSuccess: async ({ secret }) => {
      setRevealed(secret);
      await onReplaced();
      toast({ tone: 'success', message: t('channels:widget.signed.replaced') });
    },
    onError: () => {
      toast({ tone: 'danger', message: t('channels:actionFailed') });
    },
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    save.mutate(draft);
  };

  const stamp = signed.secret;
  const date = (iso: string): string =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
  const secretHint =
    stamp === null
      ? t('channels:widget.signed.noSecret')
      : stamp.setBy === null
        ? t('channels:widget.signed.secretCreatedBySystem', { date: date(stamp.setAt) })
        : t('channels:widget.signed.secretCreated', { date: date(stamp.setAt), name: stamp.setBy });

  return (
    <SectionCard
      id={`${id}-signed`}
      heading={t('channels:widget.signed.heading')}
      caption={t('channels:widget.signed.caption')}
      aside={<AdminsOnly />}
      onSubmit={submit}
      footer={
        <>
          <Button
            variant="text"
            disabled={save.isPending}
            onClick={() =>
              setDraft({ enabled: signed.enabled, seesAllChannels: signed.seesAllChannels })
            }
          >
            {t('channels:discard')}
          </Button>
          <Button type="submit" variant="contained" disabled={save.isPending}>
            {t('channels:widget.save')}
          </Button>
        </>
      }
    >
      <CheckRow
        id={`${id}-enabled`}
        checked={draft.enabled}
        label={t('channels:widget.signed.enabled')}
        hint={t('channels:widget.signed.enabledHint')}
        onChange={(enabled) => setDraft((held) => ({ ...held, enabled }))}
      />

      <Field id={`${id}-secret`} label={t('channels:widget.signed.secret')} hint={secretHint}>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <TextField
            id={`${id}-secret`}
            size="small"
            type="password"
            fullWidth
            value={stamp === null ? '' : '••••••••••••••••'}
            slotProps={{
              htmlInput: { readOnly: true, dir: 'ltr', 'aria-describedby': `${id}-secret-hint` },
            }}
          />
          <Button variant="outlined" disabled={replace.isPending} onClick={() => replace.mutate()}>
            {t('channels:widget.signed.replace')}
          </Button>
        </Box>
      </Field>

      {revealed === null ? null : (
        <Box
          sx={{
            borderRadius: '6px',
            border: `1px solid ${tokens['status.warning']}`,
            backgroundColor: tokens['status.warning.tint'],
            padding: 3,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <Field id={`${id}-new`} label={t('channels:widget.signed.newSecret')}>
            <Box sx={{ display: 'flex', gap: 2 }}>
              <TextField
                id={`${id}-new`}
                size="small"
                fullWidth
                value={revealed}
                slotProps={{ htmlInput: { readOnly: true, dir: 'ltr', spellCheck: false } }}
                sx={{ '& input': { fontFamily: 'var(--hd-font-mono, monospace)' } }}
              />
              <Button
                variant="outlined"
                startIcon={<Copy size={16} aria-hidden="true" />}
                onClick={() => {
                  void navigator.clipboard.writeText(revealed).then(
                    () => toast({ tone: 'success', message: t('channels:widget.signed.copied') }),
                    () => toast({ tone: 'danger', message: t('channels:actionFailed') }),
                  );
                }}
              >
                {t('channels:widget.signed.copy')}
              </Button>
            </Box>
          </Field>
          <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <TriangleAlert size={14} aria-hidden="true" color={tokens['status.warning']} />
            <Typography variant="caption" sx={{ color: tokens['status.warning.text'] }}>
              {t('channels:widget.signed.copyNow')}
            </Typography>
          </Box>
          <Button variant="text" sx={{ alignSelf: 'flex-start' }} onClick={() => setRevealed(null)}>
            {t('channels:widget.signed.done')}
          </Button>
        </Box>
      )}

      <CheckRow
        id={`${id}-all`}
        checked={draft.seesAllChannels}
        label={t('channels:widget.signed.allChannels')}
        hint={t('channels:widget.signed.allChannelsHint')}
        onChange={(seesAllChannels) => setDraft((held) => ({ ...held, seesAllChannels }))}
      />

      <MuiLink
        href={PROTOCOL_GUIDE_URL}
        target="_blank"
        rel="noreferrer"
        sx={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 13 }}
      >
        <BookOpen size={14} aria-hidden="true" />
        {t('channels:widget.signed.guide')}
      </MuiLink>
    </SectionCard>
  );
}
