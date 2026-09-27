import {
  INBOUND_PARSE_PROVIDERS,
  type InboundParseProvider,
  inboundParsePath,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useChannelsApi, useSession } from '../../../auth/session.tsx';
import { ConfirmDialog } from '../../../ui/confirm-dialog.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import { ago } from './format.js';

/**
 * "Inbound parse endpoints" (M2-03 on the `Admin · email channel` artboard):
 * the five URLs a provider posts to, and the brand's shared secret.
 *
 * The secret is never on screen after it is saved — the field is a mask — and
 * "Replace" is the only way to see one: it asks first, because every provider
 * still using the old secret is refused from that moment, then shows the new
 * one once in a dialog with a copy button.
 */
export function InboundParseCard(): ReactNode {
  const t = useT();
  const api = useChannelsApi();
  const brand = currentBrand(useSession());
  const tokens = useSemanticTokens();
  const toast = useToast();
  const { locale } = usePreferences();
  const queryClient = useQueryClient();
  const headingId = useId();
  const secretId = useId();
  const hintId = useId();
  const [confirming, setConfirming] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [now] = useState(Date.now);

  const settings = useQuery({
    queryKey: ['inbound-parse', brand.id],
    queryFn: () => api.inboundParse(brand.id),
  });

  const replace = useMutation({
    mutationFn: () => api.replaceInboundSecret(brand.id),
    onSuccess: async ({ secret }) => {
      setConfirming(false);
      setRevealed(secret);
      await queryClient.invalidateQueries({ queryKey: ['inbound-parse', brand.id] });
      toast({ tone: 'success', message: t('channels:toast.secretReplaced') });
    },
    onError: () => {
      toast({ tone: 'danger', message: t('channels:toast.failed') });
    },
  });

  const copy = async (text: string, message: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ tone: 'success', message });
    } catch {
      toast({ tone: 'danger', message: t('channels:toast.failed') });
    }
  };

  const base = `${window.location.origin}`;
  const last = settings.data?.lastRequest ?? null;
  const secretSet = settings.data?.secretSet ?? false;

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      sx={{
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box
        sx={{
          paddingBlock: '14px 10px',
          paddingInline: 4,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
        }}
      >
        <Typography id={headingId} variant="h3" component="h2" sx={{ fontSize: 16 }}>
          {t('channels:inboundParse.heading')}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 13 }}>
          {t('channels:inboundParse.caption')}
        </Typography>
        <Typography variant="mono" sx={{ fontSize: 12, color: 'text.secondary' }}>
          <bdi>{t('channels:inboundParse.base', { url: base })}</bdi>
        </Typography>
      </Box>

      <Box component="ul" sx={{ listStyle: 'none', margin: 0, paddingInline: 4, paddingBlock: 0 }}>
        {INBOUND_PARSE_PROVIDERS.map((provider) => (
          <Endpoint
            key={provider}
            provider={provider}
            onCopy={(name) => {
              void copy(
                `${base}${inboundParsePath(provider)}`,
                t('channels:inboundParse.copied', { provider: name }),
              );
            }}
          />
        ))}
      </Box>

      <Box
        sx={{
          paddingBlock: '12px 14px',
          paddingInline: 4,
          borderBlockStart: `1px solid ${tokens['bg.muted']}`,
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}
      >
        <Typography component="label" htmlFor={secretId} sx={{ fontSize: 13, fontWeight: 500 }}>
          {t('channels:inboundParse.secret')}
        </Typography>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <TextField
            id={secretId}
            size="small"
            type="password"
            value={secretSet ? '••••••••••••••••' : ''}
            fullWidth
            slotProps={{ htmlInput: { readOnly: true, 'aria-describedby': hintId } }}
          />
          <Button
            variant="outlined"
            onClick={() => {
              setConfirming(true);
            }}
          >
            {t('channels:inboundParse.replace')}
          </Button>
        </Box>
        <Typography id={hintId} variant="caption" sx={{ color: 'text.secondary' }}>
          {secretSet ? t('channels:inboundParse.hint') : t('channels:inboundParse.noSecret')}
          {last === null
            ? null
            : ` ${t('channels:inboundParse.lastRequest', {
                provider: t(`channels:mailboxes.providers.${last.provider}`),
                ago: ago(last.at, now, locale),
                outcome: t(`channels:inboundParse.outcomes.${last.outcome}`),
              })}`}
        </Typography>
      </Box>

      <ConfirmDialog
        open={confirming}
        title={t('channels:inboundParse.confirm.title')}
        body={t('channels:inboundParse.confirm.body')}
        confirmLabel={t('channels:inboundParse.confirm.action')}
        busy={replace.isPending}
        onConfirm={() => {
          replace.mutate();
        }}
        onClose={() => {
          setConfirming(false);
        }}
      />

      <SecretDialog
        secret={revealed}
        onCopy={(secret) => {
          void copy(secret, t('channels:toast.copied'));
        }}
        onClose={() => {
          setRevealed(null);
        }}
      />
    </Box>
  );
}

function Endpoint({
  provider,
  onCopy,
}: {
  readonly provider: InboundParseProvider;
  onCopy(name: string): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const name = t(`channels:mailboxes.providers.${provider}`);

  return (
    <Box
      component="li"
      sx={{
        display: 'grid',
        gridTemplateColumns: '96px minmax(0, 1fr) 28px',
        gap: 2,
        alignItems: 'center',
        height: 36,
        borderBlockStart: `1px solid ${tokens['bg.muted']}`,
      }}
    >
      <Typography component="span" sx={{ fontSize: 13, fontWeight: 500 }}>
        {name}
      </Typography>
      <Typography
        variant="mono"
        component="bdi"
        sx={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        {inboundParsePath(provider)}
      </Typography>
      <IconButton
        size="small"
        aria-label={t('channels:inboundParse.copy', { provider: name })}
        onClick={() => {
          onCopy(name);
        }}
        sx={{
          border: `1px solid ${tokens['border.strong']}`,
          borderRadius: '6px',
          width: 28,
          height: 28,
        }}
      >
        <Copy size={14} aria-hidden="true" />
      </IconButton>
    </Box>
  );
}

function SecretDialog({
  secret,
  onCopy,
  onClose,
}: {
  readonly secret: string | null;
  onCopy(secret: string): void;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const titleId = useId();
  const fieldId = useId();

  return (
    <Dialog
      open={secret !== null}
      onClose={onClose}
      aria-labelledby={titleId}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle id={titleId}>{t('channels:inboundParse.reveal.title')}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Typography sx={{ fontSize: 14, color: 'text.secondary' }}>
          {t('channels:inboundParse.reveal.body')}
        </Typography>
        <Typography component="label" htmlFor={fieldId} sx={{ fontSize: 13, fontWeight: 500 }}>
          {t('channels:inboundParse.reveal.label')}
        </Typography>
        <TextField
          id={fieldId}
          size="small"
          value={secret ?? ''}
          fullWidth
          slotProps={{ htmlInput: { readOnly: true, dir: 'ltr' } }}
        />
      </DialogContent>
      <DialogActions>
        <Button
          variant="outlined"
          startIcon={<Copy size={14} aria-hidden="true" />}
          onClick={() => {
            if (secret !== null) {
              onCopy(secret);
            }
          }}
        >
          {t('channels:inboundParse.reveal.copy')}
        </Button>
        <Button variant="contained" onClick={onClose}>
          {t('channels:inboundParse.reveal.done')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
